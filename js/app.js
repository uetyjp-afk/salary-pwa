// 給与管理 PWA v3
const STORAGE_KEY = 'salaryRecords_v3';
const SETTINGS_KEY = 'salarySettings_v3';
const DB_NAME = 'salaryDB_v3';
const STORE_NAME = 'records';

const DEFAULT_PAYMENT_FIELDS = [
  { key: 'baseSalary', label: '基本給' },
  { key: 'salesAllowance', label: '営業手当' },
  { key: 'adjustmentAllowance', label: '調整手当' },
  { key: 'managementAllowance', label: '管理手当' },
  { key: 'holidayWorkPay', label: '休日出勤' },
  { key: 'qualificationAllowance', label: '資格手当' },
  { key: 'variableAllowance', label: '変動手当' },
  { key: 'commuteAllowance', label: '通勤手当' },
  { key: 'otherPayment', label: 'その他支給（賞与等）' }
];
const DEFAULT_DEDUCTION_FIELDS = [
  { key: 'healthInsurance', label: '健康保険料' },
  { key: 'careInsurance', label: '介護保険料' },
  { key: 'pension', label: '厚生年金' },
  { key: 'employmentInsurance', label: '雇用保険' },
  { key: 'incomeTax', label: '所得税' },
  { key: 'residentTax', label: '住民税' },
  { key: 'otherDeduction', label: 'その他控除（還付はマイナス）' }
];

let records = [];
let settings = {
  darkMode: false,
  targetNet: 0,
  paymentFields: [...DEFAULT_PAYMENT_FIELDS],
  deductionFields: [...DEFAULT_DEDUCTION_FIELDS]
};
let charts = { trend: null, payment: null, deduction: null };
let editingId = null;
let db = null;

function formatYen(n) {
  return '¥' + Number(n || 0).toLocaleString('ja-JP');
}

function uid() {
  return 'r_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function slugKey(label) {
  return 'custom_' + label.replace(/\s+/g, '_').replace(/[^\w\u3040-\u30ff\u4e00-\u9fff]/g, '').slice(0, 24) + '_' + Math.random().toString(36).slice(2, 5);
}

function calcTotals(r) {
  let payment = 0, deduction = 0;
  settings.paymentFields.forEach(f => { payment += Number(r[f.key] || 0); });
  settings.deductionFields.forEach(f => { deduction += Number(r[f.key] || 0); });
  // fallback for old seed keys if custom config removed some
  if (settings.paymentFields === DEFAULT_PAYMENT_FIELDS || !settings.paymentFields.length) {
    // already covered
  }
  return { payment, deduction, net: payment - deduction };
}

function showToast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 2800);
}

// ---------- settings persistence ----------
function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return;
    const s = JSON.parse(raw);
    if (s.paymentFields?.length) settings.paymentFields = s.paymentFields;
    if (s.deductionFields?.length) settings.deductionFields = s.deductionFields;
    if (typeof s.darkMode === 'boolean') settings.darkMode = s.darkMode;
    if (typeof s.targetNet === 'number') settings.targetNet = s.targetNet;
  } catch (e) {}
}

function saveSettings() {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  applyDarkMode();
  renderFieldLists();
  buildDynamicFormFields();
  updateTargetBanner();
}

function applyDarkMode() {
  document.body.classList.toggle('dark', settings.darkMode);
  const t = document.getElementById('dark-mode-toggle');
  if (t) t.checked = settings.darkMode;
}

// ---------- records persistence ----------
function saveToLocal() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(records));
    return true;
  } catch (e) { return false; }
}
function loadFromLocal() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) { return null; }
}

function openDB() {
  return new Promise(resolve => {
    if (!window.indexedDB) { resolve(null); return; }
    try {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = e => {
        const database = e.target.result;
        if (!database.objectStoreNames.contains(STORE_NAME))
          database.createObjectStore(STORE_NAME, { keyPath: 'id' });
      };
      req.onsuccess = e => { db = e.target.result; resolve(db); };
      req.onerror = () => resolve(null);
    } catch (e) { resolve(null); }
  });
}

