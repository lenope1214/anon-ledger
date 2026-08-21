'use strict';

const APP_VERSION = '1.20.5'; // 버전을 올릴 때 package.json·index.html·login.html의 ?v= 와 같이 맞춘다

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
  entryKind: 'sale',    // 새로 적는 줄의 참조(구분)
  txKindFilter: '',     // 거래 필터: '' 전체 / 참조 이름
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
  const savedKind = localStorage.getItem('entryKind');
  if (savedKind) state.entryKind = savedKind;
  state.easyMode = localStorage.getItem('easyMode') === '1';
} catch (e) { /* localStorage 사용 불가 환경 */ }

const VAT_LABEL = { separate: '부가세 별도', included: '부가세 포함', none: '부가세 없음' };
// 참조(거래 구분) 6가지 — 컴장부와 같은 이름·동작
//  입금/출금: 품목 없이 금액만 적는다 (돈만 오감)
//  외출/매출: 물건이 나감 (외출 = 아직 정산 안 됨)
//  외입/매입: 물건이 들어옴 (외입 = 아직 정산 안 됨)
const KINDS = {
  deposit:         { label: '입금', pair: 'withdraw',        cls: 'kind-in',   help: '돈이 들어옴 (금액만)' },
  withdraw:        { label: '출금', pair: 'deposit',         cls: 'kind-out',  help: '돈이 나감 (금액만)' },
  credit_sale:     { label: '외출', pair: 'sale',            cls: 'kind-csale', help: '물건 나감 · 아직 정산 안 됨' },
  sale:            { label: '매출', pair: 'credit_sale',     cls: 'kind-sale', help: '물건 나감 · 정산됨' },
  credit_purchase: { label: '외입', pair: 'purchase',        cls: 'kind-cbuy', help: '물건 들어옴 · 아직 정산 안 됨' },
  purchase:        { label: '매입', pair: 'credit_purchase', cls: 'kind-buy',  help: '물건 들어옴 · 정산됨' },
};
const KIND_LIST = Object.keys(KINDS);
const KIND_LABEL = Object.fromEntries(KIND_LIST.map((k) => [k, KINDS[k].label]));
const MONEY_ONLY = ['deposit', 'withdraw'];                 // 품목 없이 금액만
const OUT_KINDS = ['sale', 'credit_sale'];                  // 물건이 나간 것(매출류)
const IN_KINDS = ['purchase', 'credit_purchase'];           // 물건이 들어온 것(매입류)
const kindOf = (k) => (KINDS[k] ? k : 'sale');
const isMoneyOnly = (k) => MONEY_ONLY.includes(kindOf(k));

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
// 컴장부와 같은 부호 규칙: 공급가액 = 수량 × 단가 × (−1)
// 물건이 나가면(수량 −) 받을 돈이라 +, 물건이 들어오면(수량 +) 줄 돈이라 −
function calcItem(qty, price, vatMode) {
  const amount = -Math.round(qty * price);
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
          <thead><tr><th>상호명</th><th>대표자</th><th>연락처</th><th class="num">거래횟수</th><th class="num">매출</th><th class="num">매입</th><th class="actions"></th></tr></thead>
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
    tbody.innerHTML = `<tr><td colspan="7" class="empty-cell">${state.companies.length ? '검색 결과가 없습니다.' : '등록된 상호가 없습니다. [＋ 상호 등록] 버튼으로 시작하세요.'}</td></tr>`;
    return;
  }
  tbody.innerHTML = list
    .map(
      (c) => `<tr>
        <td><b>${esc(c.name)}</b>${c.memo ? `<div class="sub">${esc(c.memo)}</div>` : ''}</td>
        <td>${esc(c.owner)}</td>
        <td>${esc(c.phone)}</td>
        <td class="num">${won(c.txCount)}건</td>
        <td class="num">${won(c.total)}원</td>
        <td class="num">${won(c.buyTotal || 0)}원</td>
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
// 한 상호의 거래(매출·매입)를 날짜순으로 늘어놓는다.
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
  const txs = await api('GET', '/api/transactions?companyId=' + c.id);

  const inRange = (d) => (!ledgerView.from || d >= ledgerView.from) && (!ledgerView.to || d <= ledgerView.to);
  const all = txs
    .map((t) => ({
      buy: IN_KINDS.includes(kindOf(t.kind)),
      date: t.date, id: t.id,
      label: `[${KIND_LABEL[kindOf(t.kind)]}] ` + (t.items && t.items.length ? itemLabel(t) : ''),
      amount: t.total,
      tx: t,
    }))
    .sort((a, b) => a.date.localeCompare(b.date) || a.id - b.id);

  const rows = all.filter((r) => inRange(r.date));
  const body = rows
    .map(
      (r) => `<tr class="${r.buy ? 'row-buy' : ''}">
        <td>${esc(r.date)}</td>
        <td>${esc(r.label)}</td>
        <td class="num ${r.amount < 0 ? 'neg' : ''}">${r.buy ? '' : won(r.amount)}</td>
        <td class="num">${r.buy ? won(Math.abs(r.amount)) : ''}</td>
      </tr>`
    )
    .join('');

  const sales = rows.filter((r) => !r.buy).reduce((s, r) => s + r.amount, 0);
  const bought = Math.abs(rows.filter((r) => r.buy).reduce((s, r) => s + r.amount, 0));

  $('#main').innerHTML = `
    <section class="card">
      <div class="section-head">
        <button id="btnLedgerBack">← 상호 목록</button>
        <input type="date" id="lgFrom" class="date-filter" value="${esc(ledgerView.from)}" title="시작일">
        <span class="range-sep">~</span>
        <input type="date" id="lgTo" class="date-filter" value="${esc(ledgerView.to)}" title="종료일">
        <button id="btnLgClear">전체 기간</button>
        <button id="btnLgPrint" class="primary">🖨 원장 인쇄</button>
      </div>
      <div id="ledgerSheet">
        <div class="sheet">
          <h2 class="sheet-title">거 래 처 원 장</h2>
          <p class="sheet-date">${esc(c.name)}${c.owner ? ' (' + esc(c.owner) + ')' : ''} · 기간: ${esc(ledgerView.from || '처음')} ~ ${esc(ledgerView.to || '오늘')}</p>
          <table class="sheet-items ledger-doc">
            <thead><tr><th>날짜</th><th>내용</th><th class="num">매출</th><th class="num">매입</th></tr></thead>
            <tbody>
              ${body || `<tr><td colspan="4" class="empty-cell">이 기간에 거래 내역이 없습니다.</td></tr>`}
            </tbody>
            <tfoot>
              <tr><th>합계</th><th></th><th class="num">${won(sales)}</th><th class="num">${won(bought)}</th></tr>
            </tfoot>
          </table>
          <p class="sheet-memo">매출 <b>${won(sales)}원</b>${bought ? ` · 매입 <b>${won(bought)}원</b> · 이익 <b>${won(sales - bought)}원</b>` : ''}${
            ledgerView.from || ledgerView.to ? ' (표시 기간 기준)' : ''
          }</p>
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
const reportView = { mode: 'profit', year: '' };

async function renderReports() {
  await refreshCompanies();
  const txs = await api('GET', '/api/transactions');
  const years = [...new Set(txs.map((t) => t.date.slice(0, 4)))].sort().reverse();
  if (!reportView.year || !years.includes(reportView.year)) reportView.year = years[0] || String(new Date().getFullYear());
  const y = reportView.year;

  const MODES = { profit: '월별 손익', company: '거래처별', product: '품목별' };
  const sales = txs.filter((t) => OUT_KINDS.includes(kindOf(t.kind)));  // 매출 + 외출
  const buys = txs.filter((t) => IN_KINDS.includes(kindOf(t.kind)));    // 매입 + 외입
  let table = '';

  if (reportView.mode === 'profit') {
    // 월별 매출 − 매입 = 이익 (누적 이익까지)
    const rows = [];
    let cum = 0;
    for (let m = 1; m <= 12; m++) {
      const key = `${y}-${String(m).padStart(2, '0')}`;
      const sale = sales.filter((t) => t.date.startsWith(key)).reduce((s, t) => s + t.total, 0);
      const buy = Math.abs(buys.filter((t) => t.date.startsWith(key)).reduce((s, t) => s + t.total, 0));
      if (!sale && !buy) continue;
      cum += sale - buy;
      rows.push([`${m}월`, won(sale), won(buy), won(sale - buy), won(cum)]);
    }
    const saleSum = sales.filter((t) => t.date.startsWith(y)).reduce((s, t) => s + t.total, 0);
    const buySum = Math.abs(buys.filter((t) => t.date.startsWith(y)).reduce((s, t) => s + t.total, 0));
    table = rows.length
      ? plainTable(['월', '매출', '매입', '이익', '누적 이익'], rows, ['합계', won(saleSum), won(buySum), won(saleSum - buySum), ''])
      : '<p class="empty-cell">이 해에 기록된 내역이 없습니다.</p>';
  } else if (reportView.mode === 'company') {
    // 거래처마다 매출·매입·이익
    const rows = state.companies
      .map((c) => {
        const sale = sales.filter((t) => t.companyId === c.id && t.date.startsWith(y)).reduce((s, t) => s + t.total, 0);
        const buy = Math.abs(buys.filter((t) => t.companyId === c.id && t.date.startsWith(y)).reduce((s, t) => s + t.total, 0));
        const count = txs.filter((t) => t.companyId === c.id && t.date.startsWith(y)).length;
        return { name: c.name, count, sale, buy };
      })
      .filter((r) => r.count)
      .sort((a, b) => b.sale - a.sale || b.buy - a.buy);
    table = rows.length
      ? plainTable(
          ['상호', '건수', '매출', '매입', '이익'],
          rows.map((r) => [r.name, won(r.count), won(r.sale), won(r.buy), won(r.sale - r.buy)]),
          [
            '합계',
            won(rows.reduce((s, r) => s + r.count, 0)),
            won(rows.reduce((s, r) => s + r.sale, 0)),
            won(rows.reduce((s, r) => s + r.buy, 0)),
            won(rows.reduce((s, r) => s + r.sale - r.buy, 0)),
          ]
        )
      : '<p class="empty-cell">이 해에 기록된 내역이 없습니다.</p>';
  } else {
    const map = new Map();
    sales
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
      <p class="hint">${y}년 기준입니다.${
        reportView.mode === 'profit'
          ? ' 매출은 판 것, 매입은 산 것(지출)이며 이익 = 매출 − 매입입니다.'
          : ' 매출 집계에는 매입(산 것) 줄이 들어가지 않습니다.'
      } 표를 그대로 엑셀로 받아 세무사에게 전달할 수 있습니다.</p>
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

// 자유 형식 표 (첫 칸은 글자, 나머지는 숫자 오른쪽 정렬)
function plainTable(heads, rows, footer) {
  return `<table id="reportTable">
    <thead><tr>${heads.map((h, i) => `<th class="${i ? 'num' : ''}">${esc(h)}</th>`).join('')}</tr></thead>
    <tbody>
      ${rows
        .map((r) => `<tr>${r.map((v, i) => `<td class="${i ? 'num' : ''}">${i ? esc(v) : `<b>${esc(v)}</b>`}</td>`).join('')}</tr>`)
        .join('')}
    </tbody>
    ${footer ? `<tfoot><tr>${footer.map((v, i) => `<th class="${i ? 'num' : ''}">${esc(v)}</th>`).join('')}</tr></tfoot>` : ''}
  </table>`;
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

// 거래 내역을 그대로 엑셀(CSV)로 내려받는다 (지금 걸린 검색 조건 기준)
function exportTransactionsCsv() {
  const inRange = (d) => (!state.txFrom || d >= state.txFrom) && (!state.txTo || d <= state.txTo);
  const q = state.txProductQuery.trim().toLowerCase();
  const txRows = txCache
    .filter((t) => inRange(t.date))
    .filter((t) => !q || t.items.some((it) => it.name.toLowerCase().includes(q)))
    .filter((t) => !state.txKindFilter || kindOf(t.kind) === state.txKindFilter)
    .flatMap((t) =>
      t.items.map((it) => [
        t.date, t.companyName, KIND_LABEL[kindOf(t.kind)],
        it.name, it.spec, it.qty, it.price, it.supply, it.tax, it.supply + it.tax, t.memo,
      ])
    );
  const rows = txRows.sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  if (!rows.length) return toast('내려받을 내역이 없습니다.');
  const head = ['날짜', '상호', '구분', '품명', '규격', '수량', '단가', '공급가액', '세액', '합계', '메모'];
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
let checkedTxIds = new Set(); // 체크된 줄 (새로고침 전까지 유지, 't123'/'p45' 형태)

const rowKey = (tr) => 't' + tr.dataset.id;
let sheetLastIdx = null;      // 마지막으로 체크한 행 위치 (Ins 연속 체크용)

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
    <section class="card" id="txCard">
      <button type="button" id="btnToolsToggle" class="tools-toggle">🔧 검색조건·도구 열기</button>
      <div class="section-head tx-head">
        <select id="txCompany">
          <option value="">전체 상호</option>
          ${state.companies.map((c) => `<option value="${c.id}" ${String(c.id) === state.txCompanyId ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}
        </select>
        <input type="date" id="fFrom" class="date-filter" value="${esc(state.txFrom)}" title="시작일">
        <span class="range-sep">~</span>
        <input type="date" id="fTo" class="date-filter" value="${esc(state.txTo)}" title="종료일">
        <input type="search" id="fProduct" placeholder="품명 검색" value="${esc(state.txProductQuery)}">
        <button id="btnClearFilter" title="검색 조건 초기화">초기화</button>
        <select id="kindFilter" class="vat-select" title="매출·매입 걸러 보기">
          <option value="" ${state.txKindFilter === '' ? 'selected' : ''}>참조 전체 보기</option>
          ${KIND_LIST.map((k) => `<option value="${k}" ${state.txKindFilter === k ? 'selected' : ''}>${KINDS[k].label}만 보기</option>`).join('')}
        </select>
        <select id="entryKind" class="vat-select" title="새로 적는 줄의 참조 (= 키로 반전)">
          ${KIND_LIST.map((k) => `<option value="${k}" ${k === state.entryKind ? 'selected' : ''} title="${esc(KINDS[k].help)}">${KINDS[k].label}</option>`).join('')}
        </select>
        <select id="entryVat" class="vat-select" title="새로 적는 줄의 부가세 방식">
          ${Object.entries(VAT_LABEL).map(([v, l]) => `<option value="${v}" ${v === state.entryVat ? 'selected' : ''}>${l}</option>`).join('')}
        </select>
        <button id="btnAddTx" title="한 거래에 품목을 여러 개 적습니다">＋품목</button>
        <button id="btnEasyOn" title="글씨를 크게 해서 하나씩 입력합니다">🔎큰글씨</button>
        <button type="button" id="btnPin" class="pin-btn" title="저장 후 커서가 돌아갈 칸 고정 (F2)">📌<span id="pinLabel" class="pin-label">고정</span></button>
        <button type="button" id="btnDelSel" class="danger del-sel" disabled title="선택한 줄을 모두 지웁니다 (Delete 키)">🗑삭제</button>
        <button type="button" id="btnTxCsv" title="지금 조건 그대로 엑셀로 내려받기">📄엑셀</button>
        <button type="button" id="btnFullscreen" title="전체화면으로 크게 보기 (F11과 같음)">⛶전체</button>
        <span class="summary tx-summary"><span id="txSummary"></span><span id="selSummary" class="sel-summary"></span></span>
      </div>

      <div class="table-wrap ledger-wrap">
        <table class="ledger-table grid-table">
          <thead><tr><th class="chk"></th><th class="rowno">No</th><th>날짜</th><th>거래처</th><th>품목</th><th>규격</th><th class="num">수량</th><th class="num">단가</th><th class="num">공급가액</th><th>참조</th><th class="num">부가세</th><th class="num">합계</th><th>비고</th><th class="actions"></th></tr></thead>
          <tbody id="txRows"></tbody>
        </table>
      </div>
      <div id="coPanel" class="co-panel"></div>
      <p class="hint sheet-hint">
        <span><b>Enter</b> 다음 칸 · 줄 끝 저장</span>
        <span><b>↑↓←→</b> 칸 이동</span>
        <span><b>Tab</b> 검색</span>
        <span><b>=</b> 참조 반전</span>
        <span><b>Ins</b> 연속 선택 · <b>Del</b> 선택 삭제</span>
        <span><b>F2</b> 커서 고정</span>
        <button type="button" id="btnHelpInline" class="link-btn">사용법</button>
      </p>
      <button type="button" class="fab" id="btnQuickSearch" title="빠른 검색 (Tab)">🔍 검색</button>
      <button type="button" class="fab fab-help" id="btnHelp" title="사용법 안내">?</button>
    </section>`;

  $('#btnToolsToggle').addEventListener('click', () => {
    const card = $('#txCard');
    const open = card.classList.toggle('tools-open');
    $('#btnToolsToggle').textContent = open ? '🔧 검색조건·도구 닫기' : '🔧 검색조건·도구 열기';
    fitLedgerHeight();
  });

  $('#txCompany').addEventListener('change', (e) => {
    state.txCompanyId = e.target.value;
    const c = state.companies.find((x) => String(x.id) === e.target.value);
    if (c) state.entryCompanyId = String(c.id);
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
  $('#kindFilter').addEventListener('change', (e) => {
    state.txKindFilter = e.target.value;
    drawTxRows();
  });
  $('#entryKind').addEventListener('change', (e) => {
    state.entryKind = kindOf(e.target.value);
    try {
      localStorage.setItem('entryKind', state.entryKind);
    } catch (err) { /* 무시 */ }
    // 아직 적지 않은 빈 줄들은 새 구분을 따라간다
    gridRows.forEach((r, i) => {
      if (r.kind === 'new') { r.txKind = state.entryKind; paintRow(i); }
    });
  });
  $('#entryVat').addEventListener('change', (e) => {
    state.entryVat = e.target.value;
    try {
      localStorage.setItem('entryVat', e.target.value);
    } catch (err) { /* 무시 */ }
  });
  $('#btnAddTx').addEventListener('click', () => openTxForm(null));
  // 장부 아래 빈 공간(격자 줄이 없는 자투리까지)을 눌러도 적을 줄이 생긴다
  $('.ledger-wrap').addEventListener('click', (e) => {
    if (e.target.closest('tr')) return; // 줄(격자 줄 포함)은 그 줄 처리에 맡긴다
    if (e.target.closest('thead')) return;
    addRowFromEmptySpace();
  });
  $('#btnDelSel').addEventListener('click', deleteSelectedRows);
  $('#btnTxCsv').addEventListener('click', exportTransactionsCsv);
  $('#btnFullscreen').addEventListener('click', toggleFullscreen);
  $('#btnEasyOn').addEventListener('click', () => setEasyMode(true));
  $('#btnQuickSearch').addEventListener('click', toggleSearchSheet);
  $('#btnHelp').addEventListener('click', startTour);
  $('#btnHelpInline').addEventListener('click', startTour);
  $('#btnPin').addEventListener('mousedown', (e) => e.preventDefault());
  $('#btnPin').addEventListener('click', () => togglePin(gridEdit ? { id: 'g-' + gridEdit.field } : null));

  updatePinUI();
  await drawTxRows();
  fitLedgerHeight();
  scrollToBlankRow(); // 높이를 맞춘 뒤 적는 줄이 보이게
  maybeAutoTour();    // 처음 온 사용자에게 사용법 안내
}

// 장부가 화면 아래까지 꽉 차게 만든다 (컴장부처럼 한 화면을 다 쓰고,
// 페이지와 장부가 따로 스크롤되지 않도록 스크롤을 장부 하나로 모은다)
function fitLedgerHeight() {
  const wrap = $('.ledger-wrap');
  if (!wrap) return;
  const rect = wrap.getBoundingClientRect();
  const top = rect.top + window.scrollY;
  // 장부 아래에 있는 것(안내 문구·카드 여백·버전 표시)만큼을 남긴다
  const below = Math.max(0, document.body.scrollHeight - (rect.bottom + window.scrollY));
  // 줄이 적어도 장부가 화면 끝까지 차지하도록 높이를 고정한다 (아래 빈 공백 없애기)
  const h = Math.max(200, Math.round(window.innerHeight - top - below));
  wrap.style.height = h + 'px';
  wrap.style.maxHeight = h + 'px';
  fillGridSpace();
}

window.addEventListener('resize', () => {
  if (state.tab === 'transactions') fitLedgerHeight();
});
function maybeAutoTour() {
  if (state.easyMode) return; // 큰 글씨 모드에는 안내 대상 요소가 없다
  let done = true;
  try {
    done = localStorage.getItem('tourDone') === '1';
  } catch (e) { /* localStorage 사용 불가 환경에선 띄우지 않음 */ }
  if (done) return;
  setTimeout(() => {
    if ($('.grid-table') && $('#tourOverlay').classList.contains('hidden')) startTour();
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
          <span class="easy-label">구분</span>
          <select id="xKind">
            ${KIND_LIST.map((k) => `<option value="${k}" ${k === state.entryKind ? 'selected' : ''}>${KINDS[k].label} — ${KINDS[k].help}</option>`).join('')}
          </select>
        </div>
        <div class="easy-field">
          <span class="easy-label">부가세</span>
          <select id="xVat">
            ${Object.entries(VAT_LABEL).map(([v, l]) => `<option value="${v}" ${v === state.entryVat ? 'selected' : ''}>${l}</option>`).join('')}
          </select>
        </div>
        <p class="easy-total">합계 <b id="xTotal">0원</b></p>
        <button type="button" id="btnPin" class="pin-btn easy-pin">📌<span id="pinLabel" class="pin-label">커서 고정</span></button>
        <button type="submit" class="primary easy-save">저장하기</button>
      </form>
    </section>
    <section class="card easy-card">
      <h2 class="easy-recent-title">최근에 적은 것</h2>
      <div id="easyList"></div>
    </section>`;

  const xCompany = $('#xCompany');
  const preferred = state.companies.find((c) => String(c.id) === String(state.entryCompanyId));
  if (preferred) xCompany.value = preferred.name;

  // 입력 중에는 목록을 띄우지 않는다 — 찾을 땐 Tab(또는 🔍 버튼)을 쓴다
  xCompany.addEventListener('input', () => {
    state.entryCompanyId = ''; // 이름을 고치면 새 상호로 취급 (없으면 자동 등록)
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
  $('#xKind').addEventListener('change', (e) => {
    state.entryKind = kindOf(e.target.value);
    try {
      localStorage.setItem('entryKind', state.entryKind);
    } catch (err) { /* 무시 */ }
  });
  $('#xVat').addEventListener('change', (e) => {
    state.entryVat = e.target.value;
    try {
      localStorage.setItem('entryVat', e.target.value);
    } catch (err) { /* 무시 */ }
    easyRecompute();
  });
  $('#btnEasyOff').addEventListener('click', () => setEasyMode(false));
  $('#btnPin').addEventListener('mousedown', (e) => e.preventDefault());
  $('#btnPin').addEventListener('click', () => togglePin(document.activeElement));
  $('#easyForm').addEventListener('submit', (e) => {
    e.preventDefault();
    saveEasyEntry();
  });
  $('#easyForm').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === 'ArrowRight' || e.key === 'ArrowLeft') handleEntryKeys(e, saveEasyEntry);
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
    kind: state.entryKind,
    vatMode: state.entryVat,
    items: [{ name, spec: '', qty: Number($('#xQty').value) || 0, price: Number($('#xPrice').value) || 0 }],
    paid: 0,
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
  easyRecompute();
  toast('저장했습니다.');
  await drawEasyList();
  updatePinUI();
  focusAfterSave('xName');
}

async function drawEasyList() {
  txCache = await api('GET', '/api/transactions');
  const box = $('#easyList');
  if (!box) return;
  // 최신 거래 15건
  const rows = txCache
    .slice()
    .sort((a, b) => b.date.localeCompare(a.date) || b.id - a.id)
    .slice(0, 15);
  if (!rows.length) {
    box.innerHTML = '<p class="empty-cell">아직 적은 거래가 없습니다.</p>';
    return;
  }
  box.innerHTML = rows
    .map((t) => {
      const it = t.items[0];
      const more = t.items.length > 1 ? ` 외 ${t.items.length - 1}건` : '';
      const kind = kindOf(t.kind);
      const buy = IN_KINDS.includes(kind);
      return `<div class="easy-item ${buy ? 'easy-item-buy' : ''}" data-id="${t.id}" data-kind="tx">
        <div class="easy-item-head"><b>${esc(t.companyName)}</b><span>${esc(t.date)}</span></div>
        <div class="easy-item-name"><span class="kind-tag ${KINDS[kind].cls}">${KINDS[kind].label}</span> ${esc(it.name)}${more}</div>
        <div class="easy-item-foot">
          <b class="${t.total < 0 ? 'neg' : ''}">${won(t.total)}원</b>
          ${OUT_KINDS.includes(kind) ? '<button type="button" data-act="sheet">명세표</button>' : ''}
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
const SAVE_BAR_FIELDS = /^(eDate|eCompany|eName|eSpec|eQty|ePrice|xDate|xCompany|xName|xQty|xPrice)$/;

function saveBarTarget() {
  if (gridEdit) return gridEdit.input;
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

  let qty = 0;
  let price = 0;
  let name = '';
  if (state.easyMode) {
    qty = Number($('#xQty')?.value) || 0;
    price = Number($('#xPrice')?.value) || 0;
    name = ($('#xName')?.value || '').trim();
  } else if (gridEdit) {
    const row = gridRows[gridEdit.r] || {};
    const live = (f) => (gridEdit.field === f ? gridEdit.input.value : row[f]);
    qty = Number(live('qty')) || 0;
    price = Number(live('price')) || 0;
    name = String(live('name') || '').trim();
  }
  const r = calcItem(qty, price, state.entryVat);
  const total = r.supply + r.tax;
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
$('#saveBarBtn').addEventListener('click', async () => {
  if (state.easyMode) return saveEasyEntry();
  if (!gridEdit) return;
  const r = gridEdit.r;
  commitCellNow(true);
  startRowEdit(r + 1);
});

/* ─────────────── 커서 고정 ─────────────── */
// 저장 후 커서가 돌아갈 칸을 지정한다 (지정 전 기본값은 품명).
// PC: F2, 휴대폰: 📌 버튼. 기기에 기억되어 다음 접속에도 유지된다.
const PIN_FIELDS = {
  'g-date': '날짜', 'g-company': '상호', 'g-name': '품명', 'g-spec': '규격',
  'g-qty': '수량', 'g-price': '단가',
  xDate: '날짜', xCompany: '상호', xName: '품명', xQty: '수량',
  xPrice: '단가',
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
  if (state.pinnedField && !state.pinnedField.startsWith('g-')) {
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
  togglePin(gridEdit ? { id: 'g-' + gridEdit.field } : document.activeElement);
});

/* ─────────────── 입력칸 이동 (Enter / 방향키) ─────────────── */
const SHEET_FIELDS = ['eDate', 'eCompany', 'eName', 'eSpec', 'eQty', 'ePrice', 'ePaid'];
const EASY_FIELDS = ['xDate', 'xCompany', 'xName', 'xQty', 'xPrice', 'xVat'];
const entryFields = () => (state.easyMode ? EASY_FIELDS : SHEET_FIELDS);

function moveEntryFocus(dir) {
  const fields = entryFields();
  const i = fields.indexOf(document.activeElement && document.activeElement.id);
  if (i < 0) return false;
  const el = $('#' + fields[i + dir]);
  if (!el) return false;
  el.focus();
  if (el.select) el.select();
  return true;
}

const isLastEntryField = (el) => {
  const fields = entryFields();
  return el && el.id === fields[fields.length - 1];
};

// 글자를 고치는 중인지 판단 — 커서가 끝(또는 처음)이 아니면 방향키는 글자 이동에 쓴다
// 셀에 적은 숫자 읽기 (쉼표·공백을 걸러낸다)
const cellNum = (v) => Number(String(v).replace(/[,\s]/g, '')) || 0;

// 방향키로 칸을 옮길지, 글자 사이에서 커서만 옮길지 정한다
function caretAtEdge(el, dir) {
  if (!el || el.tagName !== 'INPUT') return true;
  if (['date', 'time'].includes(el.type)) return true; // 날짜 칸은 바로 이동
  let pos = null;
  let end = null;
  try {
    pos = el.selectionStart;
    end = el.selectionEnd;
  } catch (e) { /* 커서 위치를 알 수 없는 칸 */ }
  if (pos == null || end == null) return true;
  if (pos !== end) return false; // 글자가 선택된 상태면 먼저 선택만 푼다 (칸 이동 X)
  const len = el.value.length;
  return dir > 0 ? pos === len : pos === 0;
}

// 입력 행/폼 안에서의 키 처리 (Enter: 다음 칸 → 마지막 칸에서 저장, ←→: 칸 이동)
function handleEntryKeys(e, save) {
  const el = e.target;
  if (!entryFields().includes(el.id)) return;
  if (e.key === 'Enter') {
    e.preventDefault();
    if (isLastEntryField(el)) save();
    else moveEntryFocus(1);
  } else if (e.key === 'ArrowRight' && caretAtEdge(el, 1)) {
    if (moveEntryFocus(1)) e.preventDefault();
  } else if (e.key === 'ArrowLeft' && caretAtEdge(el, -1)) {
    if (moveEntryFocus(-1)) e.preventDefault();
  }
}

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

// 입력 줄의 상호를 기억한다 (다음 줄을 적을 때 그대로 이어 쓴다)
function applyEntryCompany(c) {
  state.entryCompanyId = String(c.id);
  const x = $('#xCompany');
  if (x) x.value = c.name;
  if (gridEdit && gridEdit.field === 'company') gridEdit.input.value = c.name;
  else if (gridRows[gridCursor.r] && gridRows[gridCursor.r].kind === 'new') {
    gridRows[gridCursor.r].companyName = c.name;
    paintRow(gridCursor.r);
  }
}

/* ─────────────── 엑셀식 셀 입력 그리드 ─────────────── */
const GRID_COLS = ['date', 'company', 'name', 'spec', 'qty', 'price', 'supply', 'memo'];
const BLANK_ROWS = 1;               // 맨 아래에 두는 빈 줄 (항상 한 줄만)

let gridRows = [];                  // 화면에 보이는 줄 (거래·빈 줄)
let gridEdit = null;                // { r, field, input }
let gridSearching = false;          // 검색 시트를 여는 중이면 셀 편집을 유지한다
const gridCursor = { r: 0, field: 'company' };

// 빈 줄에는 마지막으로 쓴 날짜를 미리 채워 둔다 (없으면 오늘)
const blankRow = () => ({
  kind: 'new', txKind: state.entryKind, date: state.entryDate || today(),
  companyName: '', name: '', spec: '', qty: '', price: '', paid: '', supply: '', memo: '',
});

function rowFromTx(t) {
  const items = t.items || [];
  const it = items[0] || { name: '', spec: '', qty: '', price: '' };
  const multi = items.length > 1;
  return {
    kind: 'tx', id: t.id, tx: t, multi,
    txKind: kindOf(t.kind),
    date: t.date, companyId: t.companyId, companyName: t.companyName,
    name: items.length ? it.name + (multi ? ` 외 ${items.length - 1}건` : '') : '',
    spec: multi ? '' : it.spec,
    qty: multi || !items.length ? '' : it.qty,
    price: multi || !items.length ? '' : it.price,
    supply: t.supplyTotal, total: t.total, tax: t.taxTotal, paid: t.paid, memo: t.memo || '',
  };
}

// 새로 적는 줄은 화면에서 바로 계산해 보여준다
function newRowCalc(row) {
  const r = calcItem(Number(row.qty) || 0, Number(row.price) || 0, state.entryVat);
  return { supply: r.supply, tax: r.tax, total: r.supply + r.tax };
}

function cellText(row, field) {
  const v = row[field];
  if (['date', 'company', 'name', 'spec', 'memo'].includes(field)) {
    return field === 'company' ? row.companyName || '' : String(v == null ? '' : v);
  }
  return v === '' || v == null ? '' : won(v);
}

const CELL_PH = { date: '날짜', company: '상호', name: '품명', spec: '규격', qty: '수량', price: '단가', supply: '금액', memo: '비고' };

function rowHtml(row, i) {
  const isNew = row.kind === 'new';
  const calc = isNew ? newRowCalc(row) : row;
  const kind = kindOf(row.txKind);
  const money = isMoneyOnly(kind);            // 입금·출금은 금액 한 칸만 쓴다
  const fields = editableFields(row);
  const editable = (f) => (fields.includes(f) ? ' data-edit="1"' : '');
  const cell = (f, cls) =>
    `<td class="${cls || ''}"${editable(f)} data-f="${f}" data-ph="${CELL_PH[f] || ''}">${esc(cellText(row, f))}</td>`;
  const key = row.kind === 'new' ? '' : 't' + row.id;
  const checked = key && checkedTxIds.has(key);
  const num = (v, extra, f) => `<td class="num ${extra || ''}" data-f="${f}">${v === '' || v == null ? '' : won(v)}</td>`;
  const blankNum = isNew && !row.price && !money;
  // 공급가액은 늘 눌러서 적을 수 있다 (품목 없이 금액만 적으면 입금·출금이 된다)
  const supplyShown = money
    ? row.supply === '' || row.supply == null ? '' : row.supply
    : blankNum ? '' : calc.supply;
  const supplyCell = `<td class="num ${Number(supplyShown) < 0 ? 'neg' : ''}" data-edit="1" data-f="supply" data-ph="공급가액">${
    supplyShown === '' || supplyShown == null ? '' : won(supplyShown)
  }</td>`;
  const rowCls = [
    IN_KINDS.includes(kind) ? 'row-buy' : '',
    money ? 'row-money' : '',
    checked ? 'row-checked' : '',
    isNew ? 'row-new' : '',
  ].filter(Boolean).join(' ');
  return `<tr data-r="${i}" data-kind="${row.kind}" data-id="${row.id || ''}" class="${rowCls}">
    <td class="chk">${key ? `<input type="checkbox" ${checked ? 'checked' : ''}>` : ''}</td>
    <td class="rowno">${row.no || ''}</td>
    ${cell('date')}
    ${cell('company', 'cell-company')}
    ${cell('name')}
    ${cell('spec')}
    ${cell('qty', 'num')}
    ${cell('price', 'num')}
    ${supplyCell}
    <td class="kind-cell" data-f="kind" title="눌러서 반대로 바꾸기 (= 키)"><span class="kind-tag ${KINDS[kind].cls}">${KINDS[kind].label}</span></td>
    ${num(money || blankNum ? '' : calc.tax, calc.tax < 0 ? 'neg' : '', 'tax')}
    ${
      money
        ? num(row.supply === '' || row.supply == null ? '' : row.supply, Number(row.supply) < 0 ? 'neg' : '', 'total')
        : num(blankNum ? '' : calc.total, calc.total < 0 ? 'neg' : '', 'total')
    }
    ${cell('memo', 'cell-memo')}
    <td class="actions">${
      row.kind === 'tx'
        ? `${OUT_KINDS.includes(kind) ? `<button data-act="sheet" data-id="${row.id}">명세표</button>` : ''}<button data-act="del" data-id="${row.id}" class="danger" title="삭제">✕</button>`
        : ''
    }</td>
  </tr>`;
}

function paintRow(i) {
  const tr = $(`#txRows tr[data-r="${i}"]`);
  if (!tr) return;
  // 그 줄에서 뭔가 적는 중이면 그 칸만 남기고 나머지만 새로 그린다 (입력창이 사라지지 않게)
  if (gridEdit && gridEdit.r === i && gridEdit.td && gridEdit.td.isConnected) {
    const holder = document.createElement('tbody');
    holder.innerHTML = rowHtml(gridRows[i], i);
    const fresh = holder.firstElementChild;
    if (!fresh) return;
    tr.className = fresh.className;
    const olds = [...tr.children];
    const news = [...fresh.children];
    olds.forEach((td, k) => {
      if (td === gridEdit.td || !news[k]) return;
      td.replaceWith(news[k]);
    });
    return;
  }
  tr.outerHTML = rowHtml(gridRows[i], i);
  // 다시 그리면 '지금 줄' 표시가 지워지므로 되살린다
  if (sheetLastIdx === i) {
    const fresh = $(`#txRows tr[data-r="${i}"]`);
    if (fresh) fresh.classList.add('row-pointer');
  }
}

const blankCount = () => gridRows.reduce((s, r) => s + (r.kind === 'new' ? 1 : 0), 0);

// 지금 줄(커서가 놓인 줄)을 정한다 — 파란 테두리로 표시하고 거래처 정보도 그 줄로 바꾼다
function setCursorRow(i) {
  if (!gridRows[i]) return;
  gridCursor.r = i;
  sheetLastIdx = i;
  updatePointerHighlight();
  drawCompanyPanel();
}

// 아무것도 안 적힌 빈 줄인지
// 빈 줄에 자동으로 채워지는 거래처 이름 (직전에 쓴 거래처)
function prefillCompanyName() {
  const c = state.companies.find((x) => String(x.id) === String(state.entryCompanyId));
  return c ? c.name : '';
}

// 아직 아무것도 적지 않은 빈 줄인지.
//  · 거래처는 자동으로 채워지므로 그 값 그대로면 '안 적은 것'으로 본다
//  · 금액은 0으로 다시 계산돼 들어오기도 하므로 숫자로 비어 있는지 본다
const isUntouchedBlank = (row) => {
  if (!row || row.kind !== 'new') return false;
  const co = String(row.companyName || '').trim();
  if (co && co !== prefillCompanyName()) return false;
  return (
    !String(row.name || '').trim() && !String(row.spec || '').trim() &&
    !Number(row.qty) && !Number(row.price) && !Number(row.supply) && !String(row.memo || '').trim()
  );
};

// 장부 아래 빈 곳을 누르면 적을 줄을 한 줄 더 만든다 (엑셀에서 아래를 누르는 느낌)
function addRowFromEmptySpace() {
  const tbody = $('#txRows');
  if (!tbody) return;
  if (gridEdit) commitCellNow(false); // 적던 값을 먼저 반영하고 판단한다
  const last = gridRows[gridRows.length - 1];
  if (isUntouchedBlank(last)) {
    // 이미 비어 있는 줄이 있으면 새로 만들지 않고 그 줄로 간다 (한 번 반짝여 알려준다)
    const i = gridRows.length - 1;
    startRowEdit(i);
    const tr = rowElAt(i);
    if (tr) {
      tr.classList.remove('row-flash');
      void tr.offsetWidth;
      tr.classList.add('row-flash');
    }
    return;
  }
  gridRows.push(blankRow());
  renumberRows();
  const i = gridRows.length - 1;
  const filler = tbody.querySelector('tr.grid-filler');
  const html = rowHtml(gridRows[i], i);
  if (filler) filler.insertAdjacentHTML('beforebegin', html);
  else tbody.insertAdjacentHTML('beforeend', html);
  fillGridSpace();
  startRowEdit(i);
}

// No 를 다시 매긴다 — 저장된 줄만 1,2,3… (저장 안 된 줄은 번호 없음)
function renumberRows() {
  let n = 0;
  gridRows.forEach((r) => {
    r.no = r.kind === 'tx' ? ++n : '';
  });
}

// 그 줄의 화면 요소
const rowElAt = (i) => $(`#txRows tr[data-r="${i}"]`);

// 저장된 줄 중 다음/이전 줄 번호 (저장 안 된 줄은 건너뛴다)
function nextSavedRow(from) {
  for (let i = (from == null ? -1 : from) + 1; i < gridRows.length; i++) if (gridRows[i].kind === 'tx') return i;
  return -1;
}
function prevSavedRow(from) {
  for (let i = (from == null ? gridRows.length : from) - 1; i >= 0; i--) if (gridRows[i].kind === 'tx') return i;
  return -1;
}

// 적는 줄(맨 아래 빈 줄)이 화면에 보이게 스크롤한다
function scrollToBlankRow() {
  const i = gridRows.findIndex((r) => r.kind === 'new');
  const tr = i >= 0 ? $(`#txRows tr[data-r="${i}"]`) : null;
  if (tr) tr.scrollIntoView({ block: 'nearest' });
}

// 남는 아래 공간을 빈 격자로 채운다 (컴장부처럼 표가 화면 끝까지 이어지게)
function fillGridSpace() {
  const tbody = $('#txRows');
  const wrap = $('.ledger-wrap');
  if (!tbody || !wrap) return;
  tbody.querySelectorAll('tr.grid-filler').forEach((tr) => tr.remove());
  if (window.matchMedia('(max-width: 700px)').matches) return; // 휴대폰 카드형은 그대로
  const head = $('.grid-table thead');
  const cols = $$('.grid-table thead th').length || 14;
  const last = tbody.querySelector('tr:last-child');
  const rowH = last ? last.getBoundingClientRect().height : 28;
  const free = wrap.clientHeight - (head ? head.getBoundingClientRect().height : 0) - tbody.getBoundingClientRect().height;
  const n = rowH > 0 ? Math.floor(free / rowH) : 0;
  if (n <= 0) return;
  const cells = '<td></td>'.repeat(cols);
  tbody.insertAdjacentHTML('beforeend', `<tr class="grid-filler">${cells}</tr>`.repeat(Math.min(n, 60)));
}

// 맨 아래 빈 줄은 항상 한 줄만 둔다 (줄을 저장하면 새 빈 줄이 하나 생긴다)
function ensureTrailingBlank() {
  const tbody = $('#txRows');
  if (!tbody) return 0;
  const last = gridRows[gridRows.length - 1];
  if (last && last.kind === 'new') return 0;
  gridRows.push(blankRow());
  renumberRows();
  const html = rowHtml(gridRows[gridRows.length - 1], gridRows.length - 1);
  const filler = tbody.querySelector('tr.grid-filler');
  if (filler) filler.insertAdjacentHTML('beforebegin', html);
  else tbody.insertAdjacentHTML('beforeend', html);
  fillGridSpace();
  return 1;
}

// 아직 손대지 않은 빈 줄은 마지막에 쓴 날짜·구분을 따라간다
function syncBlankRow() {
  gridRows.forEach((r, i) => {
    if (r.kind !== 'new') return;
    if (r.companyName || r.name || r.spec || r.qty !== '' || r.price !== '') return;
    r.date = state.entryDate || today();
    r.txKind = state.entryKind;
    if (!(gridEdit && gridEdit.r === i)) paintRow(i);
  });
}

async function drawTxRows() {
  const qs = state.txCompanyId ? '?companyId=' + state.txCompanyId : '';
  txCache = await api('GET', '/api/transactions' + qs);
  const tbody = $('#txRows');
  if (!tbody) return;

  const inRange = (d) => (!state.txFrom || d >= state.txFrom) && (!state.txTo || d <= state.txTo);
  const q = state.txProductQuery.trim().toLowerCase();
  let list = txCache.filter((t) => inRange(t.date));
  if (q) list = list.filter((t) => t.items.some((it) => it.name.toLowerCase().includes(q)));
  if (state.txKindFilter) list = list.filter((t) => kindOf(t.kind) === state.txKindFilter);
  $('#txSummary').textContent = summaryText(list.map(rowFromTx));

  // 저장된 줄을 날짜순으로 깔고, 맨 아래에 빈 줄 한 줄을 붙인다
  gridRows = list
    .map((t) => Object.assign(rowFromTx(t), { sortKey: t.date + '|' + String(t.id).padStart(8, '0') }))
    .sort((a, b) => a.sortKey.localeCompare(b.sortKey));
  for (let k = 0; k < BLANK_ROWS; k++) gridRows.push(blankRow());

  renumberRows();
  tbody.innerHTML = gridRows.map((r, i) => rowHtml(r, i)).join('');
  updateSelSummary();
  drawCompanyPanel(true);
  bindGridEvents(tbody);
  fillGridSpace();
  // 새로 적을 수 있는 첫 빈 줄이 보이도록
  scrollToBlankRow();
}

function bindGridEvents(tbody) {
  tbody.onclick = async (e) => {
    const btn = e.target.closest('button[data-act]');
    if (btn) return handleRowAction(btn);
    if (e.target.closest('tr.grid-filler')) return addRowFromEmptySpace(); // 아래 빈 곳을 누르면 한 줄 더
    const cb = e.target.closest('input[type="checkbox"]');
    const td = e.target.closest('td');
    const tr = e.target.closest('tr[data-r]');
    if (!tr || !td) return;
    const i = Number(tr.dataset.r);
    if (td.classList.contains('chk')) {
      let box = cb;
      if (!box) { // 네모 옆 여백을 눌러도 체크되게
        box = td.querySelector('input[type="checkbox"]');
        if (!box) return;
        box.checked = !box.checked;
      }
      const key = 't' + tr.dataset.id;
      if (box.checked) checkedTxIds.add(key);
      else checkedTxIds.delete(key);
      tr.classList.toggle('row-checked', box.checked);
      sheetLastIdx = i;
      updatePointerHighlight();
      updateSelSummary();
      return;
    }
    setCursorRow(i); // 어디를 누르든 그 줄을 '지금 줄'로 삼는다
    if (td.classList.contains('kind-cell') && td.dataset.f === 'kind') return toggleRowKind(i);
    if (td.dataset.edit) await openCellEditor(i, td.dataset.f);
  };
}

// 매출 ↔ 매입 뒤집기 (저장된 줄은 바로 다시 저장)
async function toggleRowKind(r) {
  return flipRowKind(r, false);
}

// keepEditing: 셀을 적는 중이면 입력창을 살린 채 구분 표시만 바꾼다
async function flipRowKind(r, keepEditing) {
  const row = gridRows[r];
  if (!row) return;
  row.txKind = KINDS[kindOf(row.txKind)].pair;
  if (isMoneyOnly(row.txKind) && row.supply !== '' && row.supply != null) {
    // 입금은 +, 출금은 − (컴장부와 같게)
    const size = Math.abs(Number(row.supply) || 0);
    row.supply = row.txKind === 'deposit' ? size : -size;
    row.total = row.supply;
  }
  if (keepEditing) paintKindCell(r);
  else paintRow(r);
  if (row.kind === 'tx') await saveExistingRow(row, r, keepEditing);
  else updateSummaryOnly();
}

// 줄 전체를 다시 그리지 않고 구분 태그·배경색만 바꾼다 (입력 중에도 안전)
function paintKindCell(r) {
  const row = gridRows[r];
  const tr = $(`#txRows tr[data-r="${r}"]`);
  if (!row || !tr) return;
  const kind = kindOf(row.txKind);
  const td = tr.querySelector('td.kind-cell');
  if (td) td.innerHTML = `<span class="kind-tag ${KINDS[kind].cls}">${KINDS[kind].label}</span>`;
  tr.classList.toggle('row-buy', IN_KINDS.includes(kind));
  tr.classList.toggle('row-money', isMoneyOnly(kind));
  const sheetBtn = tr.querySelector('button[data-act="sheet"]');
  if (sheetBtn && !OUT_KINDS.includes(kind)) sheetBtn.remove(); // 물건이 나간 줄에만 명세표
  updateSummaryOnly();
}

async function handleRowAction(btn) {
  const id = Number(btn.dataset.id);
  const act = btn.dataset.act;
  const t = txCache.find((x) => x.id === id);
  if (!t) return;
  if (act === 'sheet') return openStatement(t);
  if (act === 'del') {
    if (!confirm(`${t.date} '${t.companyName}' 거래를 삭제할까요?`)) return;
    await api('DELETE', '/api/transactions/' + id);
    checkedTxIds.delete('t' + id);
    toast('거래를 삭제했습니다.');
    await refreshCompanies();
    drawTxRows();
  }
}

/* ── 셀 편집기 ── */
async function openCellEditor(r, field) {
  const row = gridRows[r];
  if (!row) return;
  if (gridEdit) {
    if (gridEdit.r === r && gridEdit.field === field) return; // 같은 칸이면 그대로
    commitCellNow(gridEdit.r !== r); // 적던 값만 바로 반영하고 저장은 뒤에서
  }

  const td = $(`#txRows tr[data-r="${r}"] td[data-f="${field}"]`);
  if (!td) return;
  const isNum = ['qty', 'price', 'paid', 'supply'].includes(field);
  const input = document.createElement('input');
  input.className = 'cell-input';
  if (field === 'date') input.type = 'date';
  else if (isNum) {
    // type=number는 커서 위치를 알 수 없어 ←/→ 로 글자 사이를 못 움직인다.
    // 글자 칸으로 두고 inputmode로 숫자 키패드만 띄운다.
    input.type = 'text';
    input.inputMode = field === 'qty' ? 'decimal' : 'numeric';
    input.autocomplete = 'off';
    input.classList.add('num');
  }
  let raw = field === 'company' ? row.companyName : row[field];
  // 공급가액은 자동 계산된 값이 보이던 자리라, 그 값을 그대로 놓고 고치게 한다
  if (field === 'supply' && (raw === '' || raw == null) && !isMoneyOnly(row.txKind)) {
    const c = newRowCalc(row);
    raw = row.price === '' || row.price == null ? '' : c.supply;
  }
  input.value = field === 'date' && !raw && row.kind === 'new' ? state.entryDate || today() : raw == null ? '' : raw;
  if (field === 'company' && row.kind === 'new' && !raw) {
    const c = state.companies.find((x) => String(x.id) === String(state.entryCompanyId));
    if (c) input.value = c.name;
  }
  td.textContent = '';
  td.appendChild(input);
  td.classList.add('cell-editing');
  input.focus();
  input.select();
  gridEdit = { r, field, input, td };
  gridCursor.r = r;
  gridCursor.field = field;
  drawCompanyPanel();
  sheetLastIdx = r;
  updatePointerHighlight();
  updateSaveBar();

  input.addEventListener('keydown', onCellKey);
  input.addEventListener('blur', () => setTimeout(() => {
    if (gridSearching) return; // 검색창으로 옮겨간 것뿐이므로 그대로 둔다
    if (gridEdit && gridEdit.input === input && document.activeElement !== input) commitCellNow(true);
  }, 120));
}

function closeCellEditor() {
  if (!gridEdit) return;
  const { r } = gridEdit;
  gridEdit = null;
  paintRow(r);
  updateSaveBar();
}

// 편집 중인 값을 줄에 반영한다 (leaveRow=true면 줄을 벗어나는 상황)
// 적던 값을 그 자리에서 화면에 반영한다 (저장은 뒤에서 따로)
function applyCellValue() {
  if (!gridEdit) return null;
  const { r, field, input } = gridEdit;
  const row = gridRows[r];
  const value = input.value.trim();
  gridEdit = null;
  if (!row) return null;

  if (field === 'company') {
    row.companyName = value;
    const found = state.companies.find((c) => c.name.toLowerCase() === value.toLowerCase());
    row.companyId = found ? found.id : 0;
    if (found) state.entryCompanyId = String(found.id);
  } else if (field === 'supply') {
    applySupplyValue(row, value);
  } else if (['qty', 'price', 'paid'].includes(field)) {
    row[field] = value === '' ? '' : cellNum(value);
    if (value !== '') leaveMoneyOnly(row);
  } else {
    row[field] = value;
    if (['name', 'spec'].includes(field) && value !== '') leaveMoneyOnly(row);
  }
  if (row.kind === 'new' && field === 'date') state.entryDate = value;
  // 화면 숫자는 서버 응답을 기다리지 않고 그 자리에서 다시 계산한다
  if (!isMoneyOnly(row.txKind) && !row.multi && field !== 'supply') recalcRowAmounts(row);
  paintRow(r);
  updateSummaryOnly();
  return r;
}

// 입금·출금 줄에 품목·수량·단가를 적으면 물건이 오가는 참조로 바꾼다
// (입금 → 매출, 출금 → 매입)
function leaveMoneyOnly(row) {
  if (!isMoneyOnly(row.txKind)) return;
  const amount = Math.abs(Number(row.supply) || 0);
  row.txKind = kindOf(row.txKind) === 'deposit' ? 'sale' : 'purchase';
  // 적어 둔 금액이 있으면 수량 1·단가 그 금액으로 옮겨 금액이 사라지지 않게 한다
  if (amount && (row.qty === '' || row.qty == null) && (row.price === '' || row.price == null)) {
    row.qty = OUT_KINDS.includes(kindOf(row.txKind)) ? -1 : 1;
    row.price = amount;
  }
}

const rowVatMode = (row) => (row.kind === 'tx' && row.tx && row.tx.vatMode) || state.entryVat;

// 수량·단가로 공급가액·부가세·합계를 다시 계산한다
function recalcRowAmounts(row) {
  const c = calcItem(Number(row.qty) || 0, Number(row.price) || 0, rowVatMode(row));
  row.supply = c.supply;
  row.tax = c.tax;
  row.total = c.supply + c.tax;
}

// 공급가액 칸에 직접 적었을 때 (컴장부와 같은 방식)
//  · 품목·수량·단가가 비어 있으면 → 금액만 있는 줄, 즉 입금(+)·출금(−)
//  · 품목이 있으면 → 적은 금액에 맞춰 단가를 거꾸로 계산한다
function applySupplyValue(row, value) {
  const v = value === '' ? '' : cellNum(value);
  const moneyRow =
    isMoneyOnly(row.txKind) ||
    (!String(row.name || '').trim() && (row.qty === '' || row.qty == null) && (row.price === '' || row.price == null));

  if (moneyRow) {
    if (!isMoneyOnly(row.txKind)) row.txKind = Number(v) < 0 ? 'withdraw' : 'deposit'; // 참조를 입금·출금으로
    if (v === '') {
      row.supply = '';
      row.total = '';
    } else {
      const size = Math.abs(Number(v) || 0);
      row.supply = kindOf(row.txKind) === 'deposit' ? size : -size; // 입금 +, 출금 −
      row.total = row.supply;
    }
    row.tax = 0;
    row.name = '';
    row.spec = '';
    row.qty = '';
    row.price = '';
    return;
  }

  if (v === '') { // 금액을 지우면 단가도 비운다
    row.price = '';
    recalcRowAmounts(row);
    return;
  }
  // 방향(+/−)은 참조가 정하고, 적은 금액은 크기만 쓴다 — 단가가 음수가 되지 않게
  const goesOut = OUT_KINDS.includes(kindOf(row.txKind));
  const size = Math.abs(Number(row.qty) || 1);
  const qty = goesOut ? -size : size;
  row.qty = qty;
  const base = rowVatMode(row) === 'included' ? Math.round(Math.abs(v) * 1.1) : Math.abs(v);
  row.price = Math.round(base / size);
  recalcRowAmounts(row);
}

// 상호 목록(거래 합계 포함) 다시 읽기 — 연달아 저장할 땐 한 번만
let companyRefreshTimer = null;
function scheduleCompanyRefresh() {
  clearTimeout(companyRefreshTimer);
  companyRefreshTimer = setTimeout(() => {
    refreshCompanies().catch(() => {});
  }, 600);
}

// 저장은 순서대로, 화면 조작과 따로 진행한다
let gridSaveChain = Promise.resolve();
const pendingSaves = new Map(); // 줄마다 아직 끝나지 않은 저장 수
const isLastPendingSave = (r) => (pendingSaves.get(r) || 0) <= 1;

function queueRowSave(r, mayLeave) {
  if (r == null || !gridRows[r]) return Promise.resolve();
  pendingSaves.set(r, (pendingSaves.get(r) || 0) + 1);
  gridSaveChain = gridSaveChain.then(async () => {
    try {
      const row = gridRows[r];
      if (!row) return;
      if (row.kind === 'tx') await saveExistingRow(row, r);
      else if (mayLeave) await saveNewRowIfReady(r);
    } finally {
      const left = (pendingSaves.get(r) || 1) - 1;
      if (left > 0) pendingSaves.set(r, left);
      else pendingSaves.delete(r);
    }
  });
  return gridSaveChain;
}

// 값만 바로 반영하고 저장은 뒤에서 — 칸 이동이 기다리지 않게 한다
function commitCellNow(mayLeave) {
  const r = applyCellValue();
  if (r == null) return;
  queueRowSave(r, mayLeave);
  updateSaveBar();
}

// 서버로 보낼 거래 내용 (참조에 따라 품목 없이 금액만 보내기도 한다)
function txPayload(row, isNew) {
  const kind = kindOf(row.txKind);
  const base = {
    companyId: row.companyId || 0,
    companyName: row.companyName,
    date: row.date || today(),
    kind,
    memo: row.memo != null ? String(row.memo) : (row.tx && row.tx.memo) || '',
  };
  if (isMoneyOnly(kind)) {
    const size = Math.abs(Number(row.supply) || 0);
    return Object.assign(base, { amount: kind === 'deposit' ? size : -size, items: [] });
  }
  const defaultQty = OUT_KINDS.includes(kind) ? -1 : 1; // 나가면 −, 들어오면 +
  const items = row.multi
    ? row.tx.items
    : [{ name: row.name, spec: row.spec, qty: Number(row.qty) || (isNew ? defaultQty : 0), price: Number(row.price) || 0 }];
  return Object.assign(base, {
    vatMode: isNew ? state.entryVat : (row.tx && row.tx.vatMode) || state.entryVat,
    items,
    paid: 0,
  });
}

// 기존 줄은 셀을 고칠 때마다 바로 저장한다
async function saveExistingRow(row, r, keepEditing) {
  try {
    {
      const saved = await api('PUT', '/api/transactions/' + row.id, txPayload(row, false));
      if (isLastPendingSave(r)) { // 뒤이어 저장할 게 남아 있으면 화면 값을 건드리지 않는다
        Object.assign(row, rowFromTx(Object.assign({ companyName: row.companyName }, saved)));
      }
    }
    drawCompanyPanel(true);
    scheduleCompanyRefresh();
    clearProductsCache();
    if (keepEditing) paintKindCell(r); // 적는 중이면 입력창을 지우지 않는다
    else paintRow(r);
    updateSummaryOnly();
  } catch (e) {
    // 저장은 뒤에서 돌아가므로 알림창 대신 안내를 띄우고, 적는 중이 아닐 때만 다시 읽는다
    toast('⚠ 저장하지 못했습니다 — ' + (e.message || '연결을 확인하세요'));
    if (!gridEdit) drawTxRows();
  }
}

// 빈 줄에 상호·품명이 채워졌으면 새 거래로 저장한다
async function saveNewRowIfReady(r) {
  const row = gridRows[r];
  if (!row || row.kind !== 'new') return false;
  if (!row.companyName.trim()) return false;
  if (isMoneyOnly(row.txKind)) {
    if (!Number(row.supply)) return false; // 입금·출금은 금액이 있어야 저장
  } else {
    if (!row.name.trim() && !fillNewRowFromLast(row)) return false;
    if (!row.name.trim()) return false;
  }

  try {
    const tx = await api('POST', '/api/transactions', txPayload(row, true));
    // 새로 만들어진 상호면 목록을 바로 읽어와야 이름이 붙는다
    if (state.companies.some((x) => x.id === tx.companyId)) scheduleCompanyRefresh();
    else await refreshCompanies();
    clearProductsCache();
    txCache = [tx, ...txCache];
    const c = state.companies.find((x) => x.id === tx.companyId);
    if (c) state.entryCompanyId = String(c.id);
    state.entryDate = tx.date;
    gridRows[r] = rowFromTx(Object.assign({ companyName: c ? c.name : row.companyName }, tx));
    renumberRows(); // 저장돼 새 번호가 생겼으니 다시 매긴다
    paintRow(r);
    for (let k = r + 1; k < gridRows.length; k++) if (gridRows[k].kind === 'tx') paintRow(k); // 뒤 줄 번호도 갱신
    ensureTrailingBlank(); // 저장된 줄 아래에 새 빈 줄을 하나 만든다
    drawCompanyPanel(true);
    syncBlankRow();        // 아직 손대지 않은 빈 줄은 방금 쓴 날짜를 따라간다
    updateSummaryOnly();
    return true;
  } catch (e) {
    toast('⚠ 저장하지 못했습니다 — ' + (e.message || '연결을 확인하세요'));
    return false;
  }
}

// 품명을 비워둔 채 저장하면 직전 품목을 그대로 가져온다
function fillNewRowFromLast(row) {
  const last = getLastItem();
  if (!last) return false;
  row.name = last.name;
  row.spec = last.spec;
  if (row.price === '' || row.price == null) row.price = last.price;
  if (row.qty === '' || row.qty == null) row.qty = last.qty;
  return true;
}

// 화면에 보이는 줄로 매출·매입·이익을 요약한다
function summaryText(txRows) {
  const sum = (kinds) => txRows.filter((r) => kinds.includes(kindOf(r.txKind))).reduce((s, r) => s + r.total, 0);
  const saleTotal = sum(OUT_KINDS);          // 매출 + 외출 (받을 돈이라 +)
  const buyTotal = Math.abs(sum(IN_KINDS));  // 매입 + 외입 (줄 돈이라 −로 저장 → 크기로 표시)
  const inMoney = sum(['deposit']);
  const outMoney = Math.abs(sum(['withdraw']));
  const parts = [`거래 ${txRows.length}건`];
  if (saleTotal || !buyTotal) parts.push(`매출 ${won(saleTotal)}원`);
  if (buyTotal) parts.push(`매입 ${won(buyTotal)}원`);
  if (saleTotal && buyTotal) parts.push(`이익 ${won(saleTotal - buyTotal)}원`);
  if (inMoney) parts.push(`입금 ${won(inMoney)}원`);
  if (outMoney) parts.push(`출금 ${won(outMoney)}원`);
  return parts.join(' · ');
}

function updateSummaryOnly() {
  const el = $('#txSummary');
  if (!el) return;
  el.textContent = summaryText(gridRows.filter((r) => r.kind === 'tx'));
}

/* ── 셀 사이 이동 ── */
function editableFields(row) {
  if (!row) return GRID_COLS;
  // 입금·출금 줄에서도 품목·수량·단가를 적을 수 있다 (적으면 매출·매입으로 바뀐다)
  if (row.kind === 'tx' && row.multi) return ['date', 'company', 'memo'];    // 품목은 팝업에서 고친다
  return GRID_COLS;
}

function moveCell(dr, dfield) {
  if (!gridEdit) return;
  const { r, field } = gridEdit;
  const row = gridRows[r];
  const fields = editableFields(row);
  let nr = r;
  let nf = field;

  if (dfield) {
    const i = fields.indexOf(field);
    const ni = i + dfield;
    if (ni < 0 || ni >= fields.length) {
      if (dfield > 0) { // 줄 끝 → 저장을 걸어두고 바로 다음 줄로
        commitCellNow(true);
        return startRowEdit(r + 1);
      }
      nr = r - 1;
      nf = fields[fields.length - 1];
    } else {
      nf = fields[ni];
    }
  } else {
    nr = r + dr;
  }
  if (nr < 0 || nr >= gridRows.length) return;

  const leaving = nr !== r;
  commitCellNow(leaving); // 저장을 기다리지 않는다 — 칸은 바로 옮긴다
  const target = gridRows[nr];
  const tf = editableFields(target).includes(nf) ? nf : editableFields(target)[0];
  openCellEditor(nr, tf);
}

// 다음 줄을 적기 시작한다 (커서 고정 칸이 있으면 그 칸부터)
function startRowEdit(r) {
  ensureTrailingBlank();
  if (!gridRows[r]) {
    // 방금 적은 줄이 아직 저장 중이라 다음 줄이 없다 — 빈 줄을 하나 만들어 이어 적게 한다
    const tbody = $('#txRows');
    if (!tbody) return;
    gridRows.push(blankRow());
    renumberRows();
    r = gridRows.length - 1;
    tbody.insertAdjacentHTML('beforeend', rowHtml(gridRows[r], r));
  }
  const row = gridRows[r];
  if (!row) return;
  const pinned = state.pinnedField && state.pinnedField.startsWith('g-') ? state.pinnedField.slice(2) : '';
  const fields = editableFields(row);
  const field = fields.includes(pinned) ? pinned : row.kind === 'new' ? 'company' : fields[0];
  openCellEditor(r, field);
  const tr = $(`#txRows tr[data-r="${r}"]`);
  if (tr) scrollRowIntoView(tr);
}

function onCellKey(e) {
  const { field, input } = gridEdit || {};
  if (!gridEdit) return;
  if (e.key === 'Enter') {
    e.preventDefault();
    moveCell(0, 1);
  } else if (e.key === 'Tab') {
    e.preventDefault();
    // 컴장부처럼 거래처·품목 칸에서는 Tab이 검색창을 연다
    if (field === 'company' || field === 'name') openContextSearch();
    else moveCell(0, e.shiftKey ? -1 : 1);
  } else if (e.key === 'ArrowDown') {
    e.preventDefault();
    moveCell(1, 0);
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    moveCell(-1, 0);
  } else if (e.key === 'ArrowRight' && caretAtEdge(input, 1)) {
    e.preventDefault();
    moveCell(0, 1);
  } else if (e.key === 'ArrowLeft' && caretAtEdge(input, -1)) {
    e.preventDefault();
    moveCell(0, -1);
  } else if (e.key === '=' && field !== 'name' && field !== 'spec' && field !== 'company') {
    // = : 참조를 반대로 뒤집는다 (입금↔출금, 외출↔매출, 외입↔매입)
    // 글자 칸에서는 '=' 를 그대로 적을 수 있게 둔다
    e.preventDefault();
    flipRowKind(gridEdit.r, true);
  }
}

// 체크된 거래의 소계 표시
function updateSelSummary() {
  const el = $('#selSummary');
  const sel = txCache.filter((t) => checkedTxIds.has('t' + t.id));
  const delBtn = $('#btnDelSel');
  if (delBtn) {
    delBtn.disabled = !sel.length;
    delBtn.textContent = sel.length ? `🗑삭제 ${sel.length}` : '🗑삭제';
  }
  if (!el) return;
  if (!sel.length) {
    el.innerHTML = '';
    return;
  }
  const saleSum = sel.filter((t) => OUT_KINDS.includes(kindOf(t.kind))).reduce((s, t) => s + t.total, 0);
  const buySum = Math.abs(sel.filter((t) => IN_KINDS.includes(kindOf(t.kind))).reduce((s, t) => s + t.total, 0));
  const canBundle = sel.some((t) => OUT_KINDS.includes(kindOf(t.kind)));
  el.innerHTML =
    ` · ☑ 선택 ${sel.length}건:` +
    (saleSum || !buySum ? ` 매출 ${won(saleSum)}원` : '') +
    (buySum ? ` 매입 ${won(buySum)}원` : '') +
    (saleSum && buySum ? ` · 이익 ${won(saleSum - buySum)}원` : '') +
    (canBundle ? ' <button type="button" id="btnBundleSheet" class="bundle-btn">🧾 선택한 것 한 장으로</button>' : '') +
    ' <button type="button" id="btnDelSelInline" class="bundle-btn del-sel">🗑 선택한 것 지우기</button>';
  const btn = $('#btnBundleSheet');
  if (btn) btn.addEventListener('click', openBundleStatement);
  const del = $('#btnDelSelInline');
  if (del) del.addEventListener('click', deleteSelectedRows);
}

// 고정된 머리글·입력 행에 가려지지 않게 스크롤한다 (다음 줄까지 한 줄 더 보이도록)
function scrollRowIntoView(tr) {
  const wrap = $('.ledger-wrap');
  if (!wrap || !tr) return;
  const head = $('.ledger-table thead', wrap);
  const headH = head ? head.getBoundingClientRect().height : 0;
  const entryH = 0;
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
  const rows = $$('#txRows tr');
  rows.forEach((tr) => tr.classList.remove('row-pointer'));
  if (sheetLastIdx != null && sheetLastIdx >= 0 && rows[sheetLastIdx]) {
    rows[sheetLastIdx].classList.add('row-pointer');
  }
}

// Ins 연속 체크: 포인터의 다음 행을 체크 (키를 누르고 있으면 반복)
function checkNextRow() {
  const next = nextSavedRow(sheetLastIdx);
  if (next < 0) {
    toast('마지막 줄입니다.');
    return;
  }
  sheetLastIdx = next;
  const tr = rowElAt(next);
  if (tr) {
    const cb = tr.querySelector('input[type="checkbox"]');
    if (cb && !cb.checked) {
      cb.checked = true;
      checkedTxIds.add(rowKey(tr));
      tr.classList.add('row-checked');
    }
    scrollRowIntoView(tr);
  }
  updatePointerHighlight();
  updateSelSummary();
}

// '-' 건너뛰기: 체크하지 않고 포인터만 다음 행으로
function skipNextRow() {
  const next = nextSavedRow(sheetLastIdx);
  if (next < 0) {
    toast('마지막 줄입니다.');
    return;
  }
  sheetLastIdx = next;
  const tr = rowElAt(next);
  if (tr) scrollRowIntoView(tr);
  updatePointerHighlight();
}

// Backspace 되돌리기: 포인터 행의 체크를 풀고 포인터를 한 칸 위로 (연타 가능)
function undoCheckRow() {
  if (sheetLastIdx == null || sheetLastIdx < 0) return;
  const cur = rowElAt(sheetLastIdx);
  if (cur) {
    const cb = cur.querySelector('input[type="checkbox"]');
    if (cb && cb.checked) {
      cb.checked = false;
      checkedTxIds.delete(rowKey(cur));
      cur.classList.remove('row-checked');
    }
  }
  sheetLastIdx = prevSavedRow(sheetLastIdx); // 없으면 -1 (다음 Ins는 첫 줄부터)
  const back = sheetLastIdx >= 0 ? rowElAt(sheetLastIdx) : null;
  if (back) scrollRowIntoView(back);
  updatePointerHighlight();
  updateSelSummary();
}

document.addEventListener('keydown', (e) => {
  if (state.tab !== 'transactions' || gridEdit) return;
  if (!['Insert', '-', 'Backspace', '=', 'Delete'].includes(e.key)) return;
  // 입력 중일 땐 원래 동작 유지 — 다만 방금 누른 체크 네모는 예외
  // (줄을 클릭해 체크하면 그 네모가 포커스를 갖는데, 이때도 '='로 이어서 체크되어야 한다)
  if (e.target.closest('select, textarea')) return;
  const inp = e.target.closest('input');
  if (inp && !(inp.type === 'checkbox' && inp.closest('#txRows'))) return;
  if (!$('#modal').classList.contains('hidden')) return;
  e.preventDefault();
  if (e.key === 'Delete') deleteSelectedRows();         // 고른 줄을 한꺼번에 지운다
  else if (e.key === '=') flipRowKind(gridCursor.r, false); // 지금 줄의 참조를 뒤집는다
  else if (e.key === 'Insert') checkNextRow();
  else if (e.key === '-') skipNextRow();
  else undoCheckRow();
});

/* ─────────────── 빠른 검색 시트 (Tab / 🔍) ─────────────── */
const ss = { tab: 'company', items: [], sel: 0, matched: true, companyId: 0, companyName: '' };

async function getAllProducts() {
  if (!state.productsCache.all) {
    state.productsCache.all = await api('GET', '/api/products');
  }
  return state.productsCache.all;
}

function searchSheetOpen() {
  return !$('#searchSheet').classList.contains('hidden');
}

function openSearchSheet(tab, query, company) {
  $('#searchSheet').classList.remove('hidden');
  document.body.classList.add('sheet-open'); // 본문을 패널 높이만큼 위로 밀어 올림
  ss.companyId = (company && company.id) || 0;   // 상호가 정해져 있으면 그 상호 제품만
  ss.companyName = (company && company.name) || '';
  if (tab) ssSetTabOnly(tab);
  $('#ssInput').value = query || '';
  ssUpdate();
  $('#ssInput').focus();
  $('#ssInput').select();
  scrollSheetToBottom(); // 입력 행이 패널 위에 계속 보이도록
}

// 적어 둔 상호명으로 상호를 찾는다 (아직 저장 전이라 id가 없을 수 있다)
function companyByName(name) {
  const n = (name || '').trim().toLowerCase();
  if (!n) return null;
  return state.companies.find((c) => c.name.toLowerCase() === n) || null;
}

// 품명을 찾을 때 기준이 되는 상호 — 그 줄에 적힌 상호(없으면 전체)
function contextCompany() {
  if (!state.easyMode && gridEdit) {
    const row = gridRows[gridEdit.r];
    if (row) {
      const byId = state.companies.find((c) => c.id === Number(row.companyId));
      return byId || companyByName(row.companyName);
    }
  }
  const x = $('#xCompany');
  if (x) return companyByName(x.value);
  return state.companies.find((c) => String(c.id) === String(state.entryCompanyId)) || null;
}

// 커서가 있던 칸에 맞춰 검색 대상과 검색어를 정한다
function openContextSearch() {
  if (gridEdit) {
    const value = gridEdit.input.value.trim();
    if (gridEdit.field === 'company') {
      gridSearching = true;
      return openSearchSheet('company', value);
    }
    if (gridEdit.field === 'name') {
      gridSearching = true;
      return openSearchSheet('product', value, contextCompany());
    }
  }
  const el = document.activeElement;
  const id = el && el.id;
  const value = el && typeof el.value === 'string' ? el.value.trim() : '';
  if (id === 'xCompany') return openSearchSheet('company', value);
  if (id === 'xName') return openSearchSheet('product', value, contextCompany());
  openSearchSheet(null, '');
}

function closeSearchSheet() {
  $('#searchSheet').classList.add('hidden');
  document.body.classList.remove('sheet-open');
  if (gridSearching) {
    gridSearching = false;
    // 고르지 않고 닫았으면 원래 칸으로 커서를 돌려준다
    if (gridEdit && gridEdit.input && gridEdit.input.isConnected) gridEdit.input.focus();
  }
}

function toggleSearchSheet() {
  if (searchSheetOpen()) closeSearchSheet();
  else openContextSearch();
}

// 탭만 바꾸고 검색은 호출한 쪽에서 실행한다
function ssSetTabOnly(tab) {
  ss.tab = tab;
  $('#ssTabCompany').classList.toggle('active', tab === 'company');
  $('#ssTabProduct').classList.toggle('active', tab === 'product');
  $('#ssInput').placeholder =
    tab === 'company'
      ? '상호명·대표자 검색 (아래에서 바로 수정 가능)'
      : `품명·규격 검색 (${ss.companyId ? esc(ss.companyName) : '전체 상호'})`;
}

function ssSetTab(tab) {
  ssSetTabOnly(tab);
  ssUpdate();
  $('#ssInput').focus();
}

// 가나다순 정렬 (컴장부처럼 목록은 늘 전체를 보여준다)
const sortByName = (list) => list.slice().sort((a, b) => a.name.localeCompare(b.name, 'ko'));

// 적어 둔 글자로 '시작하는' 첫 항목을 찾는다 (없으면 그 글자가 들어간 첫 항목)
function firstMatchIndex(list, q) {
  if (!q) return { index: 0, matched: true };
  const key = q.toLowerCase();
  const starts = list.findIndex((x) => (x.name || '').toLowerCase().startsWith(key));
  if (starts >= 0) return { index: starts, matched: true };
  const has = list.findIndex(
    (x) => (x.name || '').toLowerCase().includes(key) || (x.owner || '').toLowerCase().includes(key) || (x.spec || '').toLowerCase().includes(key)
  );
  return has >= 0 ? { index: has, matched: true } : { index: 0, matched: false };
}

async function ssUpdate() {
  const q = $('#ssInput').value.trim();
  if (ss.tab === 'company') {
    ss.items = sortByName(state.companies);
  } else {
    const names = new Map(state.companies.map((c) => [c.id, c.name]));
    let all = [];
    try {
      all = await getAllProducts();
    } catch (e) { /* 미로그인 등 */ }
    ss.items = sortByName(
      all
        .filter((p) => names.has(p.companyId))
        .filter((p) => !ss.companyId || p.companyId === ss.companyId) // 거래처가 정해졌으면 그 거래처 품목만
        .map((p) => Object.assign({}, p, { companyName: names.get(p.companyId) }))
    );
  }
  // 목록은 전체를 두고, 적어 둔 글자에 맞는 자리로 커서만 옮긴다
  const found = firstMatchIndex(ss.items, q);
  ss.sel = found.index;
  ss.matched = found.matched;
  ssRender();
}

function bindSsScopeBar() {
  const btn = $('#ssAllCompanies');
  if (!btn) return;
  btn.addEventListener('mousedown', (e) => e.preventDefault()); // 입력칸 포커스 유지
  btn.addEventListener('click', () => {
    ss.companyId = 0;
    ss.companyName = '';
    ssSetTabOnly('product');
    ssUpdate();
    $('#ssInput').focus();
  });
}

// 전체화면 — 장부를 한 화면에 더 많이 보이게 (컴장부처럼 꽉 채워 쓰기)
function toggleFullscreen() {
  const el = document.documentElement;
  if (document.fullscreenElement) {
    document.exitFullscreen().catch(() => {});
    return;
  }
  const req = el.requestFullscreen || el.webkitRequestFullscreen;
  if (!req) return toast('이 브라우저에서는 F11 키로 전체화면을 켜 주세요.');
  req.call(el).catch(() => toast('전체화면을 켤 수 없습니다 — F11 키를 눌러 주세요.'));
}

document.addEventListener('fullscreenchange', () => {
  const btn = $('#btnFullscreen');
  if (btn) btn.textContent = document.fullscreenElement ? '⛶ 전체화면 끄기' : '⛶ 전체화면';
  if (state.tab === 'transactions') fitLedgerHeight();
});

// 커서가 있는 줄의 거래처 정보를 장부 아래에 늘 띄운다 (컴장부처럼)
let coPanelId = null;

function drawCompanyPanel(force) {
  const box = $('#coPanel');
  if (!box) return;
  const row = gridRows[gridCursor.r];
  const id = row ? Number(row.companyId) || 0 : 0;
  const c = state.companies.find((x) => x.id === id);
  if (!force && coPanelId === (c ? c.id : 0)) return;
  coPanelId = c ? c.id : 0;
  if (!c) {
    box.innerHTML = '<span class="co-empty">거래처 칸에 커서를 두면 그 거래처 정보가 여기 나옵니다 · 여기서 바로 고칠 수 있습니다</span>';
    return;
  }
  box.innerHTML =
    `<span class="co-title">${esc(c.name)}</span>` +
    COMPANY_FIELDS.filter((f) => f.f !== 'name')
      .map(
        (f) => `<label class="co-item"><span>${f.label}</span>
          <input data-co="${f.f}" data-id="${c.id}" value="${esc(c[f.f])}" placeholder="${esc(f.ph || '')}"></label>`
      )
      .join('') +
    `<label class="co-item co-memo"><span>메모</span>
      <input data-co="memo" data-id="${c.id}" value="${esc(c.memo)}" placeholder=""></label>` +
    `<span class="co-sum">매출 ${won(c.total)}원${c.buyTotal ? ` · 매입 ${won(c.buyTotal)}원` : ''}</span>`;
  box.onclick = (e) => {
    if (e.target.tagName === 'INPUT') return; // 칸을 누른 건 수정
    box.classList.toggle('open');
  };
  $$('#coPanel input').forEach((inp) => {
    inp.addEventListener('change', () => saveCompanyPanelField(inp));
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        inp.blur();
      }
    });
  });
}

async function saveCompanyPanelField(inp) {
  const c = state.companies.find((x) => x.id === Number(inp.dataset.id));
  if (!c) return;
  c[inp.dataset.co] = inp.value.trim();
  try {
    await api('PUT', '/api/companies/' + c.id, {
      name: c.name, owner: c.owner || '', bizNo: c.bizNo || '',
      phone: c.phone || '', address: c.address || '', memo: c.memo || '',
    });
    toast('거래처 정보를 저장했습니다.');
  } catch (e) {
    toast('⚠ 저장하지 못했습니다 — ' + e.message);
  }
}

const COMPANY_FIELDS = [
  { f: 'name', label: '상호명', cls: 'w-name' },
  { f: 'owner', label: '대표자명', cls: 'w-owner' },
  { f: 'bizNo', label: '사업자번호', cls: 'w-biz', ph: '000-00-00000' },
  { f: 'phone', label: '연락처', cls: 'w-phone' },
  { f: 'address', label: '주소', cls: 'w-addr' },
];

// 상호로 좁혀 보는 중이면 그 사실과 [전체 상호에서 찾기] 버튼을 보여준다
function ssScopeBar() {
  const q = $('#ssInput').value.trim();
  const noMatch =
    q && !ss.matched
      ? `<p class="ss-scope ss-nomatch">'<b>${esc(q)}</b>'로 시작하는 ${ss.tab === 'company' ? '거래처' : '품목'}가 없습니다 ·
         <b>Enter</b>를 누르면 적은 그대로 씁니다 (저장할 때 새로 등록)</p>`
      : '';
  const scope =
    ss.tab === 'product' && ss.companyId
      ? `<p class="ss-scope"><b>${esc(ss.companyName)}</b>의 품목만 보는 중
         <button type="button" id="ssAllCompanies" class="link-btn">전체 거래처에서 찾기</button></p>`
      : '';
  return noMatch + scope;
}

function ssRender() {
  const box = $('#ssResults');
  if (!ss.items.length) {
    const q = $('#ssInput').value.trim();
    box.innerHTML =
      ssScopeBar() +
      (q
        ? `<p class="empty-cell">'${esc(q)}' 검색 결과가 없습니다 · <b>Enter</b>를 누르면 적은 그대로 칸에 넣습니다 (저장할 때 새로 등록)</p>`
        : '<p class="empty-cell">검색 결과가 없습니다.</p>');
    bindSsScopeBar();
    return;
  }
  if (ss.tab === 'company') {
    // 상호 정보를 입력칸으로 보여줘 그 자리에서 바로 고칠 수 있게 한다
    box.innerHTML = `
      <div class="ss-grid">
        <div class="ss-grid-head">
          ${COMPANY_FIELDS.map((c) => `<span class="${c.cls}">${c.label}</span>`).join('')}
          <span class="w-out">매출</span><span class="w-pick"></span>
        </div>
        ${ss.items
          .map(
            (c, i) => `<div class="ss-row ${i === ss.sel ? 'sel' : ''}" data-i="${i}" data-id="${c.id}">
              ${COMPANY_FIELDS.map(
                (col) => `<input class="${col.cls}" data-f="${col.f}" data-id="${c.id}" value="${esc(c[col.f])}" placeholder="${col.ph || col.label}">`
              ).join('')}
              <span class="w-out num">${won(c.total)}원</span>
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
  box.insertAdjacentHTML('afterbegin', ssScopeBar());
  bindSsScopeBar();
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

// 검색 결과가 없을 때 Enter: 적은 글자를 그대로 칸에 넣는다 (저장할 때 자동 등록)
function ssApplyText() {
  const text = $('#ssInput').value.trim();
  if (!text) return closeSearchSheet();
  if (!state.easyMode && gridEdit) {
    const r = gridEdit.r;
    const row = gridRows[r];
    gridSearching = false;
    gridEdit = null; // 편집 중이던 값 대신 검색창에 적은 값을 쓴다
    closeSearchSheet();
    if (ss.tab === 'company') {
      row.companyName = text;
      row.companyId = 0; // 저장할 때 이 이름으로 자동 등록된다
      paintRow(r);
      if (row.kind === 'tx') saveExistingRow(row, r);
      return openCellEditor(r, editableFields(row).includes('name') ? 'name' : 'date');
    }
    row.name = text;
    paintRow(r);
    if (row.kind === 'tx') saveExistingRow(row, r);
    return openCellEditor(r, 'spec');
  }
  // 큰 글씨 모드: 해당 입력칸에 그대로 넣는다
  const el = ss.tab === 'company' ? $('#xCompany') : $('#xName');
  closeSearchSheet();
  if (el) {
    el.value = text;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.focus();
  }
}

function ssPick(i) {
  const it = ss.items[i];
  if (!it) return;
  // 장부 그리드에서 셀을 편집하는 중이면 그 줄에 채워 넣는다
  if (!state.easyMode && gridEdit) {
    const r = gridEdit.r;
    const row = gridRows[r];
    gridSearching = false;
    gridEdit = null; // 편집 중이던 값은 버리고 고른 값으로 채운다
    paintRow(r);
    if (ss.tab === 'company') {
      row.companyName = it.name;
      row.companyId = it.id;
      state.entryCompanyId = String(it.id);
      paintRow(r);
      closeSearchSheet();
      if (row.kind === 'tx') saveExistingRow(row, r);
      return openCellEditor(r, editableFields(row).includes('name') ? 'name' : 'date');
    }
    const c = state.companies.find((x) => x.id === it.companyId);
    if (c) {
      row.companyName = c.name;
      row.companyId = c.id;
      state.entryCompanyId = String(c.id);
    }
    row.name = it.name;
    row.spec = it.spec;
    row.price = it.price;
    if (row.qty === '' || row.qty == null) row.qty = 1;
    paintRow(r);
    closeSearchSheet();
    if (row.kind === 'tx') saveExistingRow(row, r);
    return openCellEditor(r, 'qty');
  }
  const nameEl = $('#xName');
  const priceEl = $('#xPrice');
  const qtyEl = $('#xQty');
  if (ss.tab === 'company') {
    applyEntryCompany(it);
    closeSearchSheet();
    if (nameEl) nameEl.focus();
    return;
  }
  const c = state.companies.find((x) => x.id === it.companyId);
  if (c) applyEntryCompany(c); // 제품을 고르면 그 제품의 상호까지 함께 적용
  if (nameEl) nameEl.value = it.name;
  if (priceEl) priceEl.value = it.price;
  if (state.easyMode) easyRecompute();
  closeSearchSheet();
  if (qtyEl) {
    qtyEl.focus();
    qtyEl.select();
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
    if (ss.items.length && ss.matched) ssPick(ss.sel);
    else ssApplyText(); // 맞는 항목이 없으면 적은 글자를 그대로 칸에 넣는다
  }
});

// ESC: 열려 있는 것을 닫기만 한다 (검색은 Tab으로만 연다)
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || state.tab !== 'transactions') return;
  if (!$('#modal').classList.contains('hidden')) return;
  if (document.body.classList.contains('printing')) return;
  if (searchSheetOpen()) {
    e.preventDefault();
    return closeSearchSheet();
  }
  if (gridEdit) {
    e.preventDefault();
    return closeCellEditor(); // 적던 값을 버리고 편집만 닫는다
  }
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
        <label>구분
          <select name="kind">
            ${KIND_LIST.filter((k) => !MONEY_ONLY.includes(k))
              .map((k) => {
                const cur = tx ? kindOf(tx.kind) : state.entryKind;
                return `<option value="${k}" ${k === cur ? 'selected' : ''}>${KINDS[k].label} — ${KINDS[k].help}</option>`;
              })
              .join('')}
          </select>
        </label>
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
      kind: kindOf(form.kind.value),
      vatMode: form.vatMode.value,
      items,
      paid: 0,
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

// 체크한 줄을 한꺼번에 지운다 (컴장부 상단 [삭제]와 같은 기능)
async function deleteSelectedRows() {
  const sel = txCache.filter((t) => checkedTxIds.has('t' + t.id));
  if (!sel.length) return toast('먼저 줄 왼쪽 네모를 눌러(또는 Ins 키로) 지울 줄을 고르세요.');
  const first = sel[0];
  const more = sel.length > 1 ? ` 외 ${sel.length - 1}건` : '';
  if (!confirm(`선택한 ${sel.length}건을 지울까요?\n\n${first.date} ${first.companyName}${more}\n\n지운 내역은 되돌릴 수 없습니다.`)) return;
  let done = 0;
  for (const t of sel) {
    try {
      await api('DELETE', '/api/transactions/' + t.id);
      checkedTxIds.delete('t' + t.id);
      done += 1;
    } catch (e) {
      toast('⚠ 일부를 지우지 못했습니다 — ' + e.message);
      break;
    }
  }
  toast(`${done}건을 지웠습니다.`);
  await refreshCompanies();
  await drawTxRows();
}

// 체크한 여러 거래를 한 장의 거래명세표로 묶는다 (같은 상호끼리만)
function openBundleStatement() {
  const sel = txCache.filter((t) => checkedTxIds.has('t' + t.id));
  const list = sel.filter((t) => OUT_KINDS.includes(kindOf(t.kind))).sort((a, b) => a.date.localeCompare(b.date) || a.id - b.id);
  if (!list.length) return toast('매출·외출 줄을 골라 주세요 (물건이 나간 거래만 명세표를 만듭니다).');
  const companyIds = [...new Set(list.map((t) => t.companyId))];
  if (companyIds.length > 1) return toast('한 상호의 거래만 묶을 수 있습니다. 상호 하나만 골라 주세요.');

  // 품명 앞에 날짜(월/일)를 붙여 어느 날 것인지 알아볼 수 있게 한다
  const multiDay = new Set(list.map((t) => t.date)).size > 1;
  const items = list.flatMap((t) =>
    t.items.map((it) => Object.assign({}, it, { name: (multiDay ? t.date.slice(5).replace('-', '/') + ' ' : '') + it.name }))
  );
  const vatModes = [...new Set(list.map((t) => t.vatMode))];
  const bundle = {
    id: 0,
    companyId: list[0].companyId,
    companyName: list[0].companyName,
    date: multiDay ? `${list[0].date} ~ ${list[list.length - 1].date}` : list[0].date,
    vatMode: vatModes.length === 1 ? vatModes[0] : '',
    items,
    supplyTotal: list.reduce((s, t) => s + t.supplyTotal, 0),
    taxTotal: list.reduce((s, t) => s + t.taxTotal, 0),
    total: list.reduce((s, t) => s + t.total, 0),
    paid: 0,
    memo: `거래 ${list.length}건 묶음`,
  };
  openStatement(bundle);
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
        <td class="num">${won(Math.abs(it.qty))}</td>
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
        <tr><th>합계금액</th><td class="num">${won(tx.total)}원</td></tr>
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
    ...tx.items.map((it) => `· ${it.name}${it.spec ? '(' + it.spec + ')' : ''} ${won(Math.abs(it.qty))}개 x ${won(it.price)}원 = ${won(it.supply + it.tax)}원`),
    '',
    `공급가액 ${won(tx.supplyTotal)}원 / 세액 ${won(tx.taxTotal)}원`,
    `합계 ${won(tx.total)}원`,
  ];
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
    alt: '.ledger-wrap',
    title: '여기가 장부입니다',
    body: '거래 내역이 옛날→최신 순으로 쌓입니다. 컴퓨터에서는 머리글이 위에 고정되고, 휴대폰에서는 한 거래가 두세 줄 카드처럼 접혀서 보입니다.',
    pos: 'bottom',
  },
  {
    sel: '#txRows tr.row-new',
    title: '빈 칸을 눌러서 적으세요',
    body: '엑셀처럼 빈 칸을 누르면 그 자리에서 바로 입력됩니다. 날짜·상호·품명·수량·단가를 적고 줄 끝에서 Enter를 누르면 저장되고 다음 줄로 넘어갑니다. 공급가액·세액·합계는 자동으로 계산됩니다. 아래로 내리면 빈 줄이 계속 이어집니다.',
    pos: 'top',
  },
  {
    sel: '#txRows tr.row-new td[data-f="company"]',
    title: '상호는 그냥 적으면 등록됩니다',
    body: '상호명을 그대로 적으면 됩니다. 처음 보는 이름이면 자동으로 새로 등록되니 미리 만들어 둘 필요가 없습니다. 찾아서 고르고 싶으면 몇 글자만 적고 Tab을 누르세요 — 전체 거래처가 가나다순으로 뜨고 그 글자로 시작하는 곳에 커서가 가 있습니다. 한 번 정하면 계속 유지됩니다.',
    pos: 'top',
  },
  {
    sel: '#txRows tr.row-new td[data-f="name"]',
    title: '품명도 자동으로 쌓입니다',
    body: '품명을 적으면 그대로 제품으로 등록되고, 단가를 바꿔 적으면 최신 단가로 갱신됩니다. 예전에 팔던 걸 찾을 땐 몇 글자 적고 Tab을 누르세요 — 고르면 규격·단가까지 채워집니다. 같은 걸 또 적을 땐 품명을 비워두면 직전 품목이 그대로 들어갑니다.',
    pos: 'top',
  },
  {
    sel: '#txRows tr.row-new td[data-f="price"]',
    title: '반품·차감은 = 키로',
    body: '단가를 적고 = 키를 누르면 마이너스로 바뀝니다(한 번 더 누르면 원래대로). 마이너스 금액은 표에서 빨간색으로 보입니다.',
    pos: 'top',
  },
  {
    sel: '#txRows tr[data-kind="tx"] td.chk',
    title: '왼쪽 네모로 체크하고 소계 보기',
    body: '줄 왼쪽 네모를 누르면 체크됩니다. 체크한 뒤 = 키를 누르면 다음 줄이 연달아 체크되고, − 는 건너뛰기, Backspace 는 되돌리기입니다. 체크한 것들의 합계가 위에 표시됩니다.',
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
    title: 'Tab 으로 빠른 검색',
    body: '커서가 상호 칸에 있으면 상호만, 품명 칸에 있으면 제품만 찾아줍니다. 칸에 적어둔 글자가 검색어로 들어가고, 그 글자로 시작하는 것부터 보여줍니다. 고르면 입력 줄에 바로 채워집니다.',
    pos: 'left',
  },
  {
    sel: '#txRows tr[data-kind="tx"] button[data-act="sheet"]',
    title: '거래명세표 인쇄',
    body: '[명세표] 버튼으로 거래명세표를 띄워 인쇄하거나 PDF로 저장합니다. 공급받는자 정보는 명세표에서 바로 고칠 수 있고, 공급자 정보는 [내 정보] 탭에서 설정합니다.',
    pos: 'bottom',
    optional: true,
  },
  {
    sel: '#btnPin',
    title: '다음 줄을 어느 칸부터 적을지 (커서 고정)',
    body: '줄을 저장하면 다음 줄의 상호 칸부터 시작합니다. 늘 같은 칸부터 적고 싶으면 그 칸을 누른 뒤 F2(또는 이 📌 버튼)를 누르세요. 한 번 더 누르면 해제됩니다.',
    pos: 'top',
  },
  {
    sel: '#btnHelp',
    title: '다시 보고 싶을 땐 여기',
    body: '이 [?] 버튼을 누르면 언제든 사용법을 다시 볼 수 있습니다. 이제 첫 거래를 적어 보세요!',
    pos: 'left',
  },
];

const tour = { steps: [], i: 0, toolsOpened: false };

// 화면 폭에 따라 감춰진 요소가 있으면 대체 요소를 비춘다
function tourStepEl(step) {
  return tourVisible(step.sel) || (step.alt ? tourVisible(step.alt) : null);
}

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
  // 휴대폰에서는 접혀 있는 검색조건·도구를 펴 두고 안내한다 (끝나면 원래대로)
  const toolsBtn = $('#btnToolsToggle');
  tour.toolsOpened = false;
  if (toolsBtn && tourVisible('#btnToolsToggle') && !$('#txCard').classList.contains('tools-open')) {
    toolsBtn.click();
    tour.toolsOpened = true;
  }
  // 화면에 실제로 있는 단계만 사용 (거래가 없으면 행 관련 단계는 건너뜀)
  tour.steps = TOUR_STEPS.filter((s) => !s.optional || tourStepEl(s));
  tour.i = 0;
  $('#tourOverlay').classList.remove('hidden');
  showTourStep();
}

function endTour() {
  $('#tourOverlay').classList.add('hidden');
  if (tour.toolsOpened) { // 안내하려고 펴 둔 도구 줄은 다시 접는다
    const btn = $('#btnToolsToggle');
    if (btn && $('#txCard') && $('#txCard').classList.contains('tools-open')) btn.click();
    tour.toolsOpened = false;
  }
  try {
    localStorage.setItem('tourDone', '1');
  } catch (e) { /* 무시 */ }
}

function showTourStep() {
  const step = tour.steps[tour.i];
  if (!step) return endTour();
  const el = tourStepEl(step);
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
    .then((v) => {
      $('#verFooter').textContent = `거래장부 v${v.version} · ${v.commit}`;
      // 서버는 새 버전인데 화면 코드가 예전 것이면(캐시) 한 번 자동 새로고침한다
      if (v.version !== APP_VERSION) {
        if (!sessionStorage.getItem('verReloaded')) {
          sessionStorage.setItem('verReloaded', '1');
          location.reload();
        } else {
          $('#verFooter').textContent += ` · ⚠ 화면은 v${APP_VERSION} — Ctrl+Shift+R로 새로고침하세요`;
        }
      } else {
        sessionStorage.removeItem('verReloaded');
      }
    })
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
