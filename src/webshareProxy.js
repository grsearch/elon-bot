// src/webshareProxy.js — Webshare 旋转代理配置
//
// Webshare 旋转代理统一入口：
//   host: p.webshare.io  port: 80
//   username / password  → 从控制台 Proxy → Overview 页面获取
//
// 用法：在 .env 填入
//   WEBSHARE_PROXY_USERNAME=你的用户名
//   WEBSHARE_PROXY_PASSWORD=你的密码
//
// axios 代理配置通过 getAxiosProxy() 获取，直接展开进请求选项即可。
'use strict';

const axios  = require('axios');
const logger = require('./logger');

const WEBSHARE_API_KEY = process.env.WEBSHARE_API_KEY || '';

// Webshare 旋转代理固定入口（Backbone / Rotating）
const PROXY_HOST = 'p.webshare.io';
const PROXY_PORT = 80;

// 缓存从 API 拉到的凭证
let _username = process.env.WEBSHARE_PROXY_USERNAME || '';
let _password = process.env.WEBSHARE_PROXY_PASSWORD || '';
let _ready    = false;

// ── 从 Webshare API 自动拉取代理用户名密码 ────────────────────
// 如果 .env 已手动填写 WEBSHARE_PROXY_USERNAME/PASSWORD 则跳过
async function init() {
  // 优先用手动填写的凭证
  if (_username && _password) {
    _ready = true;
    logger.info(`[Proxy] Webshare 代理就绪（手动配置）| ${PROXY_HOST}:${PROXY_PORT} | user=${_username}`);
    return;
  }

  // 没有手动填写 → 用 API Key 自动拉取
  if (!WEBSHARE_API_KEY) {
    logger.warn('[Proxy] 未配置 WEBSHARE_API_KEY / WEBSHARE_PROXY_USERNAME，代理不可用');
    return;
  }

  try {
    // 拉取账户下的代理配置（包含 username/password）
    const { data } = await axios.get(
      'https://proxy.webshare.io/api/v2/proxy/config/',
      {
        headers: { Authorization: `Token ${WEBSHARE_API_KEY}` },
        timeout: 10000,
      }
    );

    _username = data?.username || '';
    _password = data?.password || '';

    if (_username && _password) {
      _ready = true;
      logger.info(`[Proxy] Webshare 代理就绪（API自动配置）| ${PROXY_HOST}:${PROXY_PORT} | user=${_username}`);
    } else {
      logger.warn('[Proxy] Webshare API 返回了空的 username/password，请检查账户状态');
    }
  } catch (e) {
    logger.warn(`[Proxy] 拉取 Webshare 代理配置失败: ${e.message}`);
  }
}

// ── 返回 axios 代理配置对象 ────────────────────────────────────
// 使用方式: const { data } = await axios.get(url, { ...getAxiosProxy(), ...其他选项 })
function getAxiosProxy() {
  if (!_ready) return {};
  return {
    proxy: {
      protocol: 'http',
      host:     PROXY_HOST,
      port:     PROXY_PORT,
      auth: {
        username: _username,
        password: _password,
      },
    },
  };
}

function isReady() { return _ready; }

module.exports = { init, getAxiosProxy, isReady };