async function saveToIDB() {
  if (!db) return false;
  try {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    store.clear();
    records.forEach(r => store.put(r));
    return new Promise(res => {
      tx.oncomplete = () => res(true);
      tx.onerror = () => res(false);
    });
  } catch (e) { return false; }
}

async function persist() {
  const ok = saveToLocal() || (await saveToIDB());
  updateSaveStatus(ok);
  return ok;
}

function updateSaveStatus(ok) {
  const el = document.getElementById('save-status');
  if (!el) return;
  el.textContent = ok
    ? `保存OK（${records.length}件）。ブラウザに保存済みです。`
    : `保存に問題がある可能性があります（${records.length}件）。JSONエクスポートを推奨します。`;
  el.style.color = ok ? '#16a34a' : '#dc2626';
}

// ---------- navigation ----------
function switchPage(page) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  document.getElementById('page-' + page).classList.add('active');
  document.querySelector(`.nav-btn[data-page="${page}"]`).classList.add('active');
  if (page === 'dashboard') updateDashboard();
  if (page === 'list') renderList();
  if (page === 'add' && !editingId) resetForm();
  if (page === 'settings') renderFieldLists();
}
window.switchPage = switchPage;

document.querySelectorAll('.nav-btn').forEach(btn => {
  btn.addEventListener('click', () => switchPage(btn.dataset.page));
});

// ---------- dynamic form fields ----------
function buildDynamicFormFields() {
  const payBox = document.getElementById('payment-fields');
  const dedBox = document.getElementById('deduction-fields');
  if (!payBox || !dedBox) return;

  payBox.innerHTML = settings.paymentFields.map(f =>
    `<div class="form-group"><label>${f.label}</label><input type="number" data-field="${f.key}" class="pay-input" value="0"></div>`
  ).join('');

  dedBox.innerHTML = settings.deductionFields.map(f =>
    `<div class="form-group"><label>${f.label}</label><input type="number" data-field="${f.key}" class="ded-input" value="0"></div>`
  ).join('');

  document.querySelectorAll('.pay-input, .ded-input').forEach(el => {
    el.addEventListener('input', updatePreview);
  });
}

function renderFieldLists() {
  const payList = document.getElementById('field-list-payment');
  const dedList = document.getElementById('field-list-deduction');
  if (!payList || !dedList) return;

  const row = (kind, f, i, total) => {
    const upDis = i === 0 ? 'disabled' : '';
    const downDis = i === total - 1 ? 'disabled' : '';
    return `<li class="field-item">
      <span class="field-name">${f.label}</span>
      <span class="field-actions">
        <button type="button" class="btn btn-sm btn-outline" onclick="moveField('${kind}',${i},-1)" ${upDis} title="上へ">↑</button>
        <button type="button" class="btn btn-sm btn-outline" onclick="moveField('${kind}',${i},1)" ${downDis} title="下へ">↓</button>
        <button type="button" class="btn btn-sm btn-danger" onclick="removeField('${kind}',${i})">削除</button>
      </span>
    </li>`;
  };

  const nP = settings.paymentFields.length;
  const nD = settings.deductionFields.length;
  payList.innerHTML = nP
    ? settings.paymentFields.map((f, i) => row('payment', f, i, nP)).join('')
    : '<li style="color:#94a3b8">項目なし</li>';
  dedList.innerHTML = nD
    ? settings.deductionFields.map((f, i) => row('deduction', f, i, nD)).join('')
    : '<li style="color:#94a3b8">項目なし</li>';
}

window.moveField = function(kind, index, dir) {
  const list = kind === 'payment' ? settings.paymentFields : settings.deductionFields;
  const to = index + dir;
  if (to < 0 || to >= list.length) return;
  const tmp = list[index];
  list[index] = list[to];
  list[to] = tmp;
  saveSettings();
};

window.removeField = function(kind, index) {
  if (!confirm('この項目を削除しますか？（既存データ内の値は残りますが入力欄から消えます）')) return;
  if (kind === 'payment') settings.paymentFields.splice(index, 1);
  else settings.deductionFields.splice(index, 1);
  saveSettings();
  showToast('項目を削除しました');
};

