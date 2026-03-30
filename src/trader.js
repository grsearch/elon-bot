// src/trader.js — Jupiter 买入执行（仅买入，无止损/止盈/卖出逻辑）
'use strict';

const {
  Connection, Keypair, PublicKey,
  VersionedTransaction, LAMPORTS_PER_SOL,
} = require('@solana/web3.js');
const bs58   = require('bs58');
const axios  = require('axios');
const logger = require('./logger');
const { broadcastToClients } = require('./wsHub');

// ── Config ─────────────────────────────────────────────────────
const HELIUS_RPC   = process.env.HELIUS_RPC_URL            || '';
const JUP_API      = process.env.JUPITER_API_URL           || 'https://api.jup.ag';
const JUP_API_KEY  = process.env.JUPITER_API_KEY           || '';
const SLIPPAGE_BPS = parseInt(process.env.SLIPPAGE_BPS     || '500');
const TRADE_SOL    = parseFloat(process.env.TRADE_SIZE_SOL || '2');   // 默认 2 SOL

const SLIPPAGE_MAX_BPS = 2000;   // 动态重试上限 20%
const SOL_MINT         = 'So11111111111111111111111111111111111111112';

function jupHeaders() {
  return JUP_API_KEY ? { 'x-api-key': JUP_API_KEY } : {};
}

// ── Wallet ─────────────────────────────────────────────────────
let _keypair = null;
function getKeypair() {
  if (_keypair) return _keypair;
  const pk = process.env.WALLET_PRIVATE_KEY;
  if (!pk) throw new Error('WALLET_PRIVATE_KEY not set');
  _keypair = Keypair.fromSecretKey(bs58.decode(pk));
  return _keypair;
}

// ── RPC connection ─────────────────────────────────────────────
let _conn = null;
function getConn() {
  if (_conn) return _conn;
  if (!HELIUS_RPC) throw new Error('HELIUS_RPC_URL not set');
  _conn = new Connection(HELIUS_RPC, 'confirmed');
  return _conn;
}

// ── Jupiter Ultra API ─────────────────────────────────────────

async function getSwapOrder({ inputMint, outputMint, amount, slippageBps }) {
  const { data } = await axios.get(`${JUP_API}/ultra/v1/order`, {
    params: {
      inputMint,
      outputMint,
      amount:      Math.floor(amount).toString(),
      slippageBps: slippageBps ?? SLIPPAGE_BPS,
      taker:       getKeypair().publicKey.toBase58(),
    },
    headers: jupHeaders(),
    timeout: 10000,
  });
  return data;
}

async function executeSwapOrder({ requestId, signedTransaction }) {
  const { data } = await axios.post(
    `${JUP_API}/ultra/v1/execute`,
    { requestId, signedTransaction },
    { headers: jupHeaders(), timeout: 30000 }
  );
  return data;
}

function signTx(base64Tx) {
  const kp  = getKeypair();
  const buf = Buffer.from(base64Tx, 'base64');
  const tx  = VersionedTransaction.deserialize(buf);
  tx.sign([kp]);
  return Buffer.from(tx.serialize()).toString('base64');
}

// ── 动态滑点重试 ───────────────────────────────────────────────
// 首次 SLIPPAGE_BPS → 重试1 ×1.5 → 重试2 ×1.5，上限 SLIPPAGE_MAX_BPS
async function executeWithRetry(orderFn, retries = 3) {
  let slippage = SLIPPAGE_BPS;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const order    = await orderFn(slippage);
      const txBase64 = order.transaction;
      if (!txBase64) {
        throw new Error(`Jupiter order missing 'transaction'. Keys: ${Object.keys(order).join(', ')}`);
      }

      const signed = signTx(txBase64);
      const result = await executeSwapOrder({ requestId: order.requestId, signedTransaction: signed });

      if (result.status === 'Success') return result;
      logger.warn(`[Trader] status="${result.status}" attempt=${attempt} slippage=${slippage}bps`);

    } catch (e) {
      logger.warn(`[Trader] attempt=${attempt} slippage=${slippage}bps error: ${e.message}`);
    }

    slippage = Math.min(Math.floor(slippage * 1.5), SLIPPAGE_MAX_BPS);
    if (attempt < retries) await sleep(1500 * attempt);
  }

  throw new Error(`Swap failed after ${retries} retries`);
}

// ── BUY ────────────────────────────────────────────────────────

/**
 * 买入指定代币，固定消耗 TRADE_SIZE_SOL SOL。
 * @param {object} tokenState - { address, symbol, currentPrice }
 * @returns {object|null} position 对象，失败返回 null
 */
async function buy(tokenState) {
  const { address, symbol } = tokenState;
  const solLamports = Math.floor(TRADE_SOL * LAMPORTS_PER_SOL);

  logger.warn(
    `[Trader] BUY ${symbol} | ${TRADE_SOL} SOL | mint=${address}`
  );

  try {
    const result = await executeWithRetry((slipBps) =>
      getSwapOrder({
        inputMint:   SOL_MINT,
        outputMint:  address,
        amount:      solLamports,
        slippageBps: slipBps,
      })
    );

    const tokenBalance     = parseInt(result.outputAmountResult || '0');
    const solSpentLamports = parseInt(result.inputAmountResult  || String(solLamports));

    // 成交后重拉价格作为入场基准（买单执行有延迟）
    let entryPriceUsd = tokenState.currentPrice ?? null;
    try {
      const freshPrice = await require('./birdeye').getPrice(address);
      if (freshPrice && freshPrice > 0) entryPriceUsd = freshPrice;
    } catch (_) {}

    const solSpent = solSpentLamports / LAMPORTS_PER_SOL;

    logger.warn(
      `[Trader] BUY OK ${symbol}` +
      ` | sig=${result.signature?.slice(0, 16)}` +
      ` | got=${tokenBalance} tokens` +
      ` | spent=${solSpent.toFixed(4)} SOL` +
      ` | entryUsd=${entryPriceUsd}`
    );

    broadcastToClients({
      type: 'trade',
      data: {
        id:        Date.now(),
        time:      new Date().toISOString(),
        tradeType: 'BUY',
        symbol,
        mint:      address,
        price:     entryPriceUsd,
        amount:    solSpent,
        sig:       result.signature,
      },
    });

    return {
      tokenBalance,
      initialBalance: tokenBalance,
      solSpent,
      entryPriceUsd,
      txBuy: result.signature,
    };

  } catch (e) {
    logger.warn(`[Trader] BUY FAILED ${symbol}: ${e.message}`);
    return null;
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = { buy, getKeypair, getConn };
