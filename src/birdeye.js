// src/birdeye.js — 原版直接复用
const axios  = require('axios');
const logger = require('./logger');
const BASE = 'https://public-api.birdeye.so';
const KEY  = process.env.BIRDEYE_API_KEY || '';
const client = axios.create({ baseURL: BASE, timeout: 8000, headers: { 'X-API-KEY': KEY, 'x-chain': 'solana' } });
async function getPrice(address) {
  try { const { data } = await client.get('/defi/price', { params: { address } }); return data?.data?.value ?? null; }
  catch (e) { logger.warn(`[Birdeye] getPrice ${address.slice(0,8)}: ${e.message}`); return null; }
}
async function getTokenOverview(address) {
  try { const { data } = await client.get('/defi/token_overview', { params: { address } }); return data?.data ?? null; }
  catch (e) { logger.warn(`[Birdeye] getTokenOverview ${address.slice(0,8)}: ${e.message}`); return null; }
}
module.exports = { getPrice, getTokenOverview };