document.getElementById('add-payment-field')?.addEventListener('click', () => {
  const input = document.getElementById('new-payment-field');
  const label = (input.value || '').trim();
  if (!label) { showToast('項目名を入力してください'); return; }
  if (settings.paymentFields.some(f => f.label === label)) { showToast('同じ名前があります'); return; }
  settings.paymentFields.push({ key: slugKey(label), label });
  input.value = '';
  saveSettings();
  showToast('支給項目を追加しました');
});

document.getElementById('add-deduction-field')?.addEventListener('click', () => {
  const input = document.getElementById('new-deduction-field');
  const label = (input.value || '').trim();
  if (!label) { showToast('項目名を入力してください'); return; }
  if (settings.deductionFields.some(f => f.label === label)) { showToast('同じ名前があります'); return; }
  settings.deductionFields.push({ key: slugKey(label), label });
  input.value = '';
  saveSettings();
  showToast('控除項目を追加しました');
});

// ---------- form ----------
function getFormData() {
  const year = +document.getElementById('year').value;
  const month = +document.getElementById('month').value;
  const type = document.getElementById('type').value;
  const data = {
    id: editingId || uid(),
    year, month, type,
    yearMonth: `${year}-${String(month).padStart(2, '0')}`,
    workDays: +document.getElementById('workDays').value || 0,
    holidayWorkDays: +document.getElementById('holidayWorkDays').value || 0,
    paidLeaveDays: +document.getElementById('paidLeaveDays').value || 0,
    paidLeaveRemain: +document.getElementById('paidLeaveRemain').value || 0,
    note: document.getElementById('note').value || '',
    updatedAt: new Date().toISOString()
  };
  document.querySelectorAll('.pay-input, .ded-input').forEach(el => {
    data[el.dataset.field] = +el.value || 0;
  });
  return data;
}

function setFormData(r) {
  document.getElementById('year').value = r.year ?? '';
  document.getElementById('month').value = r.month ?? 1;
  document.getElementById('type').value = r.type || '給与';
  document.getElementById('workDays').value = r.workDays ?? 0;
  document.getElementById('holidayWorkDays').value = r.holidayWorkDays ?? 0;
  document.getElementById('paidLeaveDays').value = r.paidLeaveDays ?? 0;
  document.getElementById('paidLeaveRemain').value = r.paidLeaveRemain ?? 0;
  document.getElementById('note').value = r.note || '';
  // rebuild fields then set values
  buildDynamicFormFields();
  document.querySelectorAll('.pay-input, .ded-input').forEach(el => {
    el.value = r[el.dataset.field] ?? 0;
  });
  updatePreview();
}

function resetForm() {
  editingId = null;
  document.getElementById('form-title').textContent = '明細を追加';
  document.getElementById('submit-btn').textContent = '保存する';
  document.getElementById('cancel-btn').style.display = 'none';
  const now = new Date();
  document.getElementById('year').value = now.getFullYear();
  document.getElementById('month').value = now.getMonth() + 1;
  document.getElementById('type').value = '給与';
  document.getElementById('workDays').value = 0;
  document.getElementById('holidayWorkDays').value = 0;
  document.getElementById('paidLeaveDays').value = 0;
  document.getElementById('paidLeaveRemain').value = 0;
  document.getElementById('note').value = '';
  buildDynamicFormFields();
  updatePreview();
}

function updatePreview() {
  const data = getFormData();
  const { payment, deduction, net } = calcTotals(data);
  document.getElementById('total-payment-preview').textContent = formatYen(payment);
  document.getElementById('total-deduction-preview').textContent = formatYen(deduction);
  document.getElementById('net-preview').textContent = formatYen(net);
}

document.getElementById('year')?.addEventListener('input', updatePreview);
document.getElementById('month')?.addEventListener('change', updatePreview);
document.getElementById('type')?.addEventListener('change', updatePreview);

