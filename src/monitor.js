// src/monitor.js — Elon MEME Bot 核心引擎
//
// 流程：
//   webhook 收到迁移代币
//   → 拉取代币元数据（Birdeye）
//   → 调用 Grok 评分（代币 × Elon 近4h推文）
//   → score >= SCORE_THRESHOLD → 立即买入 TRADE_SIZE_SOL (2 SOL)
//   → score <  SCORE_THRESHOLD → 丢弃，记录日志
//
// 买入后每60秒轮询 Birdeye 价格，更新持仓浮动盈亏供 dashboard 展示。
// 无止损/止盈/EMA，不主动卖出。

'use strict';

const birdeye                = require('./birdeye');
const trader                 = require('./trader');
const { scoreToken }         = require('./scorer');
const elonWatcher            = require('./elonWatcher');
const { broadcastToClients } = require('./wsHub');
const logger                 = require('./logger');

// ── 配置 ──────────────────────────────────────────────────────
const DEDUP_SEC       = parseInt(process.env.DEDUP_SEC       || '300'); // 去重窗口，默认5分钟
const PRICE_POLL_SEC  = parseInt(process.env.PRICE_POLL_SEC  || '60');  // 价格轮询间隔，默认60秒

class TokenMonitor {
  static instance = null;
  static getInstance() {
    if (!TokenMonitor.instance) TokenMonitor.instance = new TokenMonitor();
    return TokenMonitor.instance;
  }

  constructor() {
    this.tokens       = new Map();  // Map<address, TokenState>（只含已买入的）
    this.tradeLog     = [];         // 最近 200 条操作日志（买入 + 跳过）
    this.tradeRecords = [];         // 24h 交易记录（stats 页面）
    this._recentSeen  = new Map();  // Map<address, timestamp> 去重
    this._dashTimer   = null;
    this._priceTimer  = null;       // 每60秒轮询 Birdeye 价格
    this._cleanTimer  = null;
  }

  // ── 主入口：webhook 调用此方法 ─────────────────────────────
  async addToken({ address, symbol, network = 'solana', xMentions, holders, top10Pct, devPct }) {

    // ── 去重检查 ───────────────────────────────────────────────
    const now     = Date.now();
    const lastSeen = this._recentSeen.get(address);
    if (lastSeen && now - lastSeen < DEDUP_SEC * 1000) {
      logger.info(`[Monitor] 去重跳过 ${symbol} (${address.slice(0, 8)}) — ${Math.round((now - lastSeen) / 1000)}s ago`);
      return { ok: false, reason: 'dedup' };
    }
    this._recentSeen.set(address, now);

    logger.info(`[Monitor] 📥 收到迁移代币: ${symbol || address.slice(0, 8)} (${address})`);

    // ── 异步处理，立即返回 200 给 webhook ─────────────────────
    this._processToken({ address, symbol, network, xMentions, holders, top10Pct, devPct })
      .catch(e => logger.warn(`[Monitor] _processToken error ${symbol}: ${e.message}`));

    return { ok: true };
  }

