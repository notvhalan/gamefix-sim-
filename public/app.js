const ws = new WebSocket(`ws://${window.location.host}/ws`);
const state = { current: null };

ws.onmessage = e => {
  const msg = JSON.parse(e.data);
  if (msg.type === 'state') { state.current = msg.payload; render(msg.payload); }
};
ws.onopen = () => console.log('GFX connected');

function send(action, payload = {}) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'control', action, payload }));
}

// ─── Utilities ────────────────────────────────────────────────────────────────

const el    = id => document.getElementById(id);
const fmt   = v  => v == null ? '—' : (+v).toFixed(1);
const fmt2  = v  => v == null ? '—' : (+v).toFixed(2);
const fmtPct= v  => v == null ? '—' : (v * 100).toFixed(1) + '%';
const fmtPound = v => v == null ? '—' : '£' + Math.round(Math.abs(v)).toLocaleString();
const fmtPoundSign = v => (v >= 0 ? '+£' : '-£') + Math.abs(Math.round(v)).toLocaleString();
const fmtSign = v => (v > 0 ? '+' : '') + fmt(v);
const colorOf = v => v > 0 ? 'var(--buy)' : v < 0 ? 'var(--sell)' : 'var(--text-2)';
const clsOf   = v => v > 0 ? 'up' : v < 0 ? 'down' : '';
// Format a basis-point price (0–10000) as a probability percentage
// e.g. 5bp → "0.05%", 150bp → "1.50%", 5000bp → "50.0%"
const fmtBp = bp => {
  if (bp == null) return '—';
  const pct = bp / 100;
  return pct < 10 ? pct.toFixed(2) + '%' : pct.toFixed(1) + '%';
};
// Cost per 1 contract at a given price in bp → pence string "0.5p" or "£1.20"
const fmtBpCost = bp => {
  if (bp == null) return '—';
  const pence = bp / 10;
  return pence < 100 ? pence.toFixed(1) + 'p' : '£' + (pence / 100).toFixed(2);
};

// ─── Chart.js global defaults ─────────────────────────────────────────────────

if (typeof Chart !== 'undefined') {
  Chart.defaults.color          = '#4a6a88';
  Chart.defaults.borderColor    = 'rgba(255,255,255,0.05)';
  Chart.defaults.font.family    = 'Consolas, "Courier New", monospace';
  Chart.defaults.font.size      = 10;
}

let _ladderChart  = null;
let _historyChart = null;
let _ladderYMax   = 0;   // ratcheting: only grows, reset on destroyCharts
let _historyYMax  = 0;

// Shared axis chrome — visible border + grid lines that look like a real chart
const AXIS_X = {
  border: { display: true, color: '#1e3a5c', width: 1 },
  grid:   { color: 'rgba(30,58,92,0.55)', lineWidth: 1, drawTicks: true, tickLength: 4 },
  ticks:  { color: '#5a7a98', padding: 5 },
};
const AXIS_Y = {
  border: { display: true, color: '#1e3a5c', width: 1, dash: [] },
  grid:   { color: 'rgba(30,58,92,0.4)', lineWidth: 1, drawTicks: true, tickLength: 4 },
  ticks:  { color: '#5a7a98', padding: 6 },
};

// Round v up to the nearest clean axis ceiling (1, 1.5, 2, 2.5, 3, 4, 5, 7, 10 × 10^n)
function niceMax(v) {
  if (!v || v <= 0) return 1;
  const exp   = Math.floor(Math.log10(v));
  const mag   = Math.pow(10, exp);
  const frac  = v / mag;
  const nice  = frac <= 1 ? 1 : frac <= 1.5 ? 1.5 : frac <= 2 ? 2
              : frac <= 2.5 ? 2.5 : frac <= 3 ? 3 : frac <= 4 ? 4
              : frac <= 5 ? 5 : frac <= 7 ? 7 : 10;
  return nice * mag;
}
// Pick a step size that gives 4-6 gridlines for a given axis max
function niceStep(axisMax) {
  if (!axisMax || axisMax <= 0) return 0.1;
  const candidates = [0.1, 0.2, 0.25, 0.5, 1, 2, 2.5, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000];
  return candidates.find(s => axisMax / s <= 6) ?? axisMax / 5;
}

function destroyCharts() {
  if (_ladderChart)  { _ladderChart.destroy();  _ladderChart  = null; }
  if (_historyChart) { _historyChart.destroy(); _historyChart = null; }
  _ladderYMax = 0;
  _historyYMax = 0;
}

function svgLine(pts, color, sw = 1.5, dash = '') {
  if (!pts || pts.length < 2) return '';
  const da = dash ? ` stroke-dasharray="${dash}"` : '';
  return `<polyline points="${pts.map(p => p.join(',')).join(' ')}" fill="none" stroke="${color}" stroke-width="${sw}" stroke-linejoin="round" stroke-linecap="round"${da}/>`;
}

function normalise(history, range) {
  if (!history?.length) return [];
  const n = range === '30d' ? 30 : range === '90d' ? 90 : range === '180d' ? 180 : history.length;
  return history.slice(-n);
}

// ─── Header + market strip ────────────────────────────────────────────────────

function renderHeader(s) {
  if (el('hdr-date'))   el('hdr-date').textContent   = s.date;
  if (el('hdr-day'))    el('hdr-day').textContent    = s.day;
  if (el('hdr-status')) el('hdr-status').textContent = s.status.toUpperCase();
  if (el('hdr-seed'))   el('hdr-seed').textContent   = s.seed;
  if (el('hdr-weight')) el('hdr-weight').textContent = (s.weightingMethod || '').replace(/_/g, ' ');

  const pill = el('status-pill');
  if (pill) { pill.className = `t-pill t-pill-status-${s.status}`; }

  const checks = s.checks || [];
  const passed = checks.filter(c => c.passed).length;
  const checksEl = el('hdr-checks');
  if (checksEl) {
    checksEl.textContent = checks.length ? `${passed}/${checks.length}` : '—';
    checksEl.style.color = passed === checks.length && checks.length ? 'var(--buy)' : checks.length ? 'var(--sell)' : 'var(--text-2)';
  }
}

function renderStrip(s) {
  const l = s.ladder, p = s.previousLadder || {}, ls = s.lastSettlement;

  const kpis = [
    ['kpi-d1',       fmt(l.d1),      fmtSign(l.d1 - (p.d1 ?? l.d1))],
    ['kpi-d3',       fmt(l.d3),      fmtSign(l.d3 - (p.d3 ?? l.d3))],
    ['kpi-d7',       fmt(l.d7),      fmtSign(l.d7 - (p.d7 ?? l.d7))],
    ['kpi-realised', ls ? fmt(ls.realisedIndex) : '—', ls ? fmtSign(ls.realisedIndex - ls.previousIndex) : '—'],
    ['kpi-qualify',  ls ? ls.qualifyingLocations : '—', ls ? fmtPct(ls.qualifyingLocations / Math.max(1, ls.eligibleLocations)) : '—'],
    ['kpi-storms',   (s.storms||[]).length, (s.storms||[]).length > 0 ? '⚡' : 'none'],
    ['kpi-settled',  ls ? ls.contractsSettled : '—', ls ? `YES:${ls.yesSettlements} NO:${ls.noSettlements}` : '—'],
    ['kpi-vm',       ls ? fmtPound(ls.variationMargin) : '—', ''],
  ];

  kpis.forEach(([id, val, chg]) => {
    const vEl = el(id), cEl = el(id + '-delta');
    if (vEl) vEl.textContent = val;
    if (cEl) {
      cEl.textContent = chg;
      const num = parseFloat(chg);
      cEl.className = 't-kpi-chg ' + clsOf(num);
    }
  });
}