document.getElementById('salary-form').addEventListener('submit', async e => {
  e.preventDefault();
  const data = getFormData();
  if (!data.year || data.year < 2000) { showToast('年を正しく入力してください'); return; }
  const t = calcTotals(data);
  data.totalPayment = t.payment;
  data.totalDeduction = t.deduction;
  data.netPay = t.net;

  const same = records.find(r => r.yearMonth === data.yearMonth && r.type === data.type && r.id !== data.id);
  if (same) {
    if (!confirm(`${data.year}年${data.month}月（${data.type}）は既にあります。上書きしますか？`)) return;
    data.id = same.id;
  }

  const idx = records.findIndex(r => r.id === data.id);
  if (idx >= 0) records[idx] = data;
  else records.push(data);
  records.sort((a, b) => a.yearMonth.localeCompare(b.yearMonth) || (a.type === '給与' ? -1 : 1));

  const ok = await persist();
  showToast(ok ? (editingId ? '更新して保存しました' : '保存しました') : '保存に失敗した可能性があります');
  editingId = null;
  switchPage('list');
});

document.getElementById('cancel-btn').addEventListener('click', () => {
  editingId = null;
  resetForm();
  switchPage('list');
});

document.getElementById('copy-latest-btn').addEventListener('click', () => {
  if (!records.length) { showToast('コピーする明細がありません'); return; }
  const sorted = [...records].sort((a, b) => b.yearMonth.localeCompare(a.yearMonth));
  const latest = { ...sorted[0] };
  let y = latest.year, m = latest.month + 1;
  if (m > 12) { m = 1; y++; }
  latest.year = y;
  latest.month = m;
  latest.type = '給与';
  delete latest.id;
  setFormData(latest);
  showToast(`${sorted[0].year}年${sorted[0].month}月をコピー（年月は翌月）`);
});

// ---------- list ----------
function renderList() {
  const container = document.getElementById('list-container');
  const yearFilter = document.getElementById('filter-year').value;
  const typeFilter = document.getElementById('filter-type').value;
  let filtered = [...records];
  if (yearFilter) filtered = filtered.filter(r => r.year === +yearFilter);
  if (typeFilter) filtered = filtered.filter(r => r.type === typeFilter);
  filtered.sort((a, b) => b.yearMonth.localeCompare(a.yearMonth) || (a.type === '給与' ? -1 : 1));

  const years = [...new Set(records.map(r => r.year))].sort((a, b) => b - a);
  const select = document.getElementById('filter-year');
  const cur = select.value;
  select.innerHTML = '<option value="">すべての年</option>' + years.map(y => `<option value="${y}">${y}年</option>`).join('');
  select.value = cur;

  if (!filtered.length) {
    container.innerHTML = `<div class="empty-state"><p>明細がありません</p><button class="btn btn-primary" onclick="switchPage('add')">追加する</button></div>`;
    return;
  }

  let lastYear = null;
  container.innerHTML = filtered.map(r => {
    const { payment, deduction, net } = calcTotals(r);
    const badge = r.type === '賞与' ? '<span class="type-badge bonus">賞与</span>' : '';
    const head = r.year !== lastYear ? `<div class="list-year">${r.year}年</div>` : '';
    lastYear = r.year;
    const note = r.note ? ` / ${r.note}` : '';
    return head + `<div class="list-item">
      <div class="list-item-main">
        <div class="list-item-title">${r.year}年${r.month}月${badge}</div>
        <div class="list-item-meta">出勤 ${r.workDays ?? '-'}日 / 休出 ${r.holidayWorkDays ?? '-'}日 / 有休残 ${r.paidLeaveRemain ?? '-'}${note}</div>
      </div>
      <div class="list-item-amounts">
        <div><div class="amount-label">総支給</div><div class="amount-value payment">${formatYen(payment)}</div></div>
        <div><div class="amount-label">控除</div><div class="amount-value deduction">${formatYen(deduction)}</div></div>
        <div><div class="amount-label">手取り</div><div class="amount-value net">${formatYen(net)}</div></div>
      </div>
      <div class="list-item-actions">
        <button class="btn btn-sm btn-outline" onclick="editRecord('${r.id}')">編集</button>
        <button class="btn btn-sm btn-danger" onclick="confirmDelete('${r.id}')">削除</button>
      </div>
    </div>`;
  }).join('');
}

document.getElementById('filter-year').addEventListener('change', renderList);
document.getElementById('filter-type').addEventListener('change', renderList);

