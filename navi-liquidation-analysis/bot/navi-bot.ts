/**
 * NAVI Liquidation Monitor Bot
 *
 * Architecture:
 *   PythMonitor ──priceQueue──▶ HFUpdater ──liquidationQueue──▶ Liquidator
 *   EventMonitor ─────────────▶ PositionStore
 *                                    ▲
 *                              init_bot / 30-min refresh
 *
 * Run:  npm run bot          (live mode — submits transactions)
 *       npm run bot:dry      (dry-run — logs opportunities only)
 *
 * Required config:
 *   bot_key in config.json — hex private key (no 0x prefix), only needed in live mode
 *
 * First-time setup:
 *   npx tsx bot/init_bot.ts   builds the full position cache (~10-20 min)
 *   npm run bot               starts monitoring from cache
 */

import { writeFileSync, mkdirSync } from "fs";

import { tg } from "./telegram.js";
import { SuiClient } from "@mysten/sui/client";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Transaction } from "@mysten/sui/transactions";
import WebSocket from "ws";
import { SuiPriceServiceConnection, SuiPythClient } from "@pythnetwork/pyth-sui-js";
const { getHealthFactor: naviGetHealthFactor } =
  await import("@naviprotocol/lending" as any) as any;

import {
  CLOCK, RAY, DRY_RUN, MIN_PROFIT_USD, GAS_BUDGET_MIST,
  HF_SLOW_THRESHOLD, SLOW_INTERVAL_MS, ASSETS, BOT_KEY,
} from "./config.js";
import { MAINNET, buildTestnetAddrs, isTestnet, NetworkAddrs, BROADCAST_RPCS, RpcPool, SCAN_RPCS } from "./network.js";
import { buildLiquidationTx, LiqOpp } from "./liquidation-executor.js";
import {
  BotState,
  UserPosition,
  LiquidationOpp,
  reserveCache,
  liveIndex,
  loadAssetConfigs,
  loadOraclePrices,
  loadUserPosition,
  loadPositions,
  savePositionsCache,
  loadPositionsFromCache,
  ensureStorageTables,
  getReserveInfo,
  storeUserInfosTableId,
  POSITIONS_CACHE,
} from "./position-store.js";

// ── logging ───────────────────────────────────────────────────────────────────

const log = {
  info:  (...a: unknown[]) => console.log(`[${ts()}] INFO `, ...a),
  warn:  (...a: unknown[]) => console.warn(`[${ts()}] WARN `, ...a),
  error: (...a: unknown[]) => console.error(`[${ts()}] ERROR`, ...a),
  debug: (...a: unknown[]) => process.env.DEBUG && console.debug(`[${ts()}] DEBUG`, ...a),
};
const ts = () => new Date().toISOString().slice(11, 23);

// ── Sui clients ───────────────────────────────────────────────────────────────

let addrs:    NetworkAddrs = MAINNET;
let client  = new SuiClient({ url: MAINNET.SUI_RPC });
let scanPool = new RpcPool(SCAN_RPCS);

const pythConn = new SuiPriceServiceConnection("https://hermes.pyth.network");
let _pythClient: SuiPythClient | null = null;
function getPythClient(): SuiPythClient {
  if (!_pythClient) {
    _pythClient = new SuiPythClient(client, addrs.PYTH_STATE_ID, addrs.WORMHOLE_STATE_ID);
  }
  return _pythClient;
}

// Broadcast signed tx to all configured RPCs; return first success digest.
async function broadcastTx(tx: Transaction, keypair: Ed25519Keypair): Promise<string> {
  const bytes = await tx.build({ client });
  const { signature } = await keypair.signTransaction(bytes);

  if (BROADCAST_RPCS.length === 1) {
    const r = await client.executeTransactionBlock({
      transactionBlock: bytes, signature, options: { showEffects: true },
    });
    if (r.effects?.status?.status !== "success")
      throw new Error(`TX failed: ${JSON.stringify(r.effects?.status)}`);
    return r.digest;
  }

  const results = await Promise.allSettled(
    BROADCAST_RPCS.map(url =>
      new SuiClient({ url }).executeTransactionBlock({
        transactionBlock: bytes, signature, options: { showEffects: true },
      }).then(r => {
        if (r.effects?.status?.status !== "success")
          throw new Error(`TX failed on ${url}: ${JSON.stringify(r.effects?.status)}`);
        return r.digest;
      })
    )
  );

  const first = results.find(r => r.status === "fulfilled") as PromiseFulfilledResult<string> | undefined;
  if (!first) throw new Error(results.map(r => r.status === "rejected" ? r.reason : "").join(" | "));
  log.debug(`Broadcast to ${BROADCAST_RPCS.length} RPCs, won: ${first.value.slice(0, 16)}...`);
  return first.value;
}

// ── utilities ─────────────────────────────────────────────────────────────────

async function withRetry<T>(fn: () => Promise<T>, attempts = 3, baseMs = 1500): Promise<T> {
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); }
    catch (e) {
      if (i === attempts - 1) throw e;
      log.warn(`Retry ${i + 1}/${attempts - 1}: ${e}`);
      await sleep(baseMs * (i + 1));
    }
  }
  throw new Error("unreachable");
}

