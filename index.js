const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

const SHEET_ID = '1b7-04u_kq491RTzjJdT_DlJhL4oWIiKah9rJbqdHAZg';
const SHEET_NAME = 'SalesData';

// Parse CSV properly - handles commas inside quoted values (like large numbers)
function parseCSV(text) {
  const rows = [];
  let row = [];
  let val = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      if (inQuotes && text[i + 1] === '"') { val += '"'; i++; } // escaped quote
      else { inQuotes = !inQuotes; }
      continue;
    }
    if (ch === ',' && !inQuotes) { row.push(val); val = ''; continue; }
    if (ch === '\n' && !inQuotes) { row.push(val); rows.push(row); row = []; val = ''; continue; }
    if (ch === '\r' && !inQuotes) continue;
    val += ch;
  }
  if (val || row.length) { row.push(val); rows.push(row); }
  return rows;
}

// Helper: fetch and parse a sheet by name
async function fetchSheet(sheetName) {
  // Use gviz endpoint with sheet param — more reliable for targeting specific tabs
  const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(sheetName)}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Sheet "${sheetName}" fetch failed: ${response.status}`);
  const text = await response.text();
  return parseCSV(text);
}

const num = (val) => {
  if (!val || val.trim() === '') return 0;
  return parseFloat(val.replace(/,/g, '')) || 0;
};

const diffPct = (cur, ya) => ya !== 0 ? ((cur - ya) / Math.abs(ya)) * 100 : 0;
const diffVal = (cur, ya) => cur - ya;

// Build a metrics block { current, yearAgo, diffPct, diffVal } for sales, trx, basket
function buildMetrics(salesCur, salesYA, trxCur, trxYA) {
  const bskCur = trxCur !== 0 ? salesCur / trxCur : 0;
  const bskYA  = trxYA !== 0 ? salesYA / trxYA : 0;
  return {
    sales:  { current: salesCur, yearAgo: salesYA, diffPct: diffPct(salesCur, salesYA), diffVal: diffVal(salesCur, salesYA) },
    trx:    { current: trxCur,   yearAgo: trxYA,   diffPct: diffPct(trxCur, trxYA),     diffVal: diffVal(trxCur, trxYA) },
    basket: { current: bskCur,   yearAgo: bskYA,   diffPct: diffPct(bskCur, bskYA),     diffVal: diffVal(bskCur, bskYA) }
  };
}

// Endpoint: dropdown filter options (Area, Stores, Months)
app.get('/api/filters', async (req, res) => {
  try {
    const [stores, months] = await Promise.all([
      fetchSheet('ListOfStores'),
      fetchSheet('MonthFilter')
    ]);

    // ListOfStores - B=Region, C=Area, D=Store ID, E=Store Name
    const storeRows = stores.slice(1).filter(r => r[3] && r[3].trim() !== '');
    const areas = [...new Set(storeRows.map(r => (r[2] || '').trim()).filter(Boolean))].sort();
    const storeList = storeRows.map(r => ({
      area:    (r[2] || '').trim(),
      storeId: (r[3] || '').trim(),
      name:    (r[4] || '').trim()
    }));

    // MonthFilter - col A
    const monthList = months.slice(1).map(r => (r[0] || '').trim()).filter(Boolean);

    res.json({ ok: true, areas, stores: storeList, months: monthList });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/data', async (req, res) => {
  try {
    const { area, storeId, month } = req.query;

    // Fetch all sheets in parallel
    const [salesRows, shopperRows, storeRows, aparRows, gegRows] = await Promise.all([
      fetchSheet(SHEET_NAME),
      fetchSheet('ShopperMetricsData'),
      fetchSheet('ListOfStores'),
      fetchSheet('APAR'),
      fetchSheet('GEG')
    ]);

    // Build a Store ID → Area lookup map (from ListOfStores)
    const storeAreaMap = {};
    storeRows.slice(1).forEach(r => {
      const sid = (r[3] || '').trim();
      const ar  = (r[2] || '').trim();
      if (sid) storeAreaMap[sid] = ar;
    });

    // Filter helpers
    const matchArea    = (storeId) => !area || (storeAreaMap[storeId] || '').toLowerCase() === area.toLowerCase();
    const matchStore   = (storeId) => !storeId || true; // (placeholder, used below differently)
    const matchMonth   = (m) => !month || (m || '').trim().toLowerCase() === month.toLowerCase();
    const matchStoreId = (sid) => !storeId || (sid || '').trim() === storeId.trim();

    // ===== SalesData: Total Sales =====
    // SalesData cols: A=0 MONTH, D=3 STORE ID, F=5 SALES MTD, G=6 SALES MTD YA, M=12 TRX MTD, O=14 TRX MTD YA
    const salesData = salesRows.slice(1);
    let sCur = 0, sYA = 0, tCur = 0, tYA = 0, validRows = 0;
    salesData.forEach(cols => {
      if (!cols[5] || cols[5].trim() === '') return;
      const rowMonth   = cols[0];
      const rowStoreId = (cols[3] || '').trim();
      if (!matchMonth(rowMonth)) return;
      if (!matchStoreId(rowStoreId)) return;
      if (!matchArea(rowStoreId)) return;
      sCur += num(cols[5]);
      sYA  += num(cols[6]);
      tCur += num(cols[12]);
      tYA  += num(cols[14]);
      validRows++;
    });
    const totalSalesMetrics = buildMetrics(sCur, sYA, tCur, tYA);

    // ===== ShopperMetricsData: TNAP, KAIN, PERKS, PAG-IBIG =====
    const normalize = s => (s || '').trim().toUpperCase().replace(/[\s._-]/g, '');
    const shopperHeadersNorm = shopperRows[0].map(normalize);
    const colIdx = (name) => shopperHeadersNorm.indexOf(normalize(name));

    const typeCol     = colIdx('TYPE');
    const monthCol    = colIdx('Month');    // E in your reference
    const storeIdCol  = colIdx('STOREID');  // C
    const salesCol    = colIdx('Sales');
    const salesLYCol  = colIdx('SalesLY');
    const trxCol      = colIdx('TRXCount');
    const trxLYCol    = colIdx('TRXCountLY');

    const shopperData = shopperRows.slice(1);

    function sumByType(typeFilter) {
      let salesCur = 0, salesYA = 0, trxCur = 0, trxYA = 0, matchCount = 0;
      shopperData.forEach(cols => {
        if (typeCol < 0) return;
        const type = (cols[typeCol] || '').trim().toUpperCase();
        if (type !== typeFilter.toUpperCase()) return;

        // Apply filters
        const rowMonth   = monthCol   >= 0 ? cols[monthCol]   : '';
        const rowStoreId = storeIdCol >= 0 ? (cols[storeIdCol] || '').trim() : '';
        if (!matchMonth(rowMonth)) return;
        if (!matchStoreId(rowStoreId)) return;
        if (!matchArea(rowStoreId)) return;

        matchCount++;
        if (salesCol   >= 0) salesCur += num(cols[salesCol]);
        if (salesLYCol >= 0) salesYA  += num(cols[salesLYCol]);
        if (trxCol     >= 0) trxCur   += num(cols[trxCol]);
        if (trxLYCol   >= 0) trxYA    += num(cols[trxLYCol]);
      });
      const m = buildMetrics(salesCur, salesYA, trxCur, trxYA);
      m.matchCount = matchCount;
      return m;
    }

    const tnapMetrics    = sumByType('TNAP');
    const kainMetrics    = sumByType('KAIN');
    const perksMetrics   = sumByType('PERKS');
    const pagibigMetrics = sumByType('PAG-IBIG');

    // ===== APAR sheet =====
    // A=0 Month, C=2 Store ID, G=6 Sales, H=7 Sales YA, I=8 Trx, J=9 Trx YA
    const aparData = aparRows.slice(1);
    let aSalesCur = 0, aSalesYA = 0, aTrxCur = 0, aTrxYA = 0;
    aparData.forEach(cols => {
      const rowMonth   = cols[0];
      const rowStoreId = (cols[2] || '').trim();
      if (!matchMonth(rowMonth)) return;
      if (!matchStoreId(rowStoreId)) return;
      if (!matchArea(rowStoreId)) return;
      aSalesCur += num(cols[6]);
      aSalesYA  += num(cols[7]);
      aTrxCur   += num(cols[8]);
      aTrxYA    += num(cols[9]);
    });
    const aparMetrics = buildMetrics(aSalesCur, aSalesYA, aTrxCur, aTrxYA);

    // ===== GEG sheet (Gold, Elite, Green) =====
    // A=0 Month, C=2 Store ID, E=4 Customer Level, F=5 Sales, G=6 Sales YA, H=7 TRX, I=8 TRX LY
    const gegData = gegRows.slice(1);
    function sumGEG(levelFilter) {
      let sCur = 0, sYA = 0, trxCur = 0, trxYA = 0;
      gegData.forEach(cols => {
        const level = (cols[4] || '').trim().toUpperCase();
        if (level !== levelFilter.toUpperCase()) return;
        const rowMonth   = cols[0];
        const rowStoreId = (cols[2] || '').trim();
        if (!matchMonth(rowMonth)) return;
        if (!matchStoreId(rowStoreId)) return;
        if (!matchArea(rowStoreId)) return;
        sCur   += num(cols[5]);
        sYA    += num(cols[6]);
        trxCur += num(cols[7]);
        trxYA  += num(cols[8]);
      });
      return buildMetrics(sCur, sYA, trxCur, trxYA);
    }

    const goldMetrics  = sumGEG('Gold');
    const eliteMetrics = sumGEG('Elite');
    const greenMetrics = sumGEG('Green');

    res.json({
      ok: true,
      rowCount: validRows,
      filters: { area: area || null, storeId: storeId || null, month: month || null },
      totalSales: totalSalesMetrics,
      tnap: tnapMetrics,
      kain: kainMetrics,
      perks: perksMetrics,
      pagibig: pagibigMetrics,
      apar: aparMetrics,
      gold: goldMetrics,
      elite: eliteMetrics,
      green: greenMetrics
    });

  } catch (err) {
    console.error('Fetch error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Debug endpoint: check raw column headers and sample rows
app.get('/api/debug', async (req, res) => {
  try {
    const salesAllRows = await fetchSheet(SHEET_NAME);
    const salesHeaders = salesAllRows[0].map((h, i) => `[${i}] ${h}`);
    const salesSample = salesAllRows.slice(1, 3).map(r => r.map((v, i) => `[${i}] ${v}`));

    const shopperAllRows = await fetchSheet('ShopperMetricsData');
    const shopperHeaders = shopperAllRows[0].map((h, i) => `[${i}] ${h}`);
    const shopperSample = shopperAllRows.slice(1, 4).map(r => r.map((v, i) => `[${i}] ${v}`));
    const uniqueTypes = [...new Set(shopperAllRows.slice(1).map(r => (r[0] || '').trim()))];

    res.json({
      salesData: { headers: salesHeaders, sampleRows: salesSample, totalRows: salesAllRows.length - 1 },
      shopperMetrics: { headers: shopperHeaders, sampleRows: shopperSample, uniqueTypes, totalRows: shopperAllRows.length - 1 }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>CAMANAVA eBRT Report</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: 'Segoe UI', Arial, sans-serif; background: #f0f2f0; color: #222; min-height: 100vh; }

  .top-nav {
    background: #1B5E20; color: white; padding: 12px 24px;
    display: flex; align-items: center; justify-content: space-between;
    box-shadow: 0 2px 6px rgba(0,0,0,0.3);
  }
  .top-nav .brand { font-size: 18px; font-weight: 700; letter-spacing: 1px; }
  .top-nav .brand span { color: #A5D6A7; font-size: 12px; display: block; font-weight: 400; letter-spacing: 2px; }
  .top-nav .date-label { font-size: 12px; color: #A5D6A7; }

  .tabs { background: #2E7D32; display: flex; padding: 0 24px; gap: 4px; }
  .tab-btn {
    background: transparent; border: none; color: #C8E6C9;
    padding: 11px 22px; font-size: 13px; font-weight: 600; cursor: pointer;
    border-bottom: 3px solid transparent; transition: all 0.2s; letter-spacing: 0.5px;
  }
  .tab-btn:hover { color: white; background: rgba(255,255,255,0.08); }
  .tab-btn.active { color: white; border-bottom: 3px solid #A5D6A7; background: rgba(255,255,255,0.1); }

  .content { padding: 20px 24px; }

  .filter-bar {
    background: white; border-radius: 8px; padding: 12px 18px; margin-bottom: 16px;
    display: flex; align-items: center; gap: 16px; flex-wrap: wrap;
    box-shadow: 0 1px 4px rgba(0,0,0,0.08);
  }
  .filter-bar label { font-size: 12px; font-weight: 600; color: #555; text-transform: uppercase; letter-spacing: 0.5px; }
  .filter-bar select, .filter-bar input {
    border: 1px solid #ccc; border-radius: 5px; padding: 6px 10px;
    font-size: 13px; color: #333; background: #fafafa;
  }
  .filter-bar select:focus, .filter-bar input:focus { outline: none; border-color: #2E7D32; }
  .btn-refresh {
    margin-left: auto; background: #1B5E20; color: white; border: none;
    border-radius: 5px; padding: 7px 18px; font-size: 13px; font-weight: 600;
    cursor: pointer; transition: background 0.2s; display: flex; align-items: center; gap: 6px;
  }
  .btn-refresh:hover { background: #2E7D32; }
  .btn-refresh.loading { opacity: 0.7; cursor: not-allowed; }

  .status-bar {
    background: #E8F5E9; border: 1px solid #C8E6C9; border-radius: 6px;
    padding: 7px 14px; margin-bottom: 14px; font-size: 12px; color: #2E7D32;
    display: flex; align-items: center; gap: 8px;
  }
  .status-bar.error { background: #FFEBEE; border-color: #FFCDD2; color: #C62828; }
  .status-bar.loading { background: #FFF8E1; border-color: #FFE082; color: #F57F17; }

  .table-card { background: white; border-radius: 8px; box-shadow: 0 1px 4px rgba(0,0,0,0.08); overflow: hidden; }
  .table-wrapper { overflow-x: auto; }

  table { width: 100%; border-collapse: collapse; font-size: 13px; }

  .section-header td {
    background: #1B5E20; color: white; font-weight: 700; font-size: 12px;
    letter-spacing: 1px; text-align: center; padding: 8px 10px; text-transform: uppercase;
  }
  .col-header td {
    background: #f5f5f5; color: #444; font-weight: 700; font-size: 11px;
    text-align: center; padding: 7px 10px; border-bottom: 2px solid #ddd;
    text-transform: uppercase; letter-spacing: 0.3px;
  }
  .col-header td.metrics-col { text-align: left; color: #1B5E20; }

  tbody tr td { padding: 7px 10px; border-bottom: 1px solid #f0f0f0; vertical-align: middle; }
  tbody tr td.metrics-col { font-weight: 600; color: #333; text-align: left; white-space: nowrap; min-width: 160px; }
  tbody tr td.data-col { text-align: right; color: #555; font-variant-numeric: tabular-nums; min-width: 90px; }
  tbody tr td.diff-pos { color: #2E7D32; font-weight: 700; }
  tbody tr td.diff-neg { color: #C62828; font-weight: 700; }

  tbody tr:hover td { background: #f9fcf9; }
  .group-divider td { height: 10px; background: #f8f8f8; }
  .group-label td {
    font-size: 10px; font-weight: 700; color: #888; letter-spacing: 1px;
    text-transform: uppercase; padding: 10px 10px 4px; background: #fafafa; border-bottom: none;
  }
  .empty-cell { color: #ccc; font-size: 11px; text-align: center !important; }

  /* Section separator lines */
  table td:nth-child(2), table th:nth-child(2) { border-left: 2px solid #1B5E20; }
  table td:nth-child(6), table th:nth-child(6) { border-left: 2px solid #1B5E20; }
  table td:nth-child(10), table th:nth-child(10) { border-left: 2px solid #1B5E20; }
  table td:nth-child(14), table th:nth-child(14) { border-left: 2px solid #1B5E20; }
  .section-header .sec-div { border-left: 2px solid rgba(255,255,255,0.4); }
  .col-header .sec-div { border-left: 2px solid #1B5E20; }
  .spinner { display: inline-block; width: 12px; height: 12px; border: 2px solid #ccc; border-top-color: #1B5E20; border-radius: 50%; animation: spin 0.7s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .footer { text-align: center; padding: 16px; font-size: 11px; color: #aaa; }
</style>
</head>
<body>

<div class="top-nav">
  <div class="brand">CAMANAVA eBRT <span>ELECTRONIC BUSINESS REVIEW TOOL</span></div>
  <div class="date-label" id="currentDate"></div>
</div>

<div class="tabs">
  <button class="tab-btn active" onclick="switchTab(this, 'daily')">Daily Sales</button>
  <button class="tab-btn" onclick="switchTab(this, 'monthly')">Monthly Sales</button>
  <button class="tab-btn" onclick="switchTab(this, 'category')">Category Sales</button>
</div>

<!-- DAILY TAB -->
<div id="tab-daily" class="content">

  <div class="filter-bar">
    <label>Month</label>
    <select id="monthFilter"><option value="">All Months</option></select>
    <label>Area</label>
    <select id="areaFilter"><option value="">All Areas</option></select>
    <label>Store</label>
    <select id="storeFilter"><option value="">All Stores</option></select>
    <button class="btn-refresh" id="refreshBtn" onclick="loadData()">↻ Refresh</button>
  </div>

  <div id="statusBar" class="status-bar loading">
    <span class="spinner"></span> Loading data from Google Sheets...
  </div>

  <div class="table-card">
    <div class="table-wrapper">
      <table>
        <thead>
          <tr class="section-header">
            <td rowspan="2" style="text-align:left; width:160px;">Metrics</td>
            <td colspan="4">SALES</td>
            <td colspan="4" class="sec-div">TRANSACTION COUNT</td>
            <td colspan="4" class="sec-div">BASKET SIZE</td>
            <td colspan="2" class="sec-div">SOB</td>
          </tr>
          <tr class="col-header">
            <td>Current</td><td>Year Ago</td><td>Diff %</td><td>Diff Val</td>
            <td class="sec-div">Current</td><td>Year Ago</td><td>Diff %</td><td>Diff Val</td>
            <td class="sec-div">Current</td><td>Year Ago</td><td>Diff %</td><td>Diff Val</td>
            <td class="sec-div">Current</td><td>Year Ago</td>
          </tr>
        </thead>
        <tbody id="tableBody">
          <!-- Rows will be injected by JS -->
        </tbody>
      </table>
    </div>
  </div>

  <div class="footer" id="footerText">CAMANAVA Region · Data Source: Google Sheets</div>
</div>

<!-- MONTHLY TAB -->
<div id="tab-monthly" class="content" style="display:none;">
  <div style="text-align:center; padding: 60px; color: #aaa; font-size:14px;">Monthly Sales tab — coming soon</div>
</div>

<!-- CATEGORY TAB -->
<div id="tab-category" class="content" style="display:none;">
  <div style="text-align:center; padding: 60px; color: #aaa; font-size:14px;">Category Sales tab — coming soon</div>
</div>

<script>
  const today = new Date();
  document.getElementById('currentDate').textContent =
    today.toLocaleDateString('en-PH', { weekday:'short', year:'numeric', month:'short', day:'numeric' });

  // Cache full store list for client-side filtering
  let allStores = [];

  function switchTab(btn, tabId) {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    document.querySelectorAll('[id^="tab-"]').forEach(t => t.style.display = 'none');
    document.getElementById('tab-' + tabId).style.display = '';
  }

  // Format numbers nicely
  function fmt(n, isCount = false) {
    if (n === null || n === undefined || isNaN(n)) return '—';
    if (isCount) return Math.round(n).toLocaleString('en-PH');
    return n.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function fmtPct(n) {
    if (n === null || n === undefined || isNaN(n)) return '—';
    const sign = n >= 0 ? '+' : '';
    return sign + n.toFixed(2) + '%';
  }

  function fmtDiffVal(n, isCount = false) {
    if (n === null || n === undefined || isNaN(n)) return '—';
    const sign = n >= 0 ? '+' : '';
    return sign + fmt(n, isCount);
  }

  // Build a data cell with color coding for diff columns
  function cell(val, isDiff = false, isCount = false) {
    if (!isDiff) return \`<td class="data-col">\${isCount ? fmt(val, true) : fmt(val)}</td>\`;
    const cls = val > 0 ? 'diff-pos' : val < 0 ? 'diff-neg' : '';
    return \`<td class="data-col \${cls}">\${val}</td>\`;
  }

  function emptyRow(label) {
    const empties = Array(12).fill('<td class="data-col empty-cell">—</td>').join('');
    const sob = Array(2).fill('<td class="data-col empty-cell">—</td>').join('');
    return \`<tr><td class="metrics-col">\${label}</td>\${empties}\${sob}</tr>\`;
  }

  function dataRow(label, salesCur, salesYA, salesDiffPct, salesDiffVal,
                   trxCur, trxYA, trxDiffPct, trxDiffVal,
                   bskCur, bskYA, bskDiffPct, bskDiffVal) {
    const sDiffPctClass = salesDiffPct >= 0 ? 'diff-pos' : 'diff-neg';
    const sDiffValClass = salesDiffVal >= 0 ? 'diff-pos' : 'diff-neg';
    const tDiffPctClass = trxDiffPct >= 0 ? 'diff-pos' : 'diff-neg';
    const tDiffValClass = trxDiffVal >= 0 ? 'diff-pos' : 'diff-neg';
    const bDiffPctClass = bskDiffPct >= 0 ? 'diff-pos' : 'diff-neg';
    const bDiffValClass = bskDiffVal >= 0 ? 'diff-pos' : 'diff-neg';

    return \`<tr>
      <td class="metrics-col">\${label}</td>
      <td class="data-col">\${fmt(salesCur)}</td>
      <td class="data-col">\${fmt(salesYA)}</td>
      <td class="data-col \${sDiffPctClass}">\${fmtPct(salesDiffPct)}</td>
      <td class="data-col \${sDiffValClass}">\${fmtDiffVal(salesDiffVal)}</td>
      <td class="data-col">\${fmt(trxCur, true)}</td>
      <td class="data-col">\${fmt(trxYA, true)}</td>
      <td class="data-col \${tDiffPctClass}">\${fmtPct(trxDiffPct)}</td>
      <td class="data-col \${tDiffValClass}">\${fmtDiffVal(trxDiffVal, true)}</td>
      <td class="data-col">\${fmt(bskCur)}</td>
      <td class="data-col">\${fmt(bskYA)}</td>
      <td class="data-col \${bDiffPctClass}">\${fmtPct(bskDiffPct)}</td>
      <td class="data-col \${bDiffValClass}">\${fmtDiffVal(bskDiffVal)}</td>
      <td class="data-col empty-cell">—</td>
      <td class="data-col empty-cell">—</td>
    </tr>\`;
  }

  // Helper: build a row from a metrics object { sales:{...}, trx:{...}, basket:{...} }
  function metricsRow(label, m) {
    return dataRow(label,
      m.sales.current, m.sales.yearAgo, m.sales.diffPct, m.sales.diffVal,
      m.trx.current, m.trx.yearAgo, m.trx.diffPct, m.trx.diffVal,
      m.basket.current, m.basket.yearAgo, m.basket.diffPct, m.basket.diffVal
    );
  }

  function buildTable(d) {
    // Total TNAP = TNAP + KAIN combined
    const totalTnap = buildCombined(d.tnap, d.kain);
    // Total GEG = Gold + Elite + Green
    const totalGEG = buildCombined(buildCombined(d.gold, d.elite), d.green);

    const tb = document.getElementById('tableBody');
    tb.innerHTML = \`
      <tr class="group-label"><td colspan="15">Overview</td></tr>
      \${metricsRow('Total Sales', d.totalSales)}
      \${metricsRow('Total TNAP', totalTnap)}
      \${metricsRow('TNAP', d.tnap)}
      \${metricsRow('KAIN', d.kain)}
      <tr class="group-divider"><td colspan="15"></td></tr>
      <tr class="group-label"><td colspan="15">Loyalty Segments</td></tr>
      \${metricsRow('APAR', d.apar)}
      \${emptyRow('TOP 200')}
      \${emptyRow('Balance TNAP')}
      \${metricsRow('Gold', d.gold)}
      \${metricsRow('Elite', d.elite)}
      \${metricsRow('Green', d.green)}
      \${metricsRow('Total GEG', totalGEG)}
      \${metricsRow('PERKS', d.perks)}
      \${metricsRow('PAG-IBIG', d.pagibig)}
      <tr class="group-divider"><td colspan="15"></td></tr>
      <tr class="group-label"><td colspan="15">Uncarded</td></tr>
      \${emptyRow('UnCarded with Unusual')}
      \${emptyRow('UnUsual Transaction')}
      \${emptyRow('Total Uncarded')}
      \${emptyRow('Net of USUAL')}
    \`;
  }

  // Combine two metrics objects (add sales & trx, recompute basket)
  function buildCombined(a, b) {
    const sCur = a.sales.current + b.sales.current;
    const sYA  = a.sales.yearAgo + b.sales.yearAgo;
    const tCur = a.trx.current + b.trx.current;
    const tYA  = a.trx.yearAgo + b.trx.yearAgo;
    const bCur = tCur !== 0 ? sCur / tCur : 0;
    const bYA  = tYA !== 0 ? sYA / tYA : 0;
    const dp = (c, y) => y !== 0 ? ((c - y) / Math.abs(y)) * 100 : 0;
    return {
      sales:  { current: sCur, yearAgo: sYA, diffPct: dp(sCur, sYA), diffVal: sCur - sYA },
      trx:    { current: tCur, yearAgo: tYA, diffPct: dp(tCur, tYA), diffVal: tCur - tYA },
      basket: { current: bCur, yearAgo: bYA, diffPct: dp(bCur, bYA), diffVal: bCur - bYA }
    };
  }

  async function loadData() {
    const btn = document.getElementById('refreshBtn');
    const statusBar = document.getElementById('statusBar');
    btn.classList.add('loading');
    btn.textContent = '⏳ Loading...';
    statusBar.className = 'status-bar loading';
    statusBar.innerHTML = '<span class="spinner"></span> Fetching data from Google Sheets...';

    try {
      // Build query string from filters
      const month   = document.getElementById('monthFilter').value;
      const area    = document.getElementById('areaFilter').value;
      const storeId = document.getElementById('storeFilter').value;
      const params  = new URLSearchParams();
      if (month)   params.set('month', month);
      if (area)    params.set('area', area);
      if (storeId) params.set('storeId', storeId);

      const res = await fetch('/api/data?' + params.toString());
      const data = await res.json();

      if (!data.ok) throw new Error(data.error || 'Unknown error');

      buildTable(data);

      statusBar.className = 'status-bar';
      const f = data.filters || {};
      const filterTxt = [
        f.month   ? 'Month: ' + f.month     : null,
        f.area    ? 'Area: ' + f.area       : null,
        f.storeId ? 'Store: ' + f.storeId   : null
      ].filter(Boolean).join(' · ') || 'No filters';
      statusBar.innerHTML = \`✅ \${filterTxt} · \${data.rowCount} matched rows · Refreshed \${new Date().toLocaleTimeString('en-PH')}\`;
      document.getElementById('footerText').textContent =
        \`CAMANAVA Region · Data Source: Google Sheets · \${data.rowCount} rows matched\`;

    } catch (err) {
      statusBar.className = 'status-bar error';
      statusBar.innerHTML = '❌ Error: ' + err.message;
    } finally {
      btn.classList.remove('loading');
      btn.textContent = '↻ Refresh';
    }
  }

  // Load filter dropdowns from /api/filters
  async function loadFilters() {
    try {
      const res = await fetch('/api/filters');
      const f = await res.json();
      if (!f.ok) return;

      const monthSel = document.getElementById('monthFilter');
      f.months.forEach(m => monthSel.innerHTML += \`<option value="\${m}">\${m}</option>\`);

      const areaSel = document.getElementById('areaFilter');
      f.areas.forEach(a => areaSel.innerHTML += \`<option value="\${a}">\${a}</option>\`);

      allStores = f.stores;
      populateStoreDropdown();

      // Auto-apply filters on any change
      monthSel.addEventListener('change', loadData);
      areaSel.addEventListener('change', () => { populateStoreDropdown(); loadData(); });
      document.getElementById('storeFilter').addEventListener('change', loadData);
    } catch (e) {
      console.error('Filter load failed', e);
    }
  }

  function populateStoreDropdown() {
    const areaSel  = document.getElementById('areaFilter').value;
    const storeSel = document.getElementById('storeFilter');
    const prev     = storeSel.value;
    storeSel.innerHTML = '<option value="">All Stores</option>';
    const filtered = areaSel
      ? allStores.filter(s => s.area.toLowerCase() === areaSel.toLowerCase())
      : allStores;
    filtered.forEach(s => {
      storeSel.innerHTML += \`<option value="\${s.storeId}">\${s.storeId} · \${s.name}</option>\`;
    });
    storeSel.value = prev; // preserve selection if still valid
  }

  // Auto-load on page open
  (async () => {
    await loadFilters();
    loadData();
  })();
</script>
</body>
</html>`;

app.get('/', (req, res) => res.send(html));
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