window.editRecord = function(id) {
  const r = records.find(x => x.id === id);
  if (!r) return;
  editingId = id;
  setFormData(r);
  document.getElementById('form-title').textContent = `${r.year}年${r.month}月（${r.type}）を編集`;
  document.getElementById('submit-btn').textContent = '更新する';
  document.getElementById('cancel-btn').style.display = 'inline-flex';
  switchPage('add');
};

window.confirmDelete = async function(id) {
  const r = records.find(x => x.id === id);
  if (!r) return;
  if (!confirm(`${r.year}年${r.month}月（${r.type}）を削除しますか？`)) return;
  records = records.filter(x => x.id !== id);
  await persist();
  showToast('削除しました');
  renderList();
};

// ---------- dashboard ----------
function getYearlyStats() {
  const byYear = {};
  records.forEach(r => {
    const y = r.year;
    if (!byYear[y]) byYear[y] = { year: y, payment: 0, deduction: 0, net: 0, count: 0 };
    const t = calcTotals(r);
    byYear[y].payment += t.payment;
    byYear[y].deduction += t.deduction;
    byYear[y].net += t.net;
    byYear[y].count += 1;
  });
  return Object.values(byYear).sort((a, b) => a.year - b.year);
}

function updateTargetBanner() {
  const banner = document.getElementById('target-banner');
  if (!banner) return;
  if (!settings.targetNet || settings.targetNet <= 0) {
    banner.style.display = 'none';
    return;
  }
  banner.style.display = 'flex';
  document.getElementById('target-amount').textContent = formatYen(settings.targetNet);

  const salaries = records.filter(r => r.type === '給与').sort((a, b) => b.yearMonth.localeCompare(a.yearMonth));
  if (!salaries.length) {
    document.getElementById('target-latest').textContent = '—';
    document.getElementById('target-diff').textContent = '—';
    return;
  }
  const latest = salaries[0];
  const net = calcTotals(latest).net;
  document.getElementById('target-latest').textContent = formatYen(net);
  const diff = net - settings.targetNet;
  const el = document.getElementById('target-diff');
  const sign = diff >= 0 ? '+' : '';
  el.textContent = sign + formatYen(diff);
  el.className = diff >= 0 ? 'target-diff-up' : 'target-diff-down';
}


function renderSummaryCards(sorted) {
  const netEl = document.getElementById('sum-net');
  if (!netEl) return;
  const labelEl = document.getElementById('sum-net-label');
  const subEl = document.getElementById('sum-net-sub');
  if (!sorted.length) {
    if (labelEl) labelEl.textContent = '最新の手取り';
    netEl.textContent = '—';
    if (subEl) subEl.textContent = 'まだ明細がありません';
    document.getElementById('sum-payment').textContent = '—';
    document.getElementById('sum-deduction').textContent = '—';
    document.getElementById('sum-year-net').textContent = '—';
    return;
  }
  const salaries = sorted.filter(r => r.type === '給与');
  const latest = salaries[salaries.length - 1] || sorted[sorted.length - 1];
  const t = calcTotals(latest);
  if (labelEl) labelEl.textContent = `${latest.year}年${latest.month}月の手取り（${latest.type}）`;
  netEl.textContent = formatYen(t.net);
  if (subEl) subEl.textContent = `総支給 ${formatYen(t.payment)} − 控除 ${formatYen(t.deduction)}`;
  document.getElementById('sum-payment').textContent = formatYen(t.payment);
  document.getElementById('sum-deduction').textContent = formatYen(t.deduction);
  const yr = latest.year;
  const ynet = sorted.filter(r => r.year === yr).reduce((sum, r) => sum + calcTotals(r).net, 0);
  document.getElementById('sum-year-label').textContent = `${yr}年の手取り累計`;
  document.getElementById('sum-year-net').textContent = formatYen(ynet);
}

function updateDashboard() {
  const sorted = [...records].sort((a, b) => a.yearMonth.localeCompare(b.yearMonth));
  renderSummaryCards(sorted);
  renderMainChart(sorted);
  renderBreakdownCharts(sorted);
  renderYearlyTable(getYearlyStats());
  updateTargetBanner();
}

