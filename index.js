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
    const [salesRows, shopperRows, storeRows, aparRows, gegRows, top200Rows, unusualCurRows, unusualYARows] = await Promise.all([
      fetchSheet(SHEET_NAME),
      fetchSheet('ShopperMetricsData'),
      fetchSheet('ListOfStores'),
      fetchSheet('APAR'),
      fetchSheet('GEG'),
      fetchSheet('Top200'),
      fetchSheet('UnusualCurrent'),
      fetchSheet('UnusualYearAgo')
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

    // ===== Top200 sheet =====
    // Has TWO sections: Sales (top), TRX (bottom), with identical column structure.
    // Find the TRX section by locating the SECOND header row (col C = "STOREID").
    // Column layout (same for both sections):
    //   C=2 StoreID, G-R = 6-17: Jan_YA...Dec_YA, W-AH = 22-33: Jan_Current...Dec_Current
    const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    const YA_COL_START  = 6;
    const CUR_COL_START = 22;

    // Find header row indices (where col C looks like a header: "STOREID", "STORE ID", etc.)
    const headerIndices = [];
    top200Rows.forEach((r, i) => {
      const c = (r && r[2] || '').toString().trim().toUpperCase().replace(/[\s_]/g, '');
      const a = (r && r[0] || '').toString().trim().toUpperCase();
      if (c === 'STOREID' || a === 'REGION') headerIndices.push(i);
    });

    // Sales section: from index 1 to just before TRX header (or end if no second header)
    const salesStart = 1;
    const salesEnd   = headerIndices.length >= 2 ? headerIndices[1] - 1 : top200Rows.length - 1;
    // TRX section: from row after second header to end
    const trxStart   = headerIndices.length >= 2 ? headerIndices[1] + 1 : -1;
    const trxEnd     = top200Rows.length - 1;

    function sumTop200Section(rows, startIdx, endIdx) {
      let cur = 0, ya = 0, rowCount = 0;
      if (startIdx < 0) return { cur, ya, rowCount };
      for (let i = startIdx; i <= endIdx && i < rows.length; i++) {
        const r = rows[i];
        if (!r || !r[2]) continue;
        const rowStoreId = (r[2] || '').trim();
        // Skip rows where Store ID isn't a number (header rows, blank rows)
        if (isNaN(parseFloat(rowStoreId))) continue;
        if (!matchStoreId(rowStoreId)) continue;
        if (!matchArea(rowStoreId)) continue;

        let monthIndices;
        if (month) {
          const mIdx = MONTHS.findIndex(m => m.toLowerCase() === month.toLowerCase());
          if (mIdx < 0) continue;
          monthIndices = [mIdx];
        } else {
          monthIndices = [];
          for (let m = 0; m < 12; m++) {
            if (num(r[CUR_COL_START + m]) > 0) monthIndices.push(m);
          }
        }

        monthIndices.forEach(m => {
          cur += num(r[CUR_COL_START + m]);
          ya  += num(r[YA_COL_START + m]);
        });
        rowCount++;
      }
      return { cur, ya, rowCount };
    }

    const top200Sales = sumTop200Section(top200Rows, salesStart, salesEnd);
    const top200Trx   = sumTop200Section(top200Rows, trxStart, trxEnd);

    const top200Metrics = buildMetrics(top200Sales.cur, top200Sales.ya, top200Trx.cur, top200Trx.ya);

    // ===== Unusual Transactions (Current + Year Ago) =====
    // Both sheets: A=0 Area, B=1 Store ID, C=2 Store Name, D=3 Month, E=4 Day,
    //              F=5 Customer Name, G=6 Amount, H=7 Type, I=8 Carded, J=9 Desc, K=10 Remarks
    function sumUnusual(rows) {
      let total = 0;
      const data = rows.slice(1); // skip header
      data.forEach(cols => {
        if (!cols || cols.length < 7) return;
        const rowArea    = (cols[0] || '').trim();
        const rowStoreId = (cols[1] || '').trim();
        const rowMonth   = cols[3];
        if (area    && rowArea.toLowerCase()    !== area.toLowerCase())    return;
        if (storeId && rowStoreId               !== storeId.trim())         return;
        if (month   && (rowMonth || '').trim().toLowerCase() !== month.toLowerCase()) return;
        total += num(cols[6]); // G - Amount
      });
      return total;
    }

    const unusualCurrent = sumUnusual(unusualCurRows);
    const unusualYearAgo = sumUnusual(unusualYARows);

    const unusualMetrics = {
      sales: {
        current: unusualCurrent,
        yearAgo: unusualYearAgo,
        diffPct: diffPct(unusualCurrent, unusualYearAgo),
        diffVal: diffVal(unusualCurrent, unusualYearAgo)
      },
      // No transaction count / basket size for unusual
      trx:    null,
      basket: null
    };

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
      green: greenMetrics,
      top200: top200Metrics,
      unusual: unusualMetrics,
      _top200Debug: {
        totalSheetRows: top200Rows.length,
        headerIndices,
        salesRange: [salesStart, salesEnd],
        trxRange: [trxStart, trxEnd],
        salesRowsCounted: top200Sales.rowCount,
        trxRowsCounted: top200Trx.rowCount
      }
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
  body {
    font-family: 'Inter', 'Segoe UI', system-ui, sans-serif;
    background: #f4f6f4;
    color: #1a2e1f;
    min-height: 100vh;
    -webkit-font-smoothing: antialiased;
  }

  /* TOP NAV */
  .top-nav {
    background: linear-gradient(135deg, #1B5E20 0%, #2E7D32 100%);
    color: white; padding: 14px 28px;
    display: flex; align-items: center; justify-content: space-between;
    box-shadow: 0 1px 0 rgba(0,0,0,0.05);
  }
  .top-nav .brand { font-size: 17px; font-weight: 700; letter-spacing: 0.5px; line-height: 1.2; }
  .top-nav .brand span {
    color: #FFD54F; font-size: 10px; display: block; font-weight: 500;
    letter-spacing: 2px; margin-top: 2px;
  }
  .top-nav .date-label {
    font-size: 12px; color: #C8E6C9; font-weight: 500;
    background: rgba(255,255,255,0.08); padding: 5px 12px; border-radius: 6px;
  }

  /* TABS */
  .tabs {
    background: white; display: flex; padding: 0 28px; gap: 0;
    border-bottom: 1px solid #e5e8e5;
  }
  .tab-btn {
    background: transparent; border: none; color: #5a6b5e;
    padding: 13px 20px; font-size: 13px; font-weight: 600; cursor: pointer;
    border-bottom: 3px solid transparent; transition: all 0.15s;
    letter-spacing: 0.3px;
  }
  .tab-btn:hover { color: #1B5E20; }
  .tab-btn.active {
    color: #1B5E20;
    border-bottom-color: #FFC107;
  }

  /* CONTENT */
  .content { padding: 18px 28px; }

  /* FILTER BAR */
  .filter-bar {
    background: white; border-radius: 10px; padding: 12px 16px; margin-bottom: 14px;
    display: flex; align-items: center; gap: 14px; flex-wrap: wrap;
    border: 1px solid #e8ebe8;
  }
  .filter-bar label {
    font-size: 10px; font-weight: 700; color: #1B5E20;
    text-transform: uppercase; letter-spacing: 0.8px;
  }
  .filter-bar select, .filter-bar input {
    border: 1px solid #d4dad4; border-radius: 6px; padding: 6px 10px;
    font-size: 12px; color: #1a2e1f; background: white;
    transition: border-color 0.15s; font-weight: 500;
  }
  .filter-bar select:hover, .filter-bar input:hover { border-color: #2E7D32; }
  .filter-bar select:focus, .filter-bar input:focus {
    outline: none; border-color: #1B5E20;
    box-shadow: 0 0 0 3px rgba(27,94,32,0.12);
  }
  .btn-refresh {
    margin-left: auto;
    background: #1B5E20; color: white; border: none;
    border-radius: 6px; padding: 7px 16px; font-size: 12px; font-weight: 600;
    cursor: pointer; transition: all 0.15s; display: flex; align-items: center; gap: 6px;
    letter-spacing: 0.3px;
  }
  .btn-refresh:hover { background: #2E7D32; transform: translateY(-1px); }
  .btn-refresh.loading { opacity: 0.6; cursor: not-allowed; transform: none; }

  /* STATUS BAR */
  .status-bar {
    background: #F1F8E9; border-left: 3px solid #689F38; border-radius: 6px;
    padding: 8px 14px; margin-bottom: 14px; font-size: 11.5px; color: #33691E;
    display: flex; align-items: center; gap: 8px; font-weight: 500;
  }
  .status-bar.error { background: #FFEBEE; border-left-color: #C62828; color: #C62828; }
  .status-bar.loading { background: #FFF8E1; border-left-color: #F57F17; color: #E65100; }

  /* TABLE CARD */
  .table-card {
    background: white; border-radius: 10px; overflow: hidden;
    border: 1px solid #e8ebe8;
  }
  .table-wrapper { overflow-x: auto; }

  table {
    width: 100%; border-collapse: collapse; font-size: 11.5px;
    table-layout: fixed;
  }

  /* SECTION HEADER */
  .section-header td {
    background: #1B5E20; color: white;
    font-weight: 700; font-size: 11px;
    letter-spacing: 0.8px; text-align: center;
    padding: 9px 4px; text-transform: uppercase;
    position: relative;
  }

  /* COLUMN HEADER */
  .col-header td {
    background: #FAF8F0; color: #4a5550; font-weight: 700; font-size: 10px;
    text-align: center; padding: 6px 4px;
    border-bottom: 2px solid #FFC107;
    text-transform: uppercase; letter-spacing: 0.4px;
  }
  .col-header td.metrics-col {
    text-align: left; color: #1B5E20; padding-left: 12px;
  }

  /* DATA ROWS */
  tbody tr td {
    padding: 7px 5px; border-bottom: 1px solid #f0f2ef;
    vertical-align: middle;
  }
  tbody tr td.metrics-col {
    font-weight: 600; color: #1a2e1f; text-align: left;
    white-space: nowrap; padding-left: 12px; font-size: 11.5px;
  }
  tbody tr td.data-col {
    text-align: right; color: #3d4a40;
    font-variant-numeric: tabular-nums; padding-right: 10px;
    font-weight: 500;
  }
  tbody tr td.diff-pos { color: #2E7D32; font-weight: 700; }
  tbody tr td.diff-neg { color: #C62828; font-weight: 700; }

  tbody tr:hover td { background: #FFF176; transition: background 0.15s; }

  /* TOTAL SALES HIGHLIGHTED ROW */
  tbody tr.highlight-row td {
    background: linear-gradient(90deg, #FFF8E1 0%, #FFF9C4 100%);
    font-weight: 700;
    border-bottom: 2px solid #FFC107;
    border-top: 2px solid #FFC107;
  }
  tbody tr.highlight-row td.metrics-col {
    color: #1B5E20;
    font-size: 12.5px;
    font-weight: 800;
  }
  tbody tr.highlight-row td.data-col {
    color: #1a2e1f;
    font-weight: 700;
    font-size: 12px;
  }
  tbody tr.highlight-row:hover td {
    background: linear-gradient(90deg, #FFF59D 0%, #FFEE58 100%);
  }

  /* GROUPS */
  .group-divider td { height: 8px; background: #f4f6f4; border: none; }
  .group-label td {
    font-size: 10px; font-weight: 700; color: #1B5E20;
    letter-spacing: 1.2px; text-transform: uppercase;
    padding: 12px 12px 5px; background: white; border-bottom: none;
  }
  .empty-cell { color: #c5cdc5; font-size: 11px; text-align: center !important; font-weight: 400; }

  /* SECTION SEPARATOR LINES - prominent green dividers */
  table td:nth-child(2), table th:nth-child(2),
  table td:nth-child(6), table th:nth-child(6),
  table td:nth-child(10), table th:nth-child(10),
  table td:nth-child(14), table th:nth-child(14) {
    border-left: 3px double #1B5E20;
  }
  .section-header .sec-div { border-left: 3px solid #FFC107 !important; }
  .col-header .sec-div { border-left: 3px double #1B5E20 !important; }

  /* SPINNER */
  .spinner {
    display: inline-block; width: 12px; height: 12px;
    border: 2px solid #C8E6C9; border-top-color: #1B5E20;
    border-radius: 50%; animation: spin 0.7s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }

  /* FOOTER */
  .footer {
    text-align: center; padding: 18px 0 8px;
    font-size: 10.5px; color: #94a094; letter-spacing: 0.4px;
  }

  /* ============ MOBILE RESPONSIVE ============ */

  /* Tablet & smaller */
  @media (max-width: 900px) {
    .top-nav { padding: 12px 16px; }
    .top-nav .brand { font-size: 15px; }
    .top-nav .brand span { font-size: 9px; letter-spacing: 1.5px; }
    .top-nav .date-label { font-size: 11px; padding: 4px 10px; }
    .tabs { padding: 0 12px; overflow-x: auto; -webkit-overflow-scrolling: touch; }
    .tab-btn { padding: 11px 14px; font-size: 12px; white-space: nowrap; }
    .content { padding: 12px 14px; }
    .filter-bar { padding: 10px 12px; gap: 10px; }

    /* Give table proper width on mobile - let it scroll instead of squish */
    table {
      font-size: 11px;
      min-width: 1200px;
      table-layout: auto;
    }
    tbody tr td.metrics-col { min-width: 130px; width: 130px; }
    tbody tr td.data-col { min-width: 75px; padding: 6px 8px; }

    /* Sticky first column for table */
    .metrics-col {
      position: sticky; left: 0; z-index: 2;
      background: white !important;
      border-right: 2px solid #1B5E20;
      box-shadow: 2px 0 4px -2px rgba(0,0,0,0.1);
    }
    tbody tr:hover td.metrics-col { background: #FFF176 !important; }
    tbody tr.highlight-row td.metrics-col {
      background: #FFF59D !important;
    }
    .section-header td:first-child, .col-header td.metrics-col {
      position: sticky; left: 0; z-index: 3;
    }
    .section-header td:first-child { background: #1B5E20 !important; }
    .col-header td.metrics-col { background: #FAF8F0 !important; }
  }

  /* Phone */
  @media (max-width: 600px) {
    .top-nav {
      flex-direction: column;
      align-items: flex-start;
      gap: 8px;
      padding: 10px 14px;
    }
    .top-nav .date-label { font-size: 10px; align-self: stretch; text-align: center; }

    .tabs { padding: 0 8px; }
    .tab-btn { padding: 10px 12px; font-size: 11.5px; letter-spacing: 0.2px; }

    .content { padding: 10px; }

    /* Stack filter bar */
    .filter-bar {
      flex-direction: column;
      align-items: stretch;
      gap: 8px;
      padding: 10px;
    }
    .filter-bar > * { width: 100%; }
    .filter-bar label { width: auto; padding-top: 4px; }
    .filter-bar select, .filter-bar input {
      width: 100%; padding: 9px 12px; font-size: 14px; min-height: 38px;
    }
    .btn-refresh {
      margin-left: 0; width: 100%; justify-content: center;
      padding: 10px; font-size: 13px; min-height: 40px;
    }

    /* Compact status bar */
    .status-bar { font-size: 10.5px; padding: 7px 10px; line-height: 1.5; }

    /* Mobile table - keep numbers from overlapping by ensuring min width */
    table {
      font-size: 11px;
      min-width: 1150px;
    }
    tbody tr td.metrics-col { min-width: 120px; width: 120px; padding-left: 10px; }
    tbody tr td.data-col { min-width: 70px; padding: 7px 8px; }
    .section-header td { font-size: 10px; padding: 7px 4px; }
    .col-header td { font-size: 9.5px; padding: 6px 4px; }
    .group-label td { font-size: 9.5px; padding: 9px 10px 4px; }

    .footer { font-size: 9.5px; padding: 14px 0 4px; }
  }

  /* Smooth horizontal scroll on touch */
  .table-wrapper {
    -webkit-overflow-scrolling: touch;
    scrollbar-width: thin;
  }
  .table-wrapper::-webkit-scrollbar { height: 6px; }
  .table-wrapper::-webkit-scrollbar-thumb { background: #C8E6C9; border-radius: 3px; }
  .table-wrapper::-webkit-scrollbar-track { background: #f4f6f4; }
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
        <colgroup>
          <col style="width:11%"/>
          <col/><col/><col style="width:5.5%"/><col/>
          <col/><col/><col style="width:5.5%"/><col/>
          <col/><col/><col style="width:5.5%"/><col/>
          <col/><col/>
        </colgroup>
        <thead>
          <tr class="section-header">
            <td rowspan="2" style="text-align:left;">Metrics</td>
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

  // SOB format - plain percentage, no sign prefix
  function fmtSob(n) {
    if (n === null || n === undefined || isNaN(n)) return '—';
    return n.toFixed(2) + '%';
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
    const sobCells = Array(2).fill('<td class="data-col empty-cell">—</td>').join('');
    return \`<tr><td class="metrics-col">\${label}</td>\${empties}\${sobCells}</tr>\`;
  }

  function dataRow(label, salesCur, salesYA, salesDiffPct, salesDiffVal,
                   trxCur, trxYA, trxDiffPct, trxDiffVal,
                   bskCur, bskYA, bskDiffPct, bskDiffVal,
                   sobCur, sobYA, rowClass) {
    const sDiffPctClass = salesDiffPct >= 0 ? 'diff-pos' : 'diff-neg';
    const sDiffValClass = salesDiffVal >= 0 ? 'diff-pos' : 'diff-neg';
    const tDiffPctClass = trxDiffPct >= 0 ? 'diff-pos' : 'diff-neg';
    const tDiffValClass = trxDiffVal >= 0 ? 'diff-pos' : 'diff-neg';
    const bDiffPctClass = bskDiffPct >= 0 ? 'diff-pos' : 'diff-neg';
    const bDiffValClass = bskDiffVal >= 0 ? 'diff-pos' : 'diff-neg';

    return \`<tr class="\${rowClass || ''}">
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
      <td class="data-col">\${sobCur === null || sobCur === undefined ? '<span class="empty-cell">—</span>' : fmtSob(sobCur)}</td>
      <td class="data-col">\${sobYA  === null || sobYA  === undefined ? '<span class="empty-cell">—</span>' : fmtSob(sobYA)}</td>
    </tr>\`;
  }

  // Helper: build a row from a metrics object { sales:{...}, trx:{...}, basket:{...} }
  function metricsRow(label, m, sobCur, sobYA, rowClass) {
    return dataRow(label,
      m.sales.current, m.sales.yearAgo, m.sales.diffPct, m.sales.diffVal,
      m.trx.current, m.trx.yearAgo, m.trx.diffPct, m.trx.diffVal,
      m.basket.current, m.basket.yearAgo, m.basket.diffPct, m.basket.diffVal,
      sobCur, sobYA, rowClass
    );
  }

  // Sales-only row: sales values shown, TRX and Basket cells show dashes
  function salesOnlyRow(label, salesMetrics, sobCur, sobYA, rowClass) {
    const s = salesMetrics.sales || salesMetrics;
    const sDiffPctClass = s.diffPct >= 0 ? 'diff-pos' : 'diff-neg';
    const sDiffValClass = s.diffVal >= 0 ? 'diff-pos' : 'diff-neg';
    const blank = '<td class="data-col empty-cell">—</td>';
    return \`<tr class="\${rowClass || ''}">
      <td class="metrics-col">\${label}</td>
      <td class="data-col">\${fmt(s.current)}</td>
      <td class="data-col">\${fmt(s.yearAgo)}</td>
      <td class="data-col \${sDiffPctClass}">\${fmtPct(s.diffPct)}</td>
      <td class="data-col \${sDiffValClass}">\${fmtDiffVal(s.diffVal)}</td>
      \${blank}\${blank}\${blank}\${blank}
      \${blank}\${blank}\${blank}\${blank}
      <td class="data-col">\${sobCur === null || sobCur === undefined ? '<span class="empty-cell">—</span>' : fmtSob(sobCur)}</td>
      <td class="data-col">\${sobYA  === null || sobYA  === undefined ? '<span class="empty-cell">—</span>' : fmtSob(sobYA)}</td>
    </tr>\`;
  }

  // Compute SOB as percentage: (numerator / denominator) * 100
  function sob(numerator, denominator) {
    if (!denominator || denominator === 0) return null;
    return (numerator / denominator) * 100;
  }

  function buildTable(d) {
    // Total TNAP = TNAP + KAIN combined
    const totalTnap = buildCombined(d.tnap, d.kain);
    // Total GEG = Gold + Elite + Green
    const totalGEG = buildCombined(buildCombined(d.gold, d.elite), d.green);
    // Balance TNAP = Total TNAP - APAR - TOP 200
    const balanceTnap = buildSubtract(buildSubtract(totalTnap, d.apar), d.top200);

    // SOB denominators
    const totalSalesCur     = d.totalSales.sales.current;
    const totalSalesYA      = d.totalSales.sales.yearAgo;
    const totalTnapSalesCur = totalTnap.sales.current;
    const totalTnapSalesYA  = totalTnap.sales.yearAgo;
    const tnapSalesCur      = d.tnap.sales.current;
    const tnapSalesYA       = d.tnap.sales.yearAgo;

    const tb = document.getElementById('tableBody');
    tb.innerHTML = \`
      <tr class="group-label"><td colspan="15">Overview</td></tr>
      \${metricsRow('Total Sales', d.totalSales, null, null, 'highlight-row')}
      \${metricsRow('Total TNAP', totalTnap,
        sob(totalTnap.sales.current, totalSalesCur),
        sob(totalTnap.sales.yearAgo, totalSalesYA))}
      \${metricsRow('TNAP', d.tnap,
        sob(d.tnap.sales.current, totalSalesCur),
        sob(d.tnap.sales.yearAgo, totalSalesYA))}
      \${metricsRow('KAIN', d.kain,
        sob(d.kain.sales.current, totalSalesCur),
        sob(d.kain.sales.yearAgo, totalSalesYA))}
      <tr class="group-divider"><td colspan="15"></td></tr>
      <tr class="group-label"><td colspan="15">Loyalty Segments</td></tr>
      \${metricsRow('APAR', d.apar,
        sob(d.apar.sales.current, totalTnapSalesCur),
        sob(d.apar.sales.yearAgo, totalTnapSalesYA))}
      \${metricsRow('TOP 200', d.top200,
        sob(d.top200.sales.current, tnapSalesCur),
        sob(d.top200.sales.yearAgo, tnapSalesYA))}
      \${metricsRow('Balance TNAP', balanceTnap,
        sob(balanceTnap.sales.current, totalTnapSalesCur),
        sob(balanceTnap.sales.yearAgo, totalTnapSalesYA))}
      \${metricsRow('Gold', d.gold,
        sob(d.gold.sales.current, totalTnapSalesCur),
        sob(d.gold.sales.yearAgo, totalTnapSalesYA))}
      \${metricsRow('Elite', d.elite,
        sob(d.elite.sales.current, totalTnapSalesCur),
        sob(d.elite.sales.yearAgo, totalTnapSalesYA))}
      \${metricsRow('Green', d.green,
        sob(d.green.sales.current, totalTnapSalesCur),
        sob(d.green.sales.yearAgo, totalTnapSalesYA))}
      \${metricsRow('Total GEG', totalGEG)}
      \${metricsRow('PERKS', d.perks,
        sob(d.perks.sales.current, totalSalesCur),
        sob(d.perks.sales.yearAgo, totalSalesYA))}
      \${metricsRow('PAG-IBIG', d.pagibig,
        sob(d.pagibig.sales.current, totalSalesCur),
        sob(d.pagibig.sales.yearAgo, totalSalesYA))}
      <tr class="group-divider"><td colspan="15"></td></tr>
      <tr class="group-label"><td colspan="15">Uncarded</td></tr>
      \${(() => {
        // Uncarded with Unusual = Total Sales - Total TNAP - PERKS - PAG-IBIG
        const uncardedWithUnusual = buildSubtract(buildSubtract(buildSubtract(d.totalSales, totalTnap), d.perks), d.pagibig);
        // Total Uncarded = Uncarded with Unusual - Unusual (Sales subtract; TRX unchanged since Unusual has none)
        const totalUncarded = buildSubtract(uncardedWithUnusual, d.unusual);
        // Net of Unusual = Total Sales - Unusual (sales only)
        const netOfUnusualSalesCur = d.totalSales.sales.current - d.unusual.sales.current;
        const netOfUnusualSalesYA  = d.totalSales.sales.yearAgo - d.unusual.sales.yearAgo;
        const netOfUnusual = {
          sales: {
            current: netOfUnusualSalesCur,
            yearAgo: netOfUnusualSalesYA,
            diffPct: netOfUnusualSalesYA !== 0 ? ((netOfUnusualSalesCur - netOfUnusualSalesYA) / Math.abs(netOfUnusualSalesYA)) * 100 : 0,
            diffVal: netOfUnusualSalesCur - netOfUnusualSalesYA
          },
          trx: null, basket: null
        };
        return \`
          \${metricsRow('UnCarded with Unusual', uncardedWithUnusual)}
          \${salesOnlyRow('UnUsual Transaction', d.unusual,
            sob(d.unusual.sales.current, totalSalesCur),
            sob(d.unusual.sales.yearAgo, totalSalesYA))}
          \${metricsRow('Total Uncarded', totalUncarded)}
          \${salesOnlyRow('Net of Unusual', netOfUnusual)}
        \`;
      })()}
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

  // Subtract b from a (a - b), recompute basket
  // Subtract b from a. If b has null trx (e.g. Unusual), treat as zero.
  function buildSubtract(a, b) {
    const bSalesCur = b.sales ? b.sales.current : 0;
    const bSalesYA  = b.sales ? b.sales.yearAgo : 0;
    const bTrxCur   = b.trx   ? b.trx.current   : 0;
    const bTrxYA    = b.trx   ? b.trx.yearAgo   : 0;

    const sCur = a.sales.current - bSalesCur;
    const sYA  = a.sales.yearAgo - bSalesYA;
    const tCur = a.trx.current - bTrxCur;
    const tYA  = a.trx.yearAgo - bTrxYA;
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
      const td = data._top200Debug || {};
      statusBar.innerHTML = \`✅ \${filterTxt} · \${data.rowCount} matched rows · TOP200 [Sales rows:\${td.salesRowsCounted} TRX rows:\${td.trxRowsCounted} · headers at idx:\${(td.headerIndices||[]).join(',')} · totalSheetRows:\${td.totalSheetRows}] · Refreshed \${new Date().toLocaleTimeString('en-PH')}\`;
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