async function addOracleUpdates(tx: Transaction, ...assetIds: number[]): Promise<void> {
  if (!addrs.ORACLE_PRO_PKG) return;

  const seen      = new Set<string>();
  const pythFeeds = new Map<string, number>();
  const naviFeeds: { feed: typeof addrs.ORACLE_PRO_FEEDS[number] }[] = [];

  for (const id of assetIds) {
    const feed       = addrs.ORACLE_PRO_FEEDS[id];
    const pythFeedId = ASSETS[id]?.pyth;
    if (!feed || seen.has(feed.feedId)) continue;
    seen.add(feed.feedId);
    if (pythFeedId) pythFeeds.set(pythFeedId, id);
    naviFeeds.push({ feed });
  }

  if (pythFeeds.size > 0) {
    const feedIdList = [...pythFeeds.keys()];
    try {
      const updates = await pythConn.getPriceFeedsUpdateData(feedIdList);
      await getPythClient().updatePriceFeeds(tx, updates, feedIdList);
      log.debug(`[ORACLE] pushed Pyth VAA for ${feedIdList.length} feed(s)`);
    } catch (e) {
      log.warn(`[ORACLE] Pyth VAA push failed (proceeding without): ${e}`);
    }
  }

  for (const { feed } of naviFeeds) {
    tx.moveCall({
      target: `${addrs.ORACLE_PRO_PKG}::oracle_pro::update_single_price_v2`,
      arguments: [
        tx.object(CLOCK),
        tx.sharedObjectRef({ objectId: addrs.ORACLE_CONFIG.id,   initialSharedVersion: addrs.ORACLE_CONFIG.isv,   mutable: true  }),
        tx.sharedObjectRef({ objectId: addrs.PYTH_ORACLE.id,     initialSharedVersion: addrs.PYTH_ORACLE.isv,     mutable: true  }),
        tx.sharedObjectRef({ objectId: addrs.SUPRA_HOLDER.id,    initialSharedVersion: addrs.SUPRA_HOLDER.isv,    mutable: false }),
        tx.object(feed.pioId),
        tx.sharedObjectRef({ objectId: addrs.SWITCHBOARD_AGG.id, initialSharedVersion: addrs.SWITCHBOARD_AGG.isv, mutable: false }),
        tx.pure.address(feed.feedId),
      ],
    });
  }
}

async function detectFrontrun(opp: LiquidationOpp, detectedAtMs: number, state: BotState): Promise<void> {
  await sleep(2500);
  try {
    const txs = await client.queryTransactionBlocks({
      filter: { FromOrToAddress: { addr: opp.borrower } } as any,
      limit: 8, order: "descending",
      options: { showInput: true, showEffects: true },
    });
    for (const entry of txs.data) {
      const txMs = entry.timestampMs ? Number(entry.timestampMs) : 0;
      if (txMs > 0 && txMs < detectedAtMs - 5000) continue;
      const txData = (entry as any).transaction?.data?.transaction;
      const isNavi = JSON.stringify(txData ?? {}).includes(addrs.NAVI_PKG.slice(2, 20));
      if (!isNavi) continue;
      const winner    = (entry as any).transaction?.data?.sender ?? "unknown";
      const gasPrice  = (entry as any).transaction?.data?.gasData?.price ?? "?";
      const gasBudget = (entry as any).transaction?.data?.gasData?.budget ?? "?";
      const digest    = entry.digest;
      const debtSym   = state.configs.get(opp.debtAsset)?.symbol   ?? `a${opp.debtAsset}`;
      const collatSym = state.configs.get(opp.collatAsset)?.symbol ?? `a${opp.collatAsset}`;
      const delay     = txMs > 0 ? `${((txMs - detectedAtMs) / 1000).toFixed(2)}s after detect` : "timing unknown";
      log.warn(`[FRONTRUN] winner=${winner.slice(0, 20)}...  borrower=${opp.borrower.slice(0, 16)}...  ${debtSym}→${collatSym}  profit=$${opp.profitUsd.toFixed(0)}  gasPrice=${gasPrice}  budget=${gasBudget}  ${delay}  digest=${digest}`);
      tg(`⚡️ <b>FRONT-RUN</b>\nWinner: <code>${winner}</code>\nBorrower: <code>${opp.borrower}</code>\nPair: ${debtSym} → ${collatSym}\nOur profit: $${opp.profitUsd.toFixed(0)}\nGas price: ${gasPrice} MIST  Budget: ${gasBudget}\nTiming: ${delay}\n<a href="https://suiscan.xyz/mainnet/tx/${digest}">${digest.slice(0, 22)}...</a>`);
      return;
    }
  } catch (e) {
    log.debug(`detectFrontrun error: ${e}`);
  }
}

// ── reserve index updater ─────────────────────────────────────────────────────