function renderMainChart(sorted) {
  const view = document.getElementById('chart-view')?.value || 'monthly';
  const titleEl = document.getElementById('chart-main-title');
  const titles = {
    'monthly': '月次推移（支給・控除・手取り）',
    'yearly-net': '年ごとの手取り額',
    'yearly-payment': '年ごとの総支給額',
    'yearly-deduction': '年ごとの控除額',
    'yearly-compare': '前年度との比較（手取り）',
    'salary-only': '給与のみの月次手取り',
    'bonus-only': '賞与のみの推移'
  };
  if (titleEl) titleEl.textContent = titles[view] || titles.monthly;
  if (charts.trend) charts.trend.destroy();

  let config;
  if (view === 'monthly') {
    config = {
      type: 'line',
      data: {
        labels: sorted.map(r => `${r.year}/${r.month}${r.type==='賞与'?'賞':''}`),
        datasets: [
          { label: '総支給', data: sorted.map(r => calcTotals(r).payment), borderColor: '#2f6fb2', backgroundColor: 'rgba(47,111,178,0.1)', tension: 0.3, fill: true },
          { label: '控除', data: sorted.map(r => calcTotals(r).deduction), borderColor: '#cf5f38', backgroundColor: 'rgba(207,95,56,0.05)', tension: 0.3, fill: true },
          { label: '手取り', data: sorted.map(r => calcTotals(r).net), borderColor: '#0a7a4a', backgroundColor: 'rgba(10,122,74,0.1)', tension: 0.3, fill: true }
        ]
      },
      options: { responsive: true, plugins: { legend: { position: 'bottom' } }, scales: { y: { ticks: { callback: v => '¥' + (v/10000).toFixed(0) + '万' } } } }
    };
  } else if (view.startsWith('yearly-') && view !== 'yearly-compare') {
    const stats = getYearlyStats();
    const key = view === 'yearly-net' ? 'net' : view === 'yearly-payment' ? 'payment' : 'deduction';
    const color = key === 'net' ? '#0a7a4a' : key === 'payment' ? '#2f6fb2' : '#cf5f38';
    const label = key === 'net' ? '手取り' : key === 'payment' ? '総支給' : '控除';
    config = {
      type: 'bar',
      data: { labels: stats.map(s => s.year + '年'), datasets: [{ label, data: stats.map(s => s[key]), backgroundColor: color, borderRadius: 6 }] },
      options: { responsive: true, plugins: { legend: { display: false }, tooltip: { callbacks: { label: ctx => formatYen(ctx.raw) } } }, scales: { y: { ticks: { callback: v => '¥' + (v/10000).toFixed(0) + '万' } } } }
    };
  } else if (view === 'yearly-compare') {
    const stats = getYearlyStats();
    config = {
      type: 'bar',
      data: {
        labels: stats.map(s => s.year + '年'),
        datasets: [
          { label: '当年手取り', data: stats.map(s => s.net), backgroundColor: '#0a7a4a', borderRadius: 6 },
          { label: '前年手取り', data: stats.map((s, i) => i === 0 ? null : stats[i-1].net), backgroundColor: '#94a3b8', borderRadius: 6 }
        ]
      },
      options: {
        responsive: true,
        plugins: {
          legend: { position: 'bottom' },
          tooltip: {
            callbacks: {
              label: ctx => ctx.raw == null ? ctx.dataset.label + ': —' : ctx.dataset.label + ': ' + formatYen(ctx.raw),
              afterBody: items => {
                const i = items[0]?.dataIndex;
                if (i == null || i === 0) return '';
                const diff = stats[i].net - stats[i-1].net;
                const pct = stats[i-1].net ? ((diff / stats[i-1].net) * 100).toFixed(1) : '—';
                return `差分: ${diff >= 0 ? '+' : ''}${formatYen(diff)} (${diff >= 0 ? '+' : ''}${pct}%)`;
              }
            }
          }
        },
        scales: { y: { ticks: { callback: v => '¥' + (v/10000).toFixed(0) + '万' } } }
      }
    };
  } else {
    const typ = view === 'bonus-only' ? '賞与' : '給与';
    const filtered = sorted.filter(r => r.type === typ);
    config = {
      type: 'line',
      data: {
        labels: filtered.map(r => `${r.year}/${r.month}`),
        datasets: [
          { label: '手取り', data: filtered.map(r => calcTotals(r).net), borderColor: '#0a7a4a', backgroundColor: 'rgba(10,122,74,0.15)', tension: 0.3, fill: true },
          { label: '総支給', data: filtered.map(r => calcTotals(r).payment), borderColor: '#2f6fb2', tension: 0.3, fill: false }
        ]
      },
      options: { responsive: true, plugins: { legend: { position: 'bottom' } }, scales: { y: { ticks: { callback: v => '¥' + (v/10000).toFixed(0) + '万' } } } }
    };
  }
  charts.trend = new Chart(document.getElementById('chart-trend'), config);
}

