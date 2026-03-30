// src/elonWatcher.js — Elon Musk 推文缓存（每60秒刷新，保留最近30分钟）
//
// X API pay-per-use（按量计费）：
//   充值 credits → Developer Console 扣费
//   每次拉取最多 10 条推文，30分钟窗口内 Elon 原创推文通常 0~5 条
//   24小时内拉到同一条推文不重复计费（X 去重机制）
'use strict';

const axios        = require('axios');
const logger       = require('./logger');
const webshareProxy = require('./webshareProxy');

const BEARER_TOKEN = process.env.X_BEARER_TOKEN || '';
const ELON_USER_ID = '44196397';
const REFRESH_SEC  = parseInt(process.env.ELON_POLL_SEC    || '60');
const WINDOW_HOURS = parseFloat(process.env.ELON_WINDOW_HOURS || '0.5');
const MAX_RESULTS  = 10;
const X_API_BASE   = 'https://api.x.com/2';

let _tweets     = [];   // [{ id, text, created_at }]
let _lastPull   = 0;
let _timer      = null;
let _healthy    = false;
let _errorMsg   = '';

// ── 拉取推文 ──────────────────────────────────────────────────
async function _fetchTweets() {
  if (!BEARER_TOKEN) {
    _errorMsg = 'X_BEARER_TOKEN 未设置';
    logger.warn(`[ElonWatcher] ${_errorMsg}`);
    return;
  }

  // start_time 不能早于7天前（X API限制），但我们只要30分钟，不会触发
  const startTime = new Date(Date.now() - WINDOW_HOURS * 3600 * 1000).toISOString();

  try {
    const { data } = await axios.get(
      `${X_API_BASE}/users/${ELON_USER_ID}/tweets`,
      {
        headers: { Authorization: `Bearer ${BEARER_TOKEN}` },
        params: {
          max_results:  MAX_RESULTS,
          start_time:   startTime,
          tweet_fields: 'created_at,text',
          exclude:      'retweets,replies',
        },
        timeout: 10000,
        ...webshareProxy.getAxiosProxy(),
      }
    );

    // data.data 为 null 表示窗口内没有推文（正常情况）
    const raw  = data?.data || [];
    _tweets    = raw.map(t => ({ id: t.id, text: t.text, created_at: t.created_at }));
    _lastPull  = Date.now();
    _healthy   = true;
    _errorMsg  = '';

    logger.info(
      `[ElonWatcher] ✅ ${_tweets.length} 条原创推文` +
      ` | 窗口=${WINDOW_HOURS * 60}min` +
      (_tweets.length ? ` | 最新="${_tweets[0].text.slice(0, 50)}..."` : ' | (窗口内无推文)')
    );

  } catch (e) {
    _healthy = false;
    const status = e.response?.status;
    const body   = e.response?.data;

    if (status === 400) {
      // 常见原因：start_time 格式问题（极少）或请求参数错误
      _errorMsg = `请求参数错误(400): ${JSON.stringify(body?.errors?.[0] ?? body ?? '')}`;
    } else if (status === 401) {
      _errorMsg = 'Bearer Token 无效或已过期(401)，请在 Developer Console 重新生成';
    } else if (status === 403) {
      _errorMsg = '权限不足(403)：请确认账号已在 developer.x.com 充值 credits 并开启 pay-per-use';
    } else if (status === 429) {
      _errorMsg = 'API 限速(429)，60s 后自动重试';
    } else if (status === 503 || status === 502) {
      _errorMsg = `X API 服务暂时不可用(${status})，稍后重试`;
    } else {
      _errorMsg = `拉取失败 status=${status ?? 'network'}: ${e.message}`;
    }

    logger.warn(`[ElonWatcher] ⚠️  ${_errorMsg}`);
  }
}

// ── 公共接口 ──────────────────────────────────────────────────

/** 返回当前缓存的推文文本列表 */
function getTweets() {
  return _tweets.map(t => t.text);
}

/** 返回缓存状态（供 dashboard 展示） */
function getStatus() {
  return {
    count:        _tweets.length,
    lastPullAt:   _lastPull ? new Date(_lastPull).toISOString() : null,
    windowMins:   Math.round(WINDOW_HOURS * 60),
    pollSec:      REFRESH_SEC,
    healthy:      _healthy,
    errorMsg:     _errorMsg || null,
    preview:      _tweets[0]?.text?.slice(0, 80) ?? null,
  };
}

/** 启动定时刷新 */
function start() {
  if (_timer) return;
  logger.info(
    `[ElonWatcher] 启动 — 每 ${REFRESH_SEC}s 拉取，窗口 ${WINDOW_HOURS * 60}min` +
    ` | 端点: ${X_API_BASE}/users/${ELON_USER_ID}/tweets`
  );
  _fetchTweets();
  _timer = setInterval(_fetchTweets, REFRESH_SEC * 1000);
}

/** 停止 */
function stop() {
  if (_timer) { clearInterval(_timer); _timer = null; }
}

module.exports = { start, stop, getTweets, getStatus };

