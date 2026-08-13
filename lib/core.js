'use strict';
/*
 * 공통 로직: API 라우터, 인증, 부가세 계산.
 * 로컬 서버(server.js)와 Vercel 서버리스 함수(api/index.js)가 함께 사용한다.
 * 저장소는 setStore()로 주입한다 (로컬: 파일, Vercel: Neon Postgres).
 */
const crypto = require('crypto');

const SESSION_DAYS = 30;

function emptyDb() {
  return {
    seq: 1,
    auth: null, // { salt, hash, sessions: { 토큰해시: 만료시각(ms) } }
    settings: { name: '', owner: '', bizNo: '', phone: '', address: '' },
    companies: [],
    products: [],
    transactions: [],
  };
}

// 읽어온 데이터에 누락된 필드를 채워 항상 완전한 형태로 만든다
function normalizeDb(parsed) {
  const out = Object.assign(emptyDb(), parsed || {});
  out.settings = Object.assign(emptyDb().settings, (parsed && parsed.settings) || {});
  for (const k of ['companies', 'products', 'transactions']) {
    if (!Array.isArray(out[k])) out[k] = [];
  }
  if (!Number.isFinite(out.seq)) out.seq = 1;
  return out;
}

let db = null;
let store = null;

function setStore(s) {
  store = s;
}

async function saveDb() {
  await store.save(db);
}

// 인스턴스 안에서 요청을 순차 처리해 동시 저장으로 인한 유실을 줄인다
let chain = Promise.resolve();
function withLock(fn) {
  const run = chain.then(fn, fn);
  chain = run.then(() => {}, () => {});
  return run;
}

const nextId = () => db.seq++;
const str = (v) => String(v == null ? '' : v).trim();
const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

// 부가세 계산: separate(별도) / included(포함) / none(없음)
function calcItem(qty, price, vatMode) {
  const amount = Math.round(qty * price);
  if (vatMode === 'included') {
    const supply = Math.round(amount / 1.1);
    return { supply, tax: amount - supply };
  }
  if (vatMode === 'separate') return { supply: amount, tax: Math.round(amount * 0.1) };
  return { supply: amount, tax: 0 };
}

function buildTransaction(body, id) {
  const companyId = num(body.companyId);
  if (!db.companies.some((c) => c.id === companyId)) return { error: '상호를 선택하세요.' };
  const date = str(body.date) || new Date().toISOString().slice(0, 10);
  const vatMode = ['separate', 'included', 'none'].includes(body.vatMode) ? body.vatMode : 'separate';
  const items = (Array.isArray(body.items) ? body.items : [])
    .map((it) => ({ name: str(it.name), spec: str(it.spec), qty: num(it.qty), price: num(it.price) }))
    .filter((it) => it.name);
  if (!items.length) return { error: '품목을 1개 이상 입력하세요.' };

  let supplyTotal = 0;
  let taxTotal = 0;
  for (const it of items) {
    const { supply, tax } = calcItem(it.qty, it.price, vatMode);
    it.supply = supply;
    it.tax = tax;
    supplyTotal += supply;
    taxTotal += tax;
  }
  return {
    tx: {
      id,
      companyId,
      date,
      vatMode,
      items,
      supplyTotal,
      taxTotal,
      total: supplyTotal + taxTotal,
      paid: num(body.paid),
      memo: str(body.memo),
    },
  };
}

/* ─────────────── 인증 ─────────────── */
const loginFails = new Map(); // ip → { count, until } (인스턴스 메모리 기준)

function clientIp(req) {
  const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return fwd || (req.socket && req.socket.remoteAddress) || '';
}

function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

const tokenHash = (t) => crypto.createHash('sha256').update(t).digest('hex');
const hashPassword = (pw, saltHex) => crypto.scryptSync(pw, Buffer.from(saltHex, 'hex'), 64).toString('hex');

function verifyPassword(pw) {
  const h = crypto.scryptSync(pw, Buffer.from(db.auth.salt, 'hex'), 64);
  return crypto.timingSafeEqual(h, Buffer.from(db.auth.hash, 'hex'));
}