function renderBreakdownCharts(sorted) {
  const target = document.getElementById('breakdown-target')?.value || 'latest';
  let latest = null;
  if (sorted?.length) {
    if (target === 'latest-salary') {
      const s = sorted.filter(r => r.type === '給与');
      latest = s[s.length - 1] || sorted[sorted.length - 1];
    } else latest = sorted[sorted.length - 1];
  }
  const payTitle = document.getElementById('chart-payment-title');
  const dedTitle = document.getElementById('chart-deduction-title');
  if (latest) {
    const label = `${latest.year}年${latest.month}月（${latest.type}）`;
    if (payTitle) payTitle.textContent = label + ' の支給内訳';
    if (dedTitle) dedTitle.textContent = label + ' の控除内訳';
  }
  if (!latest) {
    if (charts.payment) charts.payment.destroy();
    if (charts.deduction) charts.deduction.destroy();
    return;
  }

  const paymentItems = settings.paymentFields
    .map(f => ({ label: f.label, value: Number(latest[f.key] || 0) }))
    .filter(i => i.value > 0);
  const deductionItems = settings.deductionFields
    .map(f => ({ label: f.label, value: Math.abs(Number(latest[f.key] || 0)) }))
    .filter(i => i.value > 0);
  const colors = ['#0a4630','#2f6fb2','#c9a86a','#0a7a4a','#cf5f38','#7a6ff0','#3aa6a0','#94a39a','#d18bb3'];

  if (charts.payment) charts.payment.destroy();
  charts.payment = new Chart(document.getElementById('chart-payment'), {
    type: 'doughnut',
    data: { labels: paymentItems.map(i => i.label), datasets: [{ data: paymentItems.map(i => i.value), backgroundColor: colors }] },
    options: { responsive: true, plugins: { legend: { position: 'bottom', labels: { boxWidth: 12, font: { size: 11 } } }, tooltip: { callbacks: { label: ctx => `${ctx.label}: ${formatYen(ctx.raw)}` } } } }
  });
  if (charts.deduction) charts.deduction.destroy();
  charts.deduction = new Chart(document.getElementById('chart-deduction'), {
    type: 'doughnut',
    data: { labels: deductionItems.map(i => i.label), datasets: [{ data: deductionItems.map(i => i.value), backgroundColor: colors }] },
    options: { responsive: true, plugins: { legend: { position: 'bottom', labels: { boxWidth: 12, font: { size: 11 } } }, tooltip: { callbacks: { label: ctx => `${ctx.label}: ${formatYen(ctx.raw)}` } } } }
  });
}

function renderYearlyTable(stats) {
  const tbody = document.getElementById('yearly-tbody');
  if (!tbody) return;
  if (!stats.length) {
    tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:#64748b">データなし</td></tr>';
    return;
  }
  tbody.innerHTML = stats.map((s, i) => {
    let cmp = '—', cls = 'same';
    if (i > 0) {
      const diff = s.net - stats[i - 1].net;
      const pct = stats[i - 1].net ? ((diff / stats[i - 1].net) * 100).toFixed(1) : '0';
      cmp = `${diff >= 0 ? '+' : ''}${formatYen(diff)} (${diff >= 0 ? '+' : ''}${pct}%)`;
      cls = diff > 0 ? 'up' : diff < 0 ? 'down' : 'same';
    }
    return `<tr>
      <td>${s.year}年</td>
      <td>${formatYen(s.payment)}</td>
      <td>${formatYen(s.deduction)}</td>
      <td><strong>${formatYen(s.net)}</strong></td>
      <td class="${cls}">${cmp}</td>
      <td>${s.count}</td>
    </tr>`;
  }).join('');
}

