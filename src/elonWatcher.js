// src/elonWatcher.js — Elon Musk 推文缓存（每60秒刷新，保留最近4小时）
'use strict';

const axios  = require('axios');
const logger = require('./logger');

const BEARER_TOKEN    = process.env.X_BEARER_TOKEN || '';
const ELON_USER_ID    = '44196397';           // @elonmusk 固定 ID
const REFRESH_SEC     = parseInt(process.env.ELON_POLL_SEC || '60');
const WINDOW_HOURS    = parseFloat(process.env.ELON_WINDOW_HOURS || '0.5'); // 默认30分钟
const MAX_RESULTS     = 20;                   // X API 单次最多 100，20 条足够

let _tweets   = [];      // [{ id, text, created_at }]
let _lastPull = 0;
let _timer    = null;
let _healthy  = false;

// ── 拉取推文 ──────────────────────────────────────────────────
async function _fetchTweets() {
  if (!BEARER_TOKEN) {
    logger.warn('[ElonWatcher] X_BEARER_TOKEN 未设置，跳过拉取');
    return;
  }

  const startTime = new Date(Date.now() - WINDOW_HOURS * 3600 * 1000).toISOString();

  try {
    const { data } = await axios.get(
      `https://api.twitter.com/2/users/${ELON_USER_ID}/tweets`,
      {
        headers:  { Authorization: `Bearer ${BEARER_TOKEN}` },
        params: {
          max_results:  MAX_RESULTS,
          start_time:   startTime,
          tweet_fields: 'created_at,text',
          exclude:      'retweets,replies',  // 过滤转推 + 过滤回复，只保留原创推文
        },
        timeout: 10000,
      }
    );

    const raw = data?.data || [];
    _tweets   = raw.map(t => ({ id: t.id, text: t.text, created_at: t.created_at }));
    _lastPull = Date.now();
    _healthy  = true;

    logger.info(
      `[ElonWatcher] ✅ 拉取 ${_tweets.length} 条推文` +
      ` | 窗口=${WINDOW_HOURS}h | 最新="${_tweets[0]?.text?.slice(0, 40) ?? '(空)'}..."`
    );
  } catch (e) {
    _healthy = false;
    const status = e.response?.status;
    if (status === 429) {
      logger.warn('[ElonWatcher] ⚠️  X API 限速 (429)，60s 后重试');
    } else {
      logger.warn(`[ElonWatcher] 拉取失败 status=${status}: ${e.message}`);
    }
  }
}

// ── 公共接口 ──────────────────────────────────────────────────

/** 返回当前缓存的推文文本列表（最多 MAX_RESULTS 条） */
function getTweets() {
  return _tweets.map(t => t.text);
}

/** 返回缓存状态（供 dashboard 展示） */
function getStatus() {
  return {
    count:       _tweets.length,
    lastPullAt:  _lastPull ? new Date(_lastPull).toISOString() : null,
    windowHours: WINDOW_HOURS,
    healthy:     _healthy,
    preview:     _tweets[0]?.text?.slice(0, 80) ?? null,
  };
}

/** 启动定时刷新 */
function start() {
  if (_timer) return;
  logger.info(`[ElonWatcher] 启动 — 每 ${REFRESH_SEC}s 拉取一次，窗口 ${WINDOW_HOURS}h`);
  _fetchTweets();                                          // 立即拉一次
  _timer = setInterval(_fetchTweets, REFRESH_SEC * 1000);
}

/** 停止 */
function stop() {
  if (_timer) { clearInterval(_timer); _timer = null; }
}

module.exports = { start, stop, getTweets, getStatus };