// ─── Order book ───────────────────────────────────────────────────────────────

function renderOrderBook(s) {
  const display  = el('order-book-display');
  const obSelect = el('ob-future-select');
  if (!display || !obSelect || !s.orderBook) return;

  const futId = obSelect.value || (s.tradableFutures?.[0]?.id);
  if (!futId) return;
  const book = s.orderBook[futId];
  const fut  = s.tradableFutures?.find(f => f.id === futId);
  if (!book || !fut) { display.innerHTML = '<div style="padding:0.6rem;color:var(--text-3)">No data</div>'; return; }

  const maxQty = Math.max(1,
    ...(book.asks || []).map(r => r.quantity),
    ...(book.bids || []).map(r => r.quantity));

  const last   = fut.lastTradePricePoints != null ? fmt2(fut.lastTradePricePoints) : '—';
  const spread = (fut.askPricePoints != null && fut.bidPricePoints != null)
    ? (fut.askPricePoints - fut.bidPricePoints).toFixed(2) : '—';
  const fv = fmt2(fut.projectedSettlement);

  let html = `<div class="t-ob-meta">
    <span>Last <b class="t-ob-last">${last}</b></span>
    <span>Sprd <b>${spread}</b></span>
    <span>FV <b>${fv}</b></span>
  </div>`;
  html += `<div class="t-ob-header"><span style="color:var(--sell)">PRICE</span><span style="text-align:right">QTY</span></div>`;

  // Asks (reversed so lowest ask is nearest the spread)
  html += `<div class="t-ob-asks">`;
  const asksView = [...(book.asks || [])].reverse();
  asksView.forEach(row => {
    const pct = (row.quantity / maxQty * 100).toFixed(0);
    html += `<div class="t-ob-row">
      <div class="t-ob-depth-bar" style="width:${pct}%"></div>
      <span class="t-ob-price">${fmt2(row.pricePoints)}</span>
      <span class="t-ob-qty">${row.quantity}</span>
    </div>`;
  });
  html += `</div>`;

  html += `<div class="t-ob-spread">
    <span style="color:var(--buy)">${fut.bidPricePoints != null ? fmt2(fut.bidPricePoints) : '—'}</span>
    <span>·spread·</span>
    <span style="color:var(--sell)">${fut.askPricePoints != null ? fmt2(fut.askPricePoints) : '—'}</span>
  </div>`;

  // Bids
  html += `<div class="t-ob-bids">`;
  (book.bids || []).forEach(row => {
    const pct = (row.quantity / maxQty * 100).toFixed(0);
    html += `<div class="t-ob-row">
      <div class="t-ob-depth-bar" style="width:${pct}%"></div>
      <span class="t-ob-price">${fmt2(row.pricePoints)}</span>
      <span class="t-ob-qty">${row.quantity}</span>
    </div>`;
  });
  html += `</div>`;

  display.innerHTML = html;
}

// ─── Futures strip ────────────────────────────────────────────────────────────

let selectedFutureId = null;

function renderFuturesStrip(s) {
  const container = el('futures-cards');
  if (!container || !s.tradableFutures) return;

  if (!selectedFutureId) selectedFutureId = s.tradableFutures[0]?.id;

  container.innerHTML = s.tradableFutures.map(fut => {
    const settle = fut.currentSettlementPriceUnits != null ? (fut.currentSettlementPriceUnits / 100).toFixed(2) : '—';
    const delta  = (fut.currentSettlementPriceUnits != null && fut.previousSettlementPriceUnits != null)
      ? ((fut.currentSettlementPriceUnits - fut.previousSettlementPriceUnits) / 100)
      : 0;
    const bid = fut.bidPricePoints != null ? fmt2(fut.bidPricePoints) : '—';
    const ask = fut.askPricePoints != null ? fmt2(fut.askPricePoints) : '—';
    const basis = (fut.projectedSettlement != null && fut.currentSettlementPriceUnits != null)
      ? fut.projectedSettlement - fut.currentSettlementPriceUnits / 100 : null;
    const basisStr = basis != null ? (basis >= 0 ? '+' : '') + basis.toFixed(3) : '—';
    const basisClr = basis == null ? 'var(--text-3)' : Math.abs(basis) < 0.01 ? 'var(--text-2)' : basis > 0 ? 'var(--buy)' : 'var(--sell)';
    const active = fut.id === selectedFutureId ? 'active' : '';
    return `<div class="t-fut-card ${active}" data-futid="${fut.id}">
      <div style="display:flex;align-items:center;justify-content:space-between">
        <span class="t-fut-symbol">${fut.symbol}</span>
        <span class="t-fut-status t-fut-status-${fut.status}">${fut.status}</span>
      </div>
      <div>
        <span class="t-fut-settle">${settle}</span>
        <span class="t-fut-delta ${clsOf(delta)}">${delta >= 0 ? '+' : ''}${delta.toFixed(2)}</span>
      </div>
      <div class="t-fut-meta">
        <span>B:<b>${bid}</b></span>
        <span>A:<b>${ask}</b></span>
        <span>FV:<b>${fmt2(fut.projectedSettlement)}</b></span>
      </div>
      <div class="t-fut-meta" style="justify-content:space-between">
        <span>Vol ${fut.volume || 0} · OI ${fut.openInterest || 0}</span>
        <span>${fut.daysUntilExpiry != null ? fut.daysUntilExpiry + 'd' : ''}</span>
      </div>
      <div class="t-fut-meta" style="justify-content:space-between;border-top:1px solid var(--border);padding-top:0.18rem;margin-top:0.1rem">
        <span style="color:var(--text-3)">Basis FV−settle</span>
        <span style="color:${basisClr};font-weight:600">${basisStr}</span>
      </div>
    </div>`;
  }).join('');

  container.querySelectorAll('.t-fut-card').forEach(card => {
    card.addEventListener('click', () => {
      selectedFutureId = card.dataset.futid;
      // Update order ticket + order book select
      const otFut = el('ot-future');
      if (otFut) otFut.value = selectedFutureId;
      const obSel = el('ob-future-select');
      if (obSel) obSel.value = selectedFutureId;
      if (state.current) { renderFuturesStrip(state.current); renderOrderBook(state.current); }
    });
  });

  // Populate order ticket and OB selects
  const otFuture = el('ot-future');
  const obSelect = el('ob-future-select');
  [otFuture, obSelect].forEach(sel => {
    if (!sel) return;
    const cur = sel.value || selectedFutureId;
    sel.innerHTML = s.tradableFutures
      .filter(f => f.status === 'ACTIVE' || f.status === 'EXPIRING')
      .map(f => `<option value="${f.id}" ${f.id === cur ? 'selected' : ''}>${f.symbol}</option>`)
      .join('');
    if (!sel.value) sel.value = selectedFutureId;
  });
}

// ─── Ladder chart (Chart.js) ──────────────────────────────────────────────────