document.getElementById('chart-view')?.addEventListener('change', () => updateDashboard());
document.getElementById('breakdown-target')?.addEventListener('change', () => updateDashboard());

// ---------- settings handlers ----------
document.getElementById('dark-mode-toggle')?.addEventListener('change', e => {
  settings.darkMode = e.target.checked;
  saveSettings();
  showToast(settings.darkMode ? 'ダークモードON' : 'ダークモードOFF');
});

document.getElementById('save-target-btn')?.addEventListener('click', () => {
  settings.targetNet = +document.getElementById('target-net').value || 0;
  saveSettings();
  showToast(settings.targetNet ? `目標手取り ${formatYen(settings.targetNet)} を設定` : '目標手取りを解除');
  updateTargetBanner();
});

document.getElementById('export-btn').addEventListener('click', () => {
  const payload = { records, settings, exportedAt: new Date().toISOString() };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `salary-backup-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
  showToast('エクスポートしました');
});

document.getElementById('import-file').addEventListener('change', async e => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const text = await file.text();
    let imported = JSON.parse(text);
    let recs = Array.isArray(imported) ? imported : imported.records;
    if (!Array.isArray(recs)) throw new Error('形式エラー');
    if (!confirm(`${recs.length}件をインポートします。既存データは置き換わります。よろしいですか？`)) return;
    if (imported.settings) {
      settings = { ...settings, ...imported.settings };
      saveSettings();
    }
    records = recs.map(r => { if (!r.id) r.id = uid(); if (!r.yearMonth) r.yearMonth = `${r.year}-${String(r.month).padStart(2,'0')}`; return r; });
    records.sort((a, b) => a.yearMonth.localeCompare(b.yearMonth));
    await persist();
    showToast(`${records.length}件インポートしました`);
    switchPage('list');
  } catch (err) {
    console.error(err);
    showToast('インポートに失敗しました');
  }
  e.target.value = '';
});

document.getElementById('reload-seed-btn').addEventListener('click', async () => {
  if (!confirm('初期データを読み込みます。現在のデータは上書きされます。よろしいですか？')) return;
  try {
    const res = await fetch('data/seed.json');
    if (!res.ok) throw new Error('seed not found');
    const seed = await res.json();
    records = seed.map(r => { if (!r.id) r.id = uid(); return r; });
    await persist();
    showToast(`空の状態にリセットしました`);
    switchPage('dashboard');
  } catch (err) {
    showToast('初期データの読み込みに失敗しました。JSONインポートを使ってください');
  }
});

document.getElementById('clear-btn').addEventListener('click', async () => {
  if (!confirm('本当にすべてのデータを削除しますか？')) return;
  if (!confirm('最終確認：全削除します。よろしいですか？')) return;
  records = [];
  await persist();
  showToast('全データを削除しました');
  switchPage('dashboard');
});

document.getElementById('force-save-btn').addEventListener('click', async () => {
  const ok = await persist();
  showToast(ok ? '保存を確認しました' : '保存に失敗しました');
});

// ---------- init ----------
async function init() {
  loadSettings();
  applyDarkMode();
  document.getElementById('target-net').value = settings.targetNet || 0;
  buildDynamicFormFields();
  await openDB();

  let loaded = loadFromLocal();
  if (loaded?.length) {
    records = loaded;
    updateSaveStatus(true);
  } else {
    try {
      const res = await fetch('data/seed.json');
      if (res.ok) {
        const seed = await res.json();
        records = seed.map(r => { if (!r.id) r.id = uid(); return r; });
        await persist();
        showToast(`空の状態にしました`);
      }
    } catch (e) {}
  }

  updateDashboard();
  renderList();
  updatePreview();
  updateSaveStatus(true);
}

init();
