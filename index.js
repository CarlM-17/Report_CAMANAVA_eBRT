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
    const storeNameMap = {};
    storeRows.slice(1).forEach(r => {
      const sid = (r[3] || '').trim();
      const ar  = (r[2] || '').trim();
      const nm  = (r[4] || '').trim();
      if (sid) { storeAreaMap[sid] = ar; storeNameMap[sid] = nm; }
    });

    // Pre-detect Top200 sections (global, doesn't depend on storeId)
    const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    const YA_COL_START  = 6;
    const CUR_COL_START = 22;
    const headerIndices = [];
    top200Rows.forEach((r, i) => {
      const c = (r && r[2] || '').toString().trim().toUpperCase().replace(/[\s_]/g, '');
      const a = (r && r[0] || '').toString().trim().toUpperCase();
      if (c === 'STOREID' || a === 'REGION') headerIndices.push(i);
    });
    const t200SalesStart = 1;
    const t200SalesEnd   = headerIndices.length >= 2 ? headerIndices[1] - 1 : top200Rows.length - 1;
    const t200TrxStart   = headerIndices.length >= 2 ? headerIndices[1] + 1 : -1;
    const t200TrxEnd     = top200Rows.length - 1;

    // Pre-detect ShopperMetrics column indices
    const normalize = s => (s || '').trim().toUpperCase().replace(/[\s._-]/g, '');
    const shopperHeadersNorm = shopperRows[0].map(normalize);
    const sColIdx = (name) => shopperHeadersNorm.indexOf(normalize(name));
    const SHOP_TYPE_COL     = sColIdx('TYPE');
    const SHOP_MONTH_COL    = sColIdx('Month');
    const SHOP_STOREID_COL  = sColIdx('STOREID');
    const SHOP_SALES_COL    = sColIdx('Sales');
    const SHOP_SALESLY_COL  = sColIdx('SalesLY');
    const SHOP_TRX_COL      = sColIdx('TRXCount');
    const SHOP_TRXLY_COL    = sColIdx('TRXCountLY');

    // ----- Reusable metric computation per store (or aggregate when storeIdFilter is null/empty) -----
    function computeMetrics(storeIdFilter) {
      const mArea    = (sid) => !area || (storeAreaMap[sid] || '').toLowerCase() === area.toLowerCase();
      const mMonth   = (m) => !month || (m || '').trim().toLowerCase() === month.toLowerCase();
      const mStoreId = (sid) => !storeIdFilter || (sid || '').trim() === storeIdFilter.trim();

      // SalesData -> Total Sales
      let sC = 0, sY = 0, tC = 0, tY = 0, validRows = 0;
      salesRows.slice(1).forEach(cols => {
        if (!cols[5] || cols[5].trim() === '') return;
        const rowStoreId = (cols[3] || '').trim();
        if (!mMonth(cols[0])) return;
        if (!mStoreId(rowStoreId)) return;
        if (!mArea(rowStoreId)) return;
        sC += num(cols[5]); sY += num(cols[6]);
        tC += num(cols[12]); tY += num(cols[14]);
        validRows++;
      });
      const totalSales = buildMetrics(sC, sY, tC, tY);

      // ShopperMetrics -> TNAP, KAIN, PERKS, PAG-IBIG
      function sumByType(typeFilter) {
        let salesCur = 0, salesYA = 0, trxCur = 0, trxYA = 0;
        shopperRows.slice(1).forEach(cols => {
          if (SHOP_TYPE_COL < 0) return;
          if ((cols[SHOP_TYPE_COL] || '').trim().toUpperCase() !== typeFilter.toUpperCase()) return;
          const rowStoreId = SHOP_STOREID_COL >= 0 ? (cols[SHOP_STOREID_COL] || '').trim() : '';
          if (!mMonth(SHOP_MONTH_COL >= 0 ? cols[SHOP_MONTH_COL] : '')) return;
          if (!mStoreId(rowStoreId)) return;
          if (!mArea(rowStoreId)) return;
          if (SHOP_SALES_COL   >= 0) salesCur += num(cols[SHOP_SALES_COL]);
          if (SHOP_SALESLY_COL >= 0) salesYA  += num(cols[SHOP_SALESLY_COL]);
          if (SHOP_TRX_COL     >= 0) trxCur   += num(cols[SHOP_TRX_COL]);
          if (SHOP_TRXLY_COL   >= 0) trxYA    += num(cols[SHOP_TRXLY_COL]);
        });
        return buildMetrics(salesCur, salesYA, trxCur, trxYA);
      }
      const tnap    = sumByType('TNAP');
      const kain    = sumByType('KAIN');
      const perks   = sumByType('PERKS');
      const pagibig = sumByType('PAG-IBIG');

      // APAR
      let aSC = 0, aSY = 0, aTC = 0, aTY = 0;
      aparRows.slice(1).forEach(cols => {
        const rowStoreId = (cols[2] || '').trim();
        if (!mMonth(cols[0])) return;
        if (!mStoreId(rowStoreId)) return;
        if (!mArea(rowStoreId)) return;
        aSC += num(cols[6]); aSY += num(cols[7]);
        aTC += num(cols[8]); aTY += num(cols[9]);
      });
      const apar = buildMetrics(aSC, aSY, aTC, aTY);

      // GEG -> Gold, Elite, Green
      function sumGEG(levelFilter) {
        let sCx = 0, sYx = 0, tCx = 0, tYx = 0;
        gegRows.slice(1).forEach(cols => {
          if ((cols[4] || '').trim().toUpperCase() !== levelFilter.toUpperCase()) return;
          const rowStoreId = (cols[2] || '').trim();
          if (!mMonth(cols[0])) return;
          if (!mStoreId(rowStoreId)) return;
          if (!mArea(rowStoreId)) return;
          sCx += num(cols[5]); sYx += num(cols[6]);
          tCx += num(cols[7]); tYx += num(cols[8]);
        });
        return buildMetrics(sCx, sYx, tCx, tYx);
      }
      const gold  = sumGEG('Gold');
      const elite = sumGEG('Elite');
      const green = sumGEG('Green');

      // Top200
      function sumTop200(start, end) {
        let cur = 0, ya = 0;
        if (start < 0) return { cur, ya };
        for (let i = start; i <= end && i < top200Rows.length; i++) {
          const r = top200Rows[i];
          if (!r || !r[2]) continue;
          const sid = (r[2] || '').trim();
          if (isNaN(parseFloat(sid))) continue;
          if (!mStoreId(sid)) continue;
          if (!mArea(sid)) continue;
          let monthIndices;
          if (month) {
            const mIdx = MONTHS.findIndex(m => m.toLowerCase() === month.toLowerCase());
            if (mIdx < 0) continue;
            monthIndices = [mIdx];
          } else {
            monthIndices = [];
            for (let m = 0; m < 12; m++) if (num(r[CUR_COL_START + m]) > 0) monthIndices.push(m);
          }
          monthIndices.forEach(m => {
            cur += num(r[CUR_COL_START + m]);
            ya  += num(r[YA_COL_START + m]);
          });
        }
        return { cur, ya };
      }
      const t200S = sumTop200(t200SalesStart, t200SalesEnd);
      const t200T = sumTop200(t200TrxStart, t200TrxEnd);
      const top200 = buildMetrics(t200S.cur, t200S.ya, t200T.cur, t200T.ya);

      // Unusual
      function sumUnusual(rows) {
        let total = 0;
        rows.slice(1).forEach(cols => {
          if (!cols || cols.length < 7) return;
          const rowArea    = (cols[0] || '').trim();
          const rowStoreId = (cols[1] || '').trim();
          const rowMonth   = cols[3];
          if (area  && rowArea.toLowerCase() !== area.toLowerCase()) return;
          if (storeIdFilter && rowStoreId !== storeIdFilter.trim()) return;
          if (month && (rowMonth || '').trim().toLowerCase() !== month.toLowerCase()) return;
          total += num(cols[6]);
        });
        return total;
      }
      const uCur = sumUnusual(unusualCurRows);
      const uYA  = sumUnusual(unusualYARows);
      const unusual = {
        sales: { current: uCur, yearAgo: uYA, diffPct: diffPct(uCur, uYA), diffVal: diffVal(uCur, uYA) },
        trx: null, basket: null
      };

      return { totalSales, tnap, kain, perks, pagibig, apar, gold, elite, green, top200, unusual, validRows };
    }

    // Aggregate metrics (uses the user's filters)
    const agg = computeMetrics(storeId);

    // Per-store breakdown (one row per store in the filtered area)
    const storeList = storeRows.slice(1)
      .filter(r => r[3] && r[3].trim() !== '')
      .filter(r => !area || (r[2] || '').toLowerCase() === area.toLowerCase());

    const perStore = storeList.map(r => {
      const sid  = (r[3] || '').trim();
      const name = (r[4] || '').trim();
      return { storeId: sid, storeName: name, metrics: computeMetrics(sid) };
    });

    res.json({
      ok: true,
      rowCount: agg.validRows,
      filters: { area: area || null, storeId: storeId || null, month: month || null },
      totalSales: agg.totalSales,
      tnap: agg.tnap,
      kain: agg.kain,
      perks: agg.perks,
      pagibig: agg.pagibig,
      apar: agg.apar,
      gold: agg.gold,
      elite: agg.elite,
      green: agg.green,
      top200: agg.top200,
      unusual: agg.unusual,
      perStore: perStore
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

  /* SECONDARY HIGHLIGHT - light green for subtotal rows (Balance TNAP, Total GEG, Net of Unusual) */
  tbody tr.highlight-green td {
    background: #E8F5E9;
    font-weight: 700;
    border-bottom: 1px solid #A5D6A7;
    border-top: 1px solid #A5D6A7;
  }
  tbody tr.highlight-green td.metrics-col {
    color: #1B5E20;
    font-weight: 700;
  }
  tbody tr.highlight-green:hover td {
    background: #FFF176;
  }

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

  /* ONE PAGE SUMMARY */
  .summary-header {
    margin: 22px 0 10px;
    display: flex; align-items: baseline; justify-content: space-between;
    flex-wrap: wrap; gap: 8px;
  }
  .summary-header h2 {
    color: #1B5E20; font-size: 15px; font-weight: 800;
    letter-spacing: 0.5px;
    padding-left: 10px; border-left: 4px solid #FFC107;
  }
  .summary-header .summary-sub {
    font-size: 11px; color: #6b7570; font-weight: 500;
  }
  .summary-table { font-size: 11px; min-width: 100%; }
  .summary-table thead th {
    background: #1B5E20; color: white;
    font-weight: 700; font-size: 10px;
    text-align: center; padding: 9px 6px;
    letter-spacing: 0.4px; text-transform: uppercase;
    cursor: pointer; user-select: none;
    position: sticky; top: 0; z-index: 1;
    transition: background 0.15s;
    border-right: 1px solid #2E7D32;
  }
  .summary-table thead th:hover { background: #2E7D32; }
  .summary-table thead th.sortable::after {
    content: ' ⇅'; opacity: 0.4; font-size: 9px;
  }
  .summary-table thead th.sort-asc::after { content: ' ↑'; opacity: 1; color: #FFC107; }
  .summary-table thead th.sort-desc::after { content: ' ↓'; opacity: 1; color: #FFC107; }
  .summary-table thead th.store-col { text-align: left; padding-left: 12px; }

  .summary-table tbody td {
    padding: 7px 6px; border-bottom: 1px solid #f0f2ef;
    text-align: right; font-variant-numeric: tabular-nums;
    font-weight: 600;
  }
  .summary-table tbody td.store-col {
    text-align: left; padding-left: 12px;
    color: #1a2e1f; font-weight: 600; white-space: nowrap;
  }
  .summary-table tbody tr:hover td { background: #FFF176; transition: background 0.15s; }
  .summary-table tbody tr:nth-child(even) td { background: #fafbf9; }
  .summary-table tbody tr:nth-child(even):hover td { background: #FFF176; }
  .summary-table .pos { color: #2E7D32; }
  .summary-table .neg { color: #C62828; }
  .summary-table .empty-cell { color: #c5cdc5; font-weight: 400; }

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

  <!-- ONE PAGE SUMMARY TABLE -->
  <div class="summary-header">
    <h2>One Page Summary</h2>
    <span class="summary-sub">Sales growth/decline % per store · Click column to sort</span>
  </div>
  <div class="table-card">
    <div class="table-wrapper">
      <table id="summaryTable" class="summary-table">
        <thead id="summaryHead"></thead>
        <tbody id="summaryBody"></tbody>
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
        sob(balanceTnap.sales.yearAgo, totalTnapSalesYA), 'highlight-green')}
      \${metricsRow('Gold', d.gold,
        sob(d.gold.sales.current, totalTnapSalesCur),
        sob(d.gold.sales.yearAgo, totalTnapSalesYA))}
      \${metricsRow('Elite', d.elite,
        sob(d.elite.sales.current, totalTnapSalesCur),
        sob(d.elite.sales.yearAgo, totalTnapSalesYA))}
      \${metricsRow('Green', d.green,
        sob(d.green.sales.current, totalTnapSalesCur),
        sob(d.green.sales.yearAgo, totalTnapSalesYA))}
      \${metricsRow('Total GEG', totalGEG, null, null, 'highlight-green')}
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
          \${salesOnlyRow('Net of Unusual', netOfUnusual, null, null, 'highlight-green')}
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

  // ======= ONE PAGE SUMMARY TABLE =======
  const SUMMARY_COLS = [
    { key: 'store',     label: 'Stores' },
    { key: 'total',     label: 'Total Sales', getter: m => m.totalSales.sales.diffPct },
    { key: 'totalTnap', label: 'Total TNAP',  getter: m => combineSalesDiff(m.tnap, m.kain) },
    { key: 'tnap',      label: 'TNAP',        getter: m => m.tnap.sales.diffPct },
    { key: 'kain',      label: 'KAIN',        getter: m => m.kain.sales.diffPct },
    { key: 'apar',      label: 'APAR',        getter: m => m.apar.sales.diffPct },
    { key: 'top200',    label: 'TOP 200',     getter: m => m.top200.sales.diffPct },
    { key: 'balanceTnap', label: 'Balance TNAP', getter: m => balanceTnapDiff(m) },
    { key: 'gold',      label: 'Gold',        getter: m => m.gold.sales.diffPct },
    { key: 'elite',     label: 'Elite',       getter: m => m.elite.sales.diffPct },
    { key: 'green',     label: 'Green',       getter: m => m.green.sales.diffPct },
    { key: 'totalGeg',  label: 'Total GEG',   getter: m => combineSalesDiff3(m.gold, m.elite, m.green) },
    { key: 'perks',     label: 'PERKS',       getter: m => m.perks.sales.diffPct },
    { key: 'pagibig',   label: 'PAG-IBIG',    getter: m => m.pagibig.sales.diffPct },
    { key: 'uncardedU', label: 'Uncarded With Unusual', getter: m => uncardedUnusualDiff(m) },
    { key: 'unusual',   label: 'Unusual Trx', getter: m => m.unusual.sales.diffPct },
    { key: 'totalUnc',  label: 'Total Uncarded', getter: m => totalUncardedDiff(m) },
    { key: 'netUnusual', label: 'Net of Unusual', getter: m => netOfUnusualDiff(m) }
  ];

  function combineSalesDiff(a, b) {
    const cur = a.sales.current + b.sales.current;
    const ya  = a.sales.yearAgo + b.sales.yearAgo;
    return ya !== 0 ? ((cur - ya) / Math.abs(ya)) * 100 : 0;
  }
  function combineSalesDiff3(a, b, c) {
    const cur = a.sales.current + b.sales.current + c.sales.current;
    const ya  = a.sales.yearAgo + b.sales.yearAgo + c.sales.yearAgo;
    return ya !== 0 ? ((cur - ya) / Math.abs(ya)) * 100 : 0;
  }
  function balanceTnapDiff(m) {
    const cur = (m.tnap.sales.current + m.kain.sales.current) - m.apar.sales.current - m.top200.sales.current;
    const ya  = (m.tnap.sales.yearAgo + m.kain.sales.yearAgo) - m.apar.sales.yearAgo - m.top200.sales.yearAgo;
    return ya !== 0 ? ((cur - ya) / Math.abs(ya)) * 100 : 0;
  }
  function uncardedUnusualDiff(m) {
    const totalTnapCur = m.tnap.sales.current + m.kain.sales.current;
    const totalTnapYA  = m.tnap.sales.yearAgo + m.kain.sales.yearAgo;
    const cur = m.totalSales.sales.current - totalTnapCur - m.perks.sales.current - m.pagibig.sales.current;
    const ya  = m.totalSales.sales.yearAgo - totalTnapYA - m.perks.sales.yearAgo - m.pagibig.sales.yearAgo;
    return ya !== 0 ? ((cur - ya) / Math.abs(ya)) * 100 : 0;
  }
  function totalUncardedDiff(m) {
    const totalTnapCur = m.tnap.sales.current + m.kain.sales.current;
    const totalTnapYA  = m.tnap.sales.yearAgo + m.kain.sales.yearAgo;
    const uwuCur = m.totalSales.sales.current - totalTnapCur - m.perks.sales.current - m.pagibig.sales.current;
    const uwuYA  = m.totalSales.sales.yearAgo - totalTnapYA  - m.perks.sales.yearAgo  - m.pagibig.sales.yearAgo;
    const cur = uwuCur - m.unusual.sales.current;
    const ya  = uwuYA  - m.unusual.sales.yearAgo;
    return ya !== 0 ? ((cur - ya) / Math.abs(ya)) * 100 : 0;
  }
  function netOfUnusualDiff(m) {
    const cur = m.totalSales.sales.current - m.unusual.sales.current;
    const ya  = m.totalSales.sales.yearAgo - m.unusual.sales.yearAgo;
    return ya !== 0 ? ((cur - ya) / Math.abs(ya)) * 100 : 0;
  }

  let summarySort = { col: null, asc: true };
  let summaryData = [];

  function buildSummaryTable(data) {
    summaryData = (data.perStore || []).slice();

    const head = document.getElementById('summaryHead');
    head.innerHTML = '<tr>' + SUMMARY_COLS.map((c, idx) => {
      const cls = ['sortable'];
      if (c.key === 'store') cls.push('store-col');
      if (summarySort.col === idx) cls.push(summarySort.asc ? 'sort-asc' : 'sort-desc');
      return \`<th class="\${cls.join(' ')}" onclick="sortSummary(\${idx})">\${c.label}</th>\`;
    }).join('') + '</tr>';

    let rows = summaryData.slice();
    if (summarySort.col !== null) {
      const col = SUMMARY_COLS[summarySort.col];
      rows.sort((a, b) => {
        if (col.key === 'store') {
          const va = a.storeName.toLowerCase();
          const vb = b.storeName.toLowerCase();
          return summarySort.asc ? va.localeCompare(vb) : vb.localeCompare(va);
        }
        let va = col.getter(a.metrics);
        let vb = col.getter(b.metrics);
        if (isNaN(va) || !isFinite(va)) va = -Infinity;
        if (isNaN(vb) || !isFinite(vb)) vb = -Infinity;
        return summarySort.asc ? va - vb : vb - va;
      });
    }

    const body = document.getElementById('summaryBody');
    body.innerHTML = rows.map(r => {
      const cells = SUMMARY_COLS.map(c => {
        if (c.key === 'store') {
          return \`<td class="store-col">\${r.storeName || r.storeId}</td>\`;
        }
        const v = c.getter(r.metrics);
        if (v === null || v === undefined || isNaN(v) || !isFinite(v) || v === 0) {
          return \`<td class="empty-cell">—</td>\`;
        }
        const cls = v >= 0 ? 'pos' : 'neg';
        const sign = v >= 0 ? '+' : '';
        return \`<td class="\${cls}">\${sign}\${v.toFixed(2)}%</td>\`;
      }).join('');
      return \`<tr>\${cells}</tr>\`;
    }).join('');
  }

  window.sortSummary = function(colIdx) {
    if (summarySort.col === colIdx) {
      summarySort.asc = !summarySort.asc;
    } else {
      summarySort.col = colIdx;
      summarySort.asc = false;
    }
    buildSummaryTable({ perStore: summaryData });
  };
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
      buildSummaryTable(data);

      statusBar.className = 'status-bar';
      const f = data.filters || {};
      const filterTxt = [
        f.month   ? 'Month: ' + f.month     : null,
        f.area    ? 'Area: ' + f.area       : null,
        f.storeId ? 'Store: ' + f.storeId   : null
      ].filter(Boolean).join(' · ') || 'No filters';
      const storeCount = data.perStore ? data.perStore.length : 0;
      statusBar.innerHTML = \`✅ \${filterTxt} · \${data.rowCount} matched rows · \${storeCount} stores in summary · Refreshed \${new Date().toLocaleTimeString('en-PH')}\`;
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