function renderLadderChart(s) {
  const canvas = el('ladder-chart');
  if (!canvas) return;
  const keys   = ['d1','d2','d3','d4','d5','d6','d7'];
  const labels = ['D+1','D+2','D+3','D+4','D+5','D+6','D+7'];
  const vals   = keys.map(k => s.ladder?.[k] ?? null);
  if (vals.every(v => v == null)) return;
  const mktVals = keys.map(k => s.marketLadder?.[k] ?? null);

  const activeFut = s.tradableFutures?.find(f => f.status === 'ACTIVE');
  const fvPts  = activeFut ? activeFut.currentSettlementPriceUnits / 100 : null;
  const realised = s.lastSettlement?.realisedIndex ?? null;

  const datasets = [
    {
      label: 'Model',
      data: vals,
      borderColor: '#2b7de9',
      backgroundColor: 'rgba(43,125,233,0.10)',
      fill: true,
      tension: 0.35,
      pointRadius: 5,
      pointHoverRadius: 7,
      pointBackgroundColor: '#2b7de9',
      pointBorderColor: '#020609',
      pointBorderWidth: 2,
      borderWidth: 2.5,
      order: 2,
    },
    {
      label: 'Market (book mid)',
      data: mktVals,
      borderColor: '#e8a020',
      borderDash: [5, 3],
      backgroundColor: 'transparent',
      fill: false,
      tension: 0.35,
      pointRadius: 4,
      pointHoverRadius: 6,
      pointBackgroundColor: '#e8a020',
      pointBorderColor: '#020609',
      pointBorderWidth: 1.5,
      borderWidth: 1.5,
      order: 1,
    },
  ];

  if (fvPts != null) datasets.push({
    label: 'Futures fair value',
    data: labels.map(() => fvPts),
    borderColor: 'rgba(232,160,32,0.45)',
    borderDash: [6, 4],
    backgroundColor: 'transparent',
    fill: false,
    pointRadius: 0,
    borderWidth: 1,
    order: 3,
  });

  if (realised != null) datasets.push({
    label: 'Realised (yesterday)',
    data: labels.map(() => realised),
    borderColor: 'rgba(0,192,122,0.55)',
    backgroundColor: 'transparent',
    fill: false,
    pointRadius: 0,
    borderWidth: 1.5,
    order: 3,
  });

  // Basis line: Market − Model per day (secondary right axis)
  const basisVals = keys.map((k, i) => {
    const m = mktVals[i], v = vals[i];
    return (m != null && v != null) ? parseFloat((m - v).toFixed(3)) : null;
  });
  datasets.push({
    label: 'Mkt − Model',
    data: basisVals,
    yAxisID: 'basis',
    borderColor: 'rgba(160,80,220,0.9)',
    backgroundColor: 'rgba(160,80,220,0.07)',
    fill: true,
    tension: 0.3,
    pointRadius: 4,
    pointHoverRadius: 6,
    pointBackgroundColor: 'rgba(160,80,220,0.9)',
    pointBorderColor: '#020609',
    pointBorderWidth: 1,
    borderWidth: 1.5,
    borderDash: [4, 3],
    order: 0,
  });

  const hasStorm = (s.storms?.length ?? 0) > 0;

  // Ratcheting y-axis: only grows, snaps to nice numbers → axis stays stable between ticks
  const dataMax = Math.max(...vals.concat(mktVals).filter(v => v != null),
                            fvPts ?? 0, realised ?? 0);
  _ladderYMax = Math.max(_ladderYMax, niceMax(dataMax * 1.15));
  const yStep = niceStep(_ladderYMax);

  const opts = {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    interaction: { mode: 'index', intersect: false },
    scales: {
      x: {
        ...AXIS_X,
        ticks: { ...AXIS_X.ticks, font: { size: 11, family: 'Consolas, monospace' } },
      },
      y: {
        ...AXIS_Y,
        min: 0,
        max: _ladderYMax,
        ticks: {
          ...AXIS_Y.ticks,
          font: { size: 10, family: 'Consolas, monospace' },
          stepSize: yStep,
          callback: v => Number.isInteger(v) ? v : v.toFixed(1),
        },
      },
      basis: {
        display: true,
        position: 'right',
        border: { display: true, color: 'rgba(160,80,220,0.3)', dash: [3, 3], width: 1 },
        grid: { display: false },
        ticks: {
          color: 'rgba(160,80,220,0.75)',
          font: { size: 9, family: 'Consolas, monospace' },
          padding: 4,
          callback: v => (v >= 0 ? '+' : '') + v.toFixed(2),
        },
        title: { display: true, text: 'MKT−MDL', color: 'rgba(160,80,220,0.65)', font: { size: 8 } },
      },
    },
    plugins: {
      legend: {
        position: 'bottom',
        labels: { color: '#4a6a88', boxWidth: 12, padding: 12, font: { size: 10 } },
      },
      tooltip: {
        backgroundColor: '#0d1a2e',
        borderColor: '#1e3a5c',
        borderWidth: 1,
        titleColor: '#c8daea',
        bodyColor: '#7a9ac0',
        callbacks: { label: ctx => ` ${ctx.dataset.label}: ${ctx.parsed.y?.toFixed(3) ?? '—'}` },
      },
    },
  };

  if (!_ladderChart) {
    _ladderChart = new Chart(canvas, { type: 'line', data: { labels, datasets }, options: opts });
  } else {
    _ladderChart.data.datasets = datasets;
    _ladderChart.options.scales.y.max      = _ladderYMax;
    _ladderChart.options.scales.y.ticks.stepSize = yStep;
    _ladderChart.update('none');
  }

  canvas.style.background = hasStorm ? 'rgba(232,53,74,0.03)' : '';
}

// ─── History chart (Chart.js) ─────────────────────────────────────────────────