async function startReserveIndexUpdater(state: BotState) {
  while (true) {
    await sleep(60_000);
    try {
      const usedAssets = new Set<number>();
      for (const pos of state.positions.values()) {
        for (const id of pos.scaledDebts.keys())       usedAssets.add(id);
        for (const id of pos.scaledCollaterals.keys()) usedAssets.add(id);
      }
      if (usedAssets.size === 0) continue;
      // Clear so getReserveInfo re-fetches fresh indices + rates
      reserveCache.clear();
      await Promise.all([...usedAssets].map(id => getReserveInfo(client, addrs, id).catch(() => {})));
      log.debug(`[INDEX] Refreshed ${usedAssets.size} asset indices + rates`);
    } catch (e) {
      log.warn("reserveIndexUpdater error:", e);
    }
  }
}

// ── 30-min position refresher ─────────────────────────────────────────────────

async function startPositionRefresher(state: BotState) {
  while (true) {
    await sleep(1_800_000);
    log.info("[REFRESH] Starting periodic position refresh...");
    try {
      await loadPositions(state, scanPool, addrs, log);
      savePositionsCache(state, log);
      log.info(`[REFRESH] Done. positions=${state.positions.size} fast=${state.fastSet.size}`);
    } catch (e) {
      log.warn("[REFRESH] loadPositions failed:", e);
    }
  }
}

// ── HF cross-validation (30-min batch, not hot path) ─────────────────────────
//
// Calls naviGetHealthFactor (devInspect on-chain) for the N riskiest positions
// sequentially with a small delay to avoid 429. Compares against our computed HF.
// Divergence > 5% flags a miscalculation in our index/price pipeline.

async function validateHFSample(
  allPositions: UserPosition[],
): Promise<string> {
  // Sample positions near the liquidation boundary (0.5–1.5).
  // HF < 0.5 are either already-liquidated stale cache or genuinely bankrupt (low signal for
  // pipeline validation). HF > 1.5 are safe and uninteresting. We focus on the band we
  // actually care about: positions we're watching or about to liquidate.
  const sample = allPositions
    .filter(p => isFinite(p.hf) && p.hf >= 0.5 && p.hf <= 1.5 && p.scaledDebts.size > 0)
    .sort((a, b) => a.hf - b.hf)
    .slice(0, 20);

  const env = isTestnet() ? "test" : "prod";
  let maxDelta = 0, alertCount = 0, rpcErrors = 0;
  const lines: string[] = [];

  for (const pos of sample) {
    let officialHf: number | null = null;
    try {
      const raw = await naviGetHealthFactor(pos.address, { client, env });
      if (typeof raw === "number") officialHf = raw;
    } catch { rpcErrors++; }

    if (officialHf == null) continue;

    const delta = Math.abs(pos.hf - officialHf) / Math.max(officialHf, 0.001);
    maxDelta = Math.max(maxDelta, delta);
    const flag = delta > 0.05 ? " ⚠️" : "";
    if (delta > 0.05) alertCount++;
    lines.push(`  ${pos.address.slice(0, 16)}…  ours=${pos.hf.toFixed(4)}  navi=${officialHf.toFixed(4)}  Δ=${(delta * 100).toFixed(1)}%${flag}`);
    log.info(`[HF-VAL] ${pos.address.slice(0, 16)}…  ours=${pos.hf.toFixed(4)}  navi=${officialHf.toFixed(4)}  Δ=${(delta * 100).toFixed(1)}%${flag}`);

    await sleep(300);
  }

  const summary = `HF-VAL n=${lines.length} maxΔ=${(maxDelta * 100).toFixed(1)}% alerts=${alertCount} rpcErr=${rpcErrors}`;
  log.info(`[HF-VAL] ${summary}`);
  if (alertCount > 0) log.warn(`[HF-VAL] ${alertCount} positions with >5% divergence — check index/price pipeline`);

  return `\n🔬 <b>HF Validation</b> (top ${sample.length} risky, sequential)\n` +
    (lines.length > 0
      ? lines.slice(0, 8).join("\n") + (lines.length > 8 ? `\n  … +${lines.length - 8} more` : "")
      : "  no results (RPC errors)") +
    `\nmaxΔ=${(maxDelta * 100).toFixed(1)}%  alerts=${alertCount}  rpcErr=${rpcErrors}`;
}

// ── time-to-liquidation estimator ─────────────────────────────────────────────

function estimateTimeToLiqSec(pos: ReturnType<BotState["positions"]["values"]> extends IterableIterator<infer T> ? T : never, state: BotState): number {
  const hf0 = pos.hf;
  if (!isFinite(hf0) || hf0 <= 1.0) return 0;
  const DAY_SEC = BigInt(86400);
  let collatNow = 0, collatDay = 0;
  for (const [id, scaled] of pos.scaledCollaterals) {
    const cfg = state.configs.get(id), price = state.prices.get(id), ri = reserveCache.get(id);
    if (!cfg || !price || !ri) continue;
    const idxNow = liveIndex(id, "supply");
    const idxDay = ri.supplyIndex + ri.supplyIndex * ri.supplyRatePerSec * DAY_SEC / RAY;
    collatNow += Number(scaled * idxNow / RAY) / 1e9 * price * cfg.liqThreshold;
    collatDay += Number(scaled * idxDay / RAY) / 1e9 * price * cfg.liqThreshold;
  }
  let debtNow = 0, debtDay = 0;
  for (const [id, scaled] of pos.scaledDebts) {
    const cfg = state.configs.get(id), price = state.prices.get(id), ri = reserveCache.get(id);
    if (!cfg || !price || !ri) continue;
    const idxNow = liveIndex(id, "borrow");
    const idxDay = ri.borrowIndex + ri.borrowIndex * ri.borrowRatePerSec * DAY_SEC / RAY;
    debtNow += Number(scaled * idxNow / RAY) / 1e9 * price;
    debtDay += Number(scaled * idxDay / RAY) / 1e9 * price;
  }
  if (debtNow === 0 || debtDay === 0) return Infinity;
  const hf1d = collatDay / debtDay;
  if (hf1d >= hf0) return Infinity;
  return (hf0 - 1.0) / (hf0 - hf1d) * 86400;
}

