// src/scorer.js — 代币 × Elon 推文关联评分（Grok API）
'use strict';

const axios         = require('axios');
const logger        = require('./logger');
const webshareProxy = require('./webshareProxy');

const GROK_KEY        = process.env.GROK_API_KEY || '';
const SCORE_THRESHOLD = parseFloat(process.env.SCORE_THRESHOLD || '0.6');
const GROK_MODEL      = process.env.GROK_MODEL || 'grok-4-1-fast';
const GROK_API        = 'https://api.x.ai/v1/chat/completions';

// ── 构建 Prompt ───────────────────────────────────────────────
function buildPrompt(token, tweets) {
  const tweetBlock = tweets.length
    ? tweets.map((t, i) => `[${i + 1}] ${t}`).join('\n')
    : '（暂无推文数据）';

  return `你是一个加密货币叙事分析专家，专注于识别 Elon Musk 推文与 MEME 代币之间的关联。

## 待分析的 MEME 代币

- 名称: ${token.name || '(未知)'}
- 符号: $${token.symbol || '(未知)'}
- 描述: ${token.description || '(无描述)'}

## Elon Musk 最近 ${process.env.ELON_WINDOW_HOURS || '4'} 小时内的推文

${tweetBlock}

## 分析任务

判断该代币是否与上述任意推文存在叙事关联。关联类型包括（但不限于）：
1. 代币名称/符号直接出自推文中的词汇、人名、地名
2. 代币描述的主题/梗与推文话题高度一致
3. 代币关联 Elon 提及的公司、产品、概念（如 xAI、DOGE、Tesla、SpaceX、Grok 等）
4. 推文中的特定 emoji、俚语、网络梗被用作代币命名

## 输出要求

只返回以下 JSON，不要任何多余文字：
{
  "score": <0.0 到 1.0 的浮点数，0=完全无关，1=强烈关联>,
  "matched_tweet": "<最相关推文的前80字，无关联则填 null>",
  "match_type": "<direct_name | theme | meme | company | none>",
  "reason": "<30字内的中文说明>"
}`;
}

// ── 解析 Grok 返回 ──────────────────────────────────────────
function parseResponse(text) {
  // 去掉可能的 markdown 代码块
  const clean = text.replace(/```json|```/g, '').trim();
  return JSON.parse(clean);
}

// ── 主评分函数 ────────────────────────────────────────────────

/**
 * 对一个代币和当前 Elon 推文列表做关联评分。
 * @param {object} token   - { name, symbol, description }
 * @param {string[]} tweets - Elon 推文文本数组
 * @returns {Promise<{score, matched_tweet, match_type, reason, pass}>}
 */
async function scoreToken(token, tweets) {
  if (!GROK_KEY) {
    logger.warn('[Scorer] GROK_API_KEY 未设置，跳过评分，默认 pass=false');
    return { score: 0, matched_tweet: null, match_type: 'none', reason: 'API key 未配置', pass: false };
  }

  if (!tweets.length) {
    logger.warn(`[Scorer] ${token.symbol} — 推文缓存为空，跳过评分`);
    return { score: 0, matched_tweet: null, match_type: 'none', reason: '推文缓存为空', pass: false };
  }

  const prompt = buildPrompt(token, tweets);

  try {
    // Grok API 兼容 OpenAI Chat Completions 格式
    const { data } = await axios.post(
      GROK_API,
      {
        model:      GROK_MODEL,
        max_tokens: 256,
        messages: [
          { role: 'system', content: '你是一个加密货币叙事分析专家。只输出 JSON，不要任何其他文字。' },
          { role: 'user',   content: prompt },
        ],
      },
      {
        headers: {
          'Authorization': `Bearer ${GROK_KEY}`,
          'Content-Type':  'application/json',
        },
        timeout: 15000,
        ...webshareProxy.getAxiosProxy(),   // Webshare 代理
      }
    );

    const raw    = data?.choices?.[0]?.message?.content || '';
    const result = parseResponse(raw);
    const pass   = result.score >= SCORE_THRESHOLD;

    logger.warn(
      `[Scorer] ${token.symbol}` +
      ` score=${result.score.toFixed(2)}` +
      ` type=${result.match_type}` +
      ` pass=${pass}` +
      ` reason="${result.reason}"`
    );

    return { ...result, pass };

  } catch (e) {
    logger.warn(`[Scorer] Grok API 调用失败 ${token.symbol}: ${e.message}`);
    return { score: 0, matched_tweet: null, match_type: 'none', reason: `API错误: ${e.message}`, pass: false };
  }
}

module.exports = { scoreToken, SCORE_THRESHOLD };
