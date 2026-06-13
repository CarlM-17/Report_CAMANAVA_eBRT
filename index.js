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

// Per Store Sales Performance endpoint
app.get('/api/store-performance', async (req, res) => {
  try {
    const { area, month } = req.query;

    const [salesRows, targetRows, storeRows] = await Promise.all([
      fetchSheet(SHEET_NAME),
      fetchSheet('SalesTarget'),
      fetchSheet('ListOfStores')
    ]);

    // Build store lookup (Store ID -> name + area + remarks from ListOfStores)
    const storeAreaMap = {};
    const storeNameMap = {};
    const storeRemarksMap = {};
    storeRows.slice(1).forEach(r => {
      const sid = (r[3] || '').trim();
      const ar  = (r[2] || '').trim();
      const nm  = (r[4] || '').trim();
      const rm  = (r[5] || '').trim();
      if (sid) { storeAreaMap[sid] = ar; storeNameMap[sid] = nm; storeRemarksMap[sid] = rm; }
    });

    const passMonth = (m) => !month || (m || '').toString().trim().toLowerCase() === month.toLowerCase();

    // Index SalesData by store (also build monthly trend - all months for chart)
    const salesByStore = {};  // sid -> {sC, sY}
    const monthlyTrend = {};  // monthName -> {sC, sY}
    salesRows.slice(1).forEach(cols => {
      if (!cols[5] && !cols[6]) return;
      const sid = (cols[3] || '').trim();
      const m = cols[0];
      const ar = storeAreaMap[sid] || '';
      if (area && ar.toLowerCase() !== area.toLowerCase()) return;

      if (passMonth(m)) {
        if (!salesByStore[sid]) salesByStore[sid] = { sC: 0, sY: 0 };
        salesByStore[sid].sC += num(cols[5]);
        salesByStore[sid].sY += num(cols[6]);
      }
      if (m) {
        const mk = (m || '').toString().trim();
        if (!monthlyTrend[mk]) monthlyTrend[mk] = { sC: 0, sY: 0 };
        monthlyTrend[mk].sC += num(cols[5]);
        monthlyTrend[mk].sY += num(cols[6]);
      }
    });

    // Index SalesTarget by store
    const targetByStore = {};
    targetRows.slice(1).forEach(cols => {
      const sid = (cols[3] || '').trim();
      const m = cols[0];
      const ar = storeAreaMap[sid] || '';
      if (area && ar.toLowerCase() !== area.toLowerCase()) return;
      if (!passMonth(m)) return;
      if (!targetByStore[sid]) targetByStore[sid] = 0;
      targetByStore[sid] += num(cols[5]);
    });

    // Build rows
    const stores = storeRows.slice(1)
      .filter(r => r[3] && r[3].trim() !== '')
      .filter(r => !area || (r[2] || '').toLowerCase() === area.toLowerCase());

    const rows = stores.map(r => {
      const sid  = (r[3] || '').trim();
      const name = (r[4] || '').trim();
      const ar   = (r[2] || '').trim();
      const remarks = (r[5] || '').trim();
      const s    = salesByStore[sid] || { sC: 0, sY: 0 };
      const target = targetByStore[sid] || 0;
      const sales = s.sC;
      const salesYA = s.sY;
      const index   = salesYA !== 0 ? (sales / salesYA) * 100 : 0;
      const growth  = salesYA !== 0 ? ((sales - salesYA) / Math.abs(salesYA)) * 100 : 0;
      const valueVsYA = sales - salesYA;
      const pctVsTarget   = target !== 0 ? (sales / target) * 100 : 0;
      const valueVsTarget = sales - target;
      return {
        storeId: sid, storeName: name, area: ar, remarks,
        sales, salesYA, index, growth, valueVsYA,
        target, pctVsTarget, valueVsTarget
      };
    });

    // Total row
    const total = {
      storeName: 'TOTAL',
      sales:   rows.reduce((s, r) => s + r.sales, 0),
      salesYA: rows.reduce((s, r) => s + r.salesYA, 0),
      target:  rows.reduce((s, r) => s + r.target, 0)
    };
    total.index = total.salesYA !== 0 ? (total.sales / total.salesYA) * 100 : 0;
    total.growth = total.salesYA !== 0 ? ((total.sales - total.salesYA) / Math.abs(total.salesYA)) * 100 : 0;
    total.valueVsYA = total.sales - total.salesYA;
    total.pctVsTarget = total.target !== 0 ? (total.sales / total.target) * 100 : 0;
    total.valueVsTarget = total.sales - total.target;

    // Summary KPIs
    const organicRows = rows.filter(r => r.remarks.toLowerCase() === 'organic');
    const organicSalesCur = organicRows.reduce((s, r) => s + r.sales, 0);
    const organicSalesYA  = organicRows.reduce((s, r) => s + r.salesYA, 0);
    const organicGrowth = organicSalesYA !== 0 ? ((organicSalesCur - organicSalesYA) / Math.abs(organicSalesYA)) * 100 : 0;
    const declinedCount = rows.filter(r => r.salesYA > 0 && r.growth < 0).length;

    const summary = {
      valueVsYA:     total.valueVsYA,
      indexVsLY:     total.index,
      valueVsTarget: total.valueVsTarget,
      indexVsTarget: total.pctVsTarget,
      declinedCount,
      organicGrowth,
      organicCount:  organicRows.length
    };

    // Charts data
    const MONTHS_ORDER = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    const trendData = MONTHS_ORDER
      .map(m => ({ month: m, sC: (monthlyTrend[m] || {}).sC || 0, sY: (monthlyTrend[m] || {}).sY || 0 }))
      .filter(d => d.sC > 0 || d.sY > 0);

    // Growth Per Area
    const areaAgg = {};
    rows.forEach(r => {
      if (!areaAgg[r.area]) areaAgg[r.area] = { sC: 0, sY: 0 };
      areaAgg[r.area].sC += r.sales;
      areaAgg[r.area].sY += r.salesYA;
    });
    const areaGrowth = Object.entries(areaAgg).map(([ar, v]) => ({
      area: ar,
      growth: v.sY !== 0 ? ((v.sC - v.sY) / Math.abs(v.sY)) * 100 : 0
    }));

    res.json({
      ok: true,
      filters: { area: area || null, month: month || null },
      rows,
      total,
      summary,
      trendData,
      areaGrowth
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/data', async (req, res) => {
  const t0 = Date.now();
  try {
    const { area, storeId, month } = req.query;

    // Fetch sheets in 2 batches of 4 to avoid Google Sheets rate limiting
    const [salesRows, shopperRows, storeRows, aparRows] = await Promise.all([
      fetchSheet(SHEET_NAME),
      fetchSheet('ShopperMetricsData'),
      fetchSheet('ListOfStores'),
      fetchSheet('APAR')
    ]);
    const t1 = Date.now();
    const [gegRows, top200Rows, unusualCurRows, unusualYARows] = await Promise.all([
      fetchSheet('GEG'),
      fetchSheet('Top200'),
      fetchSheet('UnusualCurrent'),
      fetchSheet('UnusualYearAgo')
    ]);
    const t2 = Date.now();
    console.log(`[/api/data] Fetch batch 1: ${t1-t0}ms, batch 2: ${t2-t1}ms, total fetch: ${t2-t0}ms`);

    // Build a Store ID → Area lookup map (from ListOfStores)
    const storeAreaMap = {};
    const storeNameMap = {};
    storeRows.slice(1).forEach(r => {
      const sid = (r[3] || '').trim();
      const ar  = (r[2] || '').trim();
      const nm  = (r[4] || '').trim();
      if (sid) { storeAreaMap[sid] = ar; storeNameMap[sid] = nm; }
    });

    const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];

    // Helpers
    const passMonth = (m) => !month || (m || '').toString().trim().toLowerCase() === month.toLowerCase();
    const passArea  = (sid) => !area || (storeAreaMap[sid] || '').toLowerCase() === area.toLowerCase();
    const emptyMetric = () => ({ sC: 0, sY: 0, tC: 0, tY: 0 });
    const addInto = (target, src) => {
      target.sC += src.sC; target.sY += src.sY;
      target.tC += src.tC; target.tY += src.tY;
    };
    const toMetricObj = (m) => buildMetrics(m.sC, m.sY, m.tC, m.tY);

    // ----- ONE-PASS INDEXING PER SHEET -----
    // SalesData -> by storeId
    const salesIdx = {};
    let salesValidRows = 0;
    salesRows.slice(1).forEach(cols => {
      if (!cols[5] || cols[5].trim() === '') return;
      if (!passMonth(cols[0])) return;
      const sid = (cols[3] || '').trim();
      if (!sid) return;
      if (!salesIdx[sid]) salesIdx[sid] = emptyMetric();
      salesIdx[sid].sC += num(cols[5]);
      salesIdx[sid].sY += num(cols[6]);
      salesIdx[sid].tC += num(cols[12]);
      salesIdx[sid].tY += num(cols[14]);
      salesValidRows++;
    });

    // ShopperMetrics -> by [type][storeId]
    const normalize = s => (s || '').trim().toUpperCase().replace(/[\s._-]/g, '');
    const shopperHeadersNorm = shopperRows[0].map(normalize);
    const sColIdx = (name) => shopperHeadersNorm.indexOf(normalize(name));
    const SHOP_TYPE_COL    = sColIdx('TYPE');
    const SHOP_MONTH_COL   = sColIdx('Month');
    const SHOP_STOREID_COL = sColIdx('STOREID');
    const SHOP_SALES_COL   = sColIdx('Sales');
    const SHOP_SALESLY_COL = sColIdx('SalesLY');
    const SHOP_TRX_COL     = sColIdx('TRXCount');
    const SHOP_TRXLY_COL   = sColIdx('TRXCountLY');

    const shopperIdx = { TNAP: {}, KAIN: {}, PERKS: {}, 'PAG-IBIG': {} };
    shopperRows.slice(1).forEach(cols => {
      if (SHOP_TYPE_COL < 0) return;
      const type = (cols[SHOP_TYPE_COL] || '').trim().toUpperCase();
      if (!shopperIdx[type]) return;
      if (!passMonth(SHOP_MONTH_COL >= 0 ? cols[SHOP_MONTH_COL] : '')) return;
      const sid = SHOP_STOREID_COL >= 0 ? (cols[SHOP_STOREID_COL] || '').trim() : '';
      if (!sid) return;
      const idx = shopperIdx[type];
      if (!idx[sid]) idx[sid] = emptyMetric();
      if (SHOP_SALES_COL   >= 0) idx[sid].sC += num(cols[SHOP_SALES_COL]);
      if (SHOP_SALESLY_COL >= 0) idx[sid].sY += num(cols[SHOP_SALESLY_COL]);
      if (SHOP_TRX_COL     >= 0) idx[sid].tC += num(cols[SHOP_TRX_COL]);
      if (SHOP_TRXLY_COL   >= 0) idx[sid].tY += num(cols[SHOP_TRXLY_COL]);
    });

    // APAR -> by storeId
    const aparIdx = {};
    aparRows.slice(1).forEach(cols => {
      if (!passMonth(cols[0])) return;
      const sid = (cols[2] || '').trim();
      if (!sid) return;
      if (!aparIdx[sid]) aparIdx[sid] = emptyMetric();
      aparIdx[sid].sC += num(cols[6]);
      aparIdx[sid].sY += num(cols[7]);
      aparIdx[sid].tC += num(cols[8]);
      aparIdx[sid].tY += num(cols[9]);
    });

    // GEG -> by [level][storeId]
    const gegIdx = { Gold: {}, Elite: {}, Green: {} };
    gegRows.slice(1).forEach(cols => {
      const level = (cols[4] || '').trim();
      const levelKey = Object.keys(gegIdx).find(k => k.toLowerCase() === level.toLowerCase());
      if (!levelKey) return;
      if (!passMonth(cols[0])) return;
      const sid = (cols[2] || '').trim();
      if (!sid) return;
      if (!gegIdx[levelKey][sid]) gegIdx[levelKey][sid] = emptyMetric();
      gegIdx[levelKey][sid].sC += num(cols[5]);
      gegIdx[levelKey][sid].sY += num(cols[6]);
      gegIdx[levelKey][sid].tC += num(cols[7]);
      gegIdx[levelKey][sid].tY += num(cols[8]);
    });

    // Top200 -> by storeId (sales + trx separate)
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

    function indexTop200(start, end, isTrx) {
      const idx = {};
      if (start < 0) return idx;
      const monthIdx = month ? MONTHS.findIndex(m => m.toLowerCase() === month.toLowerCase()) : -1;
      for (let i = start; i <= end && i < top200Rows.length; i++) {
        const r = top200Rows[i];
        if (!r || !r[2]) continue;
        const sid = (r[2] || '').trim();
        if (isNaN(parseFloat(sid))) continue;
        let cur = 0, ya = 0;
        if (month) {
          if (monthIdx < 0) continue;
          cur = num(r[CUR_COL_START + monthIdx]);
          ya  = num(r[YA_COL_START + monthIdx]);
        } else {
          for (let m = 0; m < 12; m++) {
            if (num(r[CUR_COL_START + m]) > 0) {
              cur += num(r[CUR_COL_START + m]);
              ya  += num(r[YA_COL_START + m]);
            }
          }
        }
        if (!idx[sid]) idx[sid] = emptyMetric();
        if (isTrx) { idx[sid].tC += cur; idx[sid].tY += ya; }
        else       { idx[sid].sC += cur; idx[sid].sY += ya; }
      }
      return idx;
    }
    const top200SalesIdx = indexTop200(t200SalesStart, t200SalesEnd, false);
    const top200TrxIdx   = indexTop200(t200TrxStart, t200TrxEnd, true);

    // Unusual -> by storeId (sales only)
    function indexUnusual(rows) {
      const idx = {};
      rows.slice(1).forEach(cols => {
        if (!cols || cols.length < 7) return;
        const rowArea = (cols[0] || '').trim();
        // Note: Unusual filter by area uses row's own area column (not store map)
        if (area && rowArea.toLowerCase() !== area.toLowerCase()) return;
        if (!passMonth(cols[3])) return;
        const sid = (cols[1] || '').trim();
        if (!sid) return;
        if (!idx[sid]) idx[sid] = 0;
        idx[sid] += num(cols[6]);
      });
      return idx;
    }
    const unusualCurIdx = indexUnusual(unusualCurRows);
    const unusualYAIdx  = indexUnusual(unusualYARows);

    // ----- FAST AGGREGATION FROM INDEXES -----
    // Get metrics for one store, OR for many stores (aggregate)
    function getStoreSet(storeIdFilter) {
      // Build list of store IDs that pass area/storeId filters
      if (storeIdFilter) return [storeIdFilter];
      // All stores known (use storeAreaMap keys, optionally filtered by area)
      return Object.keys(storeAreaMap).filter(sid => passArea(sid));
    }

    function aggIdx(idx, storeIds) {
      const out = emptyMetric();
      storeIds.forEach(sid => { if (idx[sid]) addInto(out, idx[sid]); });
      return out;
    }
    function aggIdxScalar(idx, storeIds) {
      let total = 0;
      storeIds.forEach(sid => { if (idx[sid]) total += idx[sid]; });
      return total;
    }

    function computeMetrics(storeIdFilter) {
      const stores = getStoreSet(storeIdFilter);

      const totalSales = toMetricObj(aggIdx(salesIdx, stores));
      const tnap       = toMetricObj(aggIdx(shopperIdx.TNAP, stores));
      const kain       = toMetricObj(aggIdx(shopperIdx.KAIN, stores));
      const perks      = toMetricObj(aggIdx(shopperIdx.PERKS, stores));
      const pagibig    = toMetricObj(aggIdx(shopperIdx['PAG-IBIG'], stores));
      const apar       = toMetricObj(aggIdx(aparIdx, stores));
      const gold       = toMetricObj(aggIdx(gegIdx.Gold, stores));
      const elite      = toMetricObj(aggIdx(gegIdx.Elite, stores));
      const green      = toMetricObj(aggIdx(gegIdx.Green, stores));

      // Top200: combine sales + trx indexes
      const top200Sales = aggIdx(top200SalesIdx, stores);
      const top200Trx   = aggIdx(top200TrxIdx, stores);
      const top200 = buildMetrics(top200Sales.sC, top200Sales.sY, top200Trx.tC, top200Trx.tY);

      const uCur = aggIdxScalar(unusualCurIdx, stores);
      const uYA  = aggIdxScalar(unusualYAIdx, stores);
      const unusual = {
        sales: { current: uCur, yearAgo: uYA, diffPct: diffPct(uCur, uYA), diffVal: diffVal(uCur, uYA) },
        trx: null, basket: null
      };

      return { totalSales, tnap, kain, perks, pagibig, apar, gold, elite, green, top200, unusual };
    }

    // Aggregate (uses user filters)
    const t3 = Date.now();
    const agg = computeMetrics(storeId);

    // Per-store breakdown
    const storeList = storeRows.slice(1)
      .filter(r => r[3] && r[3].trim() !== '')
      .filter(r => !area || (r[2] || '').toLowerCase() === area.toLowerCase());

    const perStore = storeList.map(r => {
      const sid  = (r[3] || '').trim();
      const name = (r[4] || '').trim();
      return { storeId: sid, storeName: name, metrics: computeMetrics(sid) };
    });
    const t4 = Date.now();
    console.log(`[/api/data] Index+aggregate: ${t3-t2}ms, per-store (${storeList.length} stores): ${t4-t3}ms, total: ${t4-t0}ms`);

    res.json({
      ok: true,
      rowCount: salesValidRows,
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
    width: 100%; min-width: 1340px;
    border-collapse: collapse; font-size: 10.5px;
    table-layout: fixed;
  }

  /* SECTION HEADER */
  .section-header td {
    background: #1B5E20; color: white;
    font-weight: 700; font-size: 10px;
    letter-spacing: 0.6px; text-align: center;
    padding: 8px 3px; text-transform: uppercase;
    position: relative;
  }

  /* COLUMN HEADER */
  .col-header td {
    background: #FAF8F0; color: #4a5550; font-weight: 700; font-size: 9.5px;
    text-align: center; padding: 5px 3px;
    border-bottom: 2px solid #FFC107;
    text-transform: uppercase; letter-spacing: 0.3px;
  }
  .col-header td.metrics-col {
    text-align: left; color: #1B5E20; padding-left: 10px;
  }

  /* DATA ROWS */
  tbody tr td {
    padding: 5px 4px; border-bottom: 1px solid #f0f2ef;
    vertical-align: middle;
  }
  tbody tr td.metrics-col {
    font-weight: 600; color: #1a2e1f; text-align: left;
    white-space: nowrap; padding-left: 10px; font-size: 10.5px;
  }
  tbody tr td.data-col {
    text-align: right; color: #3d4a40;
    font-variant-numeric: tabular-nums; padding-right: 7px;
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
  .summary-table { font-size: 10px; min-width: 1240px; table-layout: fixed; }
  .summary-table thead th.store-col,
  .summary-table tbody td.store-col { width: 150px; min-width: 150px; }
  .summary-table thead th {
    background: #1B5E20; color: white;
    font-weight: 700; font-size: 9px;
    text-align: center; padding: 7px 4px;
    letter-spacing: 0.3px; text-transform: uppercase;
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
    padding: 5px 4px; border-bottom: 1px solid #f0f2ef;
    text-align: right; font-variant-numeric: tabular-nums;
    font-weight: 600;
  }
  .summary-table tbody td.store-col {
    text-align: left; padding-left: 12px;
    color: #1a2e1f; font-weight: 600; white-space: nowrap;
    overflow: hidden; text-overflow: ellipsis;
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

  /* ===== PER STORE SALES PERFORMANCE ===== */

  /* KPI Cards */
  .kpi-grid {
    display: grid;
    grid-template-columns: repeat(6, 1fr);
    gap: 10px;
    margin-bottom: 14px;
  }
  .kpi-card {
    background: white; border-radius: 10px;
    border: 1px solid #e8ebe8;
    padding: 12px 14px;
    position: relative; overflow: hidden;
  }
  .kpi-card::before {
    content: ''; position: absolute; left: 0; top: 0; bottom: 0;
    width: 4px; background: #1B5E20;
  }
  .kpi-card.kpi-pos::before { background: #2E7D32; }
  .kpi-card.kpi-neg::before { background: #C62828; }
  .kpi-card.kpi-warn::before { background: #FFC107; }
  .kpi-label {
    font-size: 10px; color: #6b7570;
    text-transform: uppercase; letter-spacing: 0.6px;
    font-weight: 700; margin-bottom: 4px;
  }
  .kpi-value {
    font-size: 17px; font-weight: 800;
    color: #1a2e1f; letter-spacing: -0.3px;
    font-variant-numeric: tabular-nums;
  }
  .kpi-card.kpi-pos .kpi-value { color: #2E7D32; }
  .kpi-card.kpi-neg .kpi-value { color: #C62828; }
  .kpi-sub {
    font-size: 10px; color: #94a094;
    margin-top: 2px; font-weight: 500;
  }
  @media (max-width: 1100px) {
    .kpi-grid { grid-template-columns: repeat(3, 1fr); }
  }
  @media (max-width: 600px) {
    .kpi-grid { grid-template-columns: repeat(2, 1fr); }
    .kpi-value { font-size: 15px; }
  }

  .ps-table {
    width: 100%; min-width: 1100px;
    border-collapse: collapse; font-size: 11.5px;
    table-layout: auto;
  }
  .ps-table thead th {
    background: #2E7D32; color: white; font-weight: 700;
    font-size: 10.5px; padding: 9px 10px;
    text-align: center; letter-spacing: 0.4px;
    text-transform: uppercase;
    border-bottom: 2px solid #FFC107;
    cursor: pointer; user-select: none;
    transition: background 0.15s;
  }
  .ps-table thead th.sortable:hover { background: #1B5E20; }
  .ps-table thead th.sortable::after {
    content: ' ⇅'; opacity: 0.4; font-size: 9px;
  }
  .ps-table thead th.sort-asc::after  { content: ' ↑'; opacity: 1; color: #FFC107; }
  .ps-table thead th.sort-desc::after { content: ' ↓'; opacity: 1; color: #FFC107; }
  .ps-table thead th.store-col { text-align: left; padding-left: 14px; width: 200px; }
  .ps-table tbody td {
    padding: 7px 10px; border-bottom: 1px solid #f0f2ef;
    text-align: right; font-variant-numeric: tabular-nums;
    font-weight: 500; color: #3d4a40;
  }
  .ps-table tbody td.store-col {
    text-align: left; padding-left: 14px;
    color: #1a2e1f; font-weight: 600; white-space: nowrap;
  }
  .ps-table tbody tr:hover td { background: #FFF176; transition: background 0.15s; }
  .ps-table tbody tr:nth-child(even) td { background: #fafbf9; }
  .ps-table tbody tr:nth-child(even):hover td { background: #FFF176; }
  .ps-table tfoot td {
    padding: 9px 10px; font-weight: 800;
    background: linear-gradient(90deg, #FFF8E1 0%, #FFF9C4 100%);
    border-top: 2px solid #FFC107; border-bottom: 2px solid #FFC107;
    color: #1B5E20; text-align: right;
    font-variant-numeric: tabular-nums; font-size: 12px;
  }
  .ps-table tfoot td.store-col { text-align: left; padding-left: 14px; }
  .ps-table .pos { color: #2E7D32; font-weight: 700; }
  .ps-table .neg { color: #C62828; font-weight: 700; }

  /* Charts grid */
  .charts-grid {
    display: grid; grid-template-columns: 1fr 1fr; gap: 14px;
    margin-top: 16px;
  }
  .chart-card {
    background: white; border-radius: 10px;
    border: 1px solid #e8ebe8; padding: 14px 16px;
  }
  .chart-title {
    font-size: 13px; font-weight: 700; color: #1B5E20;
    padding-left: 10px; border-left: 4px solid #FFC107;
    margin-bottom: 12px; letter-spacing: 0.3px;
  }
  .chart-wrap { position: relative; height: 260px; }
  .chart-wrap-tall { height: 340px; }

  @media (max-width: 900px) {
    .charts-grid { grid-template-columns: 1fr; }
    .chart-wrap { height: 220px; }
    .chart-wrap-tall { height: 280px; }
  }
</style>
<script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.0/chart.umd.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/chartjs-plugin-datalabels@2.2.0"></script>
</head>
<body>

<div class="top-nav">
  <div class="brand">CAMANAVA eBRT <span>ELECTRONIC BUSINESS REVIEW TOOL</span></div>
  <div class="date-label" id="currentDate"></div>
</div>

<div class="tabs">
  <button class="tab-btn active" onclick="switchTab(this, 'daily')">Daily Sales</button>
  <button class="tab-btn" onclick="switchTab(this, 'monthly')">Per Store Sales Performance</button>
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

<!-- PER STORE SALES PERFORMANCE TAB -->
<div id="tab-monthly" class="content" style="display:none;">

  <div class="filter-bar">
    <label>Month</label>
    <select id="psMonthFilter"><option value="">All Months</option></select>
    <label>Area</label>
    <select id="psAreaFilter"><option value="">All Areas</option></select>
    <button class="btn-refresh" id="psRefreshBtn" onclick="loadStorePerf()">↻ Refresh</button>
  </div>

  <div id="psStatusBar" class="status-bar loading">
    <span class="spinner"></span> Loading store performance...
  </div>

  <!-- KPI Cards -->
  <div class="kpi-grid" id="psKpiGrid"></div>

  <!-- Main Performance Table -->
  <div class="table-card">
    <div class="table-wrapper">
      <table id="psTable" class="ps-table">
        <thead>
          <tr>
            <th class="store-col sortable" data-col="storeName">Store Name</th>
            <th class="sortable" data-col="sales">Sales</th>
            <th class="sortable" data-col="salesYA">Sales YA</th>
            <th class="sortable" data-col="index">Index</th>
            <th class="sortable" data-col="valueVsYA">Value vs YA</th>
            <th class="sortable" data-col="target">Target</th>
            <th class="sortable" data-col="pctVsTarget">% vs Target</th>
            <th class="sortable" data-col="valueVsTarget">Value vs Target</th>
          </tr>
        </thead>
        <tbody id="psTableBody"></tbody>
        <tfoot id="psTableFoot"></tfoot>
      </table>
    </div>
  </div>

  <!-- Charts grid (2x2) -->
  <div class="charts-grid">
    <div class="chart-card">
      <div class="chart-title">Monthly Sales Trend</div>
      <div class="chart-wrap"><canvas id="chartTrend"></canvas></div>
    </div>
    <div class="chart-card">
      <div class="chart-title">Growth Per Area</div>
      <div class="chart-wrap"><canvas id="chartAreaGrowth"></canvas></div>
    </div>
    <div class="chart-card">
      <div class="chart-title">Target Achievement per Store</div>
      <div class="chart-wrap chart-wrap-tall"><canvas id="chartTarget"></canvas></div>
    </div>
    <div class="chart-card">
      <div class="chart-title">Growth vs LY % per Store</div>
      <div class="chart-wrap chart-wrap-tall"><canvas id="chartGrowth"></canvas></div>
    </div>
  </div>

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
    // For very large numbers (>= 1M), drop decimals to save column width
    if (Math.abs(n) >= 1000000) return Math.round(n).toLocaleString('en-PH');
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

  // ========= PER STORE SALES PERFORMANCE =========
  let psFiltersLoaded = false;
  let psCharts = { trend: null, area: null, target: null, growth: null };
  let psCurrentData = null;
  let psSort = { col: null, asc: true };

  async function loadPsFilters() {
    if (psFiltersLoaded) return;
    try {
      const res = await fetch('/api/filters');
      const f = await res.json();
      if (!f.ok) return;
      const monthSel = document.getElementById('psMonthFilter');
      f.months.forEach(m => monthSel.innerHTML += \`<option value="\${m}">\${m}</option>\`);
      const areaSel  = document.getElementById('psAreaFilter');
      f.areas.forEach(a => areaSel.innerHTML += \`<option value="\${a}">\${a}</option>\`);
      monthSel.addEventListener('change', loadStorePerf);
      areaSel.addEventListener('change', loadStorePerf);
      psFiltersLoaded = true;
    } catch (e) { console.error('ps filter load failed', e); }
  }

  // Format helpers for Per Store table
  function psFmt(n) {
    if (n === null || n === undefined || isNaN(n)) return '—';
    return n.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function psFmtSigned(n) {
    if (n === null || n === undefined || isNaN(n)) return '—';
    const sign = n >= 0 ? '' : '';
    return sign + psFmt(n);
  }
  function psFmtPct(n) {
    if (n === null || n === undefined || isNaN(n)) return '—';
    return n.toFixed(2) + '%';
  }

  async function loadStorePerf() {
    const btn = document.getElementById('psRefreshBtn');
    const status = document.getElementById('psStatusBar');
    btn.classList.add('loading');
    btn.textContent = '⏳ Loading...';
    status.className = 'status-bar loading';
    status.innerHTML = '<span class="spinner"></span> Loading store performance...';

    try {
      const month = document.getElementById('psMonthFilter').value;
      const areaV = document.getElementById('psAreaFilter').value;
      const params = new URLSearchParams();
      if (month) params.set('month', month);
      if (areaV) params.set('area', areaV);

      const res = await fetch('/api/store-performance?' + params.toString());
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || 'Unknown error');

      psCurrentData = data;
      psSort = { col: null, asc: true };
      renderPsKpis(data);
      renderPsTable(data);
      renderPsCharts(data);

      status.className = 'status-bar';
      const ftxt = [
        month ? 'Month: ' + month : null,
        areaV ? 'Area: ' + areaV : null
      ].filter(Boolean).join(' · ') || 'No filters';
      status.innerHTML = \`✅ \${ftxt} · \${data.rows.length} stores · Refreshed \${new Date().toLocaleTimeString('en-PH')}\`;
    } catch (err) {
      status.className = 'status-bar error';
      status.innerHTML = '❌ Error: ' + err.message;
    } finally {
      btn.classList.remove('loading');
      btn.textContent = '↻ Refresh';
    }
  }

  function renderPsKpis(data) {
    const s = data.summary || {};
    const fmtMoney = n => {
      if (n === null || n === undefined || isNaN(n)) return '—';
      const abs = Math.abs(n);
      const sign = n < 0 ? '-' : '';
      if (abs >= 1e9) return sign + '₱' + (abs/1e9).toFixed(2) + 'B';
      if (abs >= 1e6) return sign + '₱' + (abs/1e6).toFixed(2) + 'M';
      if (abs >= 1e3) return sign + '₱' + (abs/1e3).toFixed(1) + 'K';
      return sign + '₱' + abs.toFixed(0);
    };
    const fmtPct = n => (n === null || n === undefined || isNaN(n)) ? '—' : n.toFixed(2) + '%';

    const cards = [
      { label: 'Value vs YA',     value: fmtMoney(s.valueVsYA),     cls: s.valueVsYA >= 0 ? 'kpi-pos' : 'kpi-neg', sub: s.valueVsYA >= 0 ? 'Growth in pesos' : 'Decline in pesos' },
      { label: 'Index vs LY',     value: fmtPct(s.indexVsLY),       cls: s.indexVsLY >= 100 ? 'kpi-pos' : 'kpi-neg', sub: s.indexVsLY >= 100 ? 'Above last year' : 'Below last year' },
      { label: 'Value vs Target', value: fmtMoney(s.valueVsTarget), cls: s.valueVsTarget >= 0 ? 'kpi-pos' : 'kpi-neg', sub: s.valueVsTarget >= 0 ? 'Over target' : 'Below target' },
      { label: 'Index vs Target', value: fmtPct(s.indexVsTarget),   cls: s.indexVsTarget >= 100 ? 'kpi-pos' : 'kpi-warn', sub: s.indexVsTarget >= 100 ? 'Target achieved' : 'Target not met' },
      { label: 'Stores Declined', value: (s.declinedCount ?? 0) + ' / ' + (data.rows ? data.rows.length : 0), cls: (s.declinedCount > 0) ? 'kpi-neg' : 'kpi-pos', sub: 'vs Last Year' },
      { label: 'Organic Growth',  value: fmtPct(s.organicGrowth),   cls: s.organicGrowth >= 0 ? 'kpi-pos' : 'kpi-neg', sub: (s.organicCount || 0) + ' organic stores' }
    ];
    document.getElementById('psKpiGrid').innerHTML = cards.map(c => \`
      <div class="kpi-card \${c.cls}">
        <div class="kpi-label">\${c.label}</div>
        <div class="kpi-value">\${c.value}</div>
        <div class="kpi-sub">\${c.sub}</div>
      </div>\`).join('');
  }

  function renderPsTable(data) {
    let rows = data.rows.slice();
    if (psSort.col) {
      rows.sort((a, b) => {
        let va = a[psSort.col], vb = b[psSort.col];
        if (typeof va === 'string') {
          return psSort.asc ? va.localeCompare(vb) : vb.localeCompare(va);
        }
        if (isNaN(va) || !isFinite(va)) va = -Infinity;
        if (isNaN(vb) || !isFinite(vb)) vb = -Infinity;
        return psSort.asc ? va - vb : vb - va;
      });
    }

    // Update header sort indicators
    document.querySelectorAll('#psTable thead th.sortable').forEach(th => {
      th.classList.remove('sort-asc', 'sort-desc');
      if (th.dataset.col === psSort.col) {
        th.classList.add(psSort.asc ? 'sort-asc' : 'sort-desc');
      }
    });

    const body = document.getElementById('psTableBody');
    body.innerHTML = rows.map(r => {
      const valYAClass  = r.valueVsYA >= 0 ? 'pos' : 'neg';
      const valTgtClass = r.valueVsTarget >= 0 ? 'pos' : 'neg';
      const pctTgtClass = r.pctVsTarget >= 100 ? 'pos' : 'neg';
      const indexClass  = r.index >= 100 ? 'pos' : 'neg';
      return \`<tr>
        <td class="store-col">\${r.storeName || r.storeId}</td>
        <td>\${psFmt(r.sales)}</td>
        <td>\${psFmt(r.salesYA)}</td>
        <td class="\${indexClass}">\${psFmtPct(r.index)}</td>
        <td class="\${valYAClass}">\${psFmt(r.valueVsYA)}</td>
        <td>\${psFmt(r.target)}</td>
        <td class="\${pctTgtClass}">\${psFmtPct(r.pctVsTarget)}</td>
        <td class="\${valTgtClass}">\${psFmt(r.valueVsTarget)}</td>
      </tr>\`;
    }).join('');

    const t = data.total;
    const foot = document.getElementById('psTableFoot');
    const tValYAClass = t.valueVsYA >= 0 ? 'pos' : 'neg';
    const tValTgtClass = t.valueVsTarget >= 0 ? 'pos' : 'neg';
    const tPctTgtClass = t.pctVsTarget >= 100 ? 'pos' : 'neg';
    const tIndexClass  = t.index >= 100 ? 'pos' : 'neg';
    foot.innerHTML = \`<tr>
      <td class="store-col">\${t.storeName}</td>
      <td>\${psFmt(t.sales)}</td>
      <td>\${psFmt(t.salesYA)}</td>
      <td class="\${tIndexClass}">\${psFmtPct(t.index)}</td>
      <td class="\${tValYAClass}">\${psFmt(t.valueVsYA)}</td>
      <td>\${psFmt(t.target)}</td>
      <td class="\${tPctTgtClass}">\${psFmtPct(t.pctVsTarget)}</td>
      <td class="\${tValTgtClass}">\${psFmt(t.valueVsTarget)}</td>
    </tr>\`;
  }

  // Sort click handler
  document.addEventListener('click', (e) => {
    const th = e.target.closest('#psTable thead th.sortable');
    if (!th || !psCurrentData) return;
    const col = th.dataset.col;
    if (psSort.col === col) psSort.asc = !psSort.asc;
    else { psSort.col = col; psSort.asc = false; }
    renderPsTable(psCurrentData);
  });

  function renderPsCharts(data) {
    // Destroy old charts before recreating
    Object.values(psCharts).forEach(c => { if (c) c.destroy(); });

    // Register datalabels plugin once
    if (window.ChartDataLabels && !Chart._datalabelsRegistered) {
      Chart.register(window.ChartDataLabels);
      Chart._datalabelsRegistered = true;
    }

    const GREEN = '#1B5E20';
    const GREEN_LIGHT = '#66BB6A';
    const YELLOW = '#FFC107';
    const RED = '#C62828';

    // Dynamic height for tall horizontal charts: 22px per store + padding
    const tallHeight = Math.max(340, data.rows.length * 22 + 60);
    document.querySelectorAll('.chart-wrap-tall').forEach(el => el.style.height = tallHeight + 'px');

    const compactNum = v => {
      const abs = Math.abs(v);
      if (abs >= 1e9) return (v/1e9).toFixed(1) + 'B';
      if (abs >= 1e6) return (v/1e6).toFixed(1) + 'M';
      if (abs >= 1e3) return (v/1e3).toFixed(0) + 'K';
      return Math.round(v).toString();
    };

    const commonOpts = {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { labels: { font: { size: 11 }, color: '#444' } },
        datalabels: { display: true }
      },
      scales: {
        x: { ticks: { color: '#555', font: { size: 10 } }, grid: { color: '#eee' } },
        y: { ticks: { color: '#555', font: { size: 10 } }, grid: { color: '#eee' } }
      }
    };

    // 1) Monthly Sales Trend (line)
    psCharts.trend = new Chart(document.getElementById('chartTrend'), {
      type: 'line',
      data: {
        labels: data.trendData.map(d => d.month.substring(0,3)),
        datasets: [
          { label: 'Current', data: data.trendData.map(d => d.sC),
            borderColor: GREEN, backgroundColor: 'rgba(27,94,32,0.1)',
            borderWidth: 2.5, tension: 0.3, fill: true, pointRadius: 4, pointBackgroundColor: GREEN },
          { label: 'Year Ago', data: data.trendData.map(d => d.sY),
            borderColor: YELLOW, backgroundColor: 'rgba(255,193,7,0.05)',
            borderWidth: 2, tension: 0.3, borderDash: [5,4], pointRadius: 3, pointBackgroundColor: YELLOW }
        ]
      },
      options: {
        ...commonOpts,
        plugins: {
          ...commonOpts.plugins,
          datalabels: {
            align: 'top', anchor: 'end', offset: 4,
            color: ctx => ctx.dataset.borderColor,
            font: { size: 9, weight: 700 },
            formatter: v => compactNum(v)
          }
        },
        scales: {
          ...commonOpts.scales,
          y: { ...commonOpts.scales.y, ticks: { ...commonOpts.scales.y.ticks, callback: v => compactNum(v) } }
        }
      }
    });

    // 2) Growth Per Area (bar)
    psCharts.area = new Chart(document.getElementById('chartAreaGrowth'), {
      type: 'bar',
      data: {
        labels: data.areaGrowth.map(d => d.area),
        datasets: [{
          label: 'Growth %',
          data: data.areaGrowth.map(d => d.growth),
          backgroundColor: data.areaGrowth.map(d => d.growth >= 0 ? GREEN_LIGHT : RED),
          borderColor: data.areaGrowth.map(d => d.growth >= 0 ? GREEN : RED),
          borderWidth: 1.5
        }]
      },
      options: {
        ...commonOpts,
        plugins: {
          legend: { display: false },
          datalabels: {
            anchor: 'end', align: 'end', offset: 2,
            color: ctx => ctx.dataset.data[ctx.dataIndex] >= 0 ? GREEN : RED,
            font: { size: 11, weight: 700 },
            formatter: v => (v >= 0 ? '+' : '') + v.toFixed(2) + '%'
          }
        },
        scales: {
          ...commonOpts.scales,
          y: { ...commonOpts.scales.y, ticks: { ...commonOpts.scales.y.ticks, callback: v => v + '%' } }
        }
      }
    });

    // 3) Target Achievement per Store (horizontal bar - all stores visible)
    const sortedByTgt = [...data.rows].sort((a,b) => b.pctVsTarget - a.pctVsTarget);
    psCharts.target = new Chart(document.getElementById('chartTarget'), {
      type: 'bar',
      data: {
        labels: sortedByTgt.map(r => r.storeName),
        datasets: [{
          label: '% vs Target',
          data: sortedByTgt.map(r => r.pctVsTarget),
          backgroundColor: sortedByTgt.map(r => r.pctVsTarget >= 100 ? GREEN_LIGHT : YELLOW),
          borderColor: sortedByTgt.map(r => r.pctVsTarget >= 100 ? GREEN : '#F57F17'),
          borderWidth: 1.5
        }]
      },
      options: {
        ...commonOpts,
        indexAxis: 'y',
        plugins: {
          legend: { display: false },
          datalabels: {
            anchor: 'end', align: 'end', offset: 4,
            color: ctx => ctx.dataset.data[ctx.dataIndex] >= 100 ? GREEN : '#E65100',
            font: { size: 10, weight: 700 },
            formatter: v => v.toFixed(1) + '%'
          }
        },
        scales: {
          x: { ticks: { color: '#555', font: { size: 10 }, callback: v => v + '%' }, grid: { color: '#eee' } },
          y: { ticks: { color: '#333', font: { size: 10, weight: 500 }, autoSkip: false }, grid: { display: false } }
        }
      }
    });

    // 4) Growth vs LY % per Store (horizontal bar - all stores visible)
    const sortedByGrowth = [...data.rows].sort((a,b) => b.growth - a.growth);
    psCharts.growth = new Chart(document.getElementById('chartGrowth'), {
      type: 'bar',
      data: {
        labels: sortedByGrowth.map(r => r.storeName),
        datasets: [{
          label: 'Growth %',
          data: sortedByGrowth.map(r => r.growth),
          backgroundColor: sortedByGrowth.map(r => r.growth >= 0 ? GREEN_LIGHT : RED),
          borderColor: sortedByGrowth.map(r => r.growth >= 0 ? GREEN : RED),
          borderWidth: 1.5
        }]
      },
      options: {
        ...commonOpts,
        indexAxis: 'y',
        plugins: {
          legend: { display: false },
          datalabels: {
            anchor: 'end', align: 'end', offset: 4,
            color: ctx => ctx.dataset.data[ctx.dataIndex] >= 0 ? GREEN : RED,
            font: { size: 10, weight: 700 },
            formatter: v => (v >= 0 ? '+' : '') + v.toFixed(2) + '%'
          }
        },
        scales: {
          x: { ticks: { color: '#555', font: { size: 10 }, callback: v => v + '%' }, grid: { color: '#eee' } },
          y: { ticks: { color: '#333', font: { size: 10, weight: 500 }, autoSkip: false }, grid: { display: false } }
        }
      }
    });
  }

  // Trigger load when user opens this tab for the first time
  let psFirstLoad = false;
  const _origSwitch = window.switchTab || switchTab;
  window.switchTab = function(btn, tabId) {
    _origSwitch(btn, tabId);
    if (tabId === 'monthly' && !psFirstLoad) {
      psFirstLoad = true;
      loadPsFilters().then(() => loadStorePerf());
    }
  };

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