  // ── 核心处理流程 ───────────────────────────────────────────
  async _processToken({ address, symbol, network, xMentions, holders, top10Pct, devPct }) {

    // Step 1: 拉取 Birdeye 元数据
    let meta = {};
    try {
      const overview = await birdeye.getTokenOverview(address);
      if (overview) {
        meta = {
          name:        overview.name        || symbol || address.slice(0, 8),
          symbol:      overview.symbol      || symbol || address.slice(0, 8),
          description: overview.description || '',
          fdv:         overview.fdv         ?? overview.mc        ?? null,
          lp:          overview.liquidity   ?? null,
        };
        // pump.fun 元数据字段（有些 overview 会带）
        if (overview.extensions?.description) meta.description = overview.extensions.description;
      }
    } catch (e) {
      logger.warn(`[Monitor] Birdeye meta 失败 ${symbol}: ${e.message}`);
    }

    const tokenName = meta.name   || symbol || address.slice(0, 8);
    const tokenSym  = meta.symbol || symbol || address.slice(0, 8);
    const tokenDesc = meta.description || '';

    logger.info(`[Monitor] 元数据 ${tokenSym} | FDV=$${meta.fdv?.toLocaleString() ?? '?'} LP=$${meta.lp?.toLocaleString() ?? '?'} | desc="${tokenDesc.slice(0, 60)}"`);

    // Step 2: 获取 Elon 推文缓存
    const tweets = elonWatcher.getTweets();
    logger.info(`[Monitor] Elon 推文缓存: ${tweets.length} 条`);

    // Step 3: Grok 关联评分
    const scoreResult = await scoreToken(
      { name: tokenName, symbol: tokenSym, description: tokenDesc },
      tweets
    );

    // Step 4: 根据评分决策
    if (!scoreResult.pass) {
      logger.info(
        `[Monitor] ❌ 跳过 ${tokenSym}` +
        ` | score=${scoreResult.score.toFixed(2)}` +
        ` | reason="${scoreResult.reason}"`
      );
      this._addTradeLog({
        type:    'SKIP',
        symbol:  tokenSym,
        address,
        score:   scoreResult.score,
        reason:  scoreResult.reason,
      });
      broadcastToClients({ type: 'token_skipped', data: { address, symbol: tokenSym, score: scoreResult.score, reason: scoreResult.reason } });
      return;
    }

    // Step 5: 通过评分 → 买入
    logger.warn(
      `[Monitor] ✅ 关联命中 ${tokenSym}` +
      ` | score=${scoreResult.score.toFixed(2)}` +
      ` | type=${scoreResult.match_type}` +
      ` | "${scoreResult.reason}"` +
      ` | 推文: "${scoreResult.matched_tweet?.slice(0, 60) ?? ''}"`
    );

    const state = {
      address,
      symbol:        tokenSym,
      network,
      addedAt:       Date.now(),
      currentPrice:  null,
      fdv:           meta.fdv,
      lp:            meta.lp,
      // 评分信息
      elonScore:     scoreResult.score,
      elonReason:    scoreResult.reason,
      elonMatchType: scoreResult.match_type,
      elonTweet:     scoreResult.matched_tweet,
      // 扫描服务器数据
      xMentions:     xMentions ?? null,
      holders:       holders   ?? null,
      top10Pct:      top10Pct  ?? null,
      devPct:        devPct    ?? null,
      // 持仓状态
      position:      null,
      inPosition:    false,
      pnlPct:        null,
    };

    const pos = await trader.buy(state);

    if (pos) {
      state.position   = pos;
      state.inPosition = true;
      this.tokens.set(address, state);

      this._addTradeLog({
        type:        'BUY',
        symbol:      tokenSym,
        address,
        score:       scoreResult.score,
        reason:      scoreResult.reason,
        matchType:   scoreResult.match_type,
        matchedTweet: scoreResult.matched_tweet,
        solSpent:    pos.solSpent,
        entryPrice:  pos.entryPriceUsd,
      });

      this._createTradeRecord(state, pos);
      broadcastToClients({ type: 'token_added', data: this._stateView(state) });

    } else {
      logger.warn(`[Monitor] ⚠️  ${tokenSym} 买入失败（Jupiter 错误）`);
      this._addTradeLog({
        type:   'BUY_FAILED',
        symbol: tokenSym,
        address,
        score:  scoreResult.score,
        reason: '买入执行失败',
      });
    }
  }

  // ── 启动 ──────────────────────────────────────────────────
  start() {
    logger.info(`[Monitor] 🚀 Elon MEME Bot 启动 | 价格轮询 ${PRICE_POLL_SEC}s`);

    // 每5秒推送一次 dashboard 快照
    this._dashTimer = setInterval(() => {
      broadcastToClients({ type: 'update', data: this.getDashboardData() });
    }, 5000);

    // 每 PRICE_POLL_SEC 秒轮询所有持仓的最新价格，更新浮动盈亏
    this._priceTimer = setInterval(() => this._pollPrices(), PRICE_POLL_SEC * 1000);

    // 每小时清理过期去重记录
    this._cleanTimer = setInterval(() => {
      const cutoff = Date.now() - DEDUP_SEC * 1000 * 10;
      for (const [addr, ts] of this._recentSeen.entries()) {
        if (ts < cutoff) this._recentSeen.delete(addr);
      }
    }, 3600 * 1000);

    // 启动 Elon 推文监听
    elonWatcher.start();
  }

