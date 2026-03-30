// src/routes/dashboard.js — REST API
const express          = require('express');
const router           = express.Router();
const { TokenMonitor } = require('../monitor');
const elonWatcher      = require('../elonWatcher');

// GET /api/dashboard — 完整快照
router.get('/dashboard', (req, res) => {
  res.json(TokenMonitor.getInstance().getDashboardData());
});

// GET /api/tokens — 当前持仓列表
router.get('/tokens', (req, res) => {
  const tokens = [...TokenMonitor.getInstance().tokens.values()].map(s => ({
    address:       s.address,
    symbol:        s.symbol,
    fdv:           s.fdv,
    lp:            s.lp,
    currentPrice:  s.currentPrice,
    entryPrice:    s.position?.entryPriceUsd ?? null,
    tokenBalance:  s.position?.tokenBalance  ?? 0,
    solSpent:      s.position?.solSpent      ?? null,
    pnlPct:        s.pnlPct,
    elonScore:     s.elonScore,
    elonReason:    s.elonReason,
    elonMatchType: s.elonMatchType,
    elonTweet:     s.elonTweet,
    inPosition:    s.inPosition,
    addedAt:       s.addedAt,
  }));
  res.json(tokens);
});

// GET /api/trades — 近期操作日志
router.get('/trades', (req, res) => {
  res.json(TokenMonitor.getInstance().tradeLog.slice(0, 100));
});

// GET /api/trade-records — 24h 完整交易记录
router.get('/trade-records', (req, res) => {
  res.json(TokenMonitor.getInstance().getTradeRecords());
});

// GET /api/elon — Elon 推文缓存状态
router.get('/elon', (req, res) => {
  res.json(elonWatcher.getStatus());
});

// DELETE /api/tokens/:address — 手动从持仓列表移除（不执行卖出）
router.delete('/tokens/:address', (req, res) => {
  const monitor = TokenMonitor.getInstance();
  const state   = monitor.tokens.get(req.params.address);
  if (!state) return res.status(404).json({ ok: false, error: 'Token not found' });
  monitor.removeToken(state.address, 'MANUAL_REMOVE');
  res.json({ ok: true });
});

module.exports = router;
