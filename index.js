const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>CAMANAVA eBRT Report</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }

  body {
    font-family: 'Segoe UI', Arial, sans-serif;
    background: #f0f2f0;
    color: #222;
    min-height: 100vh;
  }

  /* TOP NAV */
  .top-nav {
    background: #1B5E20;
    color: white;
    padding: 12px 24px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    box-shadow: 0 2px 6px rgba(0,0,0,0.3);
  }
  .top-nav .brand {
    font-size: 18px;
    font-weight: 700;
    letter-spacing: 1px;
  }
  .top-nav .brand span {
    color: #A5D6A7;
    font-size: 12px;
    display: block;
    font-weight: 400;
    letter-spacing: 2px;
  }
  .top-nav .date-label {
    font-size: 12px;
    color: #A5D6A7;
  }

  /* TABS */
  .tabs {
    background: #2E7D32;
    display: flex;
    padding: 0 24px;
    gap: 4px;
  }
  .tab-btn {
    background: transparent;
    border: none;
    color: #C8E6C9;
    padding: 11px 22px;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
    border-bottom: 3px solid transparent;
    transition: all 0.2s;
    letter-spacing: 0.5px;
  }
  .tab-btn:hover { color: white; background: rgba(255,255,255,0.08); }
  .tab-btn.active {
    color: white;
    border-bottom: 3px solid #A5D6A7;
    background: rgba(255,255,255,0.1);
  }

  /* MAIN CONTENT */
  .content { padding: 20px 24px; }

  /* FILTER BAR */
  .filter-bar {
    background: white;
    border-radius: 8px;
    padding: 12px 18px;
    margin-bottom: 16px;
    display: flex;
    align-items: center;
    gap: 16px;
    flex-wrap: wrap;
    box-shadow: 0 1px 4px rgba(0,0,0,0.08);
  }
  .filter-bar label {
    font-size: 12px;
    font-weight: 600;
    color: #555;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }
  .filter-bar select, .filter-bar input {
    border: 1px solid #ccc;
    border-radius: 5px;
    padding: 6px 10px;
    font-size: 13px;
    color: #333;
    background: #fafafa;
  }
  .filter-bar select:focus, .filter-bar input:focus {
    outline: none;
    border-color: #2E7D32;
  }
  .btn-refresh {
    margin-left: auto;
    background: #1B5E20;
    color: white;
    border: none;
    border-radius: 5px;
    padding: 7px 18px;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
    transition: background 0.2s;
  }
  .btn-refresh:hover { background: #2E7D32; }

  /* STORE SELECTOR */
  .store-selector {
    background: white;
    border-radius: 8px;
    padding: 12px 18px;
    margin-bottom: 16px;
    box-shadow: 0 1px 4px rgba(0,0,0,0.08);
    display: flex;
    align-items: center;
    gap: 12px;
    flex-wrap: wrap;
  }
  .store-selector label {
    font-size: 12px;
    font-weight: 700;
    color: #1B5E20;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }
  .store-selector select {
    border: 1px solid #2E7D32;
    border-radius: 5px;
    padding: 6px 12px;
    font-size: 13px;
    font-weight: 600;
    color: #1B5E20;
    background: #f1f8f1;
    min-width: 200px;
  }
  .store-badge {
    background: #E8F5E9;
    color: #1B5E20;
    border-radius: 12px;
    padding: 3px 12px;
    font-size: 12px;
    font-weight: 600;
  }

  /* MAIN TABLE CARD */
  .table-card {
    background: white;
    border-radius: 8px;
    box-shadow: 0 1px 4px rgba(0,0,0,0.08);
    overflow: hidden;
  }

  .table-wrapper { overflow-x: auto; }

  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 13px;
  }

  /* SECTION HEADER (dark green full row) */
  .section-header td {
    background: #1B5E20;
    color: white;
    font-weight: 700;
    font-size: 12px;
    letter-spacing: 1px;
    text-align: center;
    padding: 8px 10px;
    text-transform: uppercase;
  }

  /* COLUMN HEADER ROW */
  .col-header td {
    background: #f5f5f5;
    color: #444;
    font-weight: 700;
    font-size: 11px;
    text-align: center;
    padding: 7px 10px;
    border-bottom: 2px solid #ddd;
    text-transform: uppercase;
    letter-spacing: 0.3px;
  }
  .col-header td.metrics-col {
    text-align: left;
    color: #1B5E20;
  }

  /* DATA ROWS */
  tbody tr td {
    padding: 7px 10px;
    border-bottom: 1px solid #f0f0f0;
    vertical-align: middle;
  }
  tbody tr td.metrics-col {
    font-weight: 600;
    color: #333;
    text-align: left;
    white-space: nowrap;
    min-width: 160px;
  }
  tbody tr td.data-col {
    text-align: right;
    color: #555;
    font-variant-numeric: tabular-nums;
  }
  tbody tr td.diff-pos { color: #2E7D32; font-weight: 600; }
  tbody tr td.diff-neg { color: #C62828; font-weight: 600; }

  /* Row grouping */
  tbody tr:hover td { background: #f9fcf9; }
  .group-divider td { height: 10px; background: #f8f8f8; }
  .group-label td {
    font-size: 10px;
    font-weight: 700;
    color: #888;
    letter-spacing: 1px;
    text-transform: uppercase;
    padding: 10px 10px 4px;
    background: #fafafa;
    border-bottom: none;
  }

  /* SOB section narrower */
  .sob-section { min-width: 120px; }

  /* placeholder text in empty cells */
  .empty-cell { color: #ccc; font-size: 11px; text-align: center; }

  /* FOOTER */
  .footer {
    text-align: center;
    padding: 16px;
    font-size: 11px;
    color: #aaa;
  }
</style>
</head>
<body>

<!-- TOP NAV -->
<div class="top-nav">
  <div class="brand">
    CAMANAVA eBRT
    <span>ELECTRONIC BUSINESS REVIEW TOOL</span>
  </div>
  <div class="date-label" id="currentDate"></div>
</div>

<!-- TABS -->
<div class="tabs">
  <button class="tab-btn active" onclick="switchTab(this, 'daily')">Daily Sales</button>
  <button class="tab-btn" onclick="switchTab(this, 'monthly')">Monthly Sales</button>
  <button class="tab-btn" onclick="switchTab(this, 'category')">Category Sales</button>
</div>

<!-- DAILY TAB -->
<div id="tab-daily" class="content">

  <!-- Filter Bar -->
  <div class="filter-bar">
    <label>Date</label>
    <input type="date" id="reportDate"/>
    <label>Sub-Area</label>
    <select>
      <option value="">All Sub-Areas</option>
      <option>North Caloocan</option>
      <option>South Caloocan</option>
      <option>Malabon & Navotas</option>
      <option>Valenzuela</option>
    </select>
    <button class="btn-refresh">↻ Refresh Data</button>
  </div>

  <!-- Store Selector -->
  <div class="store-selector">
    <label>Store</label>
    <select>
      <option value="">-- Select Store --</option>
      <option>Store 1 - North Caloocan</option>
      <option>Store 2 - South Caloocan</option>
      <option>Store 3 - Malabon</option>
    </select>
    <span class="store-badge">30 Stores</span>
  </div>

  <!-- Main Table -->
  <div class="table-card">
    <div class="table-wrapper">
      <table>
        <!-- SECTION HEADERS -->
        <thead>
          <tr class="section-header">
            <td rowspan="2" style="text-align:left; width:160px;">Metrics</td>
            <td colspan="4">SALES</td>
            <td colspan="4">TRANSACTION COUNT</td>
            <td colspan="4">BASKET SIZE</td>
            <td colspan="2">SOB</td>
          </tr>
          <tr class="col-header">
            <!-- SALES -->
            <td>Current</td><td>Year Ago</td><td>Diff %</td><td>Diff Val</td>
            <!-- TXN COUNT -->
            <td>Current</td><td>Year Ago</td><td>Diff %</td><td>Diff Val</td>
            <!-- BASKET SIZE -->
            <td>Current</td><td>Year Ago</td><td>Diff %</td><td>Diff Val</td>
            <!-- SOB -->
            <td>Current</td><td>Year Ago</td>
          </tr>
        </thead>

        <tbody>
          <!-- GROUP: TOTAL -->
          <tr class="group-label"><td colspan="15">Overview</td></tr>
          ${buildRow('Total Sales')}
          ${buildRow('Total TNAP')}
          ${buildRow('TNAP')}
          ${buildRow('KAIN')}

          <tr class="group-divider"><td colspan="15"></td></tr>

          <!-- GROUP: LOYALTY -->
          <tr class="group-label"><td colspan="15">Loyalty Segments</td></tr>
          ${buildRow('APAR')}
          ${buildRow('TOP 200')}
          ${buildRow('Balance TNAP')}
          ${buildRow('Gold')}
          ${buildRow('Elite')}
          ${buildRow('Green')}
          ${buildRow('Total GEG')}
          ${buildRow('PERKS')}
          ${buildRow('PAG-IBIG')}

          <tr class="group-divider"><td colspan="15"></td></tr>

          <!-- GROUP: UNCARDED -->
          <tr class="group-label"><td colspan="15">Uncarded</td></tr>
          ${buildRow('UnCarded with Unusual')}
          ${buildRow('UnUsual Transaction')}
          ${buildRow('Total Uncarded')}
          ${buildRow('Net of USUAL')}
        </tbody>
      </table>
    </div>
  </div>

  <div class="footer">CAMANAVA Region · Data Source: Google Sheets · No data loaded yet</div>
</div>

<!-- MONTHLY TAB (placeholder) -->
<div id="tab-monthly" class="content" style="display:none;">
  <div style="text-align:center; padding: 60px; color: #aaa; font-size:14px;">
    Monthly Sales tab — coming soon
  </div>
</div>

<!-- CATEGORY TAB (placeholder) -->
<div id="tab-category" class="content" style="display:none;">
  <div style="text-align:center; padding: 60px; color: #aaa; font-size:14px;">
    Category Sales tab — coming soon
  </div>
</div>

<script>
  // Set today's date
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
</script>

</body>
</html>`;

function buildRow(label) {
  const emptyCols = Array(12).fill('<td class="data-col empty-cell">—</td>').join('');
  const sobCols = Array(2).fill('<td class="data-col empty-cell">—</td>').join('');
  return `<tr><td class="metrics-col">${label}</td>${emptyCols}${sobCols}</tr>`;
}

app.get('/', (req, res) => res.send(html));
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