// ── Pyth price monitor ────────────────────────────────────────────────────────

function startPythMonitor(onPrice: (assetId: number, price: number) => void) {
  const feedMap = new Map<string, number[]>();
  for (const [idStr, meta] of Object.entries(ASSETS)) {
    if (!meta.pyth) continue;
    const ids = feedMap.get(meta.pyth) ?? [];
    ids.push(Number(idStr));
    feedMap.set(meta.pyth, ids);
  }
  const feedIds = [...feedMap.keys()];

  function connect() {
    log.info("Connecting to Pyth Hermes WebSocket...");
    const ws = new WebSocket(addrs.PYTH_WS);
    ws.on("open", () => {
      ws.send(JSON.stringify({ type: "subscribe", ids: feedIds, verbose: false, binary: false }));
      log.info(`Subscribed to ${feedIds.length} Pyth feeds`);
    });
    ws.on("message", raw => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === "response" && msg.status === "error") {
          const badIds: string[] = (msg.error as string).match(/0x[0-9a-f]+/gi) ?? [];
          log.warn(`[PYTH] subscription error (${badIds.length} bad feeds): ${msg.error}`);
          for (const bad of badIds) feedMap.delete(bad);
          const good = [...feedMap.keys()];
          if (good.length > 0) ws.send(JSON.stringify({ type: "subscribe", ids: good, verbose: false, binary: false }));
          return;
        }
        if (msg.type !== "price_update") return;
        const feedId   = "0x" + msg.price_feed?.id;
        const assetIds = feedMap.get(feedId);
        if (!assetIds) return;
        const p     = msg.price_feed.price;
        const price = parseInt(p.price) * Math.pow(10, parseInt(p.expo));
        for (const assetId of assetIds) onPrice(assetId, price);
      } catch (e) { log.warn(`[PYTH] parse error: ${e}`); }
    });
    ws.on("close", () => { log.warn("Pyth WS closed, reconnecting in 3s..."); setTimeout(connect, 3000); });
    ws.on("error", e   => log.warn("Pyth WS error:", e.message));
  }
  connect();
}

// ── event monitor: track new borrows ─────────────────────────────────────────

async function eventMonitor(state: BotState) {
  const eventType = `${addrs.NAVI_PKG}::event::BorrowEvent`;
  let cursor: any = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const seed = await client.queryEvents({ query: { MoveEventType: eventType }, limit: 1, order: "descending" });
      cursor = seed.data[0]?.id ?? null;
      log.info(`Event monitor seeded at ${new Date(Number(seed.data[0]?.timestampMs)).toISOString()} (cursor=${cursor ? "ok" : "null"})`);
      break;
    } catch (e) { log.warn(`Event monitor seed attempt ${attempt + 1} failed: ${e}`); await sleep(2000); }
  }
  if (!cursor) log.warn("Event monitor: seed cursor is null — will scan from chain genesis!");

  while (true) {
    await sleep(10_000);
    try {
      const res = await client.queryEvents({ query: { MoveEventType: eventType }, cursor, limit: 50, order: "ascending" });
      for (const ev of res.data) {
        const pj2 = ev.parsedJson as any;
        const addr = pj2?.sender ?? pj2?.user;
        if (addr && !state.triedAddresses.has(addr)) {
          await loadUserPosition(state, client, addrs, addr);
          if (state.positions.has(addr)) log.info(`Tracked new borrower ${addr.slice(0, 20)}...`);
        }
      }
      if (res.data.length > 0) cursor = res.data[res.data.length - 1].id;
      else if (res.hasNextPage) cursor = res.nextCursor;
    } catch (e) { log.warn("Event monitor error:", e); }
  }
}

// ── on-chain liquidation event logger ────────────────────────────────────────