function renderHistoryChart(s) {
  const canvas = el('history-chart');
  if (!canvas) return;
  const range = el('range-select')?.value || '90d';
  const hist  = normalise(s.indexHistory, range);
  if (!hist?.length) {
    // Show placeholder text via canvas 2d if chart not initialised
    if (!_historyChart) {
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = '#4a6a88';
        ctx.font = '13px Consolas, monospace';
        ctx.textAlign = 'center';
        ctx.fillText('Advance simulation to populate history', canvas.width / 2 || 200, canvas.height / 2 || 80);
      }
    }
    return;
  }

  const series = [
    { key: 'impliedD1',         label: 'Implied D+1',     color: '#2b7de9', width: 1.5 },
    { key: 'realised',          label: 'Realised',         color: '#00c07a', width: 2   },
    { key: 'frontMonthFutures', label: 'Front future',     color: '#e8a020', width: 1.5 },
    { key: 'nextMonthFutures',  label: 'Next future',      color: '#a87de9', width: 1   },
    { key: 'ma7',               label: '7-day MA',         color: '#3a5a78', width: 1   },
  ];

  const labels   = hist.map(h => h.date?.slice(5) || '');
  const datasets = series.map(s2 => ({
    label: s2.label,
    data: hist.map(h => h[s2.key] ?? null),
    borderColor: s2.color,
    backgroundColor: 'transparent',
    fill: false,
    tension: 0.2,
    pointRadius: 0,
    pointHoverRadius: 4,
    borderWidth: s2.width,
    spanGaps: true,
  }));

  // Storm overlay: vertical red lines as a bar dataset with near-zero width
  const stormData = hist.map(h => (h.stormCount > 0 ? 1e9 : null));
  datasets.push({
    label: 'Storm',
    data: stormData,
    type: 'bar',
    backgroundColor: 'rgba(232,53,74,0.10)',
    borderColor: 'transparent',
    borderWidth: 0,
    barPercentage: 1.0,
    categoryPercentage: 1.0,
    yAxisID: 'storm',
    order: 10,
  });

  // Ratcheting y-axis for history chart
  const seriesKeys = ['impliedD1','realised','frontMonthFutures','nextMonthFutures','ma7'];
  const histMax = Math.max(...hist.flatMap(h => seriesKeys.map(k => h[k] ?? 0)));
  _historyYMax = Math.max(_historyYMax, niceMax(histMax * 1.1));
  const hStep  = niceStep(_historyYMax);

  const opts = {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    interaction: { mode: 'index', intersect: false },
    scales: {
      x: {
        ...AXIS_X,
        ticks: {
          ...AXIS_X.ticks,
          font: { size: 9, family: 'Consolas, monospace' },
          maxTicksLimit: 8,
          maxRotation: 0,
        },
      },
      y: {
        ...AXIS_Y,
        min: 0,
        max: _historyYMax,
        ticks: {
          ...AXIS_Y.ticks,
          font: { size: 9, family: 'Consolas, monospace' },
          stepSize: hStep,
          callback: v => Number.isInteger(v) ? v : v.toFixed(1),
        },
      },
      storm: { display: false, min: 0, max: 1 },
    },
    plugins: {
      legend: {
        position: 'bottom',
        labels: {
          color: '#4a6a88',
          boxWidth: 12,
          padding: 10,
          font: { size: 10 },
          filter: item => item.text !== 'Storm',
        },
      },
      tooltip: {
        backgroundColor: '#0d1a2e',
        borderColor: '#1e3a5c',
        borderWidth: 1,
        titleColor: '#c8daea',
        bodyColor: '#7a9ac0',
        filter: item => item.dataset.label !== 'Storm',
        callbacks: {
          label: ctx => ctx.parsed.y != null
            ? ` ${ctx.dataset.label}: ${ctx.parsed.y.toFixed(3)}`
            : null,
        },
      },
    },
  };

  if (!_historyChart) {
    _historyChart = new Chart(canvas, { type: 'line', data: { labels, datasets }, options: opts });
  } else {
    _historyChart.data.labels   = labels;
    _historyChart.data.datasets = datasets;
    _historyChart.options.scales.y.max            = _historyYMax;
    _historyChart.options.scales.y.ticks.stepSize = hStep;
    _historyChart.update('none');
  }
}

// ─── World map ────────────────────────────────────────────────────────────────

