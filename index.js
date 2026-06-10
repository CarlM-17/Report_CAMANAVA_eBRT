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

// Fetch and parse public Google Sheet via CSV export
app.get('/api/data', async (req, res) => {
  try {
    const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&sheet=${encodeURIComponent(SHEET_NAME)}`;
    const response = await fetch(url);
    if (!response.ok) throw new Error('Sheet fetch failed: ' + response.status);
    const text = await response.text();
    const allRows = parseCSV(text);

    // First row is header, skip it
    const dataRows = allRows.slice(1);

    // Column index map (0-based):
    // A=0 MONTH, B=1 REGION, C=2 AREA, D=3 STORE ID, E=4 STORE NAME
    // F=5 SALES MTD, G=6 SALES MTD YA, H=7 SALES GROWTH MTD
    // I=8 SALES YTD, J=9 SALES YTD YA, K=10 SALES GROWTH YTD
    // L=11 SALES PER SQM
    // M=12 TRX COUNT MTD, N=13 BASKETSIZE MTD
    // O=14 TRX COUNT MTD YA, P=15 BASKETSIZE MTD YA

    const num = (val) => {
      if (!val || val.trim() === '') return 0;
      return parseFloat(val.replace(/,/g, '')) || 0;
    };

    let salesCurrent = 0, salesYA = 0;
    let trxCurrent = 0, trxYA = 0;
    let validRows = 0;

    dataRows.forEach(cols => {
      if (!cols[5] || cols[5].trim() === '') return; // skip empty rows
      salesCurrent  += num(cols[5]);   // F - SALES MTD
      salesYA       += num(cols[6]);   // G - SALES MTD YA
      trxCurrent    += num(cols[12]);  // M - TRX COUNT MTD
      trxYA         += num(cols[14]);  // O - TRX COUNT MTD YA
      validRows++;
    });

    // Basket Size = Total Sales / Total Transaction Count
    const bskCurrent = trxCurrent !== 0 ? salesCurrent / trxCurrent : 0;
    const bskYA      = trxYA !== 0 ? salesYA / trxYA : 0;

    const diffPct = (cur, ya) => ya !== 0 ? ((cur - ya) / Math.abs(ya)) * 100 : 0;
    const diffVal = (cur, ya) => cur - ya;

    res.json({
      ok: true,
      rowCount: validRows,
      headers: allRows[0],
      totalSales: {
        current:  salesCurrent,
        yearAgo:  salesYA,
        diffPct:  diffPct(salesCurrent, salesYA),
        diffVal:  diffVal(salesCurrent, salesYA)
      },
      totalTrx: {
        current:  trxCurrent,
        yearAgo:  trxYA,
        diffPct:  diffPct(trxCurrent, trxYA),
        diffVal:  diffVal(trxCurrent, trxYA)
      },
      basketSize: {
        current:  bskCurrent,
        yearAgo:  bskYA,
        diffPct:  diffPct(bskCurrent, bskYA),
        diffVal:  diffVal(bskCurrent, bskYA)
      }
    });

  } catch (err) {
    console.error('Fetch error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Debug endpoint: check raw column headers and first 2 data rows
app.get('/api/debug', async (req, res) => {
  try {
    const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&sheet=${encodeURIComponent(SHEET_NAME)}`;
    const response = await fetch(url);
    const text = await response.text();
    const allRows = parseCSV(text);
    const headers = allRows[0].map((h, i) => `[${i}] ${h}`);
    const sample = allRows.slice(1, 3).map(r => r.map((v, i) => `[${i}] ${v}`));
    res.json({ headers, sampleRows: sample, totalColumns: allRows[0].length, totalRows: allRows.length - 1 });
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
    <label>Date</label>
    <input type="date" id="reportDate"/>
    <label>Sub-Area</label>
    <select id="subAreaFilter">
      <option value="">All Sub-Areas</option>
      <option>North Caloocan</option>
      <option>South Caloocan</option>
      <option>Malabon & Navotas</option>
      <option>Valenzuela</option>
    </select>
    <button class="btn-refresh" id="refreshBtn" onclick="loadData()">↻ Refresh Data</button>
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
  document.getElementById('reportDate').value = today.toISOString().split('T')[0];

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

  function buildTable(d) {
    const tb = document.getElementById('tableBody');
    tb.innerHTML = \`
      <tr class="group-label"><td colspan="15">Overview</td></tr>
      \${dataRow('Total Sales',
        d.totalSales.current, d.totalSales.yearAgo, d.totalSales.diffPct, d.totalSales.diffVal,
        d.totalTrx.current, d.totalTrx.yearAgo, d.totalTrx.diffPct, d.totalTrx.diffVal,
        d.basketSize.current, d.basketSize.yearAgo, d.basketSize.diffPct, d.basketSize.diffVal
      )}
      \${emptyRow('Total TNAP')}
      \${emptyRow('TNAP')}
      \${emptyRow('KAIN')}
      <tr class="group-divider"><td colspan="15"></td></tr>
      <tr class="group-label"><td colspan="15">Loyalty Segments</td></tr>
      \${emptyRow('APAR')}
      \${emptyRow('TOP 200')}
      \${emptyRow('Balance TNAP')}
      \${emptyRow('Gold')}
      \${emptyRow('Elite')}
      \${emptyRow('Green')}
      \${emptyRow('Total GEG')}
      \${emptyRow('PERKS')}
      \${emptyRow('PAG-IBIG')}
      <tr class="group-divider"><td colspan="15"></td></tr>
      <tr class="group-label"><td colspan="15">Uncarded</td></tr>
      \${emptyRow('UnCarded with Unusual')}
      \${emptyRow('UnUsual Transaction')}
      \${emptyRow('Total Uncarded')}
      \${emptyRow('Net of USUAL')}
    \`;
  }

  async function loadData() {
    const btn = document.getElementById('refreshBtn');
    const statusBar = document.getElementById('statusBar');
    btn.classList.add('loading');
    btn.textContent = '⏳ Loading...';
    statusBar.className = 'status-bar loading';
    statusBar.innerHTML = '<span class="spinner"></span> Fetching data from Google Sheets...';

    try {
      const res = await fetch('/api/data');
      const data = await res.json();

      if (!data.ok) throw new Error(data.error || 'Unknown error');

      buildTable(data);

      statusBar.className = 'status-bar';
      statusBar.innerHTML = \`✅ Loaded \${data.rowCount} store rows · Last refreshed: \${new Date().toLocaleTimeString('en-PH')}\`;
      document.getElementById('footerText').textContent =
        \`CAMANAVA Region · Data Source: Google Sheets · \${data.rowCount} stores loaded\`;

    } catch (err) {
      statusBar.className = 'status-bar error';
      statusBar.innerHTML = '❌ Error: ' + err.message;
    } finally {
      btn.classList.remove('loading');
      btn.textContent = '↻ Refresh Data';
    }
  }

  // Auto-load on page open
  loadData();
</script>
</body>
</html>`;

app.get('/', (req, res) => res.send(html));
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
