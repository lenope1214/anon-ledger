'use strict';

/* ─────────────── 공통 유틸 ─────────────── */
const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => Array.from(el.querySelectorAll(sel));

const state = {
  tab: 'transactions',  // 기본 화면 = 장부(거래관리)
  me: null,             // { username, status, isAdmin }
  companies: [],
  settings: {},
  companySearch: '',
  productCompanyId: '', // 제품관리 탭에서 선택된 상호
  txCompanyId: '',      // 거래관리 탭 필터 ('' = 전체)
  productsCache: {},    // 자동완성용 상호별 제품 캐시
  entryVat: 'separate', // 빠른 입력 행의 부가세 방식
  entryDate: '',        // 빠른 입력 행에서 마지막으로 쓴 날짜
  entryCompanyId: '',   // 빠른 입력 행에서 마지막으로 쓴 상호
  txFrom: '',           // 거래 필터: 시작일
  txTo: '',             // 거래 필터: 종료일
  txProductQuery: '',   // 거래 필터: 품명 검색어
};
state.easyMode = false; // 큰 글씨 간편 입력 (휴대폰·어르신용)
try {
  const savedVat = localStorage.getItem('entryVat');
  if (savedVat && ['separate', 'included', 'none'].includes(savedVat)) state.entryVat = savedVat;
  state.easyMode = localStorage.getItem('easyMode') === '1';
} catch (e) { /* localStorage 사용 불가 환경 */ }

const VAT_LABEL = { separate: '부가세 별도', included: '부가세 포함', none: '부가세 없음' };

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const won = (n) => (Number(n) || 0).toLocaleString('ko-KR');

function today() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401 && !url.startsWith('/api/auth/')) {
    location.href = '/login.html';
    throw new Error('로그인이 필요합니다.');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || '요청에 실패했습니다.');
  return data;
}

let toastTimer = null;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 2200);
}

/* 서버와 동일한 부가세 계산 (미리보기용) */
function calcItem(qty, price, vatMode) {
  const amount = Math.round(qty * price);
  if (vatMode === 'included') {
    const supply = Math.round(amount / 1.1);
    return { supply, tax: amount - supply };
  }
  if (vatMode === 'separate') return { supply: amount, tax: Math.round(amount * 0.1) };
  return { supply: amount, tax: 0 };
}

/* ─────────────── 모달 ─────────────── */
function openModal(html, wide) {
  const box = $('#modalBox');
  box.className = 'modal-box' + (wide ? ' wide' : '');
  box.innerHTML = html;
  $('#modal').classList.remove('hidden');
  const first = box.querySelector('input, select');
  if (first) first.focus();
}
function closeModal() {
  $('#modal').classList.add('hidden');
  $('#modalBox').innerHTML = '';
}
$('#modal').addEventListener('click', (e) => {
  if (e.target.id === 'modal') closeModal();
});

/* ─────────────── 탭 ─────────────── */
$$('#tabs button').forEach((btn) => {
  btn.addEventListener('click', () => {
    state.tab = btn.dataset.tab;
    location.hash = btn.dataset.tab;
    $$('#tabs button').forEach((b) => b.classList.toggle('active', b === btn));
    render();
  });
});

async function refreshCompanies() {
  state.companies = await api('GET', '/api/companies');
}

function render() {
  if (state.tab === 'companies') renderCompanies();
  else if (state.tab === 'products') renderProducts();
  else if (state.tab === 'transactions') renderTransactions();
  else if (state.tab === 'ledger') renderCompanyLedger();
  else if (state.tab === 'reports') renderReports();
  else if (state.tab === 'admin') renderAdmin();
  else renderSettings();
}

function emptyNotice(msg, btnLabel, tab) {
  return `<div class="empty-notice"><p>${esc(msg)}</p>${btnLabel ? `<button class="primary" data-goto="${tab}">${esc(btnLabel)}</button>` : ''}</div>`;
}

function bindGoto(root) {
  $$('button[data-goto]', root).forEach((b) =>
    b.addEventListener('click', () => {
      const target = $(`#tabs button[data-tab="${b.dataset.goto}"]`);
      if (target) target.click();
    })
  );
}

/* ─────────────── 상호관리 ─────────────── */
async function renderCompanies() {
  await refreshCompanies();
  const main = $('#main');
  main.innerHTML = `
    <section class="card">
      <div class="section-head">
        <input id="companySearch" type="search" placeholder="상호명·대표자 검색" value="${esc(state.companySearch)}">
        <button class="primary" id="btnAddCompany">＋ 상호 등록</button>
      </div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>상호명</th><th>대표자</th><th>연락처</th><th class="num">거래횟수</th><th class="num">미수금</th><th class="actions"></th></tr></thead>
          <tbody id="companyRows"></tbody>
        </table>
      </div>
    </section>`;
  drawCompanyRows();
  $('#companySearch').addEventListener('input', (e) => {
    state.companySearch = e.target.value;
    drawCompanyRows();
  });
  $('#btnAddCompany').addEventListener('click', () => openCompanyForm(null));
}

function drawCompanyRows() {
  const q = state.companySearch.trim().toLowerCase();
  const list = state.companies.filter((c) => !q || c.name.toLowerCase().includes(q) || (c.owner || '').toLowerCase().includes(q));
  const tbody = $('#companyRows');
  if (!list.length) {
    tbody.innerHTML = `<tr><td colspan="6" class="empty-cell">${state.companies.length ? '검색 결과가 없습니다.' : '등록된 상호가 없습니다. [＋ 상호 등록] 버튼으로 시작하세요.'}</td></tr>`;
    return;
  }
  tbody.innerHTML = list
    .map(
      (c) => `<tr>
        <td><b>${esc(c.name)}</b>${c.memo ? `<div class="sub">${esc(c.memo)}</div>` : ''}</td>
        <td>${esc(c.owner)}</td>
        <td>${esc(c.phone)}</td>
        <td class="num">${won(c.txCount)}건</td>
        <td class="num ${c.outstanding > 0 ? 'warn' : c.outstanding < 0 ? 'neg' : ''}">${won(c.outstanding)}원</td>
        <td class="actions">
          <button data-act="ledger" data-id="${c.id}" class="primary">원장</button>
          <button data-act="tx" data-id="${c.id}">거래보기</button>
          <button data-act="edit" data-id="${c.id}">수정</button>
          <button data-act="del" data-id="${c.id}" class="danger">삭제</button>
        </td>
      </tr>`
    )
    .join('');
  tbody.onclick = async (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const id = Number(btn.dataset.id);
    const c = state.companies.find((x) => x.id === id);
    if (!c) return;
    if (btn.dataset.act === 'edit') openCompanyForm(c);
    else if (btn.dataset.act === 'ledger') openCompanyLedger(c.id);
    else if (btn.dataset.act === 'tx') {
      state.txCompanyId = String(id);
      $(`#tabs button[data-tab="transactions"]`).click();
    } else if (btn.dataset.act === 'del') {
      if (!confirm(`'${c.name}' 상호를 삭제할까요?\n이 상호에 등록된 제품과 거래 내역도 함께 삭제됩니다.`)) return;
      await api('DELETE', '/api/companies/' + id);
      toast('상호를 삭제했습니다.');
      renderCompanies();
    }
  };
}

function openCompanyForm(c) {
  openModal(`
    <h2>${c ? '상호 수정' : '상호 등록'}</h2>
    <form id="companyForm">
      <label>상호명 *<input name="name" required value="${esc(c && c.name)}" placeholder="예: 한빛전자"></label>
      <label>대표자<input name="owner" value="${esc(c && c.owner)}"></label>
      <label>사업자등록번호<input name="bizNo" value="${esc(c && c.bizNo)}" placeholder="000-00-00000"></label>
      <label>연락처<input name="phone" value="${esc(c && c.phone)}" inputmode="tel"></label>
      <label>주소<input name="address" value="${esc(c && c.address)}"></label>
      <label>메모<input name="memo" value="${esc(c && c.memo)}"></label>
      <div class="form-actions">
        <button type="button" data-close>취소</button>
        <button type="submit" class="primary">저장</button>
      </div>
    </form>`);
  $('[data-close]').addEventListener('click', closeModal);
  $('#companyForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = Object.fromEntries(new FormData(e.target));
    try {
      if (c) await api('PUT', '/api/companies/' + c.id, body);
      else await api('POST', '/api/companies', body);
      closeModal();
      toast('저장했습니다.');
      renderCompanies();
    } catch (err) {
      alert(err.message);
    }
  });
}

/* ─────────────── 거래처원장 ─────────────── */
// 한 상호의 거래·입금을 날짜순으로 늘어놓고 누적 잔액(미수금)을 보여준다.
const ledgerView = { companyId: null, from: '', to: '' };

function openCompanyLedger(companyId) {
  ledgerView.companyId = companyId;
  state.tab = 'ledger';
  $$('#tabs button').forEach((b) => b.classList.remove('active'));
  render();
}

async function renderCompanyLedger() {
  const c = state.companies.find((x) => x.id === ledgerView.companyId);
  if (!c) {
    state.tab = 'companies';
    return render();
  }
  const [txs, pays] = await Promise.all([
    api('GET', '/api/transactions?companyId=' + c.id),
    api('GET', '/api/payments?companyId=' + c.id),
  ]);

  const inRange = (d) => (!ledgerView.from || d >= ledgerView.from) && (!ledgerView.to || d <= ledgerView.to);
  const all = [
    ...txs.map((t) => ({ kind: 'tx', date: t.date, id: t.id, label: itemLabel(t), amount: t.total, paid: t.paid, tx: t })),
    ...pays.map((x) => ({ kind: 'pay', date: x.date, id: x.id, label: '💰 입금 ' + (PAY_METHOD_LABEL[x.method] || '') + (x.memo ? ' · ' + x.memo : ''), amount: 0, paid: x.amount })),
  ].sort((a, b) => a.date.localeCompare(b.date) || a.id - b.id);

  // 기간 시작 전까지의 잔액을 '이월'로 먼저 깐다
  const before = all.filter((r) => !inRange(r.date) && (!ledgerView.from || r.date < ledgerView.from));
  const carry = before.reduce((s, r) => s + r.amount - r.paid, 0);
  const rows = all.filter((r) => inRange(r.date));

  let bal = carry;
  const body = rows
    .map((r) => {
      bal += r.amount - r.paid;
      return `<tr class="${r.kind === 'pay' ? 'row-pay' : ''}">
        <td>${esc(r.date)}</td>
        <td>${esc(r.label)}</td>
        <td class="num ${r.amount < 0 ? 'neg' : ''}">${r.amount ? won(r.amount) : ''}</td>
        <td class="num">${r.paid ? won(r.paid) : ''}</td>
        <td class="num ${bal > 0 ? 'warn' : bal < 0 ? 'neg' : ''}"><b>${won(bal)}</b></td>
      </tr>`;
    })
    .join('');

  const sales = rows.reduce((s, r) => s + r.amount, 0);
  const received = rows.reduce((s, r) => s + r.paid, 0);

  $('#main').innerHTML = `
    <section class="card">
      <div class="section-head">
        <button id="btnLedgerBack">← 상호 목록</button>
        <input type="date" id="lgFrom" class="date-filter" value="${esc(ledgerView.from)}" title="시작일">
        <span class="range-sep">~</span>
        <input type="date" id="lgTo" class="date-filter" value="${esc(ledgerView.to)}" title="종료일">
        <button id="btnLgClear">전체 기간</button>
        <button id="btnLgPay" class="pay-btn">＋ 입금 받음</button>
        <button id="btnLgPrint" class="primary">🖨 원장 인쇄</button>
      </div>
      <div id="ledgerSheet">
        <div class="sheet">
          <h2 class="sheet-title">거 래 처 원 장</h2>
          <p class="sheet-date">${esc(c.name)}${c.owner ? ' (' + esc(c.owner) + ')' : ''} · 기간: ${esc(ledgerView.from || '처음')} ~ ${esc(ledgerView.to || '오늘')}</p>
          <table class="sheet-items ledger-doc">
            <thead><tr><th>날짜</th><th>내용</th><th class="num">매출</th><th class="num">입금</th><th class="num">잔액(미수)</th></tr></thead>
            <tbody>
              ${carry ? `<tr class="carry-row"><td>이월</td><td>이전 기간 미수금</td><td class="num"></td><td class="num"></td><td class="num"><b>${won(carry)}</b></td></tr>` : ''}
              ${body || `<tr><td colspan="5" class="empty-cell">이 기간에 거래·입금 내역이 없습니다.</td></tr>`}
            </tbody>
            <tfoot>
              <tr><th>합계</th><th></th><th class="num">${won(sales)}</th><th class="num">${won(received)}</th><th class="num"><b>${won(bal)}</b></th></tr>
            </tfoot>
          </table>
          <p class="sheet-memo">현재 미수금 <b>${won(bal)}원</b>${ledgerView.from || ledgerView.to ? ' (표시 기간 기준)' : ''}</p>
        </div>
      </div>
    </section>`;

  $('#btnLedgerBack').addEventListener('click', () => {
    const btn = $('#tabs button[data-tab="companies"]');
    if (btn) btn.click();
  });
  $('#lgFrom').addEventListener('change', (e) => {
    ledgerView.from = e.target.value;
    renderCompanyLedger();
  });
  $('#lgTo').addEventListener('change', (e) => {
    ledgerView.to = e.target.value;
    renderCompanyLedger();
  });
  $('#btnLgClear').addEventListener('click', () => {
    ledgerView.from = '';
    ledgerView.to = '';
    renderCompanyLedger();
  });
  $('#btnLgPay').addEventListener('click', () => {
    state.entryCompanyId = String(c.id);
    openPaymentForm(null);
  });
  $('#btnLgPrint').addEventListener('click', () => {
    $('#printSheet').innerHTML = $('#ledgerSheet').innerHTML;
    statementCtx = null;
    $('#btnShareSheet').classList.add('hidden');
    document.body.classList.add('printing');
    $('#printOverlay').classList.remove('hidden');
  });
}

function itemLabel(t) {
  const it = t.items[0];
  return it.name + (t.items.length > 1 ? ` 외 ${t.items.length - 1}건` : '') + (it.spec ? ` (${it.spec})` : '');
}