async function liquidationEventMonitor(state: BotState) {
  const eventType = `${addrs.NAVI_PKG}::event::LiquidationEvent`;
  let cursor: any = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const seed = await client.queryEvents({ query: { MoveEventType: eventType }, limit: 1, order: "descending" });
      cursor = seed.data[0]?.id ?? null;
      log.info(`LiquidationEvent monitor seeded (cursor=${cursor ? "ok" : "null"})`);
      break;
    } catch (e) { log.warn(`liquidationEventMonitor seed attempt ${attempt + 1} failed: ${e}`); await sleep(2000); }
  }

  while (true) {
    await sleep(10_000);
    try {
      const res = await client.queryEvents({ query: { MoveEventType: eventType }, cursor, limit: 50, order: "ascending" });
      for (const ev of res.data) {
        const j        = ev.parsedJson as any;
        const borrower = (j?.user ?? "unknown") as string;
        const liqAddr  = (j?.liquidator ?? j?.sender ?? ev.sender ?? "unknown") as string;
        const debtId   = Number(j?.liquidate_asset_id   ?? j?.debt_asset_id    ?? -1);
        const collatId = Number(j?.collateral_asset_id  ?? j?.collat_asset_id  ?? -1);
        const debtAmt  = BigInt(j?.liquidate_amount  ?? j?.repay_amount  ?? 0);
        const collatAmt= BigInt(j?.collateral_amount ?? j?.reward_amount ?? 0);
        const debtCfg    = state.configs.get(debtId);
        const collatCfg  = state.configs.get(collatId);
        const debtUsd    = debtCfg   ? (Number(debtAmt)   / 10 ** debtCfg.tokenDec)   * (state.prices.get(debtId)   ?? 0) : 0;
        const collatUsd  = collatCfg ? (Number(collatAmt) / 10 ** collatCfg.tokenDec) * (state.prices.get(collatId) ?? 0) : 0;
        const debtSym    = debtCfg?.symbol   ?? `a${debtId}`;
        const collatSym  = collatCfg?.symbol ?? `a${collatId}`;
        log.info(`[LIQ-EVENT] borrower=${borrower.slice(0, 16)}...  liq=${liqAddr.slice(0, 16)}...  ${debtSym}→${collatSym}  debtUsd=$${debtUsd.toFixed(0)}  profit≈$${(collatUsd - debtUsd).toFixed(0)}  tx=${ev.id.txDigest.slice(0, 16)}...`);
        tg(`📡 <b>LIQ-EVENT</b>\nBorrower: <code>${borrower}</code>\nLiquidator: <code>${liqAddr}</code>\n${debtSym} → ${collatSym}  debt=$${debtUsd.toFixed(0)}  profit≈$${(collatUsd - debtUsd).toFixed(0)}\n<a href="https://suiscan.xyz/mainnet/tx/${ev.id.txDigest}">${ev.id.txDigest.slice(0, 20)}…</a>`);
      }
      if (res.data.length > 0) cursor = res.data[res.data.length - 1].id;
      else if (res.hasNextPage) cursor = res.nextCursor;
    } catch (e) { log.warn("liquidationEventMonitor error:", e); }
  }
}

// ── HF updater ────────────────────────────────────────────────────────────────

function handleLiquidatable(pos: ReturnType<BotState["positions"]["values"]> extends IterableIterator<infer T> ? T : never, hf: number, state: BotState, onLiquidatable: (opp: LiquidationOpp) => void, tag: string): void {
  const opp = state.bestLiquidation(pos);
  if (!opp) return;
  const debtSym   = state.configs.get(opp.debtAsset)?.symbol   ?? `asset_${opp.debtAsset}`;
  const collatSym = state.configs.get(opp.collatAsset)?.symbol ?? `asset_${opp.collatAsset}`;
  log.warn(`${tag}LIQUIDATABLE ${pos.address.slice(0, 16)}... HF=${hf.toFixed(4)} profit=$${opp.profitUsd.toFixed(2)}`);
  tg(`🔴 <b>LIQUIDATABLE</b>${tag ? " " + tag : ""}\nBorrower: <code>${opp.borrower}</code>\nHF: ${hf.toFixed(4)}\nDebt: ${debtSym} → Collat: ${collatSym}\nProfit ≈ $${opp.profitUsd.toFixed(2)}`);
  onLiquidatable(opp);
}

