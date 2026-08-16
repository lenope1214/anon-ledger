'use strict';

/* ─────────────── 공통 유틸 ─────────────── */
const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => Array.from(el.querySelectorAll(sel));

const state = {
  tab: 'companies',
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
try {
  const savedVat = localStorage.getItem('entryVat');
  if (savedVat && ['separate', 'included', 'none'].includes(savedVat)) state.entryVat = savedVat;
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
        <td class="num ${c.outstanding > 0 ? 'warn' : ''}">${won(c.outstanding)}원</td>
        <td class="actions">
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
let checkedTxIds = new Set(); // 체크된 거래 id (새로고침 전까지 유지)
let sheetLastIdx = null;      // 마지막으로 체크한 행 위치 ('=' 연속 체크용)

async function renderTransactions() {
  await refreshCompanies();
  const main = $('#main');
  if (!state.companies.length) {
    main.innerHTML = `<section class="card">${emptyNotice('거래를 입력하려면 먼저 상호를 등록해야 합니다.', '상호관리로 이동', 'companies')}</section>`;
    bindGoto(main);
    return;
  }
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
        <button id="btnAddTx">＋ 여러 품목 거래</button>
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
              <td><input id="eCompany" placeholder="상호 검색" autocomplete="off"></td>
              <td><input id="eName" placeholder="품명 입력" autocomplete="off"></td>
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
      <p class="hint">맨 아래 파란 행에 적고 Enter(또는 저장)를 누르면 바로 기록됩니다.
      품명을 입력하면 등록된 제품이 힌트로 나타나며, 적은 품명·규격·단가는 제품관리에 자동 등록됩니다.
      <b>=</b> 키: 입력 중엔 단가 부호 토글(+ ⇄ −), 행을 클릭한 뒤엔 다음 행 연속 체크
      (<b>−</b> 건너뛰기 · <b>Backspace</b> 되돌리기).
      <b>ESC</b> 키(또는 오른쪽 아래 🔍): 상호·제품 빠른 검색.</p>
      <button type="button" class="fab" id="btnQuickSearch" title="빠른 검색 (ESC)">🔍 검색</button>
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
  $('#eQty').addEventListener('input', recomputeEntry);
  $('#ePrice').addEventListener('input', recomputeEntry);
  attachProductAutocomplete($('#eName'), () => state.entryCompanyId, (p) => {
    $('#eName').value = p.name;
    $('#eSpec').value = p.spec;
    $('#ePrice').value = p.price;
    recomputeEntry();
    $('#eQty').focus();
    $('#eQty').select();
  });
  $('#btnQuickSearch').addEventListener('click', toggleSearchSheet);
  $('#btnEntrySave').addEventListener('click', saveEntry);
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
  await drawTxRows();
  scrollSheetToBottom();
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
  if (!state.entryCompanyId) {
    toast('상호를 검색해 선택하세요.');
    $('#eCompany').focus();
    return;
  }
  const name = $('#eName').value.trim();
  if (!name) {
    toast('품명을 입력하세요.');
    $('#eName').focus();
    return;
  }
  const body = {
    companyId: Number(state.entryCompanyId),
    date: $('#eDate').value || today(),
    vatMode: state.entryVat,
    items: [{ name, spec: $('#eSpec').value.trim(), qty: Number($('#eQty').value) || 0, price: Number($('#ePrice').value) || 0 }],
    paid: Number($('#ePaid').value) || 0,
    memo: '',
  };
  try {
    await api('POST', '/api/transactions', body);
  } catch (err) {
    alert(err.message);
    return;
  }
  state.entryDate = body.date;
  state.entryCompanyId = String(body.companyId);
  clearProductsCache(); // 자동 등록된 제품이 힌트에 바로 나오도록
  $('#eName').value = '';
  $('#eSpec').value = '';
  $('#eQty').value = 1;
  $('#ePrice').value = '';
  $('#ePaid').value = '';
  await drawTxRows();
  toast('저장했습니다.');
  scrollSheetToBottom();
  $('#eName').focus();
}

async function drawTxRows() {
  txCache = await api('GET', '/api/transactions' + (state.txCompanyId ? '?companyId=' + state.txCompanyId : ''));
  const tbody = $('#txRows');
  if (!tbody) return;

  // 날짜 범위·품명 검색 필터 (화면에서 걸러냄)
  let list = txCache;
  if (state.txFrom) list = list.filter((t) => t.date >= state.txFrom);
  if (state.txTo) list = list.filter((t) => t.date <= state.txTo);
  const q = state.txProductQuery.trim().toLowerCase();
  if (q) list = list.filter((t) => t.items.some((it) => it.name.toLowerCase().includes(q)));

  const total = list.reduce((s, t) => s + t.total, 0);
  const paid = list.reduce((s, t) => s + t.paid, 0);
  $('#txSummary').textContent = `${list.length}건 · 합계 ${won(total)}원 · 입금 ${won(paid)}원 · 잔액 ${won(total - paid)}원`;
  updateSelSummary();

  const rows = [...list].sort((a, b) => a.date.localeCompare(b.date) || a.id - b.id); // 옛날 → 최신
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="13" class="empty-cell">${txCache.length ? '검색 조건에 맞는 거래가 없습니다.' : '아직 거래가 없습니다. 아래 파란 입력 행에서 첫 거래를 적어보세요.'}</td></tr>`;
    return;
  }
  tbody.innerHTML = rows
    .map((t, i) => {
      const single = t.items.length === 1;
      const it = t.items[0];
      const balance = t.total - t.paid;
      const checked = checkedTxIds.has(t.id);
      return `<tr data-id="${t.id}" data-idx="${i}" class="${checked ? 'row-checked' : ''}">
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
      const t = txCache.find((x) => x.id === id);
      if (!t) return;
      if (btn.dataset.act === 'sheet') openStatement(t);
      else if (btn.dataset.act === 'edit') openTxForm(t);
      else if (btn.dataset.act === 'del') {
        if (!confirm(`${t.date} '${t.companyName}' 거래를 삭제할까요?`)) return;
        await api('DELETE', '/api/transactions/' + id);
        checkedTxIds.delete(id);
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
    const id = Number(tr.dataset.id);
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
  const sel = txCache.filter((t) => checkedTxIds.has(t.id));
  if (!sel.length) {
    el.textContent = '';
    return;
  }
  const total = sel.reduce((s, t) => s + t.total, 0);
  const paid = sel.reduce((s, t) => s + t.paid, 0);
  el.textContent = ` · ☑ 선택 ${sel.length}건: 합계 ${won(total)}원 · 입금 ${won(paid)}원 · 잔액 ${won(total - paid)}원`;
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
  if (!next) return;
  sheetLastIdx += 1;
  const cb = next.querySelector('input[type="checkbox"]');
  if (cb && !cb.checked) {
    cb.checked = true;
    checkedTxIds.add(Number(next.dataset.id));
    next.classList.add('row-checked');
  }
  next.scrollIntoView({ block: 'nearest' });
  updatePointerHighlight();
  updateSelSummary();
}

// '-' 건너뛰기: 체크하지 않고 포인터만 다음 행으로
function skipNextRow() {
  if (sheetLastIdx == null) return;
  const rows = $$('#txRows tr[data-id]');
  const next = rows[sheetLastIdx + 1];
  if (!next) return;
  sheetLastIdx += 1;
  next.scrollIntoView({ block: 'nearest' });
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
    checkedTxIds.delete(Number(cur.dataset.id));
    cur.classList.remove('row-checked');
  }
  sheetLastIdx -= 1; // -1이 되면 '첫 행 이전' 상태 — 다음 '='는 첫 행부터 체크
  if (sheetLastIdx >= 0) rows[sheetLastIdx].scrollIntoView({ block: 'nearest' });
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
  $('#ssInput').placeholder = tab === 'company' ? '상호명·대표자 검색' : '품명·규격 검색 (전체 상호)';
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

function ssRender() {
  const box = $('#ssResults');
  if (!ss.items.length) {
    box.innerHTML = '<p class="empty-cell">검색 결과가 없습니다.</p>';
    return;
  }
  box.innerHTML = ss.items
    .map((it, i) =>
      ss.tab === 'company'
        ? `<div class="ss-item ${i === ss.sel ? 'sel' : ''}" data-i="${i}">
            <b>${esc(it.name)}</b>${it.owner ? `<span class="sub">${esc(it.owner)}</span>` : ''}
            <span class="right ${it.outstanding > 0 ? 'warn' : ''}">미수 ${won(it.outstanding)}원</span>
          </div>`
        : `<div class="ss-item ${i === ss.sel ? 'sel' : ''}" data-i="${i}">
            <b>${esc(it.name)}</b>${it.spec ? `<span class="sub">${esc(it.spec)}</span>` : ''}
            <span class="sub">${esc(it.companyName)}</span>
            <span class="right">${won(it.price)}원</span>
          </div>`
    )
    .join('');
  const selEl = box.querySelector('.ss-item.sel');
  if (selEl) selEl.scrollIntoView({ block: 'nearest' });
  box.querySelectorAll('.ss-item').forEach((el) => {
    el.addEventListener('mousedown', (e) => {
      e.preventDefault();
      ssPick(Number(el.dataset.i));
    });
  });
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
        ${partyTable('공급받는자', company)}
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
  document.body.classList.add('printing');
  $('#printOverlay').classList.remove('hidden');
}

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
  if (['companies', 'products', 'transactions', 'settings', 'admin'].includes(hash)) {
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
  render();
})();