function renderWorldMap(s) {
  const svg = el('world-map');
  if (!svg) return;
  const W = 900, H = 450;
  const px = (lat, lon) => [(lon + 180) / 360 * W, (90 - lat) / 180 * H];

  let out = `<rect width="${W}" height="${H}" fill="#020912"/>`;
  // Graticules
  for (let lon = -180; lon <= 180; lon += 30) {
    const x = (lon + 180) / 360 * W;
    out += `<line x1="${x}" y1="0" x2="${x}" y2="${H}" stroke="rgba(255,255,255,0.03)" stroke-width="0.5"/>`;
  }
  for (let lat = -60; lat <= 60; lat += 30) {
    const y = (90 - lat) / 180 * H;
    out += `<line x1="0" y1="${y}" x2="${W}" y2="${y}" stroke="rgba(255,255,255,0.03)" stroke-width="0.5"/>`;
  }

  // Storm circles
  (s.storms || []).forEach(st => {
    const [sx, sy] = px(st.centreLatitude, st.centreLongitude);
    const rx = st.radiusKm / 111 / 360 * W * 1.8;
    const ry = st.radiusKm / 111 / 180 * H * 1.2;
    out += `<ellipse cx="${sx.toFixed(1)}" cy="${sy.toFixed(1)}" rx="${rx.toFixed(1)}" ry="${ry.toFixed(1)}" fill="rgba(232,53,74,0.06)" stroke="rgba(232,53,74,0.3)" stroke-width="1"/>`;
    out += `<circle cx="${sx.toFixed(1)}" cy="${sy.toFixed(1)}" r="3" fill="#e8354a" opacity="0.8"/>`;
  });

  // Location dots
  (s.locationSummaries || []).forEach(loc => {
    const [x, y] = px(loc.latitude, loc.longitude);
    let fill;
    if (loc.todaySettlementValue === 1)       fill = '#00c07a';
    else if (loc.todaySettlementValue === 0)  fill = '#152030';
    else if (loc.d1Probability > 0.20)        fill = '#dc2626';
    else if (loc.d1Probability > 0.05)        fill = '#d97706';
    else                                       fill = '#1e5fa0';
    out += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="1.8" fill="${fill}" opacity="0.85"/>`;
  });

  svg.innerHTML = out;

  const badge = el('map-storm-badge');
  if (badge) badge.textContent = s.storms?.length ? `⚡ ${s.storms.length} storm${s.storms.length > 1 ? 's' : ''}` : '';
}

// ─── Open positions ───────────────────────────────────────────────────────────

function renderPositions(s) {
  const tbody = el('positions-tbody');
  if (!tbody || !s.positions) return;
  const open = s.positions.filter(p => p.status === 'OPEN' && p.netQuantity !== 0);
  if (!open.length) {
    tbody.innerHTML = '<tr><td colspan="10" style="color:var(--text-3);text-align:center;padding:0.75rem">No open positions</td></tr>';
    return;
  }
  tbody.innerHTML = open.map(pos => {
    const fut  = s.tradableFutures?.find(f => f.id === pos.futureId);
    const acct = s.accounts?.find(a => a.id === pos.accountId);
    const entry  = (pos.averageEntryPriceUnits / 100).toFixed(2);
    const settle = (pos.previousSettlementPriceUnits / 100).toFixed(2);
    const upnl   = pos.unrealisedPnlPence / 100;
    const rpnl   = pos.realisedTradingPnlPence / 100;
    const vm     = pos.variationMarginPence / 100;
    const margin = pos.initialMarginReservedPence / 100;
    const sideClr = pos.netQuantity > 0 ? 'var(--buy)' : 'var(--sell)';
    return `<tr>
      <td class="muted">${acct?.name || pos.accountId}</td>
      <td class="mono">${fut?.symbol || pos.futureId}</td>
      <td class="mono" style="color:${sideClr};font-weight:700">${pos.netQuantity > 0 ? '+' : ''}${pos.netQuantity}</td>
      <td class="mono">${entry}</td>
      <td class="mono">${settle}</td>
      <td class="mono" style="color:${colorOf(upnl)}">${fmtPoundSign(upnl)}</td>
      <td class="mono" style="color:${colorOf(rpnl)}">${fmtPoundSign(rpnl)}</td>
      <td class="mono" style="color:${colorOf(vm)}">${fmtPoundSign(vm)}</td>
      <td class="mono">${fmtPound(margin)}</td>
      <td><button class="t-act-btn close-pos-btn" data-posid="${pos.id}">Close</button></td>
    </tr>`;
  }).join('');
  tbody.querySelectorAll('.close-pos-btn').forEach(btn => {
    btn.addEventListener('click', () => send('close-position', { positionId: btn.dataset.posid }));
  });
}

// ─── Recent trades ────────────────────────────────────────────────────────────

function renderRecentTrades(s) {
  const tbody = el('trades-tbody');
  if (!tbody) return;
  const trades = s.recentTrades || [];
  if (!trades.length) { tbody.innerHTML = '<tr><td colspan="4" style="color:var(--text-3);text-align:center">—</td></tr>'; return; }
  tbody.innerHTML = trades.slice(0, 40).map(t => {
    const buyer  = s.accounts?.find(a => a.id === t.buyAccountId)?.name?.replace(' Desk','')  || t.buyAccountId;
    const seller = s.accounts?.find(a => a.id === t.sellAccountId)?.name?.replace(' Desk','') || t.sellAccountId;
    return `<tr>
      <td class="mono warn">${t.pricePoints?.toFixed(2) ?? '—'}</td>
      <td class="mono">${t.quantity}</td>
      <td class="buy-col">${buyer}</td>
      <td class="sell-col">${seller}</td>
    </tr>`;
  }).join('');
}

// ─── Futures daily settlements ────────────────────────────────────────────────

function renderFuturesSettlements(s) {
  const tbody = el('futures-settle-tbody');
  if (!tbody) return;
  const rows = s.futuresSettlements || [];
  if (!rows.length) { tbody.innerHTML = '<tr><td colspan="5" style="color:var(--text-3);text-align:center">—</td></tr>'; return; }
  tbody.innerHTML = rows.slice(0, 25).map(fs => {
    const d = fs.newSettlementPoints - fs.previousSettlementPoints;
    return `<tr>
      <td class="muted mono" style="font-size:0.7rem">${fs.simulatedDate}</td>
      <td class="mono" style="font-size:0.72rem">${fs.symbol}</td>
      <td class="mono">${fmt2(fs.previousSettlementPoints)}</td>
      <td class="mono" style="color:${colorOf(d)}">${fmt2(fs.newSettlementPoints)}</td>
      <td class="muted" style="font-size:0.68rem">${fs.settlementMethod === 'VWAP' ? 'VWAP' : fs.settlementMethod === 'MIDPOINT' ? 'MID' : 'MDL'}</td>
    </tr>`;
  }).join('');
}

// ─── Accounts ─────────────────────────────────────────────────────────────────

function renderAccounts(s) {
  const tbody = el('accounts-tbody');
  if (!tbody || !s.accounts) return;
  tbody.innerHTML = s.accounts.map(a => {
    const avail = a.cash - (a.reservedMargin || 0);
    const vm    = a.dailyVariationMargin || 0;
    return `<tr>
      <td><b>${a.name}</b></td>
      <td class="muted">${a.traderType}</td>
      <td class="mono">${fmtPound(a.cash)}</td>
      <td class="mono">${fmtPound(a.reservedMargin || 0)}</td>
      <td class="mono" style="color:${colorOf(avail)}">${fmtPound(avail)}</td>
      <td class="mono" style="color:${colorOf(vm)}">${fmtPoundSign(vm)}</td>
    </tr>`;
  }).join('');
}

// ─── Settlement summary ───────────────────────────────────────────────────────

function renderSettlementSummary(s) {
  const div = el('settlement-content');
  if (!div) return;
  const ls = s.lastSettlement;
  if (!ls) { div.innerHTML = '<div style="padding:0.75rem;color:var(--text-3)">Advance simulation to see settlement data.</div>'; return; }
  const cells = [
    ['Settlement Date', ls.date, ''],
    ['Realised Index',  fmt(ls.realisedIndex), clsOf(ls.realisedIndex)],
    ['Implied at Close',fmt(ls.impliedAtClose), ''],
    ['Forecast Error',  fmtSign(ls.forecastError), clsOf(ls.forecastError)],
    ['Qualifying / Total', `${ls.qualifyingLocations} / ${ls.eligibleLocations}`, ''],
    ['YES / NO', `${ls.yesSettlements} / ${ls.noSettlements}`, ''],
    ['VM Credits', fmtPound(ls.credits), 'up'],
    ['VM Balanced', ls.cashBalanced ? '✓ YES' : '✗ NO', ls.cashBalanced ? 'up' : 'down'],
    ['Active Storms', ls.activeStorms || 0, ''],
  ];
  div.innerHTML = cells.map(([label, val, cls]) =>
    `<div class="t-settle-cell">
      <div class="t-settle-label">${label}</div>
      <div class="t-settle-value ${cls}">${val}</div>
    </div>`
  ).join('');
}

// ─── Location contracts ───────────────────────────────────────────────────────

function renderLocationTable(s) {
  const tbody = el('location-tbody');
  if (!tbody || !s.locationSummaries) return;
  const filterVal = el('location-filter')?.value || 'all';
  const regionVal = el('region-filter')?.value   || 'all';
  let rows = s.locationSummaries;
  if (filterVal === 'yes')     rows = rows.filter(r => r.todaySettlementValue === 1);
  if (filterVal === 'no')      rows = rows.filter(r => r.todaySettlementValue === 0);
  if (filterVal === 'pending') rows = rows.filter(r => r.todaySettlementValue == null);
  if (regionVal !== 'all')     rows = rows.filter(r => r.region === regionVal);
  rows = rows.slice(0, 80);
  tbody.innerHTML = rows.map(loc => {
    const res = loc.todaySettlementValue === 1
      ? '<span style="color:var(--buy);font-weight:700">YES</span>'
      : loc.todaySettlementValue === 0
      ? '<span style="color:var(--text-3)">NO</span>'
      : '<span style="color:var(--text-3)">—</span>';
    const cls = loc.todaySettlementValue === 1 ? 'row-yes' : 'row-no';
    const cid = loc.d1ContractId;
    const tradeBtns = cid
      ? `<button class="t-act-btn loc-buy-btn" data-cid="${cid}" style="font-size:0.63rem;padding:1px 5px;background:rgba(0,192,122,0.12);color:var(--buy);border-color:rgba(0,192,122,0.3)" title="Buy YES @ ask">B ${fmtBp(loc.d1AskPrice)}</button>`
      + `<button class="t-act-btn loc-sell-btn" data-cid="${cid}" style="font-size:0.63rem;padding:1px 5px;background:rgba(232,53,74,0.12);color:var(--sell);border-color:rgba(232,53,74,0.3)" title="Sell YES @ bid">S ${fmtBp(loc.d1BidPrice)}</button>`
      : '<span class="muted">—</span>';
    return `<tr class="${cls}" data-locid="${loc.id}" style="cursor:pointer">
      <td>${loc.name}</td>
      <td class="muted">${loc.region}</td>
      <td class="muted">${loc.climateZone}</td>
      <td class="mono">${fmtPct(loc.d1Probability)}</td>
      <td class="mono">${fmtBp(loc.d1YesPrice)}</td>
      <td class="mono muted">${fmtBp(loc.d1BidPrice)} / ${fmtBp(loc.d1AskPrice)}</td>
      <td class="mono">${loc.todayRainfallMm != null ? loc.todayRainfallMm.toFixed(1) : '—'}</td>
      <td>${res}</td>
      <td style="white-space:nowrap;display:flex;gap:2px">${tradeBtns}</td>
    </tr>`;
  }).join('');
  tbody.querySelectorAll('.loc-buy-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      send('submit-location-order', { contractId: btn.dataset.cid, side: 'BUY',  quantity: 1, accountId: 'acct-user' });
    });
  });
  tbody.querySelectorAll('.loc-sell-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      send('submit-location-order', { contractId: btn.dataset.cid, side: 'SELL', quantity: 1, accountId: 'acct-user' });
    });
  });
  tbody.querySelectorAll('tr[data-locid]').forEach(row => {
    row.addEventListener('click', () => {
      const loc = s.locationSummaries.find(l => l.id === row.dataset.locid);
      if (loc) showLocStrip(loc);
    });
  });
  // Populate region filter once
  const rf = el('region-filter');
  if (rf && rf.options.length <= 1 && s.locationSummaries.length) {
    const regions = [...new Set(s.locationSummaries.map(l => l.region))].sort();
    regions.forEach(r => { const o = document.createElement('option'); o.value = r; o.textContent = r; rf.appendChild(o); });
  }
}

// ─── Location contract strip panel ───────────────────────────────────────────

function showLocStrip(loc) {
  const panel = el('loc-strip-panel');
  const nameEl = el('loc-strip-name');
  const body   = el('loc-strip-body');
  if (!panel || !body) return;
  nameEl.textContent = loc.name;
  panel.style.display = 'block';

  const strip = loc.contractStrip || [];
  if (!strip.length) { body.innerHTML = '<div class="muted" style="font-size:0.72rem">No contracts</div>'; return; }

  body.innerHTML = strip.map(c => {
    const mid      = (c.bid + c.ask) / 2;
    const spreadBp = c.ask - c.bid;
    const relSpread = mid > 0 ? ((spreadBp / mid) * 100).toFixed(0) + '%' : '—';
    // Probability bar: sqrt scale so tiny probabilities still show a sliver
    const barPct = Math.max(0.5, Math.sqrt(c.probability) * 100);
    return `<div style="border:1px solid var(--border);border-radius:3px;padding:0.35rem 0.45rem;margin-bottom:0.35rem;background:var(--s1)">
      <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:0.18rem">
        <span style="font-size:0.65rem;color:var(--accent);font-weight:700">D+${c.dPlus}</span>
        <span class="muted" style="font-size:0.62rem">${c.obsDate}</span>
      </div>
      <div style="height:3px;background:var(--s2);border-radius:2px;margin-bottom:0.28rem;overflow:hidden">
        <div style="height:100%;width:${barPct.toFixed(1)}%;background:linear-gradient(90deg,#1e7de9,#00c07a);border-radius:2px"></div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:0.15rem;margin-bottom:0.28rem">
        <div style="text-align:center">
          <div style="font-size:0.58rem;color:var(--sell);margin-bottom:1px">BID</div>
          <div class="mono" style="font-size:0.75rem;color:var(--sell)">${fmtBp(c.bid)}</div>
          <div style="font-size:0.58rem;color:var(--text-3)">${fmtBpCost(c.bid)}</div>
        </div>
        <div style="text-align:center">
          <div style="font-size:0.58rem;color:var(--text-3);margin-bottom:1px">PROB</div>
          <div class="mono" style="font-size:0.75rem;color:var(--text-2)">${fmtBp(Math.round(mid))}</div>
          <div style="font-size:0.58rem;color:var(--text-3)">${(c.probability*100).toFixed(3)}%</div>
        </div>
        <div style="text-align:center">
          <div style="font-size:0.58rem;color:var(--buy);margin-bottom:1px">ASK</div>
          <div class="mono" style="font-size:0.75rem;color:var(--buy)">${fmtBp(c.ask)}</div>
          <div style="font-size:0.58rem;color:var(--text-3)">${fmtBpCost(c.ask)}</div>
        </div>
      </div>
      <div style="font-size:0.6rem;color:var(--text-3);margin-bottom:0.28rem">
        Spread ${spreadBp}bp · ${relSpread} of mid${c.volume ? ` · Vol ${c.volume}` : ''}${c.lastPrice != null ? ` · Last ${fmtBp(c.lastPrice)}` : ''}
      </div>
      <div style="display:flex;gap:0.3rem">
        <button class="t-act-btn strip-buy" data-cid="${c.contractId}"
          style="flex:1;font-size:0.65rem;background:rgba(0,192,122,0.15);color:var(--buy);border-color:rgba(0,192,122,0.4)">
          BUY ${fmtBp(c.ask)}
        </button>
        <button class="t-act-btn strip-sell" data-cid="${c.contractId}"
          style="flex:1;font-size:0.65rem;background:rgba(232,53,74,0.15);color:var(--sell);border-color:rgba(232,53,74,0.4)">
          SELL ${fmtBp(c.bid)}
        </button>
      </div>
    </div>`;
  }).join('');

  body.querySelectorAll('.strip-buy').forEach(btn => {
    btn.addEventListener('click', () => send('submit-location-order', { contractId: btn.dataset.cid, side: 'BUY',  quantity: 1, accountId: 'acct-user' }));
  });
  body.querySelectorAll('.strip-sell').forEach(btn => {
    btn.addEventListener('click', () => send('submit-location-order', { contractId: btn.dataset.cid, side: 'SELL', quantity: 1, accountId: 'acct-user' }));
  });
}

// ─── Location positions ───────────────────────────────────────────────────────

function renderLocationPositions(s) {
  const tbody = el('loc-pos-tbody');
  if (!tbody) return;
  const positions = (s.locationPositions || []).filter(p => p.status === 'OPEN');
  if (!positions.length) {
    tbody.innerHTML = '<tr><td colspan="9" style="color:var(--text-3);text-align:center;font-size:0.72rem">No open binary positions</td></tr>';
    return;
  }
  // Build lookup: contractId → current book mid (from locationSummaries d1 books)
  const midMap = {};
  (s.locationSummaries || []).forEach(loc => {
    if (loc.d1ContractId) {
      midMap[loc.d1ContractId] = (loc.d1BidPrice + loc.d1AskPrice) / 2;
    }
  });
  tbody.innerHTML = positions.map(p => {
    const currMid = midMap[p.contractId];
    const locName = (s.locationSummaries || []).find(l => l.id === p.locationId)?.name || p.locationId;
    const stripMid = (() => {
      const loc = s.locationSummaries?.find(l => l.id === p.locationId);
      const sc = loc?.contractStrip?.find(c => c.contractId === p.contractId);
      return sc ? (sc.bid + sc.ask) / 2 : currMid;
    })();
    const pnl = stripMid != null
      ? (p.side === 'BUY' ? (stripMid - p.entryPrice) : (p.entryPrice - stripMid)) / 10000 * 10 * p.quantity
      : null;
    // Truncate long location names for the narrow right panel
    const shortName = locName.length > 18 ? locName.slice(0, 16) + '…' : locName;
    return `<tr>
      <td style="font-size:0.68rem" title="${locName}">${shortName}</td>
      <td class="muted mono" style="font-size:0.67rem">${p.obsDate.slice(5)}</td>
      <td class="mono" style="color:${p.side === 'BUY' ? 'var(--buy)' : 'var(--sell)'};">${p.side}</td>
      <td class="mono">${p.quantity}</td>
      <td class="mono">${fmtBp(p.entryPrice)}</td>
      <td class="mono">${stripMid != null ? fmtBp(Math.round(stripMid)) : '—'}</td>
      <td class="mono" style="color:${pnl != null ? colorOf(pnl) : ''}">${pnl != null ? fmtPoundSign(pnl) : '—'}</td>
    </tr>`;
  }).join('');
}

// ─── Verification checks ──────────────────────────────────────────────────────

function renderChecks(s) {
  const list = el('checks-list');
  if (!list) return;
  const checks = s.checks || [];
  if (!checks.length) { list.innerHTML = '<div style="padding:0.6rem;color:var(--text-3)">Advance simulation to run checks.</div>'; return; }
  list.innerHTML = checks.map(c =>
    `<div class="t-check ${c.passed ? 't-check-pass' : 't-check-fail'}">
      <span class="t-check-icon">${c.passed ? '✓' : '✗'}</span>
      ${c.name}
    </div>`
  ).join('');
}

// ─── Storms panel ─────────────────────────────────────────────────────────────

function renderStorms(s) {
  const list = el('storm-list');
  if (!list) return;
  list.innerHTML = (s.storms || []).map(st =>
    `<div class="t-storm-item">
      <b>${st.id}</b> · ${st.stormType.replace(/_/g,' ')} ·
      ${st.centreLatitude.toFixed(1)}°, ${st.centreLongitude.toFixed(1)}° ·
      r=${st.radiusKm.toFixed(0)}km · ends ${st.endDate}
    </div>`
  ).join('') || '<div style="color:var(--text-3);font-size:0.76rem">No active storms</div>';
}

// ─── Audit log ────────────────────────────────────────────────────────────────

function renderAudit(s) {
  const list = el('audit-list');
  if (!list || !s.audit) return;
  list.innerHTML = [...s.audit].reverse().map(a =>
    `<div class="t-audit-item">
      <span class="t-audit-date">${a.time}</span>
      <span class="t-audit-type t-audit-${a.type}">${a.type}</span>
      <span class="t-audit-msg">${a.message}</span>
    </div>`
  ).join('');
}

// ─── Order ticket ─────────────────────────────────────────────────────────────

let currentSide = 'BUY';

function updateTicketSide(side) {
  currentSide = side;
  const buyBtn  = el('ot-side-buy');
  const sellBtn = el('ot-side-sell');
  const subBtn  = el('btn-submit-order');
  if (!buyBtn || !sellBtn || !subBtn) return;
  buyBtn.classList.toggle('active',  side === 'BUY');
  sellBtn.classList.toggle('active', side === 'SELL');
  subBtn.className = `t-submit-btn t-submit-${side.toLowerCase()}`;
  subBtn.textContent = `SUBMIT ${side} ORDER`;
}

function updateMarginInfo(s) {
  const info = el('ot-margin-info');
  if (!info || !s) return;
  const qty     = parseInt(el('ot-qty')?.value || 1);
  const accId   = el('ot-account')?.value;
  const account = s.accounts?.find(a => a.id === accId);
  const riskPts = s.settings?.initialMarginRiskPoints || 4.3;
  const reqPound = qty * riskPts * 10;
  const avail   = account ? account.cash - (account.reservedMargin || 0) : 0;
  const ok      = reqPound <= avail;
  info.innerHTML = `
    <div>Required: <b style="color:${ok ? 'var(--buy)' : 'var(--sell)'}">£${Math.round(reqPound).toLocaleString()}</b></div>
    <div>Available: <b>£${Math.round(avail).toLocaleString()}</b></div>
    <div style="color:var(--text-3);font-size:0.68rem">£10/pt × ${riskPts} risk pts × ${qty} contracts</div>`;
}

let lastStatusMsg = '';
function checkOrderStatus(s) {
  if (s.statusMessage && s.statusMessage !== lastStatusMsg) {
    lastStatusMsg = s.statusMessage;
    const isOk  = /submitted|closed|trade/i.test(s.statusMessage);
    const isErr = /rejected|failed|insufficient/i.test(s.statusMessage);
    if (isOk || isErr) showOrderStatus(s.statusMessage, isOk);
  }
}

function showOrderStatus(msg, ok) {
  const el2 = el('ot-status');
  if (!el2) return;
  el2.textContent = msg;
  el2.className = `t-ticket-status ${ok ? 'ok' : 'err'}`;
  el2.style.display = 'block';
  setTimeout(() => { el2.style.display = 'none'; }, 5000);
}

// ─── Tab system ───────────────────────────────────────────────────────────────

function initTabs() {
  document.querySelectorAll('.t-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.t-tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.t-tab-pane').forEach(p => p.classList.remove('active'));
      tab.classList.add('active');
      const pane = el('tab-' + tab.dataset.tab);
      if (pane) pane.classList.add('active');
    });
  });

  document.querySelectorAll('.t-chart-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.t-chart-tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.t-chart-pane').forEach(p => p.classList.remove('active'));
      tab.classList.add('active');
      const pane = el('pane-' + tab.dataset.chart);
      if (pane) pane.classList.add('active');
      if (state.current) {
        if (tab.dataset.chart === 'history') renderHistoryChart(state.current);
        if (tab.dataset.chart === 'map')     renderWorldMap(state.current);
      }
    });
  });
}

// ─── Basis & Replication panel ────────────────────────────────────────────────

function renderReplicationPanel(s) {
  const body = el('replication-body');
  if (!body) return;

  const fut = s.tradableFutures?.find(f => f.status === 'ACTIVE' || f.status === 'EXPIRING');
  if (!fut) { body.innerHTML = '<span class="muted" style="font-size:0.69rem">No active future</span>'; return; }

  const fv       = fut.projectedSettlement;
  const official = fut.currentSettlementPriceUnits != null ? fut.currentSettlementPriceUnits / 100 : null;
  const basis    = (fv != null && official != null) ? fv - official : null;
  const basisClr = basis == null ? 'var(--text-3)'
                 : Math.abs(basis) < 0.005 ? 'var(--text-2)'
                 : basis > 0 ? 'var(--buy)' : 'var(--sell)';

  // Days in contract month
  const [fy, fm] = fut.contractMonth.split('-').map(Number);
  const D = new Date(Date.UTC(fy, fm, 0)).getUTCDate();
  const windowDays = Math.min(7, D);
  const coveragePct = Math.round(windowDays / D * 100);

  // Aggregate strip stats across all locations × D+1..7
  let totalBid = 0, totalAsk = 0, stripCount = 0;
  (s.locationSummaries || []).forEach(loc => {
    (loc.contractStrip || []).forEach(c => {
      totalBid += c.bid; totalAsk += c.ask; stripCount++;
    });
  });
  const avgMid    = stripCount > 0 ? (totalBid + totalAsk) / 2 / stripCount : 0;
  const avgSpread = stripCount > 0 ? (totalAsk - totalBid) / stripCount : 0;

  // Theoretical spread cost to replicate 1 futures contract via D+1..7 strip:
  // Each location-day needs w_i/D contracts → sum over all locs × window days
  // Cost = Σ w_i/D × avg_spread/10000 × £10 × 7 days = (7/D) × avg_spread/10000 × £10
  const repCostGbp = (windowDays / D) * (avgSpread / 10000) * 10;

  // FV sensitivity: buying 50 binary lots on 1 location shifts mid by ~physicsHalfSpread
  // avgHalfSpread ≈ avgSpread / 2. Index move = w_i × halfSpread / 10000 = (1/1000) × (avgSpread/2) / 10000
  // FV move per 50 lots = index move / D
  const locCount  = Math.max(1, (s.locationSummaries || []).length);
  const avgWeight = 1 / locCount;
  const halfSpreadEst = avgSpread / 2;
  const fvPer50Lots = avgWeight * (halfSpreadEst / 10000) / D; // index pts per 50 lots on 1 loc

  // User futures position on this future
  const userPos = (s.positions || []).find(
    p => p.accountId === 'acct-user' && p.status === 'OPEN' && p.netQuantity !== 0 && p.futureId === fut.id
  );

  const row = (label, val, clr) =>
    `<div style="display:flex;justify-content:space-between;gap:0.5rem">
      <span style="color:var(--text-3)">${label}</span>
      <span class="mono" style="${clr ? 'color:' + clr : ''}">${val}</span>
    </div>`;

  let html = `
    <div style="margin-bottom:0.35rem">
      ${row('FV (strip-derived)', fv != null ? fmt2(fv) : '—')}
      ${row('Official settle',    official != null ? fmt2(official) : '—')}
      ${row('Basis (FV − settle)', basis != null ? (basis >= 0 ? '+' : '') + basis.toFixed(3) + ' pts' : '—', basisClr)}
    </div>
    <div style="border-top:1px solid var(--border);padding-top:0.3rem;margin-bottom:0.35rem">
      ${row('Strip window', `D+1..${windowDays} / ${D} days (${coveragePct}%)`)}
      ${row('Avg binary mid', fmtBp(Math.round(avgMid)))}
      ${row('Avg spread', avgSpread.toFixed(1) + ' bp')}
      ${row('Rep. spread cost / future', repCostGbp < 0.01 ? (repCostGbp * 100).toFixed(3) + 'p' : '£' + repCostGbp.toFixed(4))}
      ${row('FV shift / 50 lots (1 loc)', fvPer50Lots.toFixed(6) + ' pts')}
    </div>`;

  if (userPos) {
    const sideStr = userPos.netQuantity > 0 ? 'LONG' : 'SHORT';
    const qty     = Math.abs(userPos.netQuantity);
    const entry   = (userPos.averageEntryPriceUnits / 100).toFixed(2);
    const upnl    = userPos.unrealisedPnlPence / 100;
    const lotsToHedge = Math.round(locCount * windowDays * qty / D * 50);
    html += `
    <div style="border-top:1px solid var(--border);padding-top:0.3rem">
      ${row('Your position', `<span style="color:${sideStr==='LONG'?'var(--buy)':'var(--sell)'}">${sideStr} ${qty} @ ${entry}</span>`)}
      ${row('Unrealised VM', `<span style="color:${colorOf(upnl)}">${fmtPoundSign(upnl)}</span>`)}
      ${row('Binary lots to delta-hedge', '~' + lotsToHedge.toLocaleString())}
    </div>`;
  }

  body.innerHTML = html;
}

// ─── Master render ────────────────────────────────────────────────────────────

function render(s) {
  renderHeader(s);
  renderStrip(s);
  renderFuturesStrip(s);
  renderOrderBook(s);
  renderLadderChart(s);
  renderHistoryChart(s);
  renderWorldMap(s);
  renderPositions(s);
  renderRecentTrades(s);
  renderFuturesSettlements(s);
  renderAccounts(s);
  renderSettlementSummary(s);
  renderLocationTable(s);
  // Keep strip panel live if open
  const stripPanel = el('loc-strip-panel');
  if (stripPanel && stripPanel.style.display !== 'none') {
    const stripName = el('loc-strip-name')?.textContent;
    const liveLoc = s.locationSummaries?.find(l => l.name === stripName);
    if (liveLoc) showLocStrip(liveLoc);
  }
  renderLocationPositions(s);
  renderReplicationPanel(s);
  renderChecks(s);
  renderStorms(s);
  renderAudit(s);
  updateMarginInfo(s);
  checkOrderStatus(s);
}

// ─── Controls ─────────────────────────────────────────────────────────────────

function wireControls() {
  el('btn-start')?.addEventListener('click', () => send('start'));
  el('btn-pause')?.addEventListener('click', () => send('pause'));
  el('btn-step')?.addEventListener('click', () => send('advance', { days: 1 }));
  el('btn-week')?.addEventListener('click', () => send('advance', { days: 7 }));
  el('btn-month')?.addEventListener('click', () => send('advance', { days: 30 }));
  el('btn-reset')?.addEventListener('click', () => { destroyCharts(); send('reset'); });
  el('btn-clear-storms')?.addEventListener('click', () => send('clear-storms'));

  el('ot-side-buy')?.addEventListener('click',  () => updateTicketSide('BUY'));
  el('ot-side-sell')?.addEventListener('click', () => updateTicketSide('SELL'));

  el('ot-type')?.addEventListener('change', () => {
    const isLimit = el('ot-type')?.value === 'LIMIT';
    const lf = el('limit-price-field');
    if (lf) lf.style.display = isLimit ? 'flex' : 'none';
  });

  el('btn-submit-order')?.addEventListener('click', () => {
    const futureId         = el('ot-future')?.value;
    const accountId        = el('ot-account')?.value;
    const quantity         = parseInt(el('ot-qty')?.value || 1);
    const orderType        = el('ot-type')?.value || 'MARKET';
    const timeInForce      = el('ot-tif')?.value  || 'GTC';
    const limitPricePoints = orderType === 'LIMIT' ? parseFloat(el('ot-limit')?.value || 0) : null;
    if (!futureId || quantity <= 0) { showOrderStatus('Select a contract first.', false); return; }
    send('submit-order', { accountId, futureId, side: currentSide, quantity, orderType, timeInForce, limitPricePoints });
  });

  document.querySelectorAll('[data-storm]').forEach(btn => {
    btn.addEventListener('click', () => send('inject-storm', { stormType: btn.dataset.storm }));
  });
  document.querySelectorAll('[data-weight]').forEach(btn => {
    btn.addEventListener('click', () => send('set-weighting', { method: btn.dataset.weight }));
  });

  el('loc-strip-close')?.addEventListener('click', () => {
    const p = el('loc-strip-panel'); if (p) p.style.display = 'none';
  });

  // Right-panel tab switching (Settlements ↔ Binary Positions)
  document.querySelectorAll('.t-rpanel-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.t-rpanel-tab').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const targetId = btn.dataset.rpanel;
      ['rpanel-settle', 'rpanel-binaries'].forEach(id => {
        const pane = el(id);
        if (pane) pane.style.display = id === targetId ? 'block' : 'none';
      });
    });
  });
  el('range-select')?.addEventListener('change',      () => { if (state.current) renderHistoryChart(state.current); });
  el('location-filter')?.addEventListener('change',   () => { if (state.current) renderLocationTable(state.current); });
  el('region-filter')?.addEventListener('change',     () => { if (state.current) renderLocationTable(state.current); });
  el('ob-future-select')?.addEventListener('change',  () => { if (state.current) renderOrderBook(state.current); });

  ['ot-qty','ot-account','ot-future'].forEach(id => {
    el(id)?.addEventListener('input',  () => { if (state.current) updateMarginInfo(state.current); });
    el(id)?.addEventListener('change', () => { if (state.current) updateMarginInfo(state.current); });
  });

  el('btn-apply-settings')?.addEventListener('click', () => {
    const inputs = el('settings-form').querySelectorAll('input, select');
    const settings = {};
    inputs.forEach(inp => {
      if (!inp.name) return;
      settings[inp.name] = inp.type === 'number' ? parseFloat(inp.value) : inp.value;
    });
    send('apply-settings', { settings });
  });
}

initTabs();
wireControls();