async function hfUpdater(state: BotState, onLiquidatable: (opp: LiquidationOpp) => void) {
  let lastSlowSweep   = 0;
  let lastSlowReport  = 0;
  let reportOnFirstPrice = true;

  while (true) {
    const now = Date.now();

    // fast tier: every tick
    for (const addr of state.fastSet) {
      const pos = state.positions.get(addr);
      if (!pos) { state.fastSet.delete(addr); continue; }
      const hf = state.computeHF(pos);
      pos.hf = hf;
      pos.lastUpdated = now;
      if (hf < 1.0) {
        handleLiquidatable(pos, hf, state, onLiquidatable, "");
        state.fastSet.delete(addr);
      } else if (hf > HF_SLOW_THRESHOLD) {
        state.fastSet.delete(addr);
      }
    }

    if (reportOnFirstPrice && state.prices.size > 0) {
      reportOnFirstPrice = false;
      lastSlowReport = now - 1_800_000;
      lastSlowSweep  = 0;
    }

    // slow tier sweep
    if (now - lastSlowSweep > SLOW_INTERVAL_MS) {
      lastSlowSweep = now;
      log.debug(`[SWEEP] positions=${state.positions.size} prices=${state.prices.size} nextReport=${Math.max(0, Math.round((lastSlowReport + 1_800_000 - now) / 1000))}s`);

      type RiskyEntry = { addr: string; hf: number; promoted: boolean };
      const risky: RiskyEntry[] = [];

      for (const [addr, pos] of state.positions) {
        if (state.fastSet.has(addr)) continue;
        const hf     = state.computeHF(pos);
        const prevHf = pos.hf;
        pos.hf = hf;
        pos.lastUpdated = now;

        if (hf < 1.0) {
          handleLiquidatable(pos, hf, state, onLiquidatable, "[slow]");
        } else if (hf <= HF_SLOW_THRESHOLD && prevHf > HF_SLOW_THRESHOLD) {
          log.info(`Promoted ${addr.slice(0, 16)}... to fast tier (HF=${hf.toFixed(4)})`);
          state.fastSet.add(addr);
          risky.push({ addr, hf, promoted: true });
        } else if (hf < 1.15) {
          risky.push({ addr, hf, promoted: false });
        }
      }

      if (now - lastSlowReport >= 1_800_000 && state.prices.size > 0) {
        lastSlowReport = now;
        risky.sort((a, b) => a.hf - b.hf);
        const total = state.positions.size;
        const fast  = state.fastSet.size;
        const slow  = total - fast;

        const fmtUsd = (scaled: bigint, id: number, side: "borrow" | "supply"): string => {
          const cfg = state.configs.get(id), price = state.prices.get(id) ?? 0;
          if (!cfg) return "?";
          const usd = (Number(scaled * liveIndex(id, side) / RAY) / 1e9) * price;
          return usd >= 1_000_000 ? `$${(usd / 1_000_000).toFixed(1)}M`
               : usd >= 1_000    ? `$${(usd / 1_000).toFixed(1)}k`
               : `$${usd.toFixed(0)}`;
        };
        const fmtTtl = (sec: number): string => {
          if (!isFinite(sec) || sec > 3650 * 86400) return "stable";
          const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600);
          return d > 0 ? `${d}d ${h}h` : `${h}h ${Math.floor((sec % 3600) / 60)}m`;
        };

        const top5Hf = [...state.positions.values()]
          .filter(p => isFinite(p.hf))
          .sort((a, b) => a.hf - b.hf)
          .slice(0, 5);

        const top5Ttl = [...state.positions.values()]
          .filter(p => p.hf > 1.0 && p.scaledDebts.size > 0)
          .map(p => ({ p, ttl: estimateTimeToLiqSec(p, state) }))
          .filter(x => isFinite(x.ttl) && x.ttl > 0)
          .sort((a, b) => a.ttl - b.ttl)
          .slice(0, 5);

        let msg = `📊 <b>30min Report</b> ${new Date().toISOString().slice(11, 19)} UTC\n`;
        msg += `Positions: ${total} total  |  fast=${fast}  slow=${slow}\n`;
        msg += risky.length > 0
          ? `⚠️ Near-liq (HF &lt; 1.15): ${risky.length}\n`
          : `✅ No positions below HF 1.15\n`;

        if (top5Hf.length > 0) {
          msg += `\n📉 <b>Lowest HF:</b>\n`;
          for (let i = 0; i < top5Hf.length; i++) {
            const p = top5Hf[i];
            const debtStr   = [...p.scaledDebts.entries()].map(([id, s]) => `${state.configs.get(id)?.symbol ?? `a${id}`} ${fmtUsd(s, id, "borrow")}`).join(", ");
            const collatStr = [...p.scaledCollaterals.entries()].map(([id, s]) => `${state.configs.get(id)?.symbol ?? `a${id}`} ${fmtUsd(s, id, "supply")}`).join(", ");
            msg += `${i + 1}. <code>${p.address.slice(0, 20)}…</code>  HF=${p.hf.toFixed(4)}\n`;
            msg += `   💸 ${debtStr}\n`;
            msg += `   💰 ${collatStr}\n`;
          }
        }

        if (top5Ttl.length > 0) {
          msg += `\n⏱ <b>Interest-driven (fastest to liq, flat prices):</b>\n`;
          for (let i = 0; i < top5Ttl.length; i++) {
            const { p, ttl } = top5Ttl[i];
            const debtStr = [...p.scaledDebts.entries()].map(([id, s]) => `${state.configs.get(id)?.symbol ?? `a${id}`} ${fmtUsd(s, id, "borrow")}`).join(", ");
            msg += `${i + 1}. <code>${p.address.slice(0, 20)}…</code>  HF=${p.hf.toFixed(4)}  ⏳${fmtTtl(ttl)}\n`;
            msg += `   💸 ${debtStr}\n`;
          }
          log.info(`[30MIN-TTL] ${top5Ttl.map(({ p, ttl }) => `${p.address.slice(0, 16)}...(HF=${p.hf.toFixed(4)},ttl=${fmtTtl(ttl)})`).join(" | ")}`);
        }

        validateHFSample([...state.positions.values()])
          .then(valMsg => tg(msg + valMsg))
          .catch(() => tg(msg));
        log.info(`[30MIN-REPORT] total=${total} fast=${fast} slow=${slow} near-liq=${risky.length}` +
          (top5Hf[0] ? ` lowest-HF=${top5Hf[0].hf.toFixed(4)} (${top5Hf[0].address.slice(0, 16)}...)` : ""));
      }
    }

    await sleep(50);
  }
}

