'use strict';

/* ─────────────── 공통 유틸 ─────────────── */
const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => Array.from(el.querySelectorAll(sel));

const state = {
  tab: 'companies',
  companies: [],
  settings: {},
  companySearch: '',
  productCompanyId: '', // 제품관리 탭에서 선택된 상호
  txCompanyId: '',      // 거래관리 탭 필터 ('' = 전체)
};

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
      closeModal();
      toast('저장했습니다.');
      drawProductRows();
    } catch (err) {
      alert(err.message);
    }
  });
}

/* ─────────────── 거래관리 ─────────────── */
let txCache = [];

async function renderTransactions() {
  await refreshCompanies();
  const main = $('#main');
  main.innerHTML = `
    <section class="card">
      <div class="section-head">
        <select id="txCompany">
          <option value="">전체 상호</option>
          ${state.companies.map((c) => `<option value="${c.id}" ${String(c.id) === state.txCompanyId ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}
        </select>
        <button class="primary" id="btnAddTx">＋ 새 거래</button>
      </div>
      <p id="txSummary" class="summary"></p>
      <div class="table-wrap">
        <table>
          <thead><tr><th>날짜</th><th>상호</th><th>품목</th><th class="num">공급가액</th><th class="num">세액</th><th class="num">합계</th><th class="num">입금</th><th class="num">잔액</th><th class="actions"></th></tr></thead>
          <tbody id="txRows"></tbody>
        </table>
      </div>
    </section>`;
  $('#txCompany').addEventListener('change', (e) => {
    state.txCompanyId = e.target.value;
    drawTxRows();
  });
  $('#btnAddTx').addEventListener('click', () => openTxForm(null));
  drawTxRows();
}

async function drawTxRows() {
  txCache = await api('GET', '/api/transactions' + (state.txCompanyId ? '?companyId=' + state.txCompanyId : ''));
  const tbody = $('#txRows');
  if (!tbody) return;
  const total = txCache.reduce((s, t) => s + t.total, 0);
  const paid = txCache.reduce((s, t) => s + t.paid, 0);
  $('#txSummary').textContent = `${txCache.length}건 · 합계 ${won(total)}원 · 입금 ${won(paid)}원 · 잔액 ${won(total - paid)}원`;
  if (!txCache.length) {
    tbody.innerHTML = `<tr><td colspan="9" class="empty-cell">${state.companies.length ? '거래 내역이 없습니다. [＋ 새 거래] 버튼으로 시작하세요.' : '먼저 상호관리에서 상호를 등록하세요.'}</td></tr>`;
    return;
  }
  tbody.innerHTML = txCache
    .map((t) => {
      const first = t.items[0];
      const label = esc(first.name) + (t.items.length > 1 ? ` 외 ${t.items.length - 1}건` : '');
      const balance = t.total - t.paid;
      return `<tr>
        <td>${esc(t.date)}</td>
        <td><b>${esc(t.companyName)}</b></td>
        <td>${label}${t.memo ? `<div class="sub">${esc(t.memo)}</div>` : ''}</td>
        <td class="num">${won(t.supplyTotal)}</td>
        <td class="num">${won(t.taxTotal)}</td>
        <td class="num"><b>${won(t.total)}</b></td>
        <td class="num">${won(t.paid)}</td>
        <td class="num ${balance > 0 ? 'warn' : ''}">${won(balance)}</td>
        <td class="actions">
          <button data-act="sheet" data-id="${t.id}">명세표</button>
          <button data-act="edit" data-id="${t.id}">수정</button>
          <button data-act="del" data-id="${t.id}" class="danger">삭제</button>
        </td>
      </tr>`;
    })
    .join('');
  tbody.onclick = async (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const id = Number(btn.dataset.id);
    const t = txCache.find((x) => x.id === id);
    if (!t) return;
    if (btn.dataset.act === 'sheet') openStatement(t);
    else if (btn.dataset.act === 'edit') openTxForm(t);
    else if (btn.dataset.act === 'del') {
      if (!confirm(`${t.date} '${t.companyName}' 거래를 삭제할까요?`)) return;
      await api('DELETE', '/api/transactions/' + id);
      toast('거래를 삭제했습니다.');
      drawTxRows();
    }
  };
}

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
          <thead><tr><th>제품 선택</th><th>품명 *</th><th>규격</th><th class="w-qty">수량</th><th class="w-price">단가</th><th class="num">금액</th><th></th></tr></thead>
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
  let products = [];

  async function loadProducts() {
    products = await api('GET', '/api/products?companyId=' + form.companyId.value);
    $$('.i-product', form).forEach(fillProductSelect);
  }

  function fillProductSelect(sel) {
    const keep = sel.value;
    sel.innerHTML = '<option value="">직접 입력</option>' + products.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('');
    sel.value = keep && products.some((p) => String(p.id) === keep) ? keep : '';
  }

  function addRow(item) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><select class="i-product"></select></td>
      <td><input class="i-name" value="${esc(item && item.name)}" placeholder="품명"></td>
      <td><input class="i-spec" value="${esc(item && item.spec)}" placeholder="규격"></td>
      <td><input class="i-qty" type="number" inputmode="decimal" step="any" min="0" value="${item ? item.qty : 1}"></td>
      <td><input class="i-price" type="number" inputmode="numeric" min="0" value="${item ? item.price : 0}"></td>
      <td class="num i-amount">0</td>
      <td><button type="button" class="i-del" title="품목 삭제">✕</button></td>`;
    fillProductSelect($('.i-product', tr));
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
  $('#txFormCompany').addEventListener('change', loadProducts);
  $('#btnAddItem').addEventListener('click', () => addRow(null));
  $('#itemRows').addEventListener('click', (e) => {
    if (e.target.classList.contains('i-del')) {
      e.target.closest('tr').remove();
      recompute();
    }
  });
  $('#itemRows').addEventListener('change', (e) => {
    if (!e.target.classList.contains('i-product')) return;
    const p = products.find((x) => String(x.id) === e.target.value);
    if (!p) return;
    const tr = e.target.closest('tr');
    $('.i-name', tr).value = p.name;
    $('.i-spec', tr).value = p.spec;
    $('.i-price', tr).value = p.price;
    recompute();
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
      closeModal();
      toast('저장했습니다.');
      drawTxRows();
    } catch (err) {
      alert(err.message);
    }
  });

  await loadProducts();
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

/* ─────────────── 시작 ─────────────── */
$('#btnLogout').addEventListener('click', async () => {
  if (!confirm('로그아웃할까요?')) return;
  await api('POST', '/api/auth/logout');
  location.href = '/login.html';
});

(async function init() {
  const hash = location.hash.slice(1);
  if (['companies', 'products', 'transactions', 'settings'].includes(hash)) {
    state.tab = hash;
    $$('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === hash));
  }
  try {
    const st = await api('GET', '/api/auth/status');
    if (!st.authed) {
      location.href = '/login.html';
      return;
    }
    state.settings = await api('GET', '/api/settings');
    await refreshCompanies();
  } catch (e) {
    $('#main').innerHTML = `<section class="card"><p class="empty-notice">서버에 연결할 수 없습니다: ${esc(e.message)}</p></section>`;
    return;
  }
  render();
})();