/* ─────────────── 집계 (월별·거래처별·품목별) ─────────────── */
const reportView = { mode: 'month', year: '' };

async function renderReports() {
  await refreshCompanies();
  const [txs, pays] = await Promise.all([api('GET', '/api/transactions'), api('GET', '/api/payments')]);
  const years = [...new Set([...txs.map((t) => t.date.slice(0, 4)), ...pays.map((p) => p.date.slice(0, 4))])].sort().reverse();
  if (!reportView.year || !years.includes(reportView.year)) reportView.year = years[0] || String(new Date().getFullYear());
  const y = reportView.year;

  const MODES = { month: '월별 현황', company: '거래처별', product: '품목별' };
  let table = '';

  if (reportView.mode === 'month') {
    // 1~12월 매출·입금·잔액
    const rows = [];
    let cumulative = 0;
    for (let m = 1; m <= 12; m++) {
      const key = `${y}-${String(m).padStart(2, '0')}`;
      const sales = txs.filter((t) => t.date.startsWith(key)).reduce((s, t) => s + t.total, 0);
      const received =
        txs.filter((t) => t.date.startsWith(key)).reduce((s, t) => s + t.paid, 0) +
        pays.filter((p) => p.date.startsWith(key)).reduce((s, p) => s + p.amount, 0);
      const count = txs.filter((t) => t.date.startsWith(key)).length;
      if (!sales && !received && !count) continue;
      cumulative += sales - received;
      rows.push({ label: `${m}월`, count, sales, received, balance: cumulative });
    }
    table = reportTable(['월', '건수', '매출', '받은 돈', '누적 미수'], rows, true);
  } else if (reportView.mode === 'company') {
    const rows = state.companies
      .map((c) => {
        const ts = txs.filter((t) => t.companyId === c.id && t.date.startsWith(y));
        const sales = ts.reduce((s, t) => s + t.total, 0);
        const received =
          ts.reduce((s, t) => s + t.paid, 0) +
          pays.filter((p) => p.companyId === c.id && p.date.startsWith(y)).reduce((s, p) => s + p.amount, 0);
        return { label: c.name, count: ts.length, sales, received, balance: c.outstanding };
      })
      .filter((r) => r.count || r.sales || r.received || r.balance)
      .sort((a, b) => b.sales - a.sales);
    table = reportTable(['상호', '건수', '매출', '받은 돈', '현재 미수'], rows);
  } else {
    const map = new Map();
    txs
      .filter((t) => t.date.startsWith(y))
      .forEach((t) =>
        t.items.forEach((it) => {
          const cur = map.get(it.name) || { label: it.name, count: 0, qty: 0, sales: 0 };
          cur.count += 1;
          cur.qty += it.qty;
          cur.sales += it.supply + it.tax;
          map.set(it.name, cur);
        })
      );
    const rows = [...map.values()].sort((a, b) => b.sales - a.sales);
    table = reportTable(['품명', '건수', '수량', '매출'], rows, false, true);
  }

  $('#main').innerHTML = `
    <section class="card">
      <div class="section-head">
        <select id="rpYear">${years.map((v) => `<option ${v === y ? 'selected' : ''}>${v}</option>`).join('')}</select>
        <div class="auth-tabs report-tabs">
          ${Object.entries(MODES).map(([k, l]) => `<button type="button" data-mode="${k}" class="${k === reportView.mode ? 'active' : ''}">${l}</button>`).join('')}
        </div>
        <button id="btnCsv">📄 엑셀(CSV) 내려받기</button>
      </div>
      <div class="table-wrap">${table}</div>
      <p class="hint">${y}년 기준입니다. 표를 그대로 엑셀로 받아 세무사에게 전달할 수 있습니다.</p>
    </section>`;

  $('#rpYear').addEventListener('change', (e) => {
    reportView.year = e.target.value;
    renderReports();
  });
  $$('.report-tabs button').forEach((b) =>
    b.addEventListener('click', () => {
      reportView.mode = b.dataset.mode;
      renderReports();
    })
  );
  $('#btnCsv').addEventListener('click', () => downloadTableCsv(`${y}_${reportView.mode}`));
}

function reportTable(heads, rows, cumulative, isProduct) {
  if (!rows.length) return '<p class="empty-cell">이 해에 기록된 내역이 없습니다.</p>';
  const sum = rows.reduce(
    (a, r) => ({ count: a.count + r.count, qty: a.qty + (r.qty || 0), sales: a.sales + r.sales, received: a.received + (r.received || 0) }),
    { count: 0, qty: 0, sales: 0, received: 0 }
  );
  return `<table id="reportTable">
    <thead><tr>${heads.map((h, i) => `<th class="${i ? 'num' : ''}">${h}</th>`).join('')}</tr></thead>
    <tbody>
      ${rows
        .map(
          (r) => `<tr>
            <td><b>${esc(r.label)}</b></td>
            <td class="num">${won(r.count)}</td>
            ${isProduct ? `<td class="num">${won(r.qty)}</td>` : ''}
            <td class="num ${r.sales < 0 ? 'neg' : ''}">${won(r.sales)}</td>
            ${isProduct ? '' : `<td class="num">${won(r.received)}</td>`}
            ${isProduct ? '' : `<td class="num ${r.balance > 0 ? 'warn' : r.balance < 0 ? 'neg' : ''}"><b>${won(r.balance)}</b></td>`}
          </tr>`
        )
        .join('')}
    </tbody>
    <tfoot><tr>
      <th>합계</th><th class="num">${won(sum.count)}</th>
      ${isProduct ? `<th class="num">${won(sum.qty)}</th>` : ''}
      <th class="num">${won(sum.sales)}</th>
      ${isProduct ? '' : `<th class="num">${won(sum.received)}</th>`}
      ${isProduct ? '' : `<th class="num">${cumulative ? '' : won(rows.reduce((a, r) => a + r.balance, 0))}</th>`}
    </tr></tfoot>
  </table>`;
}