  stop() {
    if (this._dashTimer)  clearInterval(this._dashTimer);
    if (this._priceTimer) clearInterval(this._priceTimer);
    if (this._cleanTimer) clearInterval(this._cleanTimer);
    elonWatcher.stop();
    logger.info('[Monitor] Stopped');
  }

  // ── 手动移除（dashboard 用） ────────────────────────────────
  removeToken(addr, reason) {
    const state = this.tokens.get(addr);
    if (state) {
      logger.info(`[Monitor] 🗑  Removed ${state.symbol} — ${reason}`);
      this.tokens.delete(addr);
      broadcastToClients({ type: 'token_removed', data: { address: addr, reason } });
    }
  }

  // ── 价格轮询（每 PRICE_POLL_SEC 秒）─────────────────────────
  // 只更新 currentPrice 和 pnlPct，供 dashboard 实时展示浮动盈亏。
  // 不做任何交易决策。
  async _pollPrices() {
    if (this.tokens.size === 0) return;

    for (const [addr, state] of this.tokens.entries()) {
      try {
        const price = await birdeye.getPrice(addr);
        if (price !== null && price > 0) {
          state.currentPrice = price;

          // 更新浮动盈亏（仅用于展示）
          const entry = state.position?.entryPriceUsd;
          if (entry && entry > 0) {
            state.pnlPct = ((price - entry) / entry * 100).toFixed(2);
          }
        }
      } catch (e) {
        logger.warn(`[Monitor] 价格轮询失败 ${state.symbol}: ${e.message}`);
      }
      // 每个代币之间间隔 200ms，避免同时触发 Birdeye 限速
      await new Promise(r => setTimeout(r, 200));
    }

    logger.info(`[Monitor] 价格轮询完成 | ${this.tokens.size} 个持仓`);
  }

  // ── 24h 交易记录 ──────────────────────────────────────────
  _createTradeRecord(state, pos) {
    const rec = {
      id:           state.address,
      address:      state.address,
      symbol:       state.symbol,
      buyAt:        Date.now(),
      entryFdv:     state.fdv,
      entryLp:      state.lp,
      entryLpFdv:   state.fdv ? +((state.lp / state.fdv) * 100).toFixed(1) : null,
      xMentions:    state.xMentions,
      holders:      state.holders,
      top10Pct:     state.top10Pct,
      devPct:       state.devPct,
      elonScore:    state.elonScore,
      elonReason:   state.elonReason,
      elonMatchType: state.elonMatchType,
      elonTweet:    state.elonTweet,
      solSpent:     pos.solSpent,
      entryPrice:   pos.entryPriceUsd,
      exitAt:       null,
      exitReason:   null,
      exitFdv:      null,
      solReceived:  null,
      pnlPct:       null,
      currentFdv:   state.fdv,
    };
    this.tradeRecords.unshift(rec);
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    this.tradeRecords = this.tradeRecords.filter(r => r.buyAt > cutoff);
  }

  getTradeRecords() {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    return this.tradeRecords.filter(r => r.buyAt > cutoff);
  }

  _addTradeLog(entry) {
    const log = { id: Date.now(), time: new Date().toISOString(), ...entry };
    this.tradeLog.unshift(log);
    if (this.tradeLog.length > 200) this.tradeLog.length = 200;
    broadcastToClients({ type: 'trade_log', data: log });
  }

  _stateView(s) {
    return {
      address:       s.address,
      symbol:        s.symbol,
      fdv:           s.fdv,
      lp:            s.lp,
      currentPrice:  s.currentPrice,
      entryPrice:    s.position?.entryPriceUsd ?? null,
      tokenBalance:  s.position?.tokenBalance  ?? 0,
      solSpent:      s.position?.solSpent       ?? null,
      pnlPct:        s.pnlPct,
      elonScore:     s.elonScore,
      elonReason:    s.elonReason,
      elonMatchType: s.elonMatchType,
      elonTweet:     s.elonTweet,
      inPosition:    s.inPosition,
      addedAt:       s.addedAt,
    };
  }

  getDashboardData() {
    return {
      tokens:      [...this.tokens.values()].map(s => this._stateView(s)),
      tradeLog:    this.tradeLog.slice(0, 100),
      uptime:      process.uptime(),
      tokenCount:  this.tokens.size,
      elonWatcher: elonWatcher.getStatus(),
    };
  }
}

module.exports = { TokenMonitor };
