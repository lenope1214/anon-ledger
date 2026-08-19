'use strict';
/*
 * 공통 로직: API 라우터, 계정 인증, 부가세 계산.
 * 로컬 서버(server.js)와 Vercel 서버리스 함수(api/index.js)가 함께 사용한다.
 * 저장소는 setStore()로 주입한다 (로컬: 파일, Vercel: Neon Postgres).
 *
 * 계정 구조: 사용자마다 독립된 장부(ledger)를 갖는다.
 *  - 사용자 레코드: { username, salt, hash, createdAt, ledger }
 *  - ledger: { seq, settings, companies, products, transactions }
 */
const crypto = require('crypto');
const pkg = require('../package.json');

const SESSION_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;
const USERNAME_RE = /^[0-9a-zA-Z가-힣._-]{2,20}$/;

function emptyLedger() {
  return {
    seq: 1,
    settings: { name: '', owner: '', bizNo: '', phone: '', address: '' },
    companies: [],
    products: [],
    transactions: [],
    payments: [], // 거래와 별개로 받은 돈(수금) 내역
  };
}

// 읽어온 장부에 누락된 필드를 채워 항상 완전한 형태로 만든다 (예전 백업 파일 호환)
function normalizeLedger(parsed) {
  const out = Object.assign(emptyLedger(), parsed || {});
  out.settings = Object.assign(emptyLedger().settings, (parsed && parsed.settings) || {});
  for (const k of ['companies', 'products', 'transactions', 'payments']) {
    if (!Array.isArray(out[k])) out[k] = [];
  }
  if (!Number.isFinite(out.seq)) out.seq = 1;
  for (const t of out.transactions) {
    if (t.kind !== 'purchase') t.kind = 'sale'; // 구분이 없던 예전 거래는 매출
  }
  // 예전 장부에는 단가 기준일이 없다 — 거래 내역에서 날짜 기준 최신 단가로 한 번 맞춘다
  if (out.products.some((p) => p.priceDate === undefined)) {
    const map = latestPriceMap(out.transactions);
    for (const prod of out.products) {
      if (prod.priceDate !== undefined) continue;
      const latest = map.get(productKey(prod.companyId, prod.name, prod.spec));
      if (latest) {
        prod.price = latest.price;
        prod.priceDate = latest.date;
        prod.priceTxId = latest.txId;
      } else {
        prod.priceDate = ''; // 거래 없이 손으로 등록한 제품은 지금 단가를 유지
        prod.priceTxId = 0;
      }
    }
  }
  delete out.auth; // 예전 단일 비밀번호 시절 백업의 인증 정보는 버린다
  delete out.username;
  return out;
}

let store = null;
function setStore(s) {
  store = s;
}

// 요청 컨텍스트 (라우터 진입 시 설정)
let userKey = null;
let userRec = null;
let ledger = null;

async function saveLedger() {
  await store.saveUser(userKey, userRec);
}

// 인스턴스 안에서 요청을 순차 처리해 동시 저장으로 인한 유실을 줄인다
let chain = Promise.resolve();
function withLock(fn) {
  const run = chain.then(fn, fn);
  chain = run.then(() => {}, () => {});
  return run;
}

const nextId = () => ledger.seq++;
const todayStr = () => new Date().toISOString().slice(0, 10);
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

// 상호를 정한다: id가 유효하면 그대로, 아니면 이름으로 찾거나 자동 등록한다 (제품과 같은 방식)
function resolveCompany(body) {
  const companyId = num(body.companyId);
  if (ledger.companies.some((c) => c.id === companyId)) return { companyId };
  const newName = str(body.companyName);
  if (!newName) return { error: '상호를 입력하세요.' };
  const existing = ledger.companies.find((c) => c.name.toLowerCase() === newName.toLowerCase());
  if (existing) return { companyId: existing.id };
  const c = { id: nextId(), name: newName, owner: '', bizNo: '', phone: '', address: '', memo: '' };
  ledger.companies.push(c);
  return { companyId: c.id };
}

const PAY_METHODS = ['cash', 'transfer', 'card', 'note', 'etc'];

