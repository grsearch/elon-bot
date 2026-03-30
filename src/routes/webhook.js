// src/routes/webhook.js — 接收 pump.fun 迁移事件
const express          = require('express');
const router           = express.Router();
const logger           = require('../logger');
const { TokenMonitor } = require('../monitor');

/**
 * POST /webhook/add-token
 * Body（迁移扫描服务器发送）:
 * {
 *   "network":     "solana",
 *   "address":     "MINT_ADDRESS",
 *   "symbol":      "TOKEN",
 *   "name":        "Token Name",       // 可选，有时 pump.fun 会带
 *   "description": "Token desc...",    // 可选
 *   "xMentions":   12,                 // 可选
 *   "holders":     203,                // 可选
 *   "top10Pct":    "45.3%",            // 可选
 *   "devPct":      "8.1%"              // 可选
 * }
 */
router.post('/add-token', async (req, res) => {
  const {
    address, symbol, name, description,
    network, xMentions, holders, top10Pct, devPct,
  } = req.body || {};

  if (!address) return res.status(400).json({ ok: false, error: 'Missing address' });

  logger.info(`[Webhook] 收到迁移代币: ${symbol || '?'} @ ${address}`);

  try {
    // 如果 webhook body 里带了 name/description，传入 monitor 缓存，
    // 这样 _processToken 可直接使用，减少 Birdeye 调用次数。
    const result = await TokenMonitor.getInstance().addToken({
      address, symbol, name, description,
      network, xMentions, holders, top10Pct, devPct,
    });
    return res.json({ ok: result.ok, reason: result.reason || null });
  } catch (e) {
    logger.warn(`[Webhook] addToken error: ${e.message}`);
    return res.status(500).json({ ok: false, error: e.message });
  }
});

// GET /webhook/status — 健康检查
router.get('/status', (req, res) => {
  const monitor = TokenMonitor.getInstance();
  res.json({
    ok:        true,
    tokens:    monitor.tokens.size,
    uptime:    process.uptime().toFixed(0) + 's',
    timestamp: new Date().toISOString(),
  });
});

module.exports = router;