// ── liquidator ────────────────────────────────────────────────────────────────

async function liquidator(state: BotState, opp: LiquidationOpp, keypair: Ed25519Keypair | null) {
  const debtSym    = state.configs.get(opp.debtAsset)?.symbol   ?? `a${opp.debtAsset}`;
  const collatSym  = state.configs.get(opp.collatAsset)?.symbol ?? `a${opp.collatAsset}`;
  const debtCfg    = state.configs.get(opp.debtAsset);
  const collatCfg  = state.configs.get(opp.collatAsset);
  const debtPrice  = state.prices.get(opp.debtAsset) ?? 0;
  const repayUsd   = Number(opp.repayAmount) / 10 ** (debtCfg?.tokenDec ?? 9) * debtPrice;
  const receiveUsd = repayUsd * (1 + (collatCfg?.liqBonus ?? 0));
  const caseTag    = opp.source === "wallet" ? "Case2 wallet" : `Case1 ${opp.source}`;
  const collatPrice = state.prices.get(opp.collatAsset) ?? 0;
  const receiveAmt  = collatPrice > 0 ? (receiveUsd / collatPrice).toFixed(4) : "?";
  const repayHuman  = (Number(opp.repayAmount) / 10 ** (debtCfg?.tokenDec ?? 9)).toFixed(4);
  const oppSummary =
    `[${opp.source}] ${debtSym}→${collatSym}  HF=${opp.hf.toFixed(3)}\n` +
    `  repay:     ${repayHuman} ${debtSym} (~$${repayUsd.toFixed(4)})\n` +
    `  receive:   ${receiveAmt} ${collatSym} ($${receiveUsd.toFixed(4)})  (bonus ${((collatCfg?.liqBonus ?? 0)*100).toFixed(1)}%)\n` +
    `  ──────────────────────────────\n` +
    `  liqBonus:  +$${opp.grossProfitUsd.toFixed(4)}\n` +
    `  cetusFee:   -$${opp.cetusFeeUsd.toFixed(4)}\n` +
    `  gas:        -$${opp.gasCostUsd.toFixed(6)}\n` +
    `  ──────────────────────────────\n` +
    `  NET:        $${opp.profitUsd.toFixed(4)}  ✅ ≥ $${MIN_PROFIT_USD}`;

  if (DRY_RUN) {
    const detectedAt = Date.now();
    log.info(`[DRY-RUN ${caseTag}] ${opp.borrower.slice(0, 16)}...  ${oppSummary.replace(/\n/g, "  ")}`);
    tg(`🔍 <b>DRY-RUN [${caseTag}]</b>\nBorrower: <code>${opp.borrower}</code>\n${oppSummary}`);
    detectFrontrun(opp, detectedAt, state).catch(() => {});
    return;
  }

  if (!keypair) {
    log.error("No keypair loaded — set bot_key in config.json to enable live mode");
    return;
  }

  const pos = state.positions.get(opp.borrower);
  if (!pos || pos.hf >= 1.0) {
    log.debug(`Skip ${opp.borrower.slice(0, 16)}...: local HF recovered to ${pos?.hf.toFixed(4)}`);
    return;
  }

  try {
    const tx = await buildLiquidationTx(opp as LiqOpp, keypair, addrs, client, opp.source, addOracleUpdates);

    // ── gas pre-flight: devInspect to get real cost before committing ──────────
    const refGasPrice = BigInt(await client.getReferenceGasPrice());
    const inspect = await client.devInspectTransactionBlock({
      transactionBlock: tx,
      sender: keypair.getPublicKey().toSuiAddress(),
      gasPrice: refGasPrice.toString(),
    });
    if (inspect.effects.status.status !== "success") {
      log.error(`[PREFLIGHT FAIL ${caseTag}] ${opp.borrower.slice(0, 20)}... devInspect failed: ${JSON.stringify(inspect.effects.status)}`);
      tg(`⚠️ <b>PREFLIGHT FAIL [${caseTag}]</b>\nBorrower: <code>${opp.borrower}</code>\n${oppSummary}\n${JSON.stringify(inspect.effects.status).slice(0, 200)}`);
      return;
    }
    const gu = inspect.effects.gasUsed;
    // At 1.5× gas price: compute cost scales, storage stays fixed
    const computeMist = BigInt(gu.computationCost);
    const actualMist  = (computeMist * 3n / 2n) + BigInt(gu.storageCost) - BigInt(gu.storageRebate);
    const suiPrice    = state.prices.get(0) ?? 1;
    const gasUsd      = (Number(actualMist) / 1e9) * suiPrice;
    const netProfitUsd = opp.profitUsd - gasUsd;
    log.info(`[PREFLIGHT OK] gas=${actualMist}MIST(1.5×) ≈$${gasUsd.toFixed(4)} gross=$${opp.profitUsd.toFixed(4)} net=$${netProfitUsd.toFixed(4)}`);
    if (netProfitUsd <= MIN_PROFIT_USD) {
      log.warn(`[SKIP] Net profit $${netProfitUsd.toFixed(4)} ≤ MIN_PROFIT_USD after gas — skipping`);
      return;
    }
    // Set gas budget from actual measurement (2× for safety headroom)
    tx.setGasBudget(actualMist * 2n);

    const digest = await broadcastTx(tx, keypair);
    log.info(`[TX SUCCESS ${caseTag}] ${digest} | borrower=${opp.borrower.slice(0, 20)}... | gross=$${opp.profitUsd.toFixed(2)} net≈$${netProfitUsd.toFixed(2)}`);
    tg(`✅ <b>TX SUCCESS [${caseTag}]</b>\n<a href="https://suiscan.xyz/mainnet/tx/${digest}">${digest.slice(0, 20)}...</a>\nBorrower: <code>${opp.borrower}</code>\n${oppSummary}\nNet ≈ $${netProfitUsd.toFixed(2)}`);
    state.positions.delete(opp.borrower);
    state.fastSet.delete(opp.borrower);
  } catch (e) {
    const detectedAt = Date.now();
    log.error(`[TX FAILED] ${opp.borrower.slice(0, 20)}...:`, e);
    tg(`❌ <b>TX FAILED</b>\nBorrower: <code>${opp.borrower}</code>\n${String(e).slice(0, 200)}`);
    detectFrontrun(opp, detectedAt, state).catch(() => {});
  }
}

