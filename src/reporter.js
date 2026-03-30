// reporter.js — 每日报告（北京时间08:00，CSV）
'use strict';
const fs = require('fs');
const path = require('path');
const logger = require('./logger');
const REPORTS_DIR = path.join(__dirname, '../public/reports');
const MAX_REPORTS = 7;
if (!fs.existsSync(REPORTS_DIR)) fs.mkdirSync(REPORTS_DIR, { recursive: true });

function recordsToCsv(records) {
  const headers = ['币种','合约地址','买入时间','买入SOL','入场价','关联评分','关联类型','关联原因','关联推文','FDV','LP','GMGN'];
  const rows = records.map(r => {
    const buyAt = r.buyAt ? new Date(r.buyAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) : '';
    return [
      r.symbol, r.address, buyAt,
      r.solSpent ?? '', r.entryPrice ?? '',
      r.elonScore ?? '', r.elonMatchType ?? '', r.elonReason ?? '',
      (r.elonTweet ?? '').slice(0, 100),
      r.entryFdv ?? '', r.entryLp ?? '',
      `https://gmgn.ai/sol/token/${r.address}`,
    ].map(v => `"${String(v).replace(/"/g,'""')}"`).join(',');
  });
  return [headers.join(','), ...rows].join('\r\n');
}

function generateReport(records) {
  const now = new Date();
  const bjDate = new Date(now.getTime() + 8 * 3600 * 1000);
  const dateStr = bjDate.toISOString().slice(0, 10);
  const filepath = path.join(REPORTS_DIR, `report_${dateStr}.csv`);
  fs.writeFileSync(filepath, '\uFEFF' + recordsToCsv(records), 'utf-8');
  logger.info(`[Reporter] ✅ 报告: report_${dateStr}.csv (${records.length}笔)`);
  const files = fs.readdirSync(REPORTS_DIR).filter(f => f.startsWith('report_') && f.endsWith('.csv')).sort().reverse();
  files.slice(MAX_REPORTS).forEach(f => fs.unlinkSync(path.join(REPORTS_DIR, f)));
}

function listReports() {
  if (!fs.existsSync(REPORTS_DIR)) return [];
  return fs.readdirSync(REPORTS_DIR)
    .filter(f => f.startsWith('report_') && f.endsWith('.csv')).sort().reverse()
    .map(f => { const s = fs.statSync(path.join(REPORTS_DIR, f)); return { filename: f, url: `/reports/${f}`, size: s.size, date: f.replace('report_','').replace('.csv','') }; });
}

function scheduleDaily(getRecordsFn) {
  function msUntil8am() {
    const now = Date.now();
    const bjNow = new Date(now + 8 * 3600 * 1000);
    const target = new Date(Date.UTC(bjNow.getUTCFullYear(), bjNow.getUTCMonth(), bjNow.getUTCDate(), 0, 0, 0, 0));
    let ms = target.getTime() - now;
    if (ms <= 0) ms += 24 * 3600 * 1000;
    return ms;
  }
  function run() {
    const records = getRecordsFn();
    if (records.length > 0) generateReport(records);
    setTimeout(run, msUntil8am());
  }
  setTimeout(run, msUntil8am());
}

module.exports = { scheduleDaily, generateReport, listReports };