function pruneSessions() {
  if (!db.auth) return;
  const now = Date.now();
  for (const [k, exp] of Object.entries(db.auth.sessions)) {
    if (!(typeof exp === 'number' && exp > now)) delete db.auth.sessions[k];
  }
}

function isAuthed(req) {
  if (!db.auth) return false; // 비밀번호를 설정하기 전에는 어떤 API도 열지 않음
  const t = parseCookies(req).session;
  if (!t) return false;
  const exp = db.auth.sessions[tokenHash(t)];
  return typeof exp === 'number' && exp > Date.now();
}

async function issueSession(req, res) {
  const token = crypto.randomBytes(32).toString('hex');
  pruneSessions();
  db.auth.sessions[tokenHash(token)] = Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000;
  await saveDb();
  const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_DAYS * 24 * 60 * 60}${secure}`);
}

async function handleAuth(req, res, p, m) {
  if (p === '/api/auth/status' && m === 'GET') {
    return sendJson(res, 200, { needsSetup: !db.auth, authed: isAuthed(req) });
  }

  if (p === '/api/auth/setup' && m === 'POST') {
    if (db.auth) return sendJson(res, 400, { error: '이미 비밀번호가 설정되어 있습니다.' });
    const b = await readBody(req);
    const pw = String(b.password || '');
    if (pw.length < 4) return sendJson(res, 400, { error: '비밀번호는 4자 이상으로 정하세요.' });
    const salt = crypto.randomBytes(16).toString('hex');
    db.auth = { salt, hash: hashPassword(pw, salt), sessions: {} };
    await issueSession(req, res);
    return sendJson(res, 200, { ok: true });
  }

  if (p === '/api/auth/login' && m === 'POST') {
    if (!db.auth) return sendJson(res, 400, { error: '먼저 비밀번호를 설정하세요.' });
    const ip = clientIp(req);
    const fail = loginFails.get(ip);
    if (fail && fail.until > Date.now()) {
      return sendJson(res, 429, { error: '로그인 시도가 너무 많습니다. 10분 뒤 다시 시도하세요.' });
    }
    const b = await readBody(req);
    if (!verifyPassword(String(b.password || ''))) {
      const f = fail || { count: 0, until: 0 };
      f.count++;
      if (f.count >= 8) {
        f.until = Date.now() + 10 * 60 * 1000;
        f.count = 0;
      }
      loginFails.set(ip, f);
      return sendJson(res, 401, { error: '비밀번호가 올바르지 않습니다.' });
    }
    loginFails.delete(ip);
    await issueSession(req, res);
    return sendJson(res, 200, { ok: true });
  }

  if (p === '/api/auth/logout' && m === 'POST') {
    const t = parseCookies(req).session;
    if (db.auth && t) {
      delete db.auth.sessions[tokenHash(t)];
      await saveDb();
    }
    res.setHeader('Set-Cookie', 'session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
    return sendJson(res, 200, { ok: true });
  }

  if (p === '/api/auth/password' && m === 'POST') {
    if (!isAuthed(req)) return sendJson(res, 401, { error: '로그인이 필요합니다.' });
    const b = await readBody(req);
    if (!verifyPassword(String(b.current || ''))) return sendJson(res, 400, { error: '현재 비밀번호가 올바르지 않습니다.' });
    const pw = String(b.next || '');
    if (pw.length < 4) return sendJson(res, 400, { error: '새 비밀번호는 4자 이상으로 정하세요.' });
    const salt = crypto.randomBytes(16).toString('hex');
    db.auth = { salt, hash: hashPassword(pw, salt), sessions: {} }; // 다른 기기는 모두 로그아웃됨
    await issueSession(req, res);
    return sendJson(res, 200, { ok: true });
  }

  return sendJson(res, 404, { error: '알 수 없는 API 경로입니다.' });
}

/* ─────────────── HTTP 유틸 ─────────────── */
function sendJson(res, code, obj) {
  const buf = Buffer.from(JSON.stringify(obj));
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': buf.length });
  res.end(buf);
}

function readBody(req) {
  // Vercel Node 런타임은 JSON 본문을 미리 파싱해 req.body에 넣어 둔다
  if (req.body !== undefined && req.body !== null) {
    try {
      const parsed = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
      return Promise.resolve(parsed && typeof parsed === 'object' ? parsed : {});
    } catch {
      return Promise.reject(new Error('잘못된 JSON 형식입니다.'));
    }
  }
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 4e6) {
        reject(new Error('요청이 너무 큽니다.'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        reject(new Error('잘못된 JSON 형식입니다.'));
      }
    });
    req.on('error', reject);
  });
}

/* ─────────────── API 라우터 ─────────────── */
async function routeApi(req, res, url) {
  const p = url.pathname;
  const m = req.method;
  const match = (re) => {
    const r = p.match(re);
    return r ? Number(r[1]) : null;
  };

  // ── 인증 (로그인 없이 접근 가능한 유일한 API) ──
  if (p.startsWith('/api/auth/')) return handleAuth(req, res, p, m);
  if (!isAuthed(req)) return sendJson(res, 401, { error: '로그인이 필요합니다.' });

  // ── 백업 다운로드 ──
  if (p === '/api/backup' && m === 'GET') {
    const copy = Object.assign({}, db, { auth: db.auth ? { salt: db.auth.salt, hash: db.auth.hash, sessions: {} } : null });
    const buf = Buffer.from(JSON.stringify(copy, null, 2));
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="ledger-backup-${new Date().toISOString().slice(0, 10)}.json"`,
      'Content-Length': buf.length,
    });
    return res.end(buf);
  }

  // ── 백업 복원 (장부 전체 교체, 현재 비밀번호는 유지) ──
  if (p === '/api/restore' && m === 'POST') {
    const b = await readBody(req);
    if (!b || typeof b !== 'object' || !Array.isArray(b.companies) || !Array.isArray(b.products) || !Array.isArray(b.transactions)) {
      return sendJson(res, 400, { error: '올바른 백업 파일이 아닙니다.' });
    }
    const keepAuth = db.auth;
    db = normalizeDb(b);
    db.auth = keepAuth;
    await saveDb();
    return sendJson(res, 200, { ok: true });
  }

  // ── 내 사업자 정보 ──
  if (p === '/api/settings' && m === 'GET') return sendJson(res, 200, db.settings);
  if (p === '/api/settings' && m === 'PUT') {
    const b = await readBody(req);
    db.settings = { name: str(b.name), owner: str(b.owner), bizNo: str(b.bizNo), phone: str(b.phone), address: str(b.address) };
    await saveDb();
    return sendJson(res, 200, db.settings);
  }

  // ── 상호관리 ──
  if (p === '/api/companies' && m === 'GET') {
    const list = db.companies
      .map((c) => {
        const txs = db.transactions.filter((t) => t.companyId === c.id);
        const total = txs.reduce((s, t) => s + t.total, 0);
        const paid = txs.reduce((s, t) => s + t.paid, 0);
        return Object.assign({}, c, { txCount: txs.length, outstanding: total - paid });
      })
      .sort((a, b) => a.name.localeCompare(b.name, 'ko'));
    return sendJson(res, 200, list);
  }
  if (p === '/api/companies' && m === 'POST') {
    const b = await readBody(req);
    if (!str(b.name)) return sendJson(res, 400, { error: '상호명을 입력하세요.' });
    const c = { id: nextId(), name: str(b.name), owner: str(b.owner), bizNo: str(b.bizNo), phone: str(b.phone), address: str(b.address), memo: str(b.memo) };
    db.companies.push(c);
    await saveDb();
    return sendJson(res, 201, c);
  }
  let id = match(/^\/api\/companies\/(\d+)$/);
  if (id != null) {
    const c = db.companies.find((x) => x.id === id);
    if (!c) return sendJson(res, 404, { error: '상호를 찾을 수 없습니다.' });
    if (m === 'PUT') {
      const b = await readBody(req);
      if (!str(b.name)) return sendJson(res, 400, { error: '상호명을 입력하세요.' });
      Object.assign(c, { name: str(b.name), owner: str(b.owner), bizNo: str(b.bizNo), phone: str(b.phone), address: str(b.address), memo: str(b.memo) });
      await saveDb();
      return sendJson(res, 200, c);
    }
    if (m === 'DELETE') {
      db.companies = db.companies.filter((x) => x.id !== id);
      db.products = db.products.filter((x) => x.companyId !== id);
      db.transactions = db.transactions.filter((x) => x.companyId !== id);
      await saveDb();
      return sendJson(res, 200, { ok: true });
    }
  }

  // ── 제품관리 ──
  if (p === '/api/products' && m === 'GET') {
    const companyId = num(url.searchParams.get('companyId'));
    const list = db.products
      .filter((x) => !companyId || x.companyId === companyId)
      .sort((a, b) => a.name.localeCompare(b.name, 'ko'));
    return sendJson(res, 200, list);
  }
  if (p === '/api/products' && m === 'POST') {
    const b = await readBody(req);
    const companyId = num(b.companyId);
    if (!db.companies.some((c) => c.id === companyId)) return sendJson(res, 400, { error: '상호를 선택하세요.' });
    if (!str(b.name)) return sendJson(res, 400, { error: '품명을 입력하세요.' });
    const prod = { id: nextId(), companyId, name: str(b.name), spec: str(b.spec), unit: str(b.unit), price: num(b.price), memo: str(b.memo) };
    db.products.push(prod);
    await saveDb();
    return sendJson(res, 201, prod);
  }
  id = match(/^\/api\/products\/(\d+)$/);
  if (id != null) {
    const prod = db.products.find((x) => x.id === id);
    if (!prod) return sendJson(res, 404, { error: '제품을 찾을 수 없습니다.' });
    if (m === 'PUT') {
      const b = await readBody(req);
      if (!str(b.name)) return sendJson(res, 400, { error: '품명을 입력하세요.' });
      Object.assign(prod, { name: str(b.name), spec: str(b.spec), unit: str(b.unit), price: num(b.price), memo: str(b.memo) });
      await saveDb();
      return sendJson(res, 200, prod);
    }
    if (m === 'DELETE') {
      db.products = db.products.filter((x) => x.id !== id);
      await saveDb();
      return sendJson(res, 200, { ok: true });
    }
  }

  // ── 거래관리 ──
  if (p === '/api/transactions' && m === 'GET') {
    const companyId = num(url.searchParams.get('companyId'));
    const names = new Map(db.companies.map((c) => [c.id, c.name]));
    const list = db.transactions
      .filter((t) => !companyId || t.companyId === companyId)
      .sort((a, b) => b.date.localeCompare(a.date) || b.id - a.id)
      .map((t) => Object.assign({}, t, { companyName: names.get(t.companyId) || '(삭제된 상호)' }));
    return sendJson(res, 200, list);
  }
  if (p === '/api/transactions' && m === 'POST') {
    const b = await readBody(req);
    const r = buildTransaction(b, nextId());
    if (r.error) return sendJson(res, 400, { error: r.error });
    db.transactions.push(r.tx);
    await saveDb();
    return sendJson(res, 201, r.tx);
  }
  id = match(/^\/api\/transactions\/(\d+)$/);
  if (id != null) {
    const idx = db.transactions.findIndex((x) => x.id === id);
    if (idx < 0) return sendJson(res, 404, { error: '거래를 찾을 수 없습니다.' });
    if (m === 'GET') return sendJson(res, 200, db.transactions[idx]);
    if (m === 'PUT') {
      const b = await readBody(req);
      const r = buildTransaction(b, id);
      if (r.error) return sendJson(res, 400, { error: r.error });
      db.transactions[idx] = r.tx;
      await saveDb();
      return sendJson(res, 200, r.tx);
    }
    if (m === 'DELETE') {
      db.transactions.splice(idx, 1);
      await saveDb();
      return sendJson(res, 200, { ok: true });
    }
  }

  return sendJson(res, 404, { error: '알 수 없는 API 경로입니다.' });
}

async function handleApi(req, res, url) {
  return withLock(async () => {
    db = await store.load();
    try {
      return await routeApi(req, res, url);
    } catch (e) {
      const msg = (e && e.message) || '서버 오류';
      const code = msg.includes('JSON') || msg.includes('큽니다') ? 400 : 500;
      return sendJson(res, code, { error: msg });
    }
  });
}

module.exports = { emptyDb, normalizeDb, setStore, handleApi, sendJson };