// 화면의 표를 그대로 CSV로 저장 (엑셀에서 바로 열림)
function downloadTableCsv(name) {
  const table = $('#reportTable');
  if (!table) return toast('내려받을 내용이 없습니다.');
  const lines = [...table.querySelectorAll('tr')].map((tr) =>
    [...tr.children]
      .map((td) => {
        const v = td.textContent.trim().replace(/,/g, '');
        return /["\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
      })
      .join(',')
  );
  const blob = new Blob(['\uFEFF' + lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
  downloadBlob(blob, `거래장부_${name}.csv`);
  toast('엑셀 파일을 내려받았습니다.');
}

function downloadBlob(blob, filename) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a); // 일부 브라우저는 문서에 붙어 있어야 동작한다
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// 거래·입금 내역을 그대로 엑셀(CSV)로 내려받는다 (지금 걸린 검색 조건 기준)
function exportTransactionsCsv() {
  const inRange = (d) => (!state.txFrom || d >= state.txFrom) && (!state.txTo || d <= state.txTo);
  const q = state.txProductQuery.trim().toLowerCase();
  const txRows = txCache
    .filter((t) => inRange(t.date))
    .filter((t) => !q || t.items.some((it) => it.name.toLowerCase().includes(q)))
    .flatMap((t) =>
      t.items.map((it) => [t.date, t.companyName, '거래', it.name, it.spec, it.qty, it.price, it.supply, it.tax, it.supply + it.tax, '', t.memo])
    );
  const payRows = (q ? [] : payCache.filter((x) => inRange(x.date))).map((x) => [
    x.date, x.companyName, '입금', PAY_METHOD_LABEL[x.method] || '', '', '', '', '', '', '', x.amount, x.memo,
  ]);
  const rows = [...txRows, ...payRows].sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  if (!rows.length) return toast('내려받을 내역이 없습니다.');
  const head = ['날짜', '상호', '구분', '품명', '규격', '수량', '단가', '공급가액', '세액', '합계', '입금', '메모'];
  const csv = [head, ...rows]
    .map((r) => r.map((v) => {
      const t = String(v == null ? '' : v);
      return /[",\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t;
    }).join(','))
    .join('\n');
  downloadBlob(new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' }), `거래장부_거래내역_${today()}.csv`);
  toast(`${rows.length}줄을 엑셀 파일로 내려받았습니다.`);
}

/* ─────────────── 제품관리 ─────────────── */
async function renderProducts() {
  await refreshCompanies();
  const main = $('#main');
  if (!state.companies.length) {
    main.innerHTML = `<section class="card">${emptyNotice('제품을 등록하려면 먼저 상호를 등록해야 합니다.', '상호관리로 이동', 'companies')}</section>`;
    bindGoto(main);
    return;
  }
  if (!state.productCompanyId || !state.companies.some((c) => c.id === Number(state.productCompanyId))) {
    state.productCompanyId = String(state.companies[0].id);
  }
  main.innerHTML = `
    <section class="card">
      <div class="section-head">
        <select id="productCompany">${state.companies.map((c) => `<option value="${c.id}" ${String(c.id) === state.productCompanyId ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select>
        <button class="primary" id="btnAddProduct">＋ 제품 등록</button>
      </div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>품명</th><th>규격</th><th>단위</th><th class="num">단가</th><th>메모</th><th class="actions"></th></tr></thead>
          <tbody id="productRows"></tbody>
        </table>
      </div>
    </section>`;
  $('#productCompany').addEventListener('change', (e) => {
    state.productCompanyId = e.target.value;
    drawProductRows();
  });
  $('#btnAddProduct').addEventListener('click', () => openProductForm(null));
  drawProductRows();
}

async function drawProductRows() {
  const list = await api('GET', '/api/products?companyId=' + state.productCompanyId);
  const tbody = $('#productRows');
  if (!tbody) return;
  if (!list.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="empty-cell">이 상호에 등록된 제품이 없습니다.</td></tr>';
    return;
  }
  tbody.innerHTML = list
    .map(
      (p) => `<tr>
        <td><b>${esc(p.name)}</b></td>
        <td>${esc(p.spec)}</td>
        <td>${esc(p.unit)}</td>
        <td class="num">${won(p.price)}원</td>
        <td>${esc(p.memo)}</td>
        <td class="actions">
          <button data-act="edit" data-id="${p.id}">수정</button>
          <button data-act="del" data-id="${p.id}" class="danger">삭제</button>
        </td>
      </tr>`
    )
    .join('');
  tbody.onclick = async (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const id = Number(btn.dataset.id);
    const p = list.find((x) => x.id === id);
    if (!p) return;
    if (btn.dataset.act === 'edit') openProductForm(p);
    else if (btn.dataset.act === 'del') {
      if (!confirm(`'${p.name}' 제품을 삭제할까요?`)) return;
      await api('DELETE', '/api/products/' + id);
      clearProductsCache();
      toast('제품을 삭제했습니다.');
      drawProductRows();
    }
  };
}

function openProductForm(p) {
  openModal(`
    <h2>${p ? '제품 수정' : '제품 등록'}</h2>
    <form id="productForm">
      <label>품명 *<input name="name" required value="${esc(p && p.name)}"></label>
      <label>규격<input name="spec" value="${esc(p && p.spec)}"></label>
      <label>단위<input name="unit" value="${esc(p && p.unit)}" placeholder="개, EA, 박스 …"></label>
      <label>단가<input name="price" type="number" inputmode="numeric" min="0" value="${p ? p.price : 0}"></label>
      <label>메모<input name="memo" value="${esc(p && p.memo)}"></label>
      <div class="form-actions">
        <button type="button" data-close>취소</button>
        <button type="submit" class="primary">저장</button>
      </div>
    </form>`);
  $('[data-close]').addEventListener('click', closeModal);
  $('#productForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = Object.fromEntries(new FormData(e.target));
    body.companyId = Number(state.productCompanyId);
    try {
      if (p) await api('PUT', '/api/products/' + p.id, body);
      else await api('POST', '/api/products', body);
      clearProductsCache();
      closeModal();
      toast('저장했습니다.');
      drawProductRows();
    } catch (err) {
      alert(err.message);
    }
  });
}

/* ─────────────── 제품 자동완성 ─────────────── */
async function getProducts(companyId) {
  if (!state.productsCache[companyId]) {
    state.productsCache[companyId] = await api('GET', '/api/products?companyId=' + companyId);
  }
  return state.productsCache[companyId];
}
function clearProductsCache() {
  state.productsCache = {};
}

// 입력칸에 검색 힌트 드롭다운을 붙인다 (품명·상호 공용).
// 힌트 상자는 표의 스크롤 영역에 잘리지 않도록 body에 fixed로 띄운다.
// opts: { getItems(질의어)→항목배열, itemHtml(항목)→HTML, onPick(항목),
//         minChars(기본 1, 0이면 포커스만 해도 전체 목록 표시),
//         enterPicksFirst(기본 false, true면 Enter로 첫 힌트 선택) }
function attachSearchDropdown(input, opts) {
  const minChars = opts.minChars == null ? 1 : opts.minChars;
  let box = null;
  let items = [];
  let sel = -1;

  function close() {
    if (box) box.remove();
    box = null;
    items = [];
    sel = -1;
  }
  function position() {
    const r = input.getBoundingClientRect();
    box.style.left = r.left + 'px';
    box.style.minWidth = Math.max(250, r.width) + 'px';
    const spaceBelow = window.innerHeight - r.bottom;
    if (spaceBelow < 260 && r.top > 260) {
      box.style.top = 'auto';
      box.style.bottom = window.innerHeight - r.top + 2 + 'px';
    } else {
      box.style.bottom = 'auto';
      box.style.top = r.bottom + 2 + 'px';
    }
  }
  function renderBox() {
    if (!box) {
      box = document.createElement('div');
      box.className = 'ac-box';
      document.body.appendChild(box);
    }
    position();
    box.innerHTML = items
      .map((it, i) => `<div class="ac-item ${i === sel ? 'sel' : ''}" data-i="${i}">${opts.itemHtml(it)}</div>`)
      .join('');
    box.querySelectorAll('.ac-item').forEach((el) => {
      el.addEventListener('mousedown', (e) => {
        e.preventDefault();
        pick(Number(el.dataset.i));
      });
    });
  }
  function pick(i) {
    const it = items[i];
    close();
    if (it) opts.onPick(it);
  }
  async function update() {
    const q = input.value.trim().toLowerCase();
    if (q.length < minChars) return close();
    let list = [];
    try {
      list = await opts.getItems(q);
    } catch (e) {
      return close();
    }
    items = list.slice(0, 8);
    sel = -1;
    if (!items.length) return close();
    renderBox();
  }

  input.addEventListener('input', update);
  if (minChars === 0) input.addEventListener('focus', update);
  input.addEventListener('keydown', (e) => {
    if (!box) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      sel = (sel + 1) % items.length;
      renderBox();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      sel = (sel - 1 + items.length) % items.length;
      renderBox();
    } else if (e.key === 'Enter') {
      if (sel >= 0 || opts.enterPicksFirst) {
        e.preventDefault();
        e.stopPropagation();
        pick(sel >= 0 ? sel : 0);
      } else {
        close(); // 힌트를 고르지 않았으면 입력한 그대로 저장 진행
      }
    } else if (e.key === 'Escape') {
      e.stopPropagation(); // 힌트만 닫고 검색 시트는 열리지 않게
      close();
    }
  });
  input.addEventListener('blur', () => setTimeout(close, 150));
  window.addEventListener('scroll', close, { capture: true, passive: true });
}

// 품명 자동완성: 해당 상호의 제품에서 검색
function attachProductAutocomplete(input, getCompanyId, onPick) {
  attachSearchDropdown(input, {
    getItems: async (q) => {
      const cid = Number(getCompanyId());
      if (!cid) return [];
      return (await getProducts(cid)).filter((p) => p.name.toLowerCase().includes(q));
    },
    itemHtml: (p) => `<b>${esc(p.name)}</b>${p.spec ? `<span class="sub">${esc(p.spec)}</span>` : ''}<span class="ac-price">${won(p.price)}원</span>`,
    onPick,
  });
}

/* ─────────────── 거래관리 (장부 시트) ─────────────── */
let txCache = [];
let payCache = [];
let checkedTxIds = new Set(); // 체크된 줄 (새로고침 전까지 유지, 't123'/'p45' 형태)

const PAY_METHOD_LABEL = { cash: '현금', transfer: '계좌이체', card: '카드', note: '어음', etc: '기타' };
const rowKey = (tr) => (tr.dataset.kind === 'pay' ? 'p' : 't') + tr.dataset.id;
let sheetLastIdx = null;      // 마지막으로 체크한 행 위치 ('=' 연속 체크용)

function setEasyMode(on) {
  state.easyMode = on;
  try {
    localStorage.setItem('easyMode', on ? '1' : '0');
  } catch (e) { /* 무시 */ }
  document.body.classList.toggle('easy', on);
  renderTransactions();
}

async function renderTransactions() {
  document.body.classList.toggle('easy', state.easyMode);
  if (state.easyMode) return renderTransactionsEasy();
  await refreshCompanies();
  const main = $('#main');
  main.innerHTML = `
    <section class="card">
      <div class="section-head">
        <select id="txCompany">
          <option value="">전체 상호</option>
          ${state.companies.map((c) => `<option value="${c.id}" ${String(c.id) === state.txCompanyId ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}
        </select>
        <input type="date" id="fFrom" class="date-filter" value="${esc(state.txFrom)}" title="시작일">
        <span class="range-sep">~</span>
        <input type="date" id="fTo" class="date-filter" value="${esc(state.txTo)}" title="종료일">
        <input type="search" id="fProduct" placeholder="품명 검색" value="${esc(state.txProductQuery)}">
        <button id="btnClearFilter" title="검색 조건 초기화">초기화</button>
        <select id="entryVat" class="vat-select" title="빠른 입력 부가세 방식">
          ${Object.entries(VAT_LABEL).map(([v, l]) => `<option value="${v}" ${v === state.entryVat ? 'selected' : ''}>${l}</option>`).join('')}
        </select>
        <button id="btnAddPay" class="pay-btn">＋ 입금 받음</button>
        <button id="btnAddTx">＋ 여러 품목 거래</button>
        <button id="btnEasyOn" title="글씨를 크게 해서 하나씩 입력합니다">🔎 큰 글씨</button>
        <button type="button" id="btnPin" class="pin-btn">📌<span id="pinLabel" class="pin-label">커서 고정</span></button>
        <button type="button" id="btnTxCsv">📄 엑셀</button>
      </div>
      <p class="summary"><span id="txSummary"></span><span id="selSummary" class="sel-summary"></span></p>
      <div class="table-wrap ledger-wrap">
        <table class="ledger-table">
          <thead><tr><th class="chk"></th><th>날짜</th><th>상호</th><th>품명</th><th>규격</th><th class="num">수량</th><th class="num">단가</th><th class="num">공급가액</th><th class="num">합계</th><th class="num">세액</th><th class="num">입금</th><th class="num">잔액</th><th class="actions"></th></tr></thead>
          <tbody id="txRows"></tbody>
          <tbody>
            <tr class="entry-row">
              <td class="chk"></td>
              <td><input type="date" id="eDate" value="${esc(state.entryDate || today())}"></td>
              <td><input id="eCompany" placeholder="상호 입력·검색" autocomplete="off"></td>
              <td><input id="eName" placeholder="품명 (비우면 이전 품목)" autocomplete="off"></td>
              <td><input id="eSpec" placeholder="규격"></td>
              <td><input id="eQty" type="number" inputmode="decimal" step="any" value="1"></td>
              <td><input id="ePrice" type="number" inputmode="numeric" placeholder="단가"></td>
              <td class="num" id="eSupply">0</td>
              <td class="num" id="eTotal">0</td>
              <td class="num" id="eTax">0</td>
              <td><input id="ePaid" type="number" inputmode="numeric" min="0" placeholder="0"></td>
              <td class="num">—</td>
              <td class="actions"><button class="primary" id="btnEntrySave">저장</button></td>
            </tr>
          </tbody>
        </table>
      </div>
      <p class="hint sheet-hint">
        <span><b>Enter</b> 저장</span>
        <span><b>품명 비우고 Enter</b> 이전 품목 그대로</span>
        <span><b>=</b> 부호 토글 · 연속 체크</span>
        <span><b>−</b> 건너뛰기</span>
        <span><b>Backspace</b> 되돌리기</span>
        <span><b>ESC</b> 빠른 검색</span>
        <span><b>F2</b> 커서 고정</span>
        <button type="button" id="btnHelpInline" class="link-btn">자세한 사용법 보기</button>
      </p>
      <button type="button" class="fab" id="btnQuickSearch" title="빠른 검색 (ESC)">🔍 검색</button>
      <button type="button" class="fab fab-help" id="btnHelp" title="사용법 안내">?</button>
    </section>`;

  const eCompany = $('#eCompany');
  const setEntryCompany = applyEntryCompany; // 입력 행 상호 설정 (세션 동안 유지, 새로고침 시 초기화)
  const preferred = state.companies.find((c) => String(c.id) === String(state.txCompanyId || state.entryCompanyId));
  if (preferred) setEntryCompany(preferred);
  else state.entryCompanyId = '';

  attachSearchDropdown(eCompany, {
    minChars: 0,           // 클릭만 해도 전체 상호 목록이 뜨고, 타자로 좁혀진다
    enterPicksFirst: true, // Enter로 맨 위 힌트 바로 선택
    getItems: async (q) => state.companies.filter((c) => !q || c.name.toLowerCase().includes(q)),
    itemHtml: (c) => `<b>${esc(c.name)}</b>${c.owner ? `<span class="sub">${esc(c.owner)}</span>` : ''}`,
    onPick: (c) => {
      setEntryCompany(c);
      $('#eName').focus();
    },
  });
  eCompany.addEventListener('input', () => {
    state.entryCompanyId = ''; // 글자를 고치면 다시 선택해야 함
  });
  eCompany.addEventListener('blur', () => {
    // 이름을 끝까지 정확히 입력한 경우는 자동 인정
    if (state.entryCompanyId) return;
    const m = state.companies.find((c) => c.name.toLowerCase() === eCompany.value.trim().toLowerCase());
    if (m) setEntryCompany(m);
  });

  $('#txCompany').addEventListener('change', (e) => {
    state.txCompanyId = e.target.value;
    const c = state.companies.find((x) => String(x.id) === e.target.value);
    if (c) setEntryCompany(c);
    drawTxRows();
  });
  $('#fFrom').addEventListener('change', (e) => {
    state.txFrom = e.target.value;
    drawTxRows();
  });
  $('#fTo').addEventListener('change', (e) => {
    state.txTo = e.target.value;
    drawTxRows();
  });
  let productFilterTimer = null;
  $('#fProduct').addEventListener('input', (e) => {
    state.txProductQuery = e.target.value;
    clearTimeout(productFilterTimer);
    productFilterTimer = setTimeout(drawTxRows, 250);
  });
  $('#btnClearFilter').addEventListener('click', () => {
    state.txCompanyId = '';
    state.txFrom = '';
    state.txTo = '';
    state.txProductQuery = '';
    $('#txCompany').value = '';
    $('#fFrom').value = '';
    $('#fTo').value = '';
    $('#fProduct').value = '';
    drawTxRows();
  });
  $('#entryVat').addEventListener('change', (e) => {
    state.entryVat = e.target.value;
    try {
      localStorage.setItem('entryVat', e.target.value);
    } catch (err) { /* 무시 */ }
    recomputeEntry();
  });
  $('#btnAddTx').addEventListener('click', () => openTxForm(null));
  $('#btnAddPay').addEventListener('click', () => openPaymentForm(null));
  $('#btnTxCsv').addEventListener('click', exportTransactionsCsv);
  $('#btnEasyOn').addEventListener('click', () => setEasyMode(true));
  $('#eQty').addEventListener('input', () => {
    state.entryQtyTouched = true;
    recomputeEntry();
  });
  $('#ePrice').addEventListener('input', recomputeEntry);
  // 품명을 비운 채 다음 칸으로 넘어가면 이전 품목을 그대로 채워 준다
  $('#eName').addEventListener('blur', () => {
    setTimeout(() => {
      if ($('#eName') && !$('#eName').value.trim() && fillFromLastItem($('#eName'), $('#eSpec'), $('#ePrice'), $('#eQty'))) {
        recomputeEntry();
        toast('이전 품목을 불러왔습니다.');
      }
    }, 180); // 자동완성 힌트를 고르는 중이면 건너뛰도록 잠깐 기다린다
  });
  attachProductAutocomplete($('#eName'), () => state.entryCompanyId, (p) => {
    $('#eName').value = p.name;
    $('#eSpec').value = p.spec;
    $('#ePrice').value = p.price;
    recomputeEntry();
    $('#eQty').focus();
    $('#eQty').select();
  });
  $('#btnQuickSearch').addEventListener('click', toggleSearchSheet);
  $('#btnHelp').addEventListener('click', startTour);
  $('#btnHelpInline').addEventListener('click', startTour);
  $('#btnEntrySave').addEventListener('click', saveEntry);
  // 버튼을 누르면 포커스가 옮겨가므로 직전에 커서가 있던 칸을 기준으로 고정한다
  $('#btnPin').addEventListener('mousedown', (e) => e.preventDefault());
  $('#btnPin').addEventListener('click', () => togglePin(document.activeElement));
  $('.entry-row').addEventListener('keydown', (e) => {
    if (e.target.tagName !== 'INPUT') return;
    if (e.key === 'Enter') {
      e.preventDefault();
      saveEntry();
    } else if (e.key === '=') {
      // '=' 키로 단가(합계) 부호 토글: 8000 ⇄ -8000 (반품·차감 입력용)
      e.preventDefault();
      const el = $('#ePrice');
      const v = Number(el.value) || 0;
      if (v !== 0) {
        el.value = -v;
        recomputeEntry();
      }
    }
  });
  recomputeEntry();
  updatePinUI();
  await drawTxRows();
  scrollSheetToBottom();
  maybeAutoTour(); // 처음 온 사용자에게 사용법 안내
}

// 첫 방문(또는 안내를 끝까지 본 적 없는 경우)에 한 번만 자동으로 튜토리얼을 띄운다
function maybeAutoTour() {
  if (state.easyMode) return; // 큰 글씨 모드에는 안내 대상 요소가 없다
  let done = true;
  try {
    done = localStorage.getItem('tourDone') === '1';
  } catch (e) { /* localStorage 사용 불가 환경에선 띄우지 않음 */ }
  if (done) return;
  setTimeout(() => {
    if ($('.entry-row') && $('#tourOverlay').classList.contains('hidden')) startTour();
  }, 500);
}

/* ─────────────── 큰 글씨 간편 입력 ─────────────── */
async function renderTransactionsEasy() {
  await refreshCompanies();
  $('#main').innerHTML = `
    <section class="card easy-card">
      <div class="easy-head">
        <h2>거래 적기</h2>
        <button type="button" id="btnEasyOff">일반 화면</button>
      </div>
      <p class="easy-guide">아래 칸을 위에서부터 하나씩 채우고 맨 아래 <b>[저장하기]</b>를 누르세요.<br>
      같은 걸 또 적을 땐 품명을 <b>비워두고</b> 저장하면 직전 품목이 그대로 들어갑니다.</p>
      <form id="easyForm" autocomplete="off">
        <div class="easy-field">
          <span class="easy-label">날짜</span>
          <input type="date" id="xDate" value="${esc(state.entryDate || today())}">
        </div>
        <div class="easy-field">
          <span class="easy-label">상호 (거래처)</span>
          <input id="xCompany" placeholder="눌러서 고르거나 새로 적기">
        </div>
        <div class="easy-field">
          <span class="easy-label">품명</span>
          <input id="xName" placeholder="예: 식대">
          <button type="button" id="xSame" class="sign-btn">직전에 적은 것과 같게</button>
        </div>
        <div class="easy-field">
          <span class="easy-label">수량</span>
          <div class="stepper">
            <button type="button" class="step-btn" data-step="-1">－</button>
            <input id="xQty" type="number" inputmode="decimal" step="any" value="1">
            <button type="button" class="step-btn" data-step="1">＋</button>
          </div>
        </div>
        <div class="easy-field">
          <span class="easy-label">단가 (금액)</span>
          <input id="xPrice" type="number" inputmode="numeric" placeholder="0">
          <button type="button" id="xSign" class="sign-btn">＋ ↔ － 바꾸기</button>
        </div>
        <div class="easy-field">
          <span class="easy-label">부가세</span>
          <select id="xVat">
            ${Object.entries(VAT_LABEL).map(([v, l]) => `<option value="${v}" ${v === state.entryVat ? 'selected' : ''}>${l}</option>`).join('')}
          </select>
        </div>
        <div class="easy-field">
          <span class="easy-label">받은 돈 (없으면 비워두세요)</span>
          <input id="xPaid" type="number" inputmode="numeric" placeholder="0">
        </div>
        <p class="easy-total">합계 <b id="xTotal">0원</b></p>
        <button type="button" id="btnPin" class="pin-btn easy-pin">📌<span id="pinLabel" class="pin-label">커서 고정</span></button>
        <button type="submit" class="primary easy-save">저장하기</button>
      </form>
    </section>
    <section class="card easy-card">
      <button type="button" id="btnAddPayEasy" class="easy-pay-btn">💰 돈 받았어요 (입금)</button>
      <h2 class="easy-recent-title">최근에 적은 것</h2>
      <div id="easyList"></div>
    </section>`;

  const xCompany = $('#xCompany');
  const preferred = state.companies.find((c) => String(c.id) === String(state.entryCompanyId));
  if (preferred) xCompany.value = preferred.name;

  attachSearchDropdown(xCompany, {
    minChars: 0,
    enterPicksFirst: true,
    getItems: async (q) => state.companies.filter((c) => !q || c.name.toLowerCase().includes(q)),
    itemHtml: (c) => `<b>${esc(c.name)}</b>${c.owner ? `<span class="sub">${esc(c.owner)}</span>` : ''}`,
    onPick: (c) => {
      state.entryCompanyId = String(c.id);
      xCompany.value = c.name;
      $('#xName').focus();
    },
  });
  xCompany.addEventListener('input', () => {
    state.entryCompanyId = ''; // 이름을 고치면 새 상호로 취급 (없으면 자동 등록)
  });
  attachProductAutocomplete($('#xName'), () => state.entryCompanyId, (p) => {
    $('#xName').value = p.name;
    $('#xPrice').value = p.price;
    easyRecompute();
  });

  $('#xSame').addEventListener('click', () => {
    if (fillFromLastItem($('#xName'), null, $('#xPrice'), $('#xQty'))) {
      easyRecompute();
      toast('직전 품목을 불러왔습니다.');
    } else {
      toast('아직 적은 거래가 없습니다.');
    }
  });
  $('#xName').addEventListener('blur', () => {
    setTimeout(() => {
      if ($('#xName') && !$('#xName').value.trim() && fillFromLastItem($('#xName'), null, $('#xPrice'), $('#xQty'))) {
        easyRecompute();
        toast('이전 품목을 불러왔습니다.');
      }
    }, 180);
  });

  $$('.step-btn').forEach((btn) =>
    btn.addEventListener('click', () => {
      const el = $('#xQty');
      const next = (Number(el.value) || 0) + Number(btn.dataset.step);
      el.value = next < 0 ? 0 : next;
      state.entryQtyTouched = true;
      easyRecompute();
    })
  );
  $('#xSign').addEventListener('click', () => {
    const el = $('#xPrice');
    const v = Number(el.value) || 0;
    if (v !== 0) {
      el.value = -v;
      easyRecompute();
    }
  });
  $('#xQty').addEventListener('input', () => {
    state.entryQtyTouched = true;
    easyRecompute();
  });
  $('#xPrice').addEventListener('input', easyRecompute);
  $('#xVat').addEventListener('change', (e) => {
    state.entryVat = e.target.value;
    try {
      localStorage.setItem('entryVat', e.target.value);
    } catch (err) { /* 무시 */ }
    easyRecompute();
  });
  $('#btnEasyOff').addEventListener('click', () => setEasyMode(false));
  $('#btnAddPayEasy').addEventListener('click', () => openPaymentForm(null));
  $('#btnPin').addEventListener('mousedown', (e) => e.preventDefault());
  $('#btnPin').addEventListener('click', () => togglePin(document.activeElement));
  $('#easyForm').addEventListener('submit', (e) => {
    e.preventDefault();
    saveEasyEntry();
  });

  easyRecompute();
  updatePinUI();
  await drawEasyList();
}

function easyRecompute() {
  if (!$('#xQty')) return;
  const r = calcItem(Number($('#xQty').value) || 0, Number($('#xPrice').value) || 0, state.entryVat);
  const total = r.supply + r.tax;
  $('#xTotal').textContent = won(total) + '원';
  $('#xTotal').classList.toggle('neg', total < 0);
}

async function saveEasyEntry() {
  const companyName = $('#xCompany').value.trim();
  if (!state.entryCompanyId && !companyName) {
    alert('상호를 적어주세요.');
    $('#xCompany').focus();
    return;
  }
  let name = $('#xName').value.trim();
  if (!name) {
    // 품명이 비어 있으면 직전 품목을 그대로 적용한다
    if (fillFromLastItem($('#xName'), null, $('#xPrice'), $('#xQty'))) {
      easyRecompute();
      name = $('#xName').value.trim();
    }
  }
  if (!name) {
    alert('품명을 적어주세요.');
    $('#xName').focus();
    return;
  }
  const body = {
    companyId: Number(state.entryCompanyId) || 0,
    companyName,
    date: $('#xDate').value || today(),
    vatMode: state.entryVat,
    items: [{ name, spec: '', qty: Number($('#xQty').value) || 0, price: Number($('#xPrice').value) || 0 }],
    paid: Number($('#xPaid').value) || 0,
    memo: '',
  };
  let tx;
  try {
    tx = await api('POST', '/api/transactions', body);
  } catch (err) {
    alert(err.message);
    return;
  }
  state.entryDate = body.date;
  state.entryQtyTouched = false;
  clearProductsCache();
  await refreshCompanies();
  const saved = state.companies.find((c) => c.id === tx.companyId);
  if (saved) {
    state.entryCompanyId = String(saved.id);
    $('#xCompany').value = saved.name;
  }
  $('#xName').value = '';
  $('#xQty').value = 1;
  $('#xPrice').value = '';
  $('#xPaid').value = '';
  easyRecompute();
  toast('저장했습니다.');
  await drawEasyList();
  updatePinUI();
  focusAfterSave('xName');
}

async function drawEasyList() {
  const [txs, pays] = await Promise.all([api('GET', '/api/transactions'), api('GET', '/api/payments')]);
  txCache = txs;
  payCache = pays;
  const box = $('#easyList');
  if (!box) return;
  // 거래와 입금을 최신순으로 섞어 15건
  const rows = [
    ...txCache.map((t) => Object.assign({ kind: 'tx' }, t)),
    ...payCache.map((x) => Object.assign({ kind: 'pay' }, x)),
  ]
    .sort((a, b) => b.date.localeCompare(a.date) || b.id - a.id)
    .slice(0, 15);
  if (!rows.length) {
    box.innerHTML = '<p class="empty-cell">아직 적은 거래가 없습니다.</p>';
    return;
  }
  box.innerHTML = rows
    .map((t) => {
      if (t.kind === 'pay') {
        return `<div class="easy-item easy-item-pay" data-id="${t.id}" data-kind="pay">
          <div class="easy-item-head"><b>${esc(t.companyName)}</b><span>${esc(t.date)}</span></div>
          <div class="easy-item-name">💰 입금 ${esc(PAY_METHOD_LABEL[t.method] || '')}${t.memo ? ' · ' + esc(t.memo) : ''}</div>
          <div class="easy-item-foot">
            <b>${won(t.amount)}원</b>
            <button type="button" data-act="pay-edit">고치기</button>
            <button type="button" data-act="pay-del" class="danger">삭제</button>
          </div>
        </div>`;
      }
      const it = t.items[0];
      const more = t.items.length > 1 ? ` 외 ${t.items.length - 1}건` : '';
      return `<div class="easy-item" data-id="${t.id}" data-kind="tx">
        <div class="easy-item-head"><b>${esc(t.companyName)}</b><span>${esc(t.date)}</span></div>
        <div class="easy-item-name">${esc(it.name)}${more}</div>
        <div class="easy-item-foot">
          <b class="${t.total < 0 ? 'neg' : ''}">${won(t.total)}원</b>
          <button type="button" data-act="sheet">명세표</button>
          <button type="button" data-act="del" class="danger">삭제</button>
        </div>
      </div>`;
    })
    .join('');
  box.onclick = async (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const item = btn.closest('.easy-item');
    const id = Number(item.dataset.id);
    const act = btn.dataset.act;
    if (act === 'pay-edit' || act === 'pay-del') {
      const pay = payCache.find((x) => x.id === id);
      if (!pay) return;
      if (act === 'pay-edit') return openPaymentForm(pay);
      if (!confirm(`${pay.date} '${pay.companyName}' 입금 ${won(pay.amount)}원을 지울까요?`)) return;
      await api('DELETE', '/api/payments/' + id);
      toast('지웠습니다.');
      await refreshCompanies();
      return drawEasyList();
    }
    const t = txCache.find((x) => x.id === id);
    if (!t) return;
    if (act === 'sheet') openStatement(t);
    else if (act === 'del') {
      if (!confirm(`${t.date} '${t.companyName}' 거래를 지울까요?`)) return;
      await api('DELETE', '/api/transactions/' + id);
      toast('지웠습니다.');
      await refreshCompanies();
      drawEasyList();
    }
  };
}

/* ─────────────── 입력 중 저장 막대 (휴대폰 키보드 위) ─────────────── */
// 아이폰 숫자 키패드에는 Enter 키가 없어 저장 버튼까지 가로 스크롤해야 했다.
// 입력칸에 커서가 있는 동안 키보드 바로 위에 저장 버튼을 띄운다.
const SAVE_BAR_FIELDS = /^(eDate|eCompany|eName|eSpec|eQty|ePrice|ePaid|xDate|xCompany|xName|xQty|xPrice|xPaid)$/;

function saveBarTarget() {
  const el = document.activeElement;
  return el && el.id && SAVE_BAR_FIELDS.test(el.id) ? el : null;
}

function updateSaveBar() {
  const bar = $('#saveBar');
  if (!bar) return;
  if (state.tab !== 'transactions' || !saveBarTarget()) {
    bar.classList.add('hidden');
    return;
  }
  bar.classList.remove('hidden');
  // 키보드가 화면을 가리는 만큼 위로 올린다 (지원하지 않는 브라우저는 화면 하단)
  const vv = window.visualViewport;
  const gap = vv ? Math.max(0, window.innerHeight - vv.height - vv.offsetTop) : 0;
  bar.style.bottom = gap + 'px';

  const isEasy = state.easyMode;
  const qty = Number($(isEasy ? '#xQty' : '#eQty')?.value) || 0;
  const price = Number($(isEasy ? '#xPrice' : '#ePrice')?.value) || 0;
  const r = calcItem(qty, price, state.entryVat);
  const total = r.supply + r.tax;
  const name = ($(isEasy ? '#xName' : '#eName')?.value || '').trim();
  const info = $('#saveBarInfo');
  info.textContent = (name || '이전 품목') + ' · ' + won(total) + '원';
  info.classList.toggle('neg', total < 0);
}

document.addEventListener('focusin', updateSaveBar);
document.addEventListener('focusout', () => setTimeout(updateSaveBar, 80));
document.addEventListener('input', (e) => {
  if (saveBarTarget()) updateSaveBar();
});
if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', updateSaveBar);
  window.visualViewport.addEventListener('scroll', updateSaveBar);
}
$('#saveBar').addEventListener('mousedown', (e) => e.preventDefault()); // 커서를 잃지 않게
$('#saveBarBtn').addEventListener('click', () => {
  if (state.easyMode) saveEasyEntry();
  else saveEntry();
});

/* ─────────────── 커서 고정 ─────────────── */
// 저장 후 커서가 돌아갈 칸을 지정한다 (지정 전 기본값은 품명).
// PC: F2, 휴대폰: 📌 버튼. 기기에 기억되어 다음 접속에도 유지된다.
const PIN_FIELDS = {
  eDate: '날짜', eCompany: '상호', eName: '품명', eSpec: '규격',
  eQty: '수량', ePrice: '단가', ePaid: '입금',
  xDate: '날짜', xCompany: '상호', xName: '품명', xQty: '수량',
  xPrice: '단가', xPaid: '받은 돈',
};

state.pinnedField = '';
try {
  const saved = localStorage.getItem('pinnedField');
  if (saved && PIN_FIELDS[saved]) state.pinnedField = saved;
} catch (e) { /* localStorage 사용 불가 환경 */ }

// 저장 후 커서를 보낼 칸 (고정된 칸이 지금 화면에 없으면 품명으로)
function focusAfterSave(defaultId) {
  const el = (state.pinnedField && $('#' + state.pinnedField)) || $('#' + defaultId);
  if (!el) return;
  el.focus();
  if (el.select) el.select();
}

function pinLabel() {
  return state.pinnedField ? PIN_FIELDS[state.pinnedField] : '';
}

// 지금 커서가 있는 칸을 고정한다 (같은 칸을 다시 지정하면 해제)
function togglePin(el) {
  const target = el && el.id && PIN_FIELDS[el.id] ? el : null;
  if (!target) {
    toast('먼저 고정할 입력칸을 누르세요.');
    return;
  }
  state.pinnedField = state.pinnedField === target.id ? '' : target.id;
  try {
    localStorage.setItem('pinnedField', state.pinnedField);
  } catch (e) { /* 무시 */ }
  toast(state.pinnedField ? `📌 '${pinLabel()}' 칸에 커서를 고정했습니다.` : '📌 커서 고정을 해제했습니다.');
  updatePinUI();
}

// 고정된 칸에 표시를 붙이고 버튼 문구를 갱신한다
function updatePinUI() {
  $$('.pinned').forEach((el) => el.classList.remove('pinned'));
  if (state.pinnedField) {
    const el = $('#' + state.pinnedField);
    if (el) el.classList.add('pinned');
  }
  const btn = $('#btnPin');
  if (btn) {
    btn.classList.toggle('on', !!state.pinnedField);
    btn.title = state.pinnedField
      ? `저장 후 '${pinLabel()}' 칸으로 돌아갑니다 (F2로 해제)`
      : '커서 고정: 입력칸을 누른 뒤 이 버튼(또는 F2)을 누르세요';
    const label = $('#pinLabel');
    if (label) label.textContent = state.pinnedField ? pinLabel() : '커서 고정';
  }
}

// F2: 지금 커서가 있는 칸을 고정 / 해제
document.addEventListener('keydown', (e) => {
  if (e.key !== 'F2' || state.tab !== 'transactions') return;
  e.preventDefault();
  togglePin(document.activeElement);
});

/* ─────────────── 이전 품목 그대로 적기 ─────────────── */
// 품명을 비운 채 넘어가거나 저장하면 직전에 적은 품목을 그대로 불러온다.
// 선택된 상호의 마지막 거래를 우선 쓰고, 없으면 전체 마지막 거래를 쓴다.
function getLastItem() {
  const cid = Number(state.entryCompanyId) || 0;
  const src = (cid && txCache.find((t) => t.companyId === cid)) || txCache[0];
  if (!src || !src.items.length) return null;
  const it = src.items[src.items.length - 1];
  return { name: it.name, spec: it.spec || '', price: it.price, qty: it.qty };
}

// 수량은 사용자가 직접 건드리지 않았을 때만 이전 값을 따라간다
function fillFromLastItem(nameEl, specEl, priceEl, qtyEl) {
  const last = getLastItem();
  if (!last) return false;
  nameEl.value = last.name;
  if (specEl) specEl.value = last.spec;
  priceEl.value = last.price;
  if (qtyEl && !state.entryQtyTouched) qtyEl.value = last.qty;
  return true;
}

function scrollSheetToBottom() {
  const wrap = $('.ledger-wrap');
  if (wrap) wrap.scrollTop = wrap.scrollHeight;
}

// 입력 행의 상호를 설정한다 (렌더 여부와 무관하게 상태를 갱신)
function applyEntryCompany(c) {
  state.entryCompanyId = String(c.id);
  const el = $('#eCompany');
  if (el) el.value = c.name;
}

function recomputeEntry() {
  if (!$('#eQty')) return;
  const r = calcItem(Number($('#eQty').value) || 0, Number($('#ePrice').value) || 0, state.entryVat);
  $('#eSupply').textContent = won(r.supply);
  $('#eTax').textContent = won(r.tax);
  $('#eTotal').textContent = won(r.supply + r.tax);
  $('#eSupply').classList.toggle('neg', r.supply < 0);
  $('#eTax').classList.toggle('neg', r.tax < 0);
  $('#eTotal').classList.toggle('neg', r.supply + r.tax < 0);
}

async function saveEntry() {
  const typedCompany = $('#eCompany').value.trim();
  if (!state.entryCompanyId && !typedCompany) {
    toast('상호를 입력하세요.');
    $('#eCompany').focus();
    return;
  }
  let name = $('#eName').value.trim();
  if (!name) {
    // 품명이 비어 있으면 직전 품목을 그대로 적용한다
    if (fillFromLastItem($('#eName'), $('#eSpec'), $('#ePrice'), $('#eQty'))) {
      recomputeEntry();
      name = $('#eName').value.trim();
    }
  }
  if (!name) {
    toast('품명을 입력하세요.');
    $('#eName').focus();
    return;
  }
  const body = {
    companyId: Number(state.entryCompanyId) || 0,
    companyName: typedCompany, // 없는 상호면 서버가 자동 등록한다
    date: $('#eDate').value || today(),
    vatMode: state.entryVat,
    items: [{ name, spec: $('#eSpec').value.trim(), qty: Number($('#eQty').value) || 0, price: Number($('#ePrice').value) || 0 }],
    paid: Number($('#ePaid').value) || 0,
    memo: '',
  };
  let tx;
  try {
    tx = await api('POST', '/api/transactions', body);
  } catch (err) {
    alert(err.message);
    return;
  }
  state.entryDate = body.date;
  state.entryQtyTouched = false;
  clearProductsCache(); // 자동 등록된 제품이 힌트에 바로 나오도록
  await refreshCompanies(); // 자동 등록된 상호가 검색에 바로 나오도록
  const savedCompany = state.companies.find((c) => c.id === tx.companyId);
  if (savedCompany) applyEntryCompany(savedCompany);
  $('#eName').value = '';
  $('#eSpec').value = '';
  $('#eQty').value = 1;
  $('#ePrice').value = '';
  $('#ePaid').value = '';
  await drawTxRows();
  toast('저장했습니다.');
  scrollSheetToBottom();
  updatePinUI();
  focusAfterSave('eName');
}

async function drawTxRows() {
  const qs = state.txCompanyId ? '?companyId=' + state.txCompanyId : '';
  const [txs, pays] = await Promise.all([
    api('GET', '/api/transactions' + qs),
    api('GET', '/api/payments' + qs),
  ]);
  txCache = txs;
  payCache = pays;
  const tbody = $('#txRows');
  if (!tbody) return;

  // 날짜 범위·품명 검색 필터 (화면에서 걸러냄)
  const inRange = (d) => (!state.txFrom || d >= state.txFrom) && (!state.txTo || d <= state.txTo);
  const q = state.txProductQuery.trim().toLowerCase();
  let list = txCache.filter((t) => inRange(t.date));
  if (q) list = list.filter((t) => t.items.some((it) => it.name.toLowerCase().includes(q)));
  // 품명으로 찾는 중에는 입금 줄을 숨긴다 (품명이 없는 줄이라 검색 대상이 아님)
  const payList = q ? [] : payCache.filter((x) => inRange(x.date));

  const total = list.reduce((s, t) => s + t.total, 0);
  const paidInline = list.reduce((s, t) => s + t.paid, 0);
  const received = payList.reduce((s, x) => s + x.amount, 0);
  const paid = paidInline + received;
  $('#txSummary').textContent =
    `거래 ${list.length}건 · 합계 ${won(total)}원 · 받은 돈 ${won(paid)}원` +
    (received ? ` (입금 ${payList.length}건 ${won(received)}원 포함)` : '') +
    ` · 미수 ${won(total - paid)}원`;
  updateSelSummary();

  // 거래와 입금을 한 장부로 합쳐 옛날 → 최신 순으로 보여준다
  const rows = [
    ...list.map((t) => Object.assign({ kind: 'tx' }, t)),
    ...payList.map((x) => Object.assign({ kind: 'pay' }, x)),
  ].sort((a, b) => a.date.localeCompare(b.date) || a.id - b.id);

  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="13" class="empty-cell">${txCache.length ? '검색 조건에 맞는 거래가 없습니다.' : '아직 거래가 없습니다. 아래 파란 입력 행에서 첫 거래를 적어보세요.'}</td></tr>`;
    return;
  }
  tbody.innerHTML = rows
    .map((t, i) => {
      if (t.kind === 'pay') {
        const checked = checkedTxIds.has('p' + t.id);
        return `<tr data-id="${t.id}" data-kind="pay" data-idx="${i}" class="row-pay ${checked ? 'row-checked' : ''}">
          <td class="chk"><input type="checkbox" ${checked ? 'checked' : ''}></td>
          <td>${esc(t.date)}</td>
          <td><b>${esc(t.companyName)}</b></td>
          <td colspan="6" class="pay-label">💰 입금 <span class="sub">${PAY_METHOD_LABEL[t.method] || ''}${t.memo ? ' · ' + esc(t.memo) : ''}</span></td>
          <td class="num"><b>${won(t.amount)}</b></td>
          <td class="num">—</td>
          <td class="actions">
            <button data-act="pay-edit" data-id="${t.id}">수정</button>
            <button data-act="pay-del" data-id="${t.id}" class="danger" title="삭제">✕</button>
          </td>
        </tr>`;
      }
      const single = t.items.length === 1;
      const it = t.items[0];
      const balance = t.total - t.paid;
      const checked = checkedTxIds.has('t' + t.id);
      return `<tr data-id="${t.id}" data-kind="tx" data-idx="${i}" class="${checked ? 'row-checked' : ''}">
        <td class="chk"><input type="checkbox" ${checked ? 'checked' : ''}></td>
        <td>${esc(t.date)}</td>
        <td><b>${esc(t.companyName)}</b></td>
        <td>${esc(it.name)}${single ? '' : ` <span class="sub">외 ${t.items.length - 1}건</span>`}${t.memo ? `<div class="sub">${esc(t.memo)}</div>` : ''}</td>
        <td>${single ? esc(it.spec) : ''}</td>
        <td class="num">${single ? won(it.qty) : ''}</td>
        <td class="num">${single ? won(it.price) : ''}</td>
        <td class="num ${t.supplyTotal < 0 ? 'neg' : ''}">${won(t.supplyTotal)}</td>
        <td class="num ${t.total < 0 ? 'neg' : ''}"><b>${won(t.total)}</b></td>
        <td class="num ${t.taxTotal < 0 ? 'neg' : ''}">${won(t.taxTotal)}</td>
        <td class="num">${won(t.paid)}</td>
        <td class="num ${balance > 0 ? 'warn' : balance < 0 ? 'neg' : ''}">${won(balance)}</td>
        <td class="actions">
          <button data-act="sheet" data-id="${t.id}">명세표</button>
          <button data-act="edit" data-id="${t.id}">수정</button>
          <button data-act="del" data-id="${t.id}" class="danger" title="삭제">✕</button>
        </td>
      </tr>`;
    })
    .join('');
  tbody.onclick = async (e) => {
    const btn = e.target.closest('button[data-act]');
    if (btn) {
      const id = Number(btn.dataset.id);
      const act = btn.dataset.act;
      if (act === 'pay-edit' || act === 'pay-del') {
        const pay = payCache.find((x) => x.id === id);
        if (!pay) return;
        if (act === 'pay-edit') openPaymentForm(pay);
        else {
          if (!confirm(`${pay.date} '${pay.companyName}' 입금 ${won(pay.amount)}원을 삭제할까요?`)) return;
          await api('DELETE', '/api/payments/' + id);
          checkedTxIds.delete('p' + id);
          toast('입금 내역을 삭제했습니다.');
          await refreshCompanies();
          drawTxRows();
        }
        return;
      }
      const t = txCache.find((x) => x.id === id);
      if (!t) return;
      if (act === 'sheet') openStatement(t);
      else if (act === 'edit') openTxForm(t);
      else if (act === 'del') {
        if (!confirm(`${t.date} '${t.companyName}' 거래를 삭제할까요?`)) return;
        await api('DELETE', '/api/transactions/' + id);
        checkedTxIds.delete('t' + id);
        toast('거래를 삭제했습니다.');
        drawTxRows();
      }
      return;
    }
    // 행 아무 곳이나 누르면 체크 토글
    const tr = e.target.closest('tr[data-id]');
    if (!tr) return;
    const cb = tr.querySelector('input[type="checkbox"]');
    if (!cb) return;
    if (e.target !== cb) cb.checked = !cb.checked;
    const id = rowKey(tr);
    if (cb.checked) checkedTxIds.add(id);
    else checkedTxIds.delete(id);
    tr.classList.toggle('row-checked', cb.checked);
    sheetLastIdx = Number(tr.dataset.idx);
    updatePointerHighlight();
    updateSelSummary();
  };
  updatePointerHighlight();
}

// 체크된 거래의 소계 표시
function updateSelSummary() {
  const el = $('#selSummary');
  if (!el) return;
  const sel = txCache.filter((t) => checkedTxIds.has('t' + t.id));
  const selPay = payCache.filter((x) => checkedTxIds.has('p' + x.id));
  const count = sel.length + selPay.length;
  if (!count) {
    el.textContent = '';
    return;
  }
  const total = sel.reduce((s, t) => s + t.total, 0);
  const paid = sel.reduce((s, t) => s + t.paid, 0) + selPay.reduce((s, x) => s + x.amount, 0);
  el.textContent = ` · ☑ 선택 ${count}건: 합계 ${won(total)}원 · 받은 돈 ${won(paid)}원 · 미수 ${won(total - paid)}원`;
}

// 고정된 머리글·입력 행에 가려지지 않게 스크롤한다 (다음 줄까지 한 줄 더 보이도록)
function scrollRowIntoView(tr) {
  const wrap = $('.ledger-wrap');
  if (!wrap || !tr) return;
  const head = $('.ledger-table thead', wrap);
  const entry = $('.entry-row', wrap);
  const headH = head ? head.getBoundingClientRect().height : 0;
  const entryH = entry ? entry.getBoundingClientRect().height : 0;
  const wrapRect = wrap.getBoundingClientRect();
  const rowRect = tr.getBoundingClientRect();
  const lookahead = rowRect.height; // 다음에 체크될 줄도 미리 보이게
  const topLimit = wrapRect.top + headH;
  const bottomLimit = wrapRect.bottom - entryH;

  if (rowRect.bottom + lookahead > bottomLimit) {
    wrap.scrollTop += rowRect.bottom + lookahead - bottomLimit;
  } else if (rowRect.top < topLimit) {
    wrap.scrollTop -= topLimit - rowRect.top;
  }
}

// 포인터(현재 위치) 행 표시 — 어느 행에서 이어갈지 파란 테두리로 보여준다
function updatePointerHighlight() {
  const rows = $$('#txRows tr[data-id]');
  rows.forEach((tr) => tr.classList.remove('row-pointer'));
  if (sheetLastIdx != null && sheetLastIdx >= 0 && rows[sheetLastIdx]) {
    rows[sheetLastIdx].classList.add('row-pointer');
  }
}

// '=' 연속 체크: 포인터의 다음 행을 체크 (키를 누르고 있으면 반복)
function checkNextRow() {
  if (sheetLastIdx == null) return;
  const rows = $$('#txRows tr[data-id]');
  const next = rows[sheetLastIdx + 1];
  if (!next) {
    toast('마지막 줄입니다.');
    return;
  }
  sheetLastIdx += 1;
  const cb = next.querySelector('input[type="checkbox"]');
  if (cb && !cb.checked) {
    cb.checked = true;
    checkedTxIds.add(rowKey(next));
    next.classList.add('row-checked');
  }
  scrollRowIntoView(next);
  updatePointerHighlight();
  updateSelSummary();
}

// '-' 건너뛰기: 체크하지 않고 포인터만 다음 행으로
function skipNextRow() {
  if (sheetLastIdx == null) return;
  const rows = $$('#txRows tr[data-id]');
  const next = rows[sheetLastIdx + 1];
  if (!next) {
    toast('마지막 줄입니다.');
    return;
  }
  sheetLastIdx += 1;
  scrollRowIntoView(next);
  updatePointerHighlight();
}

// Backspace 되돌리기: 포인터 행의 체크를 풀고 포인터를 한 칸 위로 (연타 가능)
function undoCheckRow() {
  if (sheetLastIdx == null || sheetLastIdx < 0) return;
  const rows = $$('#txRows tr[data-id]');
  const cur = rows[sheetLastIdx];
  if (!cur) return;
  const cb = cur.querySelector('input[type="checkbox"]');
  if (cb && cb.checked) {
    cb.checked = false;
    checkedTxIds.delete(rowKey(cur));
    cur.classList.remove('row-checked');
  }
  sheetLastIdx -= 1; // -1이 되면 '첫 행 이전' 상태 — 다음 '='는 첫 행부터 체크
  if (sheetLastIdx >= 0) scrollRowIntoView(rows[sheetLastIdx]);
  updatePointerHighlight();
  updateSelSummary();
}

document.addEventListener('keydown', (e) => {
  if (state.tab !== 'transactions') return;
  if (e.key !== '=' && e.key !== '-' && e.key !== 'Backspace') return;
  if (e.target.closest('input, select, textarea')) return; // 입력 중일 땐 원래 동작 유지
  if (!$('#modal').classList.contains('hidden')) return;
  e.preventDefault();
  if (e.key === '=') checkNextRow();
  else if (e.key === '-') skipNextRow();
  else undoCheckRow();
});

/* ─────────────── 빠른 검색 시트 (ESC / 🔍) ─────────────── */
const ss = { tab: 'company', items: [], sel: 0 };

async function getAllProducts() {
  if (!state.productsCache.all) {
    state.productsCache.all = await api('GET', '/api/products');
  }
  return state.productsCache.all;
}

function searchSheetOpen() {
  return !$('#searchSheet').classList.contains('hidden');
}

function openSearchSheet() {
  $('#searchSheet').classList.remove('hidden');
  document.body.classList.add('sheet-open'); // 본문을 패널 높이만큼 위로 밀어 올림
  $('#ssInput').value = '';
  ssUpdate();
  $('#ssInput').focus();
  scrollSheetToBottom(); // 입력 행이 패널 위에 계속 보이도록
}

function closeSearchSheet() {
  $('#searchSheet').classList.add('hidden');
  document.body.classList.remove('sheet-open');
  scrollSheetToBottom();
}

function toggleSearchSheet() {
  if (searchSheetOpen()) closeSearchSheet();
  else openSearchSheet();
}

function ssSetTab(tab) {
  ss.tab = tab;
  $('#ssTabCompany').classList.toggle('active', tab === 'company');
  $('#ssTabProduct').classList.toggle('active', tab === 'product');
  $('#ssInput').placeholder = tab === 'company' ? '상호명·대표자 검색 (아래에서 바로 수정 가능)' : '품명·규격 검색 (전체 상호)';
  ssUpdate();
  $('#ssInput').focus();
}

async function ssUpdate() {
  const q = $('#ssInput').value.trim().toLowerCase();
  if (ss.tab === 'company') {
    ss.items = state.companies
      .filter((c) => !q || c.name.toLowerCase().includes(q) || (c.owner || '').toLowerCase().includes(q))
      .slice(0, 50);
  } else {
    const names = new Map(state.companies.map((c) => [c.id, c.name]));
    let all = [];
    try {
      all = await getAllProducts();
    } catch (e) { /* 미로그인 등 */ }
    ss.items = all
      .filter((p) => names.has(p.companyId))
      .filter((p) => !q || p.name.toLowerCase().includes(q) || (p.spec || '').toLowerCase().includes(q))
      .map((p) => Object.assign({}, p, { companyName: names.get(p.companyId) }))
      .slice(0, 50);
  }
  ss.sel = 0;
  ssRender();
}

const COMPANY_FIELDS = [
  { f: 'name', label: '상호명', cls: 'w-name' },
  { f: 'owner', label: '대표자명', cls: 'w-owner' },
  { f: 'bizNo', label: '사업자번호', cls: 'w-biz', ph: '000-00-00000' },
  { f: 'phone', label: '연락처', cls: 'w-phone' },
  { f: 'address', label: '주소', cls: 'w-addr' },
];

function ssRender() {
  const box = $('#ssResults');
  if (!ss.items.length) {
    box.innerHTML = '<p class="empty-cell">검색 결과가 없습니다.</p>';
    return;
  }
  if (ss.tab === 'company') {
    // 상호 정보를 입력칸으로 보여줘 그 자리에서 바로 고칠 수 있게 한다
    box.innerHTML = `
      <div class="ss-grid">
        <div class="ss-grid-head">
          ${COMPANY_FIELDS.map((c) => `<span class="${c.cls}">${c.label}</span>`).join('')}
          <span class="w-out">미수금</span><span class="w-pick"></span>
        </div>
        ${ss.items
          .map(
            (c, i) => `<div class="ss-row ${i === ss.sel ? 'sel' : ''}" data-i="${i}" data-id="${c.id}">
              ${COMPANY_FIELDS.map(
                (col) => `<input class="${col.cls}" data-f="${col.f}" data-id="${c.id}" value="${esc(c[col.f])}" placeholder="${col.ph || col.label}">`
              ).join('')}
              <span class="w-out num ${c.outstanding > 0 ? 'warn' : ''}">${won(c.outstanding)}원</span>
              <button type="button" class="w-pick primary ss-pick">선택</button>
            </div>`
          )
          .join('')}
      </div>`;
    $$('.ss-row input', box).forEach((inp) => {
      inp.addEventListener('change', () => saveCompanyField(inp));
      inp.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          inp.blur(); // change가 먼저 발생해 저장된다
        }
      });
    });
  } else {
    box.innerHTML = ss.items
      .map(
        (it, i) => `<div class="ss-item ${i === ss.sel ? 'sel' : ''}" data-i="${i}">
          <b>${esc(it.name)}</b>${it.spec ? `<span class="sub">${esc(it.spec)}</span>` : ''}
          <span class="sub">${esc(it.companyName)}</span>
          <span class="right">${won(it.price)}원</span>
        </div>`
      )
      .join('');
  }
  const selEl = box.querySelector('.ss-item.sel, .ss-row.sel');
  if (selEl) selEl.scrollIntoView({ block: 'nearest' });
  box.querySelectorAll('.ss-item, .ss-row').forEach((el) => {
    el.addEventListener('mousedown', (e) => {
      if (e.target.tagName === 'INPUT') return; // 입력칸 클릭은 수정, 그 외는 선택
      e.preventDefault();
      ssPick(Number(el.dataset.i));
    });
  });
}

// 검색창에서 고친 상호 정보를 저장한다
async function saveCompanyField(inp) {
  const id = Number(inp.dataset.id);
  const c = state.companies.find((x) => x.id === id);
  if (!c) return;
  const field = inp.dataset.f;
  const value = inp.value.trim();
  if (field === 'name' && !value) {
    inp.value = c.name;
    toast('상호명은 비울 수 없습니다.');
    return;
  }
  if (c[field] === value) return;
  const prev = c[field];
  c[field] = value;
  try {
    await api('PUT', '/api/companies/' + id, {
      name: c.name,
      owner: c.owner || '',
      bizNo: c.bizNo || '',
      phone: c.phone || '',
      address: c.address || '',
      memo: c.memo || '',
    });
    toast('상호 정보를 저장했습니다.');
    if (field === 'name' && String(id) === String(state.entryCompanyId)) applyEntryCompany(c);
    drawTxRows(); // 표의 상호명도 갱신
  } catch (err) {
    c[field] = prev;
    inp.value = prev;
    alert(err.message);
  }
}

function ssPick(i) {
  const it = ss.items[i];
  if (!it) return;
  if (ss.tab === 'company') {
    applyEntryCompany(it);
    closeSearchSheet();
    const name = $('#eName');
    if (name) name.focus();
  } else {
    const c = state.companies.find((x) => x.id === it.companyId);
    if (c) applyEntryCompany(c); // 제품을 고르면 그 제품의 상호까지 함께 적용
    const name = $('#eName');
    const spec = $('#eSpec');
    const price = $('#ePrice');
    if (name) name.value = it.name;
    if (spec) spec.value = it.spec;
    if (price) price.value = it.price;
    recomputeEntry();
    closeSearchSheet();
    const qty = $('#eQty');
    if (qty) {
      qty.focus();
      qty.select();
    }
  }
}

$('#ssTabCompany').addEventListener('click', () => ssSetTab('company'));
$('#ssTabProduct').addEventListener('click', () => ssSetTab('product'));
$('#ssClose').addEventListener('click', closeSearchSheet);
let ssTimer = null;
$('#ssInput').addEventListener('input', () => {
  clearTimeout(ssTimer);
  ssTimer = setTimeout(ssUpdate, 150);
});
$('#ssInput').addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    ss.sel = Math.min(ss.sel + 1, ss.items.length - 1);
    ssRender();
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    ss.sel = Math.max(ss.sel - 1, 0);
    ssRender();
  } else if (e.key === 'Enter') {
    e.preventDefault();
    ssPick(ss.sel);
  }
});

// ESC: 거래관리 어디서든 검색 시트 열기/닫기 (팝업·명세표가 열려 있을 땐 제외)
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || state.tab !== 'transactions') return;
  if (!$('#modal').classList.contains('hidden')) return;
  if (document.body.classList.contains('printing')) return;
  e.preventDefault();
  toggleSearchSheet();
});

/* ── 거래 입력/수정 폼 ── */
async function openTxForm(tx) {
  if (!state.companies.length) await refreshCompanies();
  if (!state.companies.length) {
    alert('먼저 상호관리에서 상호를 등록하세요.');
    return;
  }
  const companyId = tx ? tx.companyId : Number(state.txCompanyId) || state.companies[0].id;

  openModal(
    `
    <h2>${tx ? '거래 수정' : '새 거래'}</h2>
    <form id="txForm">
      <div class="form-grid">
        <label>상호 *
          <select name="companyId" id="txFormCompany">
            ${state.companies.map((c) => `<option value="${c.id}" ${c.id === companyId ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}
          </select>
        </label>
        <label>거래일자<input name="date" type="date" value="${esc(tx ? tx.date : today())}"></label>
        <label>부가세
          <select name="vatMode">
            ${Object.entries(VAT_LABEL).map(([v, l]) => `<option value="${v}" ${tx && tx.vatMode === v ? 'selected' : ''}>${l}</option>`).join('')}
          </select>
        </label>
      </div>
      <div class="table-wrap">
        <table class="items-table">
          <thead><tr><th>품명 * (자동완성)</th><th>규격</th><th class="w-qty">수량</th><th class="w-price">단가</th><th class="num">금액</th><th></th></tr></thead>
          <tbody id="itemRows"></tbody>
        </table>
      </div>
      <button type="button" id="btnAddItem">＋ 품목 추가</button>
      <p class="totals">공급가액 <b id="tSupply">0</b>원 · 세액 <b id="tTax">0</b>원 · 합계 <b id="tTotal">0</b>원</p>
      <div class="form-grid">
        <label>입금액<input name="paid" type="number" inputmode="numeric" min="0" value="${tx ? tx.paid : 0}"></label>
        <label>메모<input name="memo" value="${esc(tx && tx.memo)}"></label>
      </div>
      <div class="form-actions">
        <button type="button" data-close>취소</button>
        <button type="submit" class="primary">저장</button>
      </div>
    </form>`,
    true
  );

  const form = $('#txForm');

  function addRow(item) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><input class="i-name" value="${esc(item && item.name)}" placeholder="품명" autocomplete="off"></td>
      <td><input class="i-spec" value="${esc(item && item.spec)}" placeholder="규격"></td>
      <td><input class="i-qty" type="number" inputmode="decimal" step="any" value="${item ? item.qty : 1}"></td>
      <td><input class="i-price" type="number" inputmode="numeric" value="${item ? item.price : 0}"></td>
      <td class="num i-amount">0</td>
      <td><button type="button" class="i-del" title="품목 삭제">✕</button></td>`;
    attachProductAutocomplete($('.i-name', tr), () => form.companyId.value, (p) => {
      $('.i-name', tr).value = p.name;
      $('.i-spec', tr).value = p.spec;
      $('.i-price', tr).value = p.price;
      recompute();
    });
    tr.addEventListener('keydown', (e) => {
      if (e.key === '=' && e.target.tagName === 'INPUT') {
        e.preventDefault();
        const el = $('.i-price', tr);
        const v = Number(el.value) || 0;
        if (v !== 0) {
          el.value = -v;
          recompute();
        }
      }
    });
    $('#itemRows').appendChild(tr);
    recompute();
  }

  function recompute() {
    const vatMode = form.vatMode.value;
    let supply = 0;
    let tax = 0;
    $$('#itemRows tr').forEach((tr) => {
      const qty = Number($('.i-qty', tr).value) || 0;
      const price = Number($('.i-price', tr).value) || 0;
      const r = calcItem(qty, price, vatMode);
      $('.i-amount', tr).textContent = won(r.supply + r.tax);
      supply += r.supply;
      tax += r.tax;
    });
    $('#tSupply').textContent = won(supply);
    $('#tTax').textContent = won(tax);
    $('#tTotal').textContent = won(supply + tax);
  }

  form.addEventListener('input', recompute);
  form.vatMode.addEventListener('change', recompute);
  $('#btnAddItem').addEventListener('click', () => addRow(null));
  $('#itemRows').addEventListener('click', (e) => {
    if (e.target.classList.contains('i-del')) {
      e.target.closest('tr').remove();
      recompute();
    }
  });
  $('[data-close]').addEventListener('click', closeModal);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const items = $$('#itemRows tr')
      .map((tr) => ({
        name: $('.i-name', tr).value.trim(),
        spec: $('.i-spec', tr).value.trim(),
        qty: Number($('.i-qty', tr).value) || 0,
        price: Number($('.i-price', tr).value) || 0,
      }))
      .filter((it) => it.name);
    if (!items.length) {
      alert('품목을 1개 이상 입력하세요.');
      return;
    }
    const body = {
      companyId: Number(form.companyId.value),
      date: form.date.value,
      vatMode: form.vatMode.value,
      items,
      paid: Number(form.paid.value) || 0,
      memo: form.memo.value,
    };
    try {
      if (tx) await api('PUT', '/api/transactions/' + tx.id, body);
      else await api('POST', '/api/transactions', body);
      clearProductsCache(); // 자동 등록된 제품이 힌트에 바로 나오도록
      closeModal();
      toast('저장했습니다.');
      drawTxRows();
    } catch (err) {
      alert(err.message);
    }
  });

  if (tx) tx.items.forEach((it) => addRow(it));
  else addRow(null);
}

/* ─────────────── 입금(수금) 입력 ─────────────── */
async function openPaymentForm(pay) {
  await refreshCompanies();
  const company = pay ? state.companies.find((c) => c.id === pay.companyId) : null;
  const preset = company || state.companies.find((c) => String(c.id) === String(state.entryCompanyId || state.txCompanyId));
  openModal(`
    <h2>${pay ? '입금 수정' : '입금 받음'}</h2>
    <p class="hint">거래와 별개로 받은 돈을 적습니다. 미수금에서 자동으로 빠집니다.</p>
    <form id="payForm">
      <label>상호 *<input name="companyName" id="payCompany" required autocomplete="off" placeholder="상호 입력·검색" value="${esc(preset && preset.name)}"></label>
      <div class="form-grid">
        <label>날짜<input name="date" type="date" value="${esc(pay ? pay.date : today())}"></label>
        <label>받은 금액 *<input name="amount" type="number" inputmode="numeric" required value="${pay ? pay.amount : ''}" placeholder="0"></label>
      </div>
      <div class="form-grid">
        <label>받은 방법
          <select name="method">
            ${Object.entries(PAY_METHOD_LABEL).map(([v, l]) => `<option value="${v}" ${pay && pay.method === v ? 'selected' : ''}>${l}</option>`).join('')}
          </select>
        </label>
        <label>메모<input name="memo" value="${esc(pay && pay.memo)}"></label>
      </div>
      <div class="form-actions">
        <button type="button" data-close>취소</button>
        <button type="submit" class="primary">저장</button>
      </div>
    </form>`);
  $('[data-close]').addEventListener('click', closeModal);
  attachSearchDropdown($('#payCompany'), {
    minChars: 0,
    enterPicksFirst: true,
    getItems: async (q) => state.companies.filter((c) => !q || c.name.toLowerCase().includes(q)),
    itemHtml: (c) => `<b>${esc(c.name)}</b><span class="ac-price">미수 ${won(c.outstanding)}원</span>`,
    onPick: (c) => {
      $('#payCompany').value = c.name;
      $('#payForm').amount.focus();
    },
  });
  $('#payForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = Object.fromEntries(new FormData(e.target));
    body.amount = Number(body.amount) || 0;
    try {
      if (pay) await api('PUT', '/api/payments/' + pay.id, body);
      else await api('POST', '/api/payments', body);
      closeModal();
      toast('입금 내역을 저장했습니다.');
      await refreshCompanies();
      if (state.easyMode) drawEasyList();
      else drawTxRows();
    } catch (err) {
      alert(err.message);
    }
  });
}

/* ── 거래명세표 ── */
function partyTable(title, info) {
  return `
    <table class="party-table">
      <caption>${title}</caption>
      <tr><th>상호</th><td>${esc(info.name)}</td></tr>
      <tr><th>대표자</th><td>${esc(info.owner)}</td></tr>
      <tr><th>사업자번호</th><td>${esc(info.bizNo)}</td></tr>
      <tr><th>연락처</th><td>${esc(info.phone)}</td></tr>
      <tr><th>주소</th><td>${esc(info.address)}</td></tr>
    </table>`;
}

// 공급받는자 칸을 입력칸으로 — 명세표에서 바로 상호 정보를 채우면 상호관리에 저장된다
function partyTableEditable(c) {
  const f = (field, label, extra = '') =>
    `<tr><th>${label}</th><td><input class="party-input" data-f="${field}" value="${esc(c[field])}" ${extra}></td></tr>`;
  return `
    <table class="party-table">
      <caption>공급받는자</caption>
      <tr><th>상호</th><td>${esc(c.name)}</td></tr>
      ${f('owner', '대표자')}
      ${f('bizNo', '사업자번호', 'placeholder="000-00-00000"')}
      ${f('phone', '연락처', 'inputmode="tel"')}
      ${f('address', '주소')}
    </table>`;
}

function openStatement(tx) {
  const company = state.companies.find((c) => c.id === tx.companyId) || { name: tx.companyName || '' };
  const s = state.settings;
  const MIN_ROWS = 10;
  const rows = tx.items
    .map(
      (it, i) => `<tr>
        <td class="num">${i + 1}</td>
        <td>${esc(it.name)}</td>
        <td>${esc(it.spec)}</td>
        <td class="num">${won(it.qty)}</td>
        <td class="num">${won(it.price)}</td>
        <td class="num">${won(it.supply)}</td>
        <td class="num">${won(it.tax)}</td>
      </tr>`
    )
    .join('');
  let filler = '';
  for (let i = tx.items.length; i < MIN_ROWS; i++) filler += '<tr class="filler">' + '<td>&nbsp;</td>'.repeat(7) + '</tr>';

  $('#printSheet').innerHTML = `
    <div class="sheet">
      <h2 class="sheet-title">거 래 명 세 표</h2>
      <p class="sheet-date">거래일자: ${esc(tx.date)} (${VAT_LABEL[tx.vatMode] || ''})</p>
      <div class="sheet-parties">
        ${company.id ? partyTableEditable(company) : partyTable('공급받는자', company)}
        ${partyTable('공급자', s)}
      </div>
      <table class="sheet-items">
        <thead><tr><th>번호</th><th>품명</th><th>규격</th><th>수량</th><th>단가</th><th>공급가액</th><th>세액</th></tr></thead>
        <tbody>${rows}${filler}</tbody>
        <tfoot>
          <tr><th colspan="5">합계</th><td class="num">${won(tx.supplyTotal)}</td><td class="num">${won(tx.taxTotal)}</td></tr>
        </tfoot>
      </table>
      <table class="sheet-summary">
        <tr><th>합계금액</th><td class="num">${won(tx.total)}원</td><th>입금액</th><td class="num">${won(tx.paid)}원</td><th>잔액</th><td class="num">${won(tx.total - tx.paid)}원</td></tr>
      </table>
      ${tx.memo ? `<p class="sheet-memo">비고: ${esc(tx.memo)}</p>` : ''}
      <p class="sheet-sign">인수자: ____________ (인)</p>
    </div>`;
  // 공급받는자 칸 수정 → 상호관리에 바로 저장
  $$('#printSheet .party-input').forEach((inp) => {
    inp.addEventListener('change', async () => {
      company[inp.dataset.f] = inp.value.trim();
      try {
        await api('PUT', '/api/companies/' + company.id, {
          name: company.name,
          owner: company.owner || '',
          bizNo: company.bizNo || '',
          phone: company.phone || '',
          address: company.address || '',
          memo: company.memo || '',
        });
        toast('상호 정보를 저장했습니다.');
      } catch (err) {
        alert(err.message);
      }
    });
  });
  statementCtx = { tx, company };
  $('#btnShareSheet').classList.remove('hidden');
  document.body.classList.add('printing');
  $('#printOverlay').classList.remove('hidden');
}

// 거래명세표를 카톡·문자로 보내기 좋은 글로 만든다
function statementText(tx, company) {
  const s = state.settings;
  const lines = [
    `[거래명세서] ${tx.date}`,
    `${company.name} 귀하`,
    '',
    ...tx.items.map((it) => `· ${it.name}${it.spec ? '(' + it.spec + ')' : ''} ${won(it.qty)}개 x ${won(it.price)}원 = ${won(it.supply + it.tax)}원`),
    '',
    `공급가액 ${won(tx.supplyTotal)}원 / 세액 ${won(tx.taxTotal)}원`,
    `합계 ${won(tx.total)}원`,
  ];
  if (tx.paid) lines.push(`입금 ${won(tx.paid)}원 / 잔액 ${won(tx.total - tx.paid)}원`);
  if (tx.memo) lines.push(`비고: ${tx.memo}`);
  if (s.name) {
    lines.push('', `${s.name}${s.owner ? ' ' + s.owner : ''}`);
    if (s.phone) lines.push(s.phone);
    if (s.bizNo) lines.push(`사업자 ${s.bizNo}`);
  }
  return lines.join('\n');
}

let statementCtx = null; // 지금 열려 있는 명세표

$('#btnShareSheet').addEventListener('click', async () => {
  if (!statementCtx) return;
  const text = statementText(statementCtx.tx, statementCtx.company);
  try {
    if (navigator.share) {
      await navigator.share({ title: '거래명세서', text });
      return;
    }
    await navigator.clipboard.writeText(text);
    toast('명세서 내용을 복사했습니다. 카톡에 붙여넣으세요.');
  } catch (e) {
    if (e && e.name === 'AbortError') return; // 사용자가 공유를 취소함
    prompt('아래 내용을 복사해 보내세요.', text);
  }
});

$('#btnDoPrint').addEventListener('click', () => window.print());
$('#btnClosePrint').addEventListener('click', () => {
  document.body.classList.remove('printing');
  $('#printOverlay').classList.add('hidden');
});

/* ─────────────── 내 정보 (설정) ─────────────── */
function renderSettings() {
  const s = state.settings;
  $('#main').innerHTML = `
    <div class="stack">
      <section class="card">
        <h2>내 사업자 정보</h2>
        <p class="hint">거래명세표의 '공급자' 칸에 인쇄되는 정보입니다.</p>
        <form id="settingsForm">
          <label>상호명<input name="name" value="${esc(s.name)}"></label>
          <label>대표자<input name="owner" value="${esc(s.owner)}"></label>
          <label>사업자등록번호<input name="bizNo" value="${esc(s.bizNo)}" placeholder="000-00-00000"></label>
          <label>연락처<input name="phone" value="${esc(s.phone)}" inputmode="tel"></label>
          <label>주소<input name="address" value="${esc(s.address)}"></label>
          <div class="form-actions">
            <button type="submit" class="primary">저장</button>
          </div>
        </form>
      </section>
      <section class="card">
        <h2>비밀번호 변경</h2>
        <p class="hint">변경하면 다른 기기에서는 다시 로그인해야 합니다.</p>
        <form id="pwForm">
          <label>현재 비밀번호<input name="current" type="password" required autocomplete="current-password"></label>
          <label>새 비밀번호<input name="next" type="password" required minlength="4" autocomplete="new-password"></label>
          <div class="form-actions">
            <button type="submit" class="primary">변경</button>
          </div>
        </form>
      </section>
      <section class="card">
        <h2>데이터 백업 · 복원</h2>
        <p class="hint">모든 장부 데이터가 담긴 파일을 내려받습니다. 안전한 곳에 보관하세요.</p>
        <a class="btn-link" href="/api/backup" download>💾 백업 파일 다운로드</a>
        <hr class="divider">
        <p class="hint">백업 파일로 장부 전체를 되돌립니다. 다른 곳(예: 기존 PC)에서 받은 백업을
        여기에 올리면 데이터가 그대로 옮겨집니다. <b>현재 데이터는 모두 교체</b>되고, 비밀번호는 지금 것이 유지됩니다.</p>
        <label class="btn-link restore-btn">📂 백업 파일로 복원<input type="file" id="restoreFile" accept=".json,application/json" hidden></label>
      </section>
    </div>`;
  $('#settingsForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    state.settings = await api('PUT', '/api/settings', Object.fromEntries(new FormData(e.target)));
    toast('내 정보를 저장했습니다.');
  });
  $('#pwForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('POST', '/api/auth/password', Object.fromEntries(new FormData(e.target)));
      e.target.reset();
      toast('비밀번호를 변경했습니다.');
    } catch (err) {
      alert(err.message);
    }
  });
  $('#restoreFile').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    if (!confirm(`'${file.name}' 파일의 내용으로 장부 전체를 교체할까요?\n현재 등록된 상호·제품·거래가 모두 백업 파일 내용으로 바뀝니다.`)) return;
    try {
      const data = JSON.parse(await file.text());
      await api('POST', '/api/restore', data);
      toast('복원했습니다.');
      state.settings = await api('GET', '/api/settings');
      render();
    } catch (err) {
      alert('복원 실패: ' + (err.message || '파일을 읽을 수 없습니다.'));
    }
  });
}

/* ─────────────── 관리자 (계정 관리) ─────────────── */
async function renderAdmin() {
  const users = await api('GET', '/api/admin/users');
  const pending = users.filter((u) => u.status === 'pending').length;
  const badge = (s) =>
    s === 'approved' ? '<span class="badge ok">승인됨</span>'
    : s === 'rejected' ? '<span class="badge no">거절됨</span>'
    : '<span class="badge wait">대기중</span>';
  $('#main').innerHTML = `
    <section class="card">
      <h2>계정 관리</h2>
      <p class="summary">전체 ${users.length}명 · 승인 대기 ${pending}명</p>
      <div class="table-wrap">
        <table>
          <thead><tr><th>아이디</th><th>가입일</th><th>상태</th><th class="actions"></th></tr></thead>
          <tbody id="adminRows">
            ${users
              .map(
                (u) => `<tr class="${u.status === 'pending' ? 'row-pending' : ''}">
                  <td><b>${esc(u.username)}</b>${u.isAdmin ? ' <span class="badge admin">관리자</span>' : ''}</td>
                  <td>${esc((u.createdAt || '').slice(0, 10))}</td>
                  <td>${badge(u.status)}</td>
                  <td class="actions">${
                    u.isAdmin
                      ? ''
                      : `${u.status !== 'approved' ? `<button data-act="approve" data-u="${esc(u.username)}" class="primary">승인</button>` : ''}
                         ${u.status !== 'rejected' ? `<button data-act="reject" data-u="${esc(u.username)}">거절</button>` : ''}
                         <button data-act="del" data-u="${esc(u.username)}" class="danger">삭제</button>`
                  }</td>
                </tr>`
              )
              .join('')}
          </tbody>
        </table>
      </div>
      <p class="hint">승인된 계정만 장부를 사용할 수 있습니다. 거절하면 해당 계정은 로그인해도 이용할 수 없습니다.<br>
      삭제하면 그 계정의 장부 데이터도 함께 사라집니다.</p>
    </section>`;
  $('#adminRows').onclick = async (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const username = btn.dataset.u;
    const act = btn.dataset.act;
    try {
      if (act === 'approve') {
        await api('POST', '/api/admin/users/' + encodeURIComponent(username) + '/approve');
        toast(`'${username}' 계정을 승인했습니다.`);
      } else if (act === 'reject') {
        if (!confirm(`'${username}' 계정의 이용을 거절할까요?`)) return;
        await api('POST', '/api/admin/users/' + encodeURIComponent(username) + '/reject');
        toast(`'${username}' 계정을 거절했습니다.`);
      } else if (act === 'del') {
        if (!confirm(`'${username}' 계정을 삭제할까요?\n이 계정의 장부 데이터도 모두 삭제됩니다.`)) return;
        await api('DELETE', '/api/admin/users/' + encodeURIComponent(username));
        toast(`'${username}' 계정을 삭제했습니다.`);
      }
      renderAdmin();
    } catch (err) {
      alert(err.message);
    }
  };
}

/* ─────────────── 온보딩 (승인 후 첫 진입) ─────────────── */
function renderOnboarding() {
  $('#tabs').classList.add('hidden');
  $('#main').innerHTML = `
    <section class="card narrow">
      <h2>🎉 시작하기 전에</h2>
      <p class="hint">내 업체 정보를 등록해 주세요. 거래명세표의 '공급자' 칸에 이대로 인쇄됩니다.<br>
      [내 정보] 탭에서 언제든 고칠 수 있습니다.</p>
      <form id="onboardForm">
        <label>상호명 *<input name="name" required placeholder="예: 우리컴퓨터"></label>
        <label>대표자<input name="owner"></label>
        <label>사업자등록번호<input name="bizNo" placeholder="000-00-00000"></label>
        <label>연락처<input name="phone" inputmode="tel"></label>
        <label>주소<input name="address"></label>
        <div class="form-actions">
          <button type="button" id="btnSkipOnboard">나중에 하기</button>
          <button type="submit" class="primary">저장하고 시작하기</button>
        </div>
      </form>
    </section>`;
  $('#onboardForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      state.settings = await api('PUT', '/api/settings', Object.fromEntries(new FormData(e.target)));
    } catch (err) {
      alert(err.message);
      return;
    }
    toast('업체 정보를 저장했습니다. 이제 거래를 입력해 보세요!');
    $('#tabs').classList.remove('hidden');
    state.tab = 'transactions';
    $$('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === 'transactions'));
    render(); // 거래관리로 이동하며 사용법 안내가 이어서 시작된다
  });
  $('#btnSkipOnboard').addEventListener('click', () => {
    try {
      localStorage.setItem('skipOnboarding', '1');
    } catch (e) { /* 무시 */ }
    $('#tabs').classList.remove('hidden');
    render();
  });
}

/* ─────────────── 승인 대기 / 거절 화면 ─────────────── */
function renderBlocked(st) {
  const rejected = st.status === 'rejected';
  $('#tabs').classList.add('hidden');
  $('#main').innerHTML = `
    <section class="card narrow">
      <div class="empty-notice">
        <p class="blocked-icon">${rejected ? '🚫' : '⏳'}</p>
        <p><b>${rejected ? '가입이 거절되었습니다.' : '관리자 승인을 기다리고 있습니다.'}</b></p>
        <p class="hint">${rejected ? '자세한 내용은 관리자에게 문의하세요.' : '가입 신청이 접수되었습니다.<br>관리자가 승인하면 바로 장부를 사용할 수 있습니다.'}</p>
        ${rejected ? '' : '<button class="primary" id="btnRecheck">승인됐는지 확인</button>'}
      </div>
    </section>`;
  const btn = $('#btnRecheck');
  if (btn) btn.addEventListener('click', () => location.reload());
}

/* ─────────────── 사용법 안내 (스포트라이트 튜토리얼) ─────────────── */
const TOUR_STEPS = [
  {
    sel: '.ledger-table thead',
    title: '여기가 장부입니다',
    body: '거래 내역이 옛날→최신 순으로 쌓입니다. 머리글은 항상 위에 고정되어 있어 아래로 내려도 어떤 칸인지 보입니다.',
    pos: 'bottom',
  },
  {
    sel: '.entry-row',
    title: '맨 아래 파란 줄에 바로 적으세요',
    body: '날짜·상호·품명·수량·단가를 적고 Enter를 누르면 즉시 저장되고, 다음 줄을 이어서 적을 수 있습니다. 공급가액·세액·합계는 자동으로 계산됩니다.',
    pos: 'top',
  },
  {
    sel: '#eCompany',
    title: '상호는 그냥 적으면 등록됩니다',
    body: '클릭하면 등록된 상호 목록이 뜨고, 몇 글자만 쳐도 찾아줍니다. 처음 보는 상호명을 적으면 자동으로 새로 등록되니 미리 만들어 둘 필요가 없습니다. 한 번 정하면 계속 유지됩니다.',
    pos: 'top',
  },
  {
    sel: '#eName',
    title: '품명도 자동으로 쌓입니다',
    body: '몇 글자 치면 그 상호에서 팔던 제품이 힌트로 뜹니다. 골라 쓰면 규격·단가가 자동으로 채워집니다. 새 품명은 적는 순간 제품으로 등록되고, 단가를 바꿔 적으면 최신 단가로 갱신됩니다. 같은 걸 또 적을 땐 품명을 비운 채 Enter만 눌러도 직전 품목이 그대로 들어갑니다.',
    pos: 'top',
  },
  {
    sel: '#ePrice',
    title: '반품·차감은 = 키로',
    body: '단가를 적고 = 키를 누르면 마이너스로 바뀝니다(한 번 더 누르면 원래대로). 마이너스 금액은 표에서 빨간색으로 보입니다.',
    pos: 'top',
  },
  {
    sel: '#txRows tr[data-id]',
    title: '행을 눌러 체크하고 소계 보기',
    body: '행 아무 곳이나 누르면 체크됩니다. 체크한 뒤 = 키를 누르면 다음 줄이 연달아 체크되고, − 는 건너뛰기, Backspace 는 되돌리기입니다. 체크한 것들의 합계가 위에 표시됩니다.',
    pos: 'bottom',
    optional: true,
  },
  {
    sel: '#fFrom',
    title: '기간·상호·품명으로 찾기',
    body: '날짜 범위, 상호, 품명으로 걸러 볼 수 있습니다. 걸러낸 결과의 합계도 함께 계산되며, [초기화]로 조건을 한 번에 지웁니다.',
    pos: 'bottom',
  },
  {
    sel: '#btnQuickSearch',
    title: 'ESC 로 빠른 검색',
    body: '언제든 ESC(또는 이 버튼)를 누르면 아래에서 검색창이 올라옵니다. 상호·제품을 찾아 고르면 입력 줄에 바로 채워집니다.',
    pos: 'left',
  },
  {
    sel: '#txRows tr[data-id] button[data-act="sheet"]',
    title: '거래명세표 인쇄',
    body: '[명세표] 버튼으로 거래명세표를 띄워 인쇄하거나 PDF로 저장합니다. 공급받는자 정보는 명세표에서 바로 고칠 수 있고, 공급자 정보는 [내 정보] 탭에서 설정합니다.',
    pos: 'bottom',
    optional: true,
  },
  {
    sel: '#btnPin',
    title: '저장 후 커서 자리 정하기 (커서 고정)',
    body: '저장하면 커서는 품명 칸으로 돌아갑니다. 다른 칸에서 이어 적고 싶으면, 그 칸을 누른 뒤 F2(또는 이 📌 버튼)를 누르세요. 저장할 때마다 고정한 칸으로 돌아갑니다. 한 번 더 누르면 해제됩니다.',
    pos: 'top',
  },
  {
    sel: '#btnHelp',
    title: '다시 보고 싶을 땐 여기',
    body: '이 [?] 버튼을 누르면 언제든 사용법을 다시 볼 수 있습니다. 이제 첫 거래를 적어 보세요!',
    pos: 'left',
  },
];

const tour = { steps: [], i: 0 };

function tourVisible(sel) {
  const el = $(sel);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 ? el : null;
}

function startTour() {
  if (state.easyMode) {
    alert('큰 글씨 모드에서는 화면 그대로 하나씩 적으면 됩니다.\n날짜 → 상호 → 품명 → 수량 → 단가를 채우고 [저장하기]를 누르세요.');
    return;
  }
  if (state.tab !== 'transactions') {
    const btn = $('#tabs button[data-tab="transactions"]');
    if (btn) btn.click();
    setTimeout(startTour, 350); // 탭이 그려진 뒤 시작
    return;
  }
  // 화면에 실제로 있는 단계만 사용 (거래가 없으면 행 관련 단계는 건너뜀)
  tour.steps = TOUR_STEPS.filter((s) => !s.optional || tourVisible(s.sel));
  tour.i = 0;
  $('#tourOverlay').classList.remove('hidden');
  showTourStep();
}

function endTour() {
  $('#tourOverlay').classList.add('hidden');
  try {
    localStorage.setItem('tourDone', '1');
  } catch (e) { /* 무시 */ }
}

function showTourStep() {
  const step = tour.steps[tour.i];
  if (!step) return endTour();
  const el = tourVisible(step.sel);
  if (!el) { // 못 찾으면 다음 단계로
    tour.i += 1;
    return showTourStep();
  }
  el.scrollIntoView({ block: 'center', behavior: 'instant' });

  const r = el.getBoundingClientRect();
  const pad = 6;
  const spot = $('#tourSpot');
  spot.style.top = r.top - pad + 'px';
  spot.style.left = r.left - pad + 'px';
  spot.style.width = r.width + pad * 2 + 'px';
  spot.style.height = r.height + pad * 2 + 'px';

  $('#tourStep').textContent = `${tour.i + 1} / ${tour.steps.length}`;
  $('#tourTitle').textContent = step.title;
  $('#tourBody').textContent = step.body;
  $('#tourPrev').classList.toggle('hidden', tour.i === 0);
  $('#tourNext').textContent = tour.i === tour.steps.length - 1 ? '시작하기' : '다음';

  // 말풍선을 강조 영역 옆에 놓되 화면 밖으로 나가지 않게 한다
  const box = $('#tourBox');
  box.style.visibility = 'hidden';
  box.style.top = '0px';
  box.style.left = '0px';
  requestAnimationFrame(() => {
    const b = box.getBoundingClientRect();
    const gap = 14;
    let top;
    let left;
    if (step.pos === 'top') top = r.top - b.height - gap;
    else if (step.pos === 'left' || step.pos === 'right') top = r.top + r.height / 2 - b.height / 2;
    else top = r.bottom + gap;
    if (step.pos === 'left') left = r.left - b.width - gap;
    else if (step.pos === 'right') left = r.right + gap;
    else left = r.left + r.width / 2 - b.width / 2;

    // 넘치면 반대편으로 뒤집고, 그래도 넘치면 화면 안으로 밀어 넣는다
    if (top < 8) top = r.bottom + gap;
    if (top + b.height > window.innerHeight - 8) top = Math.max(8, r.top - b.height - gap);
    left = Math.min(Math.max(8, left), window.innerWidth - b.width - 8);
    top = Math.min(Math.max(8, top), window.innerHeight - b.height - 8);

    box.style.top = top + 'px';
    box.style.left = left + 'px';
    box.style.visibility = 'visible';
  });
}

$('#tourNext').addEventListener('click', () => {
  tour.i += 1;
  if (tour.i >= tour.steps.length) endTour();
  else showTourStep();
});
$('#tourPrev').addEventListener('click', () => {
  tour.i = Math.max(0, tour.i - 1);
  showTourStep();
});
$('#tourSkip').addEventListener('click', endTour);
$('#tourOverlay').addEventListener('click', (e) => {
  if (e.target.id === 'tourOverlay') endTour(); // 배경 클릭으로 종료
});
document.addEventListener('keydown', (e) => {
  if ($('#tourOverlay').classList.contains('hidden')) return;
  if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    endTour();
  } else if (e.key === 'ArrowRight' || e.key === 'Enter') {
    e.preventDefault();
    $('#tourNext').click();
  } else if (e.key === 'ArrowLeft') {
    e.preventDefault();
    $('#tourPrev').click();
  }
}, true);
window.addEventListener('resize', () => {
  if (!$('#tourOverlay').classList.contains('hidden')) showTourStep();
});

/* ─────────────── 시작 ─────────────── */
$('#btnLogout').addEventListener('click', async () => {
  if (!confirm('로그아웃할까요?')) return;
  await api('POST', '/api/auth/logout');
  location.href = '/login.html';
});

(async function init() {
  api('GET', '/api/version')
    .then((v) => { $('#verFooter').textContent = `거래장부 v${v.version} · ${v.commit}`; })
    .catch(() => {});
  const hash = location.hash.slice(1);
  if (['companies', 'products', 'transactions', 'reports', 'settings', 'admin'].includes(hash)) {
    state.tab = hash;
    $$('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === hash));
  }
  try {
    const st = await api('GET', '/api/auth/status');
    if (!st.authed) {
      location.href = '/login.html';
      return;
    }
    state.me = st;
    $('#whoami').textContent = st.username ? st.username + '님' : '';
    if (st.status !== 'approved') {
      renderBlocked(st);
      return;
    }
    if (st.isAdmin) $('#tabAdminBtn').classList.remove('hidden');
    state.settings = await api('GET', '/api/settings');
    await refreshCompanies();
  } catch (e) {
    $('#main').innerHTML = `<section class="card"><p class="empty-notice">서버에 연결할 수 없습니다: ${esc(e.message)}</p></section>`;
    return;
  }
  // 승인 후 첫 진입이면 내 업체 정보 등록(온보딩)부터
  let skipOnboarding = false;
  try {
    skipOnboarding = localStorage.getItem('skipOnboarding') === '1';
  } catch (e) { /* 무시 */ }
  if (!state.settings.name && !skipOnboarding) {
    renderOnboarding();
    return;
  }
  render();
})();