// ── util ──────────────────────────────────────────────────────────────────────

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

// ── main ──────────────────────────────────────────────────────────────────────

async function main() {
  mkdirSync("logs", { recursive: true });
  log.info(`Starting NAVI liquidation bot (${DRY_RUN ? "DRY-RUN" : "LIVE"}, network=${isTestnet() ? "testnet" : "mainnet"})...`);

  if (isTestnet()) {
    const testnetRpc = process.env.SUI_RPC ?? "https://fullnode.testnet.sui.io:443";
    client   = new SuiClient({ url: testnetRpc });
    scanPool = new RpcPool([testnetRpc]);
    log.info("Fetching testnet contract ISVs from chain...");
    addrs = await withRetry(() => buildTestnetAddrs(client));
    _pythClient = null;
    log.info(`Testnet addrs loaded (RPC: ${testnetRpc})`);
  }

  let keypair: Ed25519Keypair | null = null;
  if (!DRY_RUN) {
    if (!BOT_KEY) { log.error("bot_key not set in config.json — aborting live mode. Use DRY_RUN=1 to test."); process.exit(1); }
    keypair = Ed25519Keypair.fromSecretKey(Buffer.from(BOT_KEY, "hex"));
    log.info(`Wallet: ${keypair.getPublicKey().toSuiAddress()}`);
  }

  const state = new BotState();
  await withRetry(() => loadAssetConfigs(state, client, addrs, log));

  // Seed prices from NAVI on-chain oracle for non-Pyth assets (NS, DEEP, BLUE, BUCK, LBTC, etc.)
  // Pyth WS will overwrite Pyth-covered assets as soon as it connects; oracle prices serve as
  // initial values so HF computation is not blind to these assets at startup.
  try {
    const oraclePrices = await loadOraclePrices(client, addrs);
    for (const [id, p] of oraclePrices) state.prices.set(id, p);
    log.info(`[ORACLE] Seeded ${oraclePrices.size} asset prices from NAVI on-chain oracle`);
  } catch (e) {
    log.warn(`[ORACLE] Failed to seed oracle prices: ${e}`);
  }

  // Startup: always load from cache for immediate monitoring.
  // If no cache exists, warn user and run a background full scan.
  const cachedCount = await loadPositionsFromCache(state, client, addrs, log);
  if (cachedCount > 0) {
    log.info(`[CACHE] Loaded ${cachedCount} positions, monitoring starts immediately`);
  } else {
    log.warn("[CACHE] No cache found. Run 'npx tsx bot/init_bot.ts' first for complete coverage.");
    log.info("[CACHE] Starting background full scan...");
  }

  // Background scan: refreshes/prunes whether or not cache was loaded.
  // Runs once at startup, then every 30 min via startPositionRefresher.
  withRetry(() => loadPositions(state, scanPool, addrs, log))
    .then(() => {
      savePositionsCache(state, log);
      log.info(`[CACHE] Background scan done: ${state.positions.size} positions`);
    })
    .catch(e => log.warn("[CACHE] Background scan failed:", e));

  const inFlight = new Set<string>();
  const enqueue = (opp: LiquidationOpp) => {
    if (inFlight.has(opp.borrower)) return;
    inFlight.add(opp.borrower);
    liquidator(state, opp, keypair).finally(() => inFlight.delete(opp.borrower));
  };

  startPythMonitor((assetId, price) => { state.prices.set(assetId, price); });
  log.info("All systems started, monitoring...");

  await Promise.all([
    eventMonitor(state),
    liquidationEventMonitor(state),
    hfUpdater(state, enqueue),
    startReserveIndexUpdater(state),
    startPositionRefresher(state),
  ]);
}

main().catch(e => { console.error("Fatal:", e); process.exit(1); });
