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

// VAA cache: dedup concurrent Pyth fetch requests (TTL = 8s; valid for NAVI staleness window)
const _vaaCache = new Map<string, { data: any; ts: number; promise?: Promise<any> }>();
const VAA_TTL_MS = 8_000;

async function fetchVaaData(feedIdList: string[]): Promise<any> {
  const key = [...feedIdList].sort().join("|");
  const entry = _vaaCache.get(key);
  if (entry) {
    if (Date.now() - entry.ts < VAA_TTL_MS) return entry.data;
    if (entry.promise) return entry.promise;  // share in-flight request
  }
  const promise: Promise<any> = (async () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const data = await pythConn.getPriceFeedsUpdateData(feedIdList);
        _vaaCache.set(key, { data, ts: Date.now() });
        return data;
      } catch (e: any) {
        if (attempt < 2) { await sleep(600 * (attempt + 1)); continue; }
        throw e;
      }
    }
  })().finally(() => {
    const cur = _vaaCache.get(key);
    if (cur?.promise === promise) _vaaCache.set(key, { ...cur, promise: undefined });
  });
  _vaaCache.set(key, { data: null, ts: 0, promise });
  return promise;
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

  // Batch 4: race fastest-success across all broadcast RPCs (Promise.any).
  // Returns as soon as ANY RPC confirms; doesn't wait for slow ones.
  const t0 = Date.now();
  const digest = await Promise.any(
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
  log.debug(`Broadcast race won in ${Date.now() - t0}ms: ${digest.slice(0, 16)}...`);
  return digest;
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
    // fetchVaaData caches results for VAA_TTL_MS ms so concurrent liquidations share one request
    const updates = await fetchVaaData(feedIdList);
    await getPythClient().updatePriceFeeds(tx, updates, feedIdList);
    log.debug(`[ORACLE] pushed Pyth VAA for ${feedIdList.length} feed(s)`);
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

// True NAVI on-chain HF — oracle update + logic_getter_unchecked::user_health_factor.
// This is what the official navi-sdk repo calls (NOT @naviprotocol/lending's getHealthFactor,
// which wraps dynamic_health_factor and returns 0 for emode users).
const NAVI_UI_GETTER = "0xa1357e2e9c28f90e76b085abb81f7ce3e59b699100687bbc3910c7e9f27bb7c8";

async function getNaviHF(rpc: SuiClient, address: string, _assetIds: number[]): Promise<number> {
  const m = await getNaviHFBatch(rpc, [address]);
  return m.get(address) ?? NaN;
}

// Batch 2: Pyth oracle freshness pre-check. Reads arrival_time from PriceInfoObject(s).
// Returns map of asset -> staleness seconds (Infinity if query failed).
// Note: multiple assets can share one pioId (vSUI/haSUI/SUI), so dedup before query.
const ORACLE_FRESHNESS_SEC = 60;
const STALE_THRESHOLD_FOR_BUNDLE_SEC = 30;  // bundle Pyth update if oracle older than this
async function getPythStalenessMap(rpc: SuiClient, assetIds: number[]): Promise<Map<number, number>> {
  const map = new Map<number, number>();
  const pioToAssets = new Map<string, number[]>();
  for (const id of assetIds) {
    const feed = addrs.ORACLE_PRO_FEEDS[id];
    if (!feed?.pioId) { map.set(id, Infinity); continue; }
    const arr = pioToAssets.get(feed.pioId) ?? [];
    arr.push(id);
    pioToAssets.set(feed.pioId, arr);
  }
  const pioIds = [...pioToAssets.keys()];
  if (pioIds.length === 0) return map;
  try {
    const res = await rpc.multiGetObjects({ ids: pioIds, options: { showContent: true } });
    const nowSec = Math.floor(Date.now() / 1000);
    for (let i = 0; i < pioIds.length; i++) {
      const arrival = Number((res[i]?.data?.content as any)?.fields?.price_info?.fields?.arrival_time ?? 0);
      const stale = arrival ? nowSec - arrival : Infinity;
      for (const a of pioToAssets.get(pioIds[i])!) map.set(a, stale);
    }
  } catch {
    for (const id of assetIds) map.set(id, Infinity);
  }
  return map;
}

async function maxPythStalenessSec(rpc: SuiClient, assetIds: number[]): Promise<number> {
  const m = await getPythStalenessMap(rpc, assetIds);
  let max = 0;
  for (const v of m.values()) max = Math.max(max, v);
  return max;
}

// Bundle Pyth + NAVI oracle update for ALL position assets.
// Empirically NAVI's calculate_value's staleness threshold is < 30s for some assets, so
// selective bundling (skip "fresh" ones) fails. Always bundling adds ~10-15 PTB cmds but
// is the only reliable way to avoid calculator 1502 on multi-asset positions.
async function addOracleUpdatesForStale(
  rpc: SuiClient,
  tx: Transaction,
  assetIds: number[],
  _stalenessSec: Map<number, number>,
): Promise<number> {
  if (!addrs.ORACLE_PRO_PKG) return 0;
  const seenFeed = new Set<string>();
  const pythFeeds = new Map<string, number>();
  const naviFeeds: typeof addrs.ORACLE_PRO_FEEDS[number][] = [];
  for (const id of assetIds) {
    const feed = addrs.ORACLE_PRO_FEEDS[id];
    const pythFeedId = ASSETS[id]?.pyth;
    if (!feed || seenFeed.has(feed.feedId)) continue;
    seenFeed.add(feed.feedId);
    if (pythFeedId) pythFeeds.set(pythFeedId, id);
    naviFeeds.push(feed);
  }
  if (pythFeeds.size === 0 && naviFeeds.length === 0) return 0;
  if (pythFeeds.size > 0) {
    const feedIdList = [...pythFeeds.keys()];
    const updates = await fetchVaaData(feedIdList);
    await getPythClient().updatePriceFeeds(tx, updates, feedIdList);
  }
  for (const feed of naviFeeds) {
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
  return naviFeeds.length;
}

// Batched NAVI HF query — single devInspect with N user_health_factor move calls.
// 200 addrs in ~700ms. If any address triggers a Move runtime error (e.g. weird position
// state), the entire batch fails. Fallback: bisect into halves until we isolate failures.
const HF_BATCH_SIZE = 200;
async function tryBatch(rpc: SuiClient, batch: string[], result: Map<string, number>): Promise<boolean> {
  try {
    const tx = new Transaction();
    for (const a of batch) {
      tx.moveCall({
        target: `${NAVI_UI_GETTER}::logic_getter_unchecked::user_health_factor`,
        arguments: [
          tx.object("0x06"),
          tx.sharedObjectRef({ objectId: addrs.NAVI_STORAGE.id, initialSharedVersion: addrs.NAVI_STORAGE.isv, mutable: true }),
          tx.sharedObjectRef({ objectId: addrs.PYTH_ORACLE.id, initialSharedVersion: addrs.PYTH_ORACLE.isv, mutable: true }),
          tx.pure.address(a),
        ],
      });
    }
    const r = await rpc.devInspectTransactionBlock({ transactionBlock: tx, sender: batch[0] });
    if (r.effects?.status?.status !== "success") return false;
    for (let j = 0; j < batch.length; j++) {
      const rv = r.results?.[j]?.returnValues?.[0];
      if (!rv) { result.set(batch[j], NaN); continue; }
      const raw = BigInt("0x" + Buffer.from(rv[0]).reverse().toString("hex"));
      const hf = Number(raw) / 1e27;
      // HF==0 quirk: NAVI returns 0 for debt=0 (no division-by-zero protection on chain).
      // Also: collat=0 (true bad debt). Both cases unactionable → mark NaN to exclude from
      // any sort/display/decision logic. Real liquidatable positions always have HF in (0, 1).
      // Healthy positions with no debt overflow to ~MAX_U256/1e27 → treat as Infinity.
      result.set(batch[j], hf === 0 ? NaN : (hf > 1e5 ? Infinity : hf));
    }
    return true;
  } catch { return false; }
}

async function getNaviHFBatch(rpc: SuiClient, addresses: string[]): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  if (addresses.length === 0) return result;
  // Bisect on failure: if a batch fails, split in half until size 1, then mark NaN.
  const stack: string[][] = [];
  for (let i = 0; i < addresses.length; i += HF_BATCH_SIZE) stack.push(addresses.slice(i, i + HF_BATCH_SIZE));
  while (stack.length > 0) {
    const batch = stack.pop()!;
    const ok = await tryBatch(rpc, batch, result);
    if (!ok) {
      if (batch.length === 1) result.set(batch[0], NaN);  // genuinely bad address
      else {
        const mid = Math.floor(batch.length / 2);
        stack.push(batch.slice(0, mid));
        stack.push(batch.slice(mid));
      }
    }
  }
  return result;
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

// Batch 5/6: dirty-tracking for event-driven HFUpdater.
// Reverse index: assetId -> positions holding that asset (collat or debt).
// On any price tick (Pyth WS or on-chain Pyth event), affected positions are marked dirty.
// HFUpdater snapshots & batches dirty positions instead of re-querying entire fastSet every loop.
const assetToPositions = new Map<number, Set<string>>();
const dirtyAddrs = new Set<string>();

function indexPosition(addr: string, pos: { scaledCollaterals: Map<number, bigint>; scaledDebts: Map<number, bigint> }): void {
  for (const id of pos.scaledCollaterals.keys()) {
    if (!assetToPositions.has(id)) assetToPositions.set(id, new Set());
    assetToPositions.get(id)!.add(addr);
  }
  for (const id of pos.scaledDebts.keys()) {
    if (!assetToPositions.has(id)) assetToPositions.set(id, new Set());
    assetToPositions.get(id)!.add(addr);
  }
}

function markAssetDirty(assetId: number): number {
  const set = assetToPositions.get(assetId);
  if (!set) return 0;
  let added = 0;
  for (const a of set) { if (!dirtyAddrs.has(a)) { dirtyAddrs.add(a); added++; } }
  return added;
}

// Batch 6: on-chain Pyth poller as belt-and-suspenders backup to Hermes WS.
// Polls all configured PriceInfoObjects every 5s; if arrival_time advanced since
// last seen, marks affected positions dirty. Catches: WS disconnects, Hermes lag,
// edge cases where on-chain push happens without our WS receiving the corresponding feed.
const lastSeenArrivalSec = new Map<number, number>();  // assetId -> last seen arrival_time
function startPythChainPoller(rpc: SuiClient): () => void {
  const tracked = Object.entries(addrs.ORACLE_PRO_FEEDS)
    .filter(([_, f]) => !!f?.pioId)
    .map(([id, f]) => ({ assetId: Number(id), pioId: f!.pioId }));
  let stopped = false;
  const loop = async () => {
    while (!stopped) {
      try {
        const res = await rpc.multiGetObjects({ ids: tracked.map(t => t.pioId), options: { showContent: true } });
        for (let i = 0; i < tracked.length; i++) {
          const arrival = Number((res[i].data?.content as any)?.fields?.price_info?.fields?.arrival_time ?? 0);
          if (!arrival) continue;
          const prev = lastSeenArrivalSec.get(tracked[i].assetId) ?? 0;
          if (arrival > prev) {
            lastSeenArrivalSec.set(tracked[i].assetId, arrival);
            if (prev > 0) markAssetDirty(tracked[i].assetId);  // skip first init pass
          }
        }
      } catch (e) { /* ignore — next tick will retry */ }
      await sleep(5000);
    }
  };
  loop();
  return () => { stopped = true; };
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
        for (const assetId of assetIds) {
          onPrice(assetId, price);
          // Batch 5: mark all positions touching this asset as dirty for next HF refresh.
          markAssetDirty(assetId);
        }
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

function handleLiquidatable(pos: ReturnType<BotState["positions"]["values"]> extends IterableIterator<infer T> ? T : never, naviHf: number, state: BotState, onLiquidatable: (opp: LiquidationOpp) => void, tag: string): void {
  const opp = state.bestLiquidation(pos);
  if (!opp) return;
  const debtSym   = state.configs.get(opp.debtAsset)?.symbol   ?? `asset_${opp.debtAsset}`;
  const collatSym = state.configs.get(opp.collatAsset)?.symbol ?? `asset_${opp.collatAsset}`;
  // pos.hf was set by HFUpdater from batched user_health_factor — already correct NAVI HF.
  const hfStr = naviHf.toFixed(4);
  log.warn(`${tag}LIQUIDATABLE ${pos.address.slice(0, 16)}... naviHF=${hfStr} profit=$${opp.profitUsd.toFixed(2)}`);
  tg(`🔴 <b>LIQUIDATABLE</b>${tag ? " " + tag : ""}\nBorrower: <code>${opp.borrower}</code>\nNAVI HF: ${hfStr}\nDebt: ${debtSym} → Collat: ${collatSym}\nProfit ≈ $${opp.profitUsd.toFixed(2)}`);
  onLiquidatable(opp);
}

async function hfUpdater(state: BotState, onLiquidatable: (opp: LiquidationOpp) => void) {
  let lastSlowSweep   = 0;
  let lastSlowReport  = 0;
  let reportOnFirstPrice = true;

  let lastFullFastRefresh = 0;
  const FAST_FORCED_REFRESH_MS = 30_000;  // safety net: refresh ALL fastSet every 30s
  while (true) {
    const now = Date.now();

    // Batch 5: event-driven fast-tier refresh.
    // 1) Snapshot dirtyAddrs (positions whose prices ticked since last loop).
    // 2) Filter to fastSet members only (slow-tier dirty handled by slow sweep).
    // 3) Periodic forced full refresh (every 30s) catches positions where Pyth tick was
    //    missed (WS reconnect) or where rate accumulation alone moves HF below 1.
    let toCheck: string[];
    const forceFull = now - lastFullFastRefresh > FAST_FORCED_REFRESH_MS;
    if (forceFull) {
      toCheck = [...state.fastSet];
      dirtyAddrs.clear();
      lastFullFastRefresh = now;
    } else {
      toCheck = [...dirtyAddrs].filter(a => state.fastSet.has(a));
      for (const a of toCheck) dirtyAddrs.delete(a);
    }

    if (toCheck.length > 0) {
      const hfs = await getNaviHFBatch(client, toCheck);
      for (const addr of toCheck) {
        const pos = state.positions.get(addr);
        if (!pos) { state.fastSet.delete(addr); continue; }
        const hf = hfs.get(addr) ?? NaN;
        if (!isFinite(hf)) continue;
        pos.hf = hf;
        pos.lastUpdated = now;
        if (hf < 1.0) {
          handleLiquidatable(pos, hf, state, onLiquidatable, "");
          state.fastSet.delete(addr);
        } else if (hf > HF_SLOW_THRESHOLD) {
          state.fastSet.delete(addr);
        }
      }
    }

    if (reportOnFirstPrice && state.prices.size > 0) {
      reportOnFirstPrice = false;
      lastSlowReport = now - 1_800_000;
      lastSlowSweep  = 0;
    }

    // slow tier sweep — batched naviHF for ALL non-fast positions.
    // ~70s for 20k positions (200/batch × 700ms × 100). SLOW_INTERVAL_MS should be ≥ 90s.
    if (now - lastSlowSweep > SLOW_INTERVAL_MS) {
      lastSlowSweep = now;
      log.debug(`[SWEEP] positions=${state.positions.size} prices=${state.prices.size} nextReport=${Math.max(0, Math.round((lastSlowReport + 1_800_000 - now) / 1000))}s`);

      type RiskyEntry = { addr: string; hf: number; promoted: boolean };
      const risky: RiskyEntry[] = [];

      const slowAddrs = [...state.positions.keys()].filter(a => !state.fastSet.has(a));
      const slowT0 = Date.now();
      const hfs = await getNaviHFBatch(client, slowAddrs);
      log.debug(`[SWEEP] naviHF batch ${slowAddrs.length} addrs in ${Date.now() - slowT0}ms`);

      for (const [addr, pos] of state.positions) {
        if (state.fastSet.has(addr)) continue;
        const hf = hfs.get(addr) ?? NaN;
        if (!isFinite(hf)) continue;
        const prevHf = pos.hf;
        pos.hf = hf;
        pos.lastUpdated = now;

        if (hf < 1.0) {
          handleLiquidatable(pos, hf, state, onLiquidatable, "[slow]");
        } else if (hf <= HF_SLOW_THRESHOLD && prevHf > HF_SLOW_THRESHOLD) {
          log.info(`Promoted ${addr.slice(0, 16)}... to fast tier (naviHF=${hf.toFixed(4)})`);
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

        // pos.hf is now NAVI HF (refreshed in fast/slow tier sweeps).
        // Filter out dust positions (debt < $5 or collat < $5) — they're real-but-uncatchable
        // bad debt; ranking them as "lowest HF" is misleading since liquidator can't profit.
        const positionDebtUsd = (p: UserPosition): number => {
          let total = 0;
          for (const [id, s] of p.scaledDebts) {
            const px = state.prices.get(id) ?? 0;
            total += (Number(s * liveIndex(id, "borrow") / RAY) / 1e9) * px;
          }
          return total;
        };
        const positionCollatUsd = (p: UserPosition): number => {
          let total = 0;
          for (const [id, s] of p.scaledCollaterals) {
            const px = state.prices.get(id) ?? 0;
            total += (Number(s * liveIndex(id, "supply") / RAY) / 1e9) * px;
          }
          return total;
        };
        const top5Hf = [...state.positions.values()]
          .filter(p => isFinite(p.hf) && positionDebtUsd(p) >= 5 && positionCollatUsd(p) >= 5)
          .sort((a, b) => a.hf - b.hf)
          .slice(0, 5)
          .map(p => ({ p, naviHF: p.hf }));

        const top5Ttl = [...state.positions.values()]
          .filter(p => p.hf > 1.0 && p.scaledDebts.size > 0)
          .map(p => ({ p, ttl: estimateTimeToLiqSec(p, state) }))
          .filter(x => isFinite(x.ttl) && x.ttl > 0)
          .sort((a, b) => a.ttl - b.ttl)
          .slice(0, 5);

        // Direct count from current pos.hf (slow-tier `risky` only sees promotion deltas).
        const nearLiqCount = [...state.positions.values()].filter(p => isFinite(p.hf) && p.hf < 1.15).length;
        let msg = `📊 <b>30min Report</b> ${new Date().toISOString().slice(11, 19)} UTC\n`;
        msg += `Positions: ${total} total  |  fast=${fast}  slow=${slow}\n`;
        msg += nearLiqCount > 0
          ? `⚠️ Near-liq (HF &lt; 1.15): ${nearLiqCount}\n`
          : `✅ No positions below HF 1.15\n`;

        if (top5Hf.length > 0) {
          msg += `\n📉 <b>Lowest NAVI HF:</b>\n`;
          for (let i = 0; i < top5Hf.length; i++) {
            const { p, naviHF } = top5Hf[i];
            const debtStr   = [...p.scaledDebts.entries()].map(([id, s]) => `${state.configs.get(id)?.symbol ?? `a${id}`} ${fmtUsd(s, id, "borrow")}`).join(", ");
            const collatStr = [...p.scaledCollaterals.entries()].map(([id, s]) => `${state.configs.get(id)?.symbol ?? `a${id}`} ${fmtUsd(s, id, "supply")}`).join(", ");
            msg += `${i + 1}. <code>${p.address.slice(0, 20)}…</code>  naviHF=${naviHF.toFixed(4)}\n`;
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
          (top5Hf[0] ? ` lowest-HF=${top5Hf[0].naviHF.toFixed(4)} (${top5Hf[0].p.address.slice(0, 16)}...)` : ""));
      }
    }

    // Tight loop: fast tier batch naviHF takes ~200-700ms by itself; no extra sleep needed
    // when fastSet has positions. Sleep 200ms when fastSet empty to avoid busy-wait.
    if (state.fastSet.size === 0) await sleep(200);
  }
}

// ── liquidator ────────────────────────────────────────────────────────────────

async function liquidator(state: BotState, opp: LiquidationOpp, keypair: Ed25519Keypair | null) {
  const t0 = Date.now();
  const debtSym    = state.configs.get(opp.debtAsset)?.symbol   ?? `a${opp.debtAsset}`;
  const collatSym  = state.configs.get(opp.collatAsset)?.symbol ?? `a${opp.collatAsset}`;
  const debtCfg    = state.configs.get(opp.debtAsset);
  const collatCfg  = state.configs.get(opp.collatAsset);
  const debtPrice  = state.prices.get(opp.debtAsset) ?? 0;
  const repayUsd   = Number(opp.repayAmount) / 10 ** (debtCfg?.tokenDec ?? 9) * debtPrice;
  const receiveUsd = repayUsd * (1 + (collatCfg?.liqBonus ?? 0));
  const caseTag    = `Case1 ${opp.source}`;
  const collatPrice = state.prices.get(opp.collatAsset) ?? 0;
  const receiveAmt  = collatPrice > 0 ? (receiveUsd / collatPrice).toFixed(4) : "?";
  const repayHuman  = (Number(opp.repayAmount) / 10 ** (debtCfg?.tokenDec ?? 9)).toFixed(4);
  const buildSummary = (hf: number) =>
    `[${opp.source}] ${debtSym}→${collatSym}  naviHF=${hf.toFixed(3)}\n` +
    `  repay:     ${repayHuman} ${debtSym} (~$${repayUsd.toFixed(4)})\n` +
    `  receive:   ${receiveAmt} ${collatSym} ($${receiveUsd.toFixed(4)})  (bonus ${((collatCfg?.liqBonus ?? 0)*100).toFixed(1)}%)\n` +
    `  liqBonus: +$${opp.grossProfitUsd.toFixed(4)}  cetusFee: -$${opp.cetusFeeUsd.toFixed(4)}  net≈$${opp.profitUsd.toFixed(4)}`;

  const pos = state.positions.get(opp.borrower);
  if (!pos) {
    log.debug(`Skip ${opp.borrower.slice(0, 16)}...: position vanished from store`);
    return;
  }
  const allPositionAssets = [...pos.scaledCollaterals.keys(), ...pos.scaledDebts.keys()];

  // pos.hf was set by HFUpdater from batched user_health_factor — already authoritative.
  // No second devInspect — saves ~700ms of RTT (was the biggest hot-path overhead).
  const naviHF = isFinite(pos.hf) ? pos.hf : opp.hf;
  const oppSummary = buildSummary(naviHF);

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

  if (!isFinite(naviHF) || naviHF >= 1.0) {
    log.debug(`Skip ${opp.borrower.slice(0, 16)}...: naviHF=${isFinite(naviHF) ? naviHF.toFixed(4) : "NaN"} (recovered)`);
    return;
  }

  try {
    const { client: rpc, url: rpcUrl } = scanPool.next();

    // Per-asset freshness check on ALL position assets (NAVI's calculate_value reads each).
    // 1502 errors come from long-tail assets (NAVX/CETUS/HAEDAL) with infrequent Pyth pushes.
    // Selective bundle: only stale (>30s) assets get Pyth update bundled in TX.
    const stalenessMap = await getPythStalenessMap(rpc, allPositionAssets);

    const FAST_GAS_BUDGET_MIST = 50_000_000n;
    const tx = await buildLiquidationTx(
      opp as LiqOpp, keypair, addrs, rpc, opp.source,
      async (t) => { await addOracleUpdatesForStale(rpc, t, allPositionAssets, stalenessMap); }
    );
    tx.setGasBudget(FAST_GAS_BUDGET_MIST);

    const tBuild = Date.now() - t0;
    const digest = await broadcastTx(tx, keypair);
    const tTotal = Date.now() - t0;
    log.info(`[TX SUCCESS ${caseTag}] ${digest} | borrower=${opp.borrower.slice(0, 20)}... | gross≈$${opp.profitUsd.toFixed(2)} | ${tBuild}ms→build, ${tTotal}ms→total`);
    tg(`✅ <b>TX SUCCESS [${caseTag}]</b>\n<a href="https://suiscan.xyz/mainnet/tx/${digest}">${digest.slice(0, 20)}...</a>\nBorrower: <code>${opp.borrower}</code>\n${oppSummary}\nLatency: ${tTotal}ms`);
    state.positions.delete(opp.borrower);
    state.fastSet.delete(opp.borrower);
  } catch (e: any) {
    const detectedAt = Date.now();
    const is429 = e?.status === 429 || String(e).includes("429");
    if (is429) {
      const { url: rpcUrl } = scanPool.next();
      scanPool.markError(rpcUrl, true, msg => log.warn(msg));
    }
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
  state.loadCetusFees(addrs.CETUS_POOLS);

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

  // Batch 5: build asset->positions reverse index for event-driven HF refresh.
  for (const [addr, pos] of state.positions) indexPosition(addr, pos);
  log.info(`[INDEX] Built asset->positions index for ${assetToPositions.size} assets`);

  // Batch 6: start on-chain Pyth freshness poller (5s interval) — backup to Hermes WS.
  startPythChainPoller(client);
  log.info("[PYTH] On-chain price-feed poller started (5s interval)");

  // 100% HF alignment: replace ALL pos.hf with batched user_health_factor result.
  // Local computeHF was used to populate pos.hf during cache load and scan; this overwrites
  // those approximate values with the authoritative on-chain HF. Re-evaluate fastSet too.
  const realignAllHF = async (label: string) => {
    const t0 = Date.now();
    const addrsToCheck = [...state.positions.keys()];
    const hfs = await getNaviHFBatch(client, addrsToCheck);
    let updated = 0, addedFast = 0, removedFast = 0;
    for (const [addr, pos] of state.positions) {
      const hf = hfs.get(addr);
      if (hf === undefined || !isFinite(hf)) continue;
      pos.hf = hf;
      pos.lastUpdated = Date.now();
      updated++;
      const inFast = state.fastSet.has(addr);
      if (hf <= HF_SLOW_THRESHOLD && !inFast) { state.fastSet.add(addr); addedFast++; }
      else if (hf > HF_SLOW_THRESHOLD && inFast) { state.fastSet.delete(addr); removedFast++; }
    }
    log.info(`[HF-ALIGN ${label}] ${updated}/${addrsToCheck.length} positions in ${Date.now() - t0}ms (fastSet +${addedFast} -${removedFast}, now=${state.fastSet.size})`);
  };
  // Run alignment after cache load (don't block startup; happens in background).
  realignAllHF("startup").catch(e => log.warn("[HF-ALIGN] startup failed:", e));

  // Background scan: refreshes/prunes whether or not cache was loaded.
  withRetry(() => loadPositions(state, scanPool, addrs, log))
    .then(async () => {
      // Re-index after scan to catch any newly discovered positions.
      for (const [addr, pos] of state.positions) indexPosition(addr, pos);
      // 100% HF alignment after scan — overwrites local-computeHF values with naviHF.
      await realignAllHF("post-scan");
      savePositionsCache(state, log);
      log.info(`[CACHE] Background scan done: ${state.positions.size} positions, asset index has ${assetToPositions.size} entries`);
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