// 거래와 별개로 받은 돈(수금) 한 건
function buildPayment(body, id) {
  const resolved = resolveCompany(body);
  if (resolved.error) return { error: resolved.error };
  const amount = num(body.amount);
  if (!amount) return { error: '받은 금액을 입력하세요.' };
  return {
    pay: {
      id,
      companyId: resolved.companyId,
      date: str(body.date) || todayStr(),
      amount,
      method: PAY_METHODS.includes(body.method) ? body.method : 'cash',
      memo: str(body.memo),
    },
  };
}

function buildTransaction(body, id) {
  const date = str(body.date) || todayStr();
  const kind = body.kind === 'purchase' ? 'purchase' : 'sale'; // 판 것(매출) / 산 것(매입·지출)
  const vatMode = ['separate', 'included', 'none'].includes(body.vatMode) ? body.vatMode : 'separate';
  const items = (Array.isArray(body.items) ? body.items : [])
    .map((it) => ({ name: str(it.name), spec: str(it.spec), qty: num(it.qty), price: num(it.price) }))
    .filter((it) => it.name);
  if (!items.length) return { error: '품목을 1개 이상 입력하세요.' };

  const resolved = resolveCompany(body);
  if (resolved.error) return { error: resolved.error };
  const companyId = resolved.companyId;

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
      kind,
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

// 제품을 찾는 열쇠: 상호 + 품명 + 규격
const productKey = (companyId, name, spec) => companyId + '|' + name + '|' + (spec || '');

// 어느 쪽이 더 나중 거래인지 (같은 날이면 나중에 저장한 것)
const isNewerTx = (date, txId, prevDate, prevTxId) =>
  !prevDate || date > prevDate || (date === prevDate && txId >= (prevTxId || 0));

// 거래들을 훑어 (상호+품명+규격)마다 거래 날짜 기준 가장 최근 단가를 뽑는다
function latestPriceMap(txs) {
  const map = new Map();
  for (const t of txs || []) {
    for (const it of t.items || []) {
      if (!it.name || !it.price) continue; // 0원은 기준 단가로 삼지 않는다
      const k = productKey(t.companyId, it.name, it.spec);
      const prev = map.get(k);
      if (isNewerTx(t.date, t.id, prev && prev.date, prev && prev.txId)) {
        map.set(k, { price: it.price, date: t.date, txId: t.id });
      }
    }
  }
  return map;
}

// 거래에 적힌 품목을 그 상호의 제품 목록에 자동 등록한다.
// 이미 있는 제품(품명+규격이 같음)이면 **거래 날짜가 더 최근일 때만** 기본 단가를 갱신한다.
// (지난 날짜 거래를 나중에 고쳐도 최신 단가가 과거 값으로 되돌아가지 않는다)
function registerProductsFromItems(tx) {
  for (const it of tx.items) {
    const found = ledger.products.find(
      (pr) => pr.companyId === tx.companyId && pr.name === it.name && (pr.spec || '') === (it.spec || '')
    );
    if (found) {
      // 0원이 아닌 단가는 마이너스(반품·차감)를 포함해 갱신 대상
      if (it.price !== 0 && isNewerTx(tx.date, tx.id, found.priceDate, found.priceTxId)) {
        found.price = it.price;
        found.priceDate = tx.date;
        found.priceTxId = tx.id;
      }
    } else {
      ledger.products.push({
        id: nextId(), companyId: tx.companyId, name: it.name, spec: it.spec, unit: '',
        price: it.price, memo: '',
        priceDate: it.price !== 0 ? tx.date : '', priceTxId: it.price !== 0 ? tx.id : 0,
      });
    }
  }
}

// 거래를 지웠을 때, 그 거래가 기준이던 제품 단가를 남은 거래로 다시 계산한다
function recalcProductPrices(items, companyId) {
  const map = latestPriceMap(ledger.transactions);
  for (const it of items || []) {
    const prod = ledger.products.find(
      (pr) => pr.companyId === companyId && pr.name === it.name && (pr.spec || '') === (it.spec || '')
    );
    if (!prod) continue;
    const latest = map.get(productKey(companyId, it.name, it.spec));
    if (latest) {
      prod.price = latest.price;
      prod.priceDate = latest.date;
      prod.priceTxId = latest.txId;
    } else {
      // 기준이 될 거래가 남지 않았으면 마지막 단가는 그대로 두고 기준일만 비운다
      prod.priceDate = '';
      prod.priceTxId = 0;
    }
  }
}

/* ─────────────── 인증 ─────────────── */
const loginFails = new Map(); // 'ip|아이디' → { count, until } (인스턴스 메모리 기준)

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

function verifyPassword(rec, pw) {
  const h = crypto.scryptSync(pw, Buffer.from(rec.salt, 'hex'), 64);
  return crypto.timingSafeEqual(h, Buffer.from(rec.hash, 'hex'));
}

function setSessionCookie(req, res, token) {
  const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_DAYS * 24 * 60 * 60}${secure}`);
}

async function issueSession(req, res, key) {
  const token = crypto.randomBytes(32).toString('hex');
  await store.putSession(tokenHash(token), key, Date.now() + SESSION_DAYS * DAY_MS);
  setSessionCookie(req, res, token);
}

// 세션 쿠키 → 로그인된 사용자 레코드. 없으면 null
// res를 주면 사용 중인 세션을 자동 연장한다 (하루 한 번 꼴) —
// 계속 쓰는 기기는 다시 로그인할 일이 없다
async function requireUser(req, res) {
  const t = parseCookies(req).session;
  if (!t) return null;
  const th = tokenHash(t);
  const s = await store.getSession(th);
  if (!s) return null;
  const rec = await store.getUser(s.user);
  if (!rec) {
    await store.deleteSession(th);
    return null;
  }
  if (res && s.expiresAt - Date.now() < (SESSION_DAYS - 1) * DAY_MS) {
    await store.putSession(th, s.user, Date.now() + SESSION_DAYS * DAY_MS);
    setSessionCookie(req, res, t);
  }
  rec.ledger = normalizeLedger(rec.ledger);
  if (!rec.status) rec.status = 'approved'; // 승인제 도입 전에 만들어진 계정
  rec.isAdmin = rec.isAdmin === true;
  return { key: s.user, rec };
}

/* ─────────────── 관리자 (계정 관리) ─────────────── */
async function handleAdmin(req, res, p, m, admin) {
  if (p === '/api/admin/users' && m === 'GET') {
    const users = await store.listUsers();
    const list = users
      .map((r) => ({
        username: r.username,
        createdAt: r.createdAt || '',
        status: r.status || 'approved',
        isAdmin: r.isAdmin === true,
      }))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return sendJson(res, 200, list);
  }

  let r = p.match(/^\/api\/admin\/users\/([^/]+)\/(approve|reject)$/);
  if (r && m === 'POST') {
    const key = decodeURIComponent(r[1]).toLowerCase();
    if (key === admin.key) return sendJson(res, 400, { error: '자기 계정의 상태는 바꿀 수 없습니다.' });
    const rec = await store.getUser(key);
    if (!rec) return sendJson(res, 404, { error: '계정을 찾을 수 없습니다.' });
    rec.status = r[2] === 'approve' ? 'approved' : 'rejected';
    await store.saveUser(key, rec);
    if (rec.status === 'rejected') await store.deleteUserSessions(key);
    return sendJson(res, 200, { ok: true, status: rec.status });
  }

  r = p.match(/^\/api\/admin\/users\/([^/]+)$/);
  if (r && m === 'DELETE') {
    const key = decodeURIComponent(r[1]).toLowerCase();
    if (key === admin.key) return sendJson(res, 400, { error: '자기 계정은 삭제할 수 없습니다.' });
    const rec = await store.getUser(key);
    if (!rec) return sendJson(res, 404, { error: '계정을 찾을 수 없습니다.' });
    await store.deleteUser(key);
    await store.deleteUserSessions(key);
    return sendJson(res, 200, { ok: true });
  }

  return sendJson(res, 404, { error: '알 수 없는 API 경로입니다.' });
}

async function handleAuth(req, res, p, m) {
  if (p === '/api/auth/status' && m === 'GET') {
    const u = await requireUser(req, res);
    return sendJson(res, 200, {
      authed: !!u,
      username: u ? u.rec.username : null,
      status: u ? u.rec.status : null,
      isAdmin: u ? u.rec.isAdmin : false,
    });
  }

  if (p === '/api/auth/signup' && m === 'POST') {
    const b = await readBody(req);
    const username = str(b.username);
    const key = username.toLowerCase();
    if (!USERNAME_RE.test(username)) {
      return sendJson(res, 400, { error: '아이디는 2~20자의 한글·영문·숫자(일부 기호 . _ -)로 만드세요.' });
    }
    const pw = String(b.password || '');
    if (pw.length < 4) return sendJson(res, 400, { error: '비밀번호는 4자 이상으로 정하세요.' });
    if (await store.getUser(key)) return sendJson(res, 409, { error: '이미 사용 중인 아이디입니다.' });

    // 첫 가입자는 관리자(자동 승인)가 되고, 예전 단일 사용자 시절 데이터가 있으면 물려받는다.
    // 이후 가입자는 관리자 승인 대기 상태로 시작한다.
    const isFirst = (await store.countUsers()) === 0;
    let myLedger = emptyLedger();
    if (isFirst) {
      const legacy = await store.takeLegacyLedger();
      if (legacy) myLedger = normalizeLedger(legacy);
    }
    const salt = crypto.randomBytes(16).toString('hex');
    const rec = {
      username,
      salt,
      hash: hashPassword(pw, salt),
      createdAt: new Date().toISOString(),
      status: isFirst ? 'approved' : 'pending',
      isAdmin: isFirst,
      ledger: myLedger,
    };
    const created = await store.createUser(key, rec);
    if (!created) return sendJson(res, 409, { error: '이미 사용 중인 아이디입니다.' });
    await issueSession(req, res, key);
    return sendJson(res, 201, { ok: true, username, status: rec.status });
  }

  if (p === '/api/auth/login' && m === 'POST') {
    const b = await readBody(req);
    const username = str(b.username);
    const key = username.toLowerCase();
    const failKey = clientIp(req) + '|' + key;
    const fail = loginFails.get(failKey);
    if (fail && fail.until > Date.now()) {
      return sendJson(res, 429, { error: '로그인 시도가 너무 많습니다. 10분 뒤 다시 시도하세요.' });
    }
    const rec = key ? await store.getUser(key) : null;
    if (!rec || !verifyPassword(rec, String(b.password || ''))) {
      const f = fail || { count: 0, until: 0 };
      f.count++;
      if (f.count >= 8) {
        f.until = Date.now() + 10 * 60 * 1000;
        f.count = 0;
      }
      loginFails.set(failKey, f);
      return sendJson(res, 401, { error: '아이디 또는 비밀번호가 올바르지 않습니다.' });
    }
    loginFails.delete(failKey);
    await issueSession(req, res, key);
    return sendJson(res, 200, { ok: true, username: rec.username });
  }

  if (p === '/api/auth/logout' && m === 'POST') {
    const t = parseCookies(req).session;
    if (t) await store.deleteSession(tokenHash(t));
    res.setHeader('Set-Cookie', 'session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
    return sendJson(res, 200, { ok: true });
  }

  if (p === '/api/auth/password' && m === 'POST') {
    const u = await requireUser(req, res);
    if (!u) return sendJson(res, 401, { error: '로그인이 필요합니다.' });
    const b = await readBody(req);
    if (!verifyPassword(u.rec, String(b.current || ''))) return sendJson(res, 400, { error: '현재 비밀번호가 올바르지 않습니다.' });
    const pw = String(b.next || '');
    if (pw.length < 4) return sendJson(res, 400, { error: '새 비밀번호는 4자 이상으로 정하세요.' });
    const salt = crypto.randomBytes(16).toString('hex');
    u.rec.salt = salt;
    u.rec.hash = hashPassword(pw, salt);
    await store.saveUser(u.key, u.rec);
    await store.deleteUserSessions(u.key); // 다른 기기는 모두 로그아웃됨
    await issueSession(req, res, u.key);
    return sendJson(res, 200, { ok: true });
  }

  return sendJson(res, 404, { error: '알 수 없는 API 경로입니다.' });
}

/* ─────────────── HTTP 유틸 ─────────────── */
function sendJson(res, code, obj) {
  const buf = Buffer.from(JSON.stringify(obj));
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': buf.length,
    'Cache-Control': 'no-store', // API 응답은 어디서도 캐시하지 않는다
  });
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

  // ── 버전 정보 (로그인 불필요 — 화면 하단 버전 표시용) ──
  if (p === '/api/version' && m === 'GET') {
    const commit = String(process.env.VERCEL_GIT_COMMIT_SHA || '').slice(0, 7) || 'local';
    return sendJson(res, 200, { version: pkg.version, commit });
  }

  // ── 인증 (로그인 없이 접근 가능한 유일한 API) ──
  if (p.startsWith('/api/auth/')) return handleAuth(req, res, p, m);

  const u = await requireUser(req, res);
  if (!u) return sendJson(res, 401, { error: '로그인이 필요합니다.' });

  // ── 관리자 API ──
  if (p.startsWith('/api/admin/')) {
    if (!u.rec.isAdmin) return sendJson(res, 403, { error: '관리자만 사용할 수 있습니다.' });
    return handleAdmin(req, res, p, m, u);
  }

  // ── 승인 전 계정은 장부 기능을 쓸 수 없다 ──
  if (u.rec.status !== 'approved') {
    return sendJson(res, 403, {
      error: u.rec.status === 'rejected' ? '가입이 거절된 계정입니다.' : '관리자 승인 대기 중인 계정입니다.',
      status: u.rec.status,
    });
  }

  userKey = u.key;
  userRec = u.rec;
  ledger = u.rec.ledger;

  // ── 백업 다운로드 (내 계정의 장부만) ──
  if (p === '/api/backup' && m === 'GET') {
    const copy = Object.assign({ username: userRec.username }, ledger);
    const buf = Buffer.from(JSON.stringify(copy, null, 2));
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="ledger-backup-${new Date().toISOString().slice(0, 10)}.json"`,
      'Content-Length': buf.length,
    });
    return res.end(buf);
  }

  // ── 백업 복원 (내 장부 전체 교체, 계정/비밀번호는 유지) ──
  if (p === '/api/restore' && m === 'POST') {
    const b = await readBody(req);
    if (!b || typeof b !== 'object' || !Array.isArray(b.companies) || !Array.isArray(b.products) || !Array.isArray(b.transactions)) {
      // payments는 예전 백업에 없을 수 있으므로 필수로 보지 않는다 (normalizeLedger가 채운다)
      return sendJson(res, 400, { error: '올바른 백업 파일이 아닙니다.' });
    }
    userRec.ledger = normalizeLedger(b);
    ledger = userRec.ledger;
    await saveLedger();
    return sendJson(res, 200, { ok: true });
  }

  // ── 내 사업자 정보 ──
  if (p === '/api/settings' && m === 'GET') return sendJson(res, 200, ledger.settings);
  if (p === '/api/settings' && m === 'PUT') {
    const b = await readBody(req);
    ledger.settings = { name: str(b.name), owner: str(b.owner), bizNo: str(b.bizNo), phone: str(b.phone), address: str(b.address) };
    await saveLedger();
    return sendJson(res, 200, ledger.settings);
  }

  // ── 상호관리 ──
  if (p === '/api/companies' && m === 'GET') {
    const list = ledger.companies
      .map((c) => {
        const txs = ledger.transactions.filter((t) => t.companyId === c.id);
        const sales = txs.filter((t) => t.kind !== 'purchase');
        const buys = txs.filter((t) => t.kind === 'purchase');
        const total = sales.reduce((s, t) => s + t.total, 0);
        const paid = sales.reduce((s, t) => s + t.paid, 0);
        const received = ledger.payments
          .filter((pay) => pay.companyId === c.id)
          .reduce((s, pay) => s + pay.amount, 0);
        const buyTotal = buys.reduce((s, t) => s + t.total, 0);
        const buyPaid = buys.reduce((s, t) => s + t.paid, 0);
        return Object.assign({}, c, {
          txCount: txs.length,
          total,                                   // 매출 합계
          received: paid + received,               // 받은 돈
          outstanding: total - paid - received,    // 미수금 (매출 기준)
          buyTotal,                                // 매입(지출) 합계
          buyPaid,                                 // 그중 치른 돈
          payable: buyTotal - buyPaid,             // 미지급 (매입 기준)
        });
      })
      .sort((a, b) => a.name.localeCompare(b.name, 'ko'));
    return sendJson(res, 200, list);
  }
  if (p === '/api/companies' && m === 'POST') {
    const b = await readBody(req);
    if (!str(b.name)) return sendJson(res, 400, { error: '상호명을 입력하세요.' });
    const c = { id: nextId(), name: str(b.name), owner: str(b.owner), bizNo: str(b.bizNo), phone: str(b.phone), address: str(b.address), memo: str(b.memo) };
    ledger.companies.push(c);
    await saveLedger();
    return sendJson(res, 201, c);
  }
  let id = match(/^\/api\/companies\/(\d+)$/);
  if (id != null) {
    const c = ledger.companies.find((x) => x.id === id);
    if (!c) return sendJson(res, 404, { error: '상호를 찾을 수 없습니다.' });
    if (m === 'PUT') {
      const b = await readBody(req);
      if (!str(b.name)) return sendJson(res, 400, { error: '상호명을 입력하세요.' });
      Object.assign(c, { name: str(b.name), owner: str(b.owner), bizNo: str(b.bizNo), phone: str(b.phone), address: str(b.address), memo: str(b.memo) });
      await saveLedger();
      return sendJson(res, 200, c);
    }
    if (m === 'DELETE') {
      ledger.companies = ledger.companies.filter((x) => x.id !== id);
      ledger.products = ledger.products.filter((x) => x.companyId !== id);
      ledger.transactions = ledger.transactions.filter((x) => x.companyId !== id);
      await saveLedger();
      return sendJson(res, 200, { ok: true });
    }
  }

  // ── 제품관리 ──
  if (p === '/api/products' && m === 'GET') {
    const companyId = num(url.searchParams.get('companyId'));
    const list = ledger.products
      .filter((x) => !companyId || x.companyId === companyId)
      .sort((a, b) => a.name.localeCompare(b.name, 'ko'));
    return sendJson(res, 200, list);
  }
  if (p === '/api/products' && m === 'POST') {
    const b = await readBody(req);
    const companyId = num(b.companyId);
    if (!ledger.companies.some((c) => c.id === companyId)) return sendJson(res, 400, { error: '상호를 선택하세요.' });
    if (!str(b.name)) return sendJson(res, 400, { error: '품명을 입력하세요.' });
    const prod = {
      id: nextId(), companyId, name: str(b.name), spec: str(b.spec), unit: str(b.unit),
      price: num(b.price), memo: str(b.memo),
      priceDate: todayStr(), priceTxId: 0, // 손으로 정한 단가는 오늘 기준
    };
    ledger.products.push(prod);
    await saveLedger();
    return sendJson(res, 201, prod);
  }
  id = match(/^\/api\/products\/(\d+)$/);
  if (id != null) {
    const prod = ledger.products.find((x) => x.id === id);
    if (!prod) return sendJson(res, 404, { error: '제품을 찾을 수 없습니다.' });
    if (m === 'PUT') {
      const b = await readBody(req);
      if (!str(b.name)) return sendJson(res, 400, { error: '품명을 입력하세요.' });
      const priceChanged = num(b.price) !== prod.price;
      Object.assign(prod, { name: str(b.name), spec: str(b.spec), unit: str(b.unit), price: num(b.price), memo: str(b.memo) });
      if (priceChanged) { // 손으로 고친 단가는 오늘 기준 — 지난 날짜 거래에 덮이지 않는다
        prod.priceDate = todayStr();
        prod.priceTxId = 0;
      }
      await saveLedger();
      return sendJson(res, 200, prod);
    }
    if (m === 'DELETE') {
      ledger.products = ledger.products.filter((x) => x.id !== id);
      await saveLedger();
      return sendJson(res, 200, { ok: true });
    }
  }

  // ── 수금(입금) 관리 ──
  if (p === '/api/payments' && m === 'GET') {
    const companyId = num(url.searchParams.get('companyId'));
    const names = new Map(ledger.companies.map((c) => [c.id, c.name]));
    const list = ledger.payments
      .filter((x) => !companyId || x.companyId === companyId)
      .sort((a, b) => b.date.localeCompare(a.date) || b.id - a.id)
      .map((x) => Object.assign({}, x, { companyName: names.get(x.companyId) || '(삭제된 상호)' }));
    return sendJson(res, 200, list);
  }
  if (p === '/api/payments' && m === 'POST') {
    const b = await readBody(req);
    const r = buildPayment(b, nextId());
    if (r.error) return sendJson(res, 400, { error: r.error });
    ledger.payments.push(r.pay);
    await saveLedger();
    return sendJson(res, 201, r.pay);
  }
  id = match(/^\/api\/payments\/(\d+)$/);
  if (id != null) {
    const idx = ledger.payments.findIndex((x) => x.id === id);
    if (idx < 0) return sendJson(res, 404, { error: '입금 내역을 찾을 수 없습니다.' });
    if (m === 'PUT') {
      const b = await readBody(req);
      const r = buildPayment(b, id);
      if (r.error) return sendJson(res, 400, { error: r.error });
      ledger.payments[idx] = r.pay;
      await saveLedger();
      return sendJson(res, 200, r.pay);
    }
    if (m === 'DELETE') {
      ledger.payments.splice(idx, 1);
      await saveLedger();
      return sendJson(res, 200, { ok: true });
    }
  }

  // ── 거래관리 ──
  if (p === '/api/transactions' && m === 'GET') {
    const companyId = num(url.searchParams.get('companyId'));
    const names = new Map(ledger.companies.map((c) => [c.id, c.name]));
    const list = ledger.transactions
      .filter((t) => !companyId || t.companyId === companyId)
      .sort((a, b) => b.date.localeCompare(a.date) || b.id - a.id)
      .map((t) => Object.assign({}, t, { companyName: names.get(t.companyId) || '(삭제된 상호)' }));
    return sendJson(res, 200, list);
  }
  if (p === '/api/transactions' && m === 'POST') {
    const b = await readBody(req);
    const r = buildTransaction(b, nextId());
    if (r.error) return sendJson(res, 400, { error: r.error });
    ledger.transactions.push(r.tx);
    registerProductsFromItems(r.tx);
    await saveLedger();
    return sendJson(res, 201, r.tx);
  }
  id = match(/^\/api\/transactions\/(\d+)$/);
  if (id != null) {
    const idx = ledger.transactions.findIndex((x) => x.id === id);
    if (idx < 0) return sendJson(res, 404, { error: '거래를 찾을 수 없습니다.' });
    if (m === 'GET') return sendJson(res, 200, ledger.transactions[idx]);
    if (m === 'PUT') {
      const b = await readBody(req);
      const before = ledger.transactions[idx];
      const r = buildTransaction(b, id);
      if (r.error) return sendJson(res, 400, { error: r.error });
      ledger.transactions[idx] = r.tx;
      registerProductsFromItems(r.tx); // 새로 적은 품목은 제품으로 등록
      // 날짜·품목·단가가 바뀌었을 수 있으니 관련 제품 단가를 거래 날짜 기준으로 다시 계산
      recalcProductPrices(before.items, before.companyId);
      recalcProductPrices(r.tx.items, r.tx.companyId);
      await saveLedger();
      return sendJson(res, 200, r.tx);
    }
    if (m === 'DELETE') {
      const [gone] = ledger.transactions.splice(idx, 1);
      recalcProductPrices(gone.items, gone.companyId); // 지운 거래가 기준이었으면 다시 계산
      await saveLedger();
      return sendJson(res, 200, { ok: true });
    }
  }

  return sendJson(res, 404, { error: '알 수 없는 API 경로입니다.' });
}

async function handleApi(req, res, url) {
  return withLock(async () => {
    try {
      return await routeApi(req, res, url);
    } catch (e) {
      const msg = (e && e.message) || '서버 오류';
      const code = msg.includes('JSON') || msg.includes('큽니다') ? 400 : 500;
      return sendJson(res, code, { error: msg });
    }
  });
}

module.exports = { emptyLedger, normalizeLedger, setStore, handleApi, sendJson };
