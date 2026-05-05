/**
 * init_bot.ts — Slow liquidator + full position snapshot
 *
 * Scans every address in the NAVI user_info table. For each active account:
 *   • Snapshot: record scaled balances at scan time; indices/prices are live
 *     (Pyth WS + liveIndex extrapolation — NOT frozen to init startup time)
 *   • Liquidate: if HF < 1.0 and profitable, run devInspect then submit
 *
 * Every 1000 active accounts → incremental save to logs/positions-cache.json.
 * Final save at end of scan — used by navi-bot.ts on startup to warm its fast-set.
 */

import { mkdirSync } from "fs";

import WebSocket from "ws";
import { SuiClient } from "@mysten/sui/client";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Transaction } from "@mysten/sui/transactions";
import { SuiPriceServiceConnection, SuiPythClient } from "@pythnetwork/pyth-sui-js";
import { MAINNET, SCAN_RPCS, RpcPool } from "./network.js";
import {
  BotState, UserPosition,
  loadAssetConfigs, loadOraclePrices, loadPositions, savePositionsCache,
  liveIndex, getReserveInfo, getScaledBalance, loadUserPosition,
} from "./position-store.js";
import { buildLiquidationTx } from "./liquidation-executor.js";
import { ASSETS, RAY, MIN_PROFIT_USD, BOT_KEY } from "./config.js";
import { tg } from "./telegram.js";


// ── Oracle price updates for liquidation TX ───────────────────────────────────
const pythConn = new SuiPriceServiceConnection("https://hermes.pyth.network");
let _pythClient: SuiPythClient | null = null;
function getPythClient(client: SuiClient): SuiPythClient {
  if (!_pythClient) _pythClient = new SuiPythClient(client, MAINNET.PYTH_STATE_ID, MAINNET.WORMHOLE_STATE_ID);
  return _pythClient;
}

// Per-asset Pyth freshness check (dedup pioIds when multiple assets share one feed).
const STALE_BUNDLE_THRESHOLD_SEC = 30;
async function getPythStalenessMap(client: SuiClient, assetIds: number[]): Promise<Map<number, number>> {
  const map = new Map<number, number>();
  const pioToAssets = new Map<string, number[]>();
  for (const id of assetIds) {
    const feed = MAINNET.ORACLE_PRO_FEEDS[id];
    if (!feed?.pioId) { map.set(id, Infinity); continue; }
    const arr = pioToAssets.get(feed.pioId) ?? [];
    arr.push(id);
    pioToAssets.set(feed.pioId, arr);
  }
  const pioIds = [...pioToAssets.keys()];
  if (pioIds.length === 0) return map;
  try {
    const res = await client.multiGetObjects({ ids: pioIds, options: { showContent: true } });
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

// Bundle Pyth + NAVI oracle update for ALL position assets (no selective skip — NAVI's
// calculator staleness threshold < 30s for some assets, so bundling all is the safe path).
async function addStaleOracleUpdates(
  client: SuiClient, tx: Transaction, assetIds: number[], _stalenessMap: Map<number, number>,
): Promise<number> {
  const seen = new Set<string>();
  const pythFeeds = new Map<string, number>();
  const naviFeeds: any[] = [];
  for (const id of assetIds) {
    const feed = MAINNET.ORACLE_PRO_FEEDS[id];
    const pf = ASSETS[id]?.pyth;
    if (!feed || seen.has(feed.feedId)) continue;
    seen.add(feed.feedId);
    if (pf) pythFeeds.set(pf, id);
    naviFeeds.push(feed);
  }
  if (pythFeeds.size === 0 && naviFeeds.length === 0) return 0;
  if (pythFeeds.size > 0) {
    const ids = [...pythFeeds.keys()];
    const updates = await pythConn.getPriceFeedsUpdateData(ids);
    await getPythClient(client).updatePriceFeeds(tx, updates, ids);
  }
  for (const feed of naviFeeds) {
    tx.moveCall({
      target: `${MAINNET.ORACLE_PRO_PKG}::oracle_pro::update_single_price_v2`,
      arguments: [
        tx.object("0x6"),
        tx.sharedObjectRef({ objectId: MAINNET.ORACLE_CONFIG.id, initialSharedVersion: MAINNET.ORACLE_CONFIG.isv, mutable: true }),
        tx.sharedObjectRef({ objectId: MAINNET.PYTH_ORACLE.id, initialSharedVersion: MAINNET.PYTH_ORACLE.isv, mutable: true }),
        tx.sharedObjectRef({ objectId: MAINNET.SUPRA_HOLDER.id, initialSharedVersion: MAINNET.SUPRA_HOLDER.isv, mutable: false }),
        tx.object(feed.pioId),
        tx.sharedObjectRef({ objectId: MAINNET.SWITCHBOARD_AGG.id, initialSharedVersion: MAINNET.SWITCHBOARD_AGG.isv, mutable: false }),
        tx.pure.address(feed.feedId),
      ],
    });
  }
  return naviFeeds.length;
}

// True NAVI on-chain HF via logic_getter_unchecked::user_health_factor + oracle update.
// This is what the official navi-sdk repo calls (NOT the SDK package's `getHealthFactor`,
// which wraps `dynamic_health_factor` and returns 0 for emode users).
const NAVI_UI_GETTER = "0xa1357e2e9c28f90e76b085abb81f7ce3e59b699100687bbc3910c7e9f27bb7c8";

async function getNaviHF(client: SuiClient, address: string, _assetIds: number[]): Promise<number> {
  const m = await getNaviHFBatch(client, [address]);
  return m.get(address) ?? NaN;
}

// Batched user_health_factor with bisect-on-failure to isolate bad addresses.
const HF_BATCH_SIZE = 200;
async function tryHfBatch(client: SuiClient, batch: string[], result: Map<string, number>): Promise<boolean> {
  try {
    const tx = new Transaction();
    for (const a of batch) {
      tx.moveCall({
        target: `${NAVI_UI_GETTER}::logic_getter_unchecked::user_health_factor`,
        arguments: [
          tx.object("0x06"),
          tx.sharedObjectRef({ objectId: MAINNET.NAVI_STORAGE.id, initialSharedVersion: MAINNET.NAVI_STORAGE.isv, mutable: true }),
          tx.sharedObjectRef({ objectId: MAINNET.PYTH_ORACLE.id, initialSharedVersion: MAINNET.PYTH_ORACLE.isv, mutable: true }),
          tx.pure.address(a),
        ],
      });
    }
    const r = await client.devInspectTransactionBlock({ transactionBlock: tx, sender: batch[0] });
    if (r.effects?.status?.status !== "success") return false;
    for (let j = 0; j < batch.length; j++) {
      const rv = r.results?.[j]?.returnValues?.[0];
      if (!rv) { result.set(batch[j], NaN); continue; }
      const raw = BigInt("0x" + Buffer.from(rv[0]).reverse().toString("hex"));
      const hf = Number(raw) / 1e27;
      // HF==0 → unactionable (debt=0 healthy OR collat=0 bad-debt). Mark NaN.
      result.set(batch[j], hf === 0 ? NaN : (hf > 1e5 ? Infinity : hf));
    }
    return true;
  } catch { return false; }
}

async function getNaviHFBatch(client: SuiClient, addresses: string[]): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  if (addresses.length === 0) return result;
  const stack: string[][] = [];
  for (let i = 0; i < addresses.length; i += HF_BATCH_SIZE) stack.push(addresses.slice(i, i + HF_BATCH_SIZE));
  while (stack.length > 0) {
    const batch = stack.pop()!;
    const ok = await tryHfBatch(client, batch, result);
    if (!ok) {
      if (batch.length === 1) result.set(batch[0], NaN);
      else {
        const mid = Math.floor(batch.length / 2);
        stack.push(batch.slice(0, mid));
        stack.push(batch.slice(mid));
      }
    }
  }
  return result;
}

async function addOracleUpdates(client: SuiClient, tx: Transaction, ...assetIds: number[]): Promise<void> {
  if (!MAINNET.ORACLE_PRO_PKG) return;
  const seen      = new Set<string>();
  const pythFeeds = new Map<string, number>();
  const naviFeeds: { feed: (typeof MAINNET.ORACLE_PRO_FEEDS)[number] }[] = [];

  for (const id of assetIds) {
    const feed       = MAINNET.ORACLE_PRO_FEEDS[id];
    const pythFeedId = ASSETS[id]?.pyth;
    if (!feed || seen.has(feed.feedId)) continue;
    seen.add(feed.feedId);
    if (pythFeedId) pythFeeds.set(pythFeedId, id);
    naviFeeds.push({ feed });
  }

  if (pythFeeds.size > 0) {
    const feedIdList = [...pythFeeds.keys()];
    const updates = await pythConn.getPriceFeedsUpdateData(feedIdList);
    await getPythClient(client).updatePriceFeeds(tx, updates, feedIdList);
  }

  for (const { feed } of naviFeeds) {
    tx.moveCall({
      target: `${MAINNET.ORACLE_PRO_PKG}::oracle_pro::update_single_price_v2`,
      arguments: [
        tx.object("0x6"),
        tx.sharedObjectRef({ objectId: MAINNET.ORACLE_CONFIG.id,   initialSharedVersion: MAINNET.ORACLE_CONFIG.isv,   mutable: true  }),
        tx.sharedObjectRef({ objectId: MAINNET.PYTH_ORACLE.id,     initialSharedVersion: MAINNET.PYTH_ORACLE.isv,     mutable: true  }),
        tx.sharedObjectRef({ objectId: MAINNET.SUPRA_HOLDER.id,    initialSharedVersion: MAINNET.SUPRA_HOLDER.isv,    mutable: false }),
        tx.object(feed.pioId),
        tx.sharedObjectRef({ objectId: MAINNET.SWITCHBOARD_AGG.id, initialSharedVersion: MAINNET.SWITCHBOARD_AGG.isv, mutable: false }),
        tx.pure.address(feed.feedId),
      ],
    });
  }
}

// ── Pyth WebSocket: keeps state.prices live throughout the long scan ──────────

function startPythPriceFeed(state: BotState): () => void {
  const feedMap = new Map<string, number[]>();
  for (const [id, a] of Object.entries(ASSETS)) {
    if (!a.pyth) continue;
    const arr = feedMap.get(a.pyth) ?? [];
    arr.push(Number(id));
    feedMap.set(a.pyth, arr);
  }
  const feedIds = [...feedMap.keys()];
  let ws: WebSocket | null = null;
  let closed = false;

  const connect = () => {
    if (closed) return;
    ws = new WebSocket("wss://hermes.pyth.network/ws");
    ws.on("open", () => {
      ws!.send(JSON.stringify({ ids: feedIds, type: "subscribe" }));
      console.log(`[init_bot] Pyth WS connected — tracking ${feedIds.length} feeds`);
    });
    ws.on("message", (raw: Buffer) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type !== "price_update") return;
        const p = msg.price_feed;
        const price = Number(p.price.price) * Math.pow(10, p.price.expo);
        if (!isFinite(price) || price <= 0) return;
        for (const aid of feedMap.get(`0x${p.id}`) ?? []) state.prices.set(aid, price);
      } catch {}
    });
    ws.on("close", () => { if (!closed) setTimeout(connect, 3000); });
    ws.on("error", () => {});
  };
  connect();
  return () => { closed = true; ws?.close(); };
}

// ── Inline liquidation ────────────────────────────────────────────────────────

// ── profit label helper ───────────────────────────────────────────────────────

function oppLabel(opp: NonNullable<ReturnType<BotState["bestLiquidation"]>>, state: BotState, hf: number): string {
  const debtSym    = state.configs.get(opp.debtAsset)?.symbol   ?? `a${opp.debtAsset}`;
  const collatSym  = state.configs.get(opp.collatAsset)?.symbol ?? `a${opp.collatAsset}`;
  const debtPrice  = state.prices.get(opp.debtAsset)   ?? 0;
  const debtCfg    = state.configs.get(opp.debtAsset);
  const collatCfg  = state.configs.get(opp.collatAsset);

  const collatPrice = state.prices.get(opp.collatAsset) ?? 0;
  const repayUsd    = Number(opp.repayAmount) / 10 ** (debtCfg?.tokenDec ?? 9) * debtPrice;
  const receiveUsd  = repayUsd * (1 + (collatCfg?.liqBonus ?? 0));
  const receiveAmt  = collatPrice > 0 ? (receiveUsd / collatPrice).toFixed(4) : "?";
  const minProfitOk = opp.profitUsd >= MIN_PROFIT_USD;

  const repayHuman = (Number(opp.repayAmount) / 10 ** (debtCfg?.tokenDec ?? 9)).toFixed(4);
  return (
    `[${opp.source}] ${debtSym}→${collatSym}  HF=${hf.toFixed(3)}\n` +
    `  repay:     ${repayHuman} ${debtSym} (~$${repayUsd.toFixed(4)})\n` +
    `  receive:   ${receiveAmt} ${collatSym} ($${receiveUsd.toFixed(4)})  (bonus ${((collatCfg?.liqBonus ?? 0)*100).toFixed(1)}%)\n` +
    `  ──────────────────────────────\n` +
    `  liqBonus:  +$${opp.grossProfitUsd.toFixed(4)}\n` +
    `  cetusFee:   -$${opp.cetusFeeUsd.toFixed(4)}\n` +
    `  gas:        -$${opp.gasCostUsd.toFixed(6)}\n` +
    `  ──────────────────────────────\n` +
    `  NET:        $${opp.profitUsd.toFixed(4)}  ${minProfitOk ? `✅ ≥ $${MIN_PROFIT_USD}` : `❌ < $${MIN_PROFIT_USD}`}`
  );
}

// Returns a one-line explanation of why flash loan is not available for this opp.
function flashSkipReason(opp: NonNullable<ReturnType<BotState["bestLiquidation"]>>, state: BotState): string {
  const suiCoinType    = state.configs.get(0)?.coinType ?? "0x2::sui::SUI";
  const debtCoinType   = state.configs.get(opp.debtAsset)?.coinType   ?? "";
  const collatCoinType = state.configs.get(opp.collatAsset)?.coinType ?? "";
  const debtSym        = state.configs.get(opp.debtAsset)?.symbol   ?? `a${opp.debtAsset}`;
  const collatSym      = state.configs.get(opp.collatAsset)?.symbol ?? `a${opp.collatAsset}`;

  const hasPair = (a: string, b: string) =>
    state.cetusFees.has(`${a},${b}`) || state.cetusFees.has(`${b},${a}`);

  if (debtCoinType === suiCoinType) {
    // SUI debt: only path is direct SUI/COLLAT pool; multi-hop inapplicable
    if (!hasPair(suiCoinType, collatCoinType))
      return `no ${debtSym}/${collatSym} Cetus pool (can't flash-borrow ${debtSym})`;
    return `${debtSym}/${collatSym} flash fee exceeds liq bonus`;
  }
  if (!hasPair(debtCoinType, suiCoinType))
    return `no ${debtSym}/SUI Cetus pool (can't flash-borrow ${debtSym})`;
  if (!hasPair(collatCoinType, suiCoinType))
    return `no ${collatSym}/SUI Cetus pool (can't swap ${collatSym} back to SUI for repayment)`;
  return "flash fee exceeds liq bonus";
}

// ── tryLiquidate — 3-branch decision ─────────────────────────────────────────
//
//  Case 1: flash loan profit > MIN_PROFIT_USD → devInspect + execute
//  Case 2: wallet profit > MIN_PROFIT_USD     → report (execute if debt=SUI)
//  Case 3: neither profitable                 → report diagnostic (debt ≥ $5 only)

async function tryLiquidate(
  pos:     UserPosition,
  state:   BotState,
  client:  SuiClient,
  keypair: Ed25519Keypair,
): Promise<void> {
  const opp = state.bestLiquidation(pos);

  // ── Case 3: no profitable pair ──────────────────────────────────────────────
  if (!opp) {
    let debtUsd = 0;
    for (const [id, scaled] of pos.scaledDebts) {
      const actual = Number(scaled * liveIndex(id, "borrow") / RAY) / 1e9;
      debtUsd += actual * (state.prices.get(id) ?? 0);
    }
    if (debtUsd >= 5) {
      const allAssets = [...pos.scaledCollaterals.keys(), ...pos.scaledDebts.keys()];
      const naviHF    = await getNaviHF(client, pos.address, allAssets);
      // Skip if NAVI HF query failed (RPC issue) or position is healthy.
      // Case3 only meaningful for underwater positions we can't capture.
      if (!isFinite(naviHF) || naviHF >= 1.0) {
        console.log(`[init_bot] skip Case3 ${pos.address.slice(0,20)}  naviHF=${isFinite(naviHF) ? naviHF.toFixed(3) : "NaN"}`);
        return;
      }
      const hfStr     = `naviHF=${naviHF.toFixed(3)}`;
      const displayHf = naviHF;
      const bestDebug  = state.bestLiquidation(pos, -Infinity);
      const collatSyms = [...pos.scaledCollaterals.keys()].map(id => state.configs.get(id)?.symbol ?? `a${id}`).join(",");
      const debtSyms   = [...pos.scaledDebts.keys()].map(id => state.configs.get(id)?.symbol ?? `a${id}`).join(",");
      const debtIds    = [...pos.scaledDebts.keys()];
      const sameAsset  = debtIds.every(id => pos.scaledCollaterals.has(id)) && [...pos.scaledCollaterals.keys()].every(id => pos.scaledDebts.has(id));

      // Hypothetical profit estimate: pick the best (debt, collat) pair by gross liq bonus.
      // No Cetus/wallet fee modeling — just shows what the position COULD yield if a route existed.
      let hypoLine = "";
      if (!bestDebug && !sameAsset) {
        let best: { debtSym: string; collatSym: string; repayUsd: number; receiveUsd: number; gross: number } | null = null;
        for (const [debtId, dScaled] of pos.scaledDebts) {
          const dCfg = state.configs.get(debtId), dPx = state.prices.get(debtId);
          if (!dCfg || !dPx) continue;
          const dRaw = Number(dScaled * liveIndex(debtId, "borrow") / RAY) / 1e9;
          const dCloseFactor = dCfg.closeFactor > 0 ? dCfg.closeFactor : 0.5;
          const maxRepayUsd = dRaw * dPx * dCloseFactor;
          for (const [cId, cScaled] of pos.scaledCollaterals) {
            if (cId === debtId) continue;
            const cCfg = state.configs.get(cId), cPx = state.prices.get(cId);
            if (!cCfg || !cPx) continue;
            const cRaw = Number(cScaled * liveIndex(cId, "supply") / RAY) / 1e9;
            const cUsd = cRaw * cPx;
            const repayUsd = Math.min(maxRepayUsd, cUsd / (1 + cCfg.liqBonus));
            if (repayUsd <= 0) continue;
            const receiveUsd = repayUsd * (1 + cCfg.liqBonus);
            const gross = receiveUsd - repayUsd;
            if (!best || gross > best.gross) {
              best = { debtSym: dCfg.symbol, collatSym: cCfg.symbol, repayUsd, receiveUsd, gross };
            }
          }
        }
        if (best) {
          hypoLine = `\n  hypothetical: repay $${best.repayUsd.toFixed(2)} ${best.debtSym} → receive $${best.receiveUsd.toFixed(2)} ${best.collatSym}  gross=+$${best.gross.toFixed(2)} <i>(no Cetus route, can't execute)</i>`;
        }
      }

      const debugLabel = bestDebug
        ? oppLabel(bestDebug, state, displayHf)
        : sameAsset
          ? `same-asset pair (collat=[${collatSyms}] debt=[${debtSyms}]) — cross-asset liquidation not possible`
          : `no valid cross-asset pair found for collat=[${collatSyms}] debt=[${debtSyms}]${hypoLine}`;
      const msg = sameAsset
        ? `📋 <b>Case3: same-asset</b>\n<code>${pos.address}</code>\n${debtSyms} debt=$${debtUsd.toFixed(2)}  ${hfStr}\nCross-asset liquidation not possible`
        : `📋 <b>Case3: below threshold</b>\n<code>${pos.address}</code>\n${hfStr}  debt=$${debtUsd.toFixed(2)}  collat=[${collatSyms}]→debt=[${debtSyms}]\n${debugLabel}`;
      console.log(`[init_bot] ${msg.replace(/<[^>]+>/g, "").replace(/\n/g, "  ")}`);
      await tg(msg);
    }
    return;
  }

  // Re-fetch complete position from chain (catches assets the initial scan missed).
  await loadUserPosition(state, client, MAINNET, pos.address);
  const refreshedPos = state.positions.get(pos.address) ?? pos;
  const freshOpp = state.bestLiquidation(refreshedPos) ?? opp;
  const allPositionAssets = [
    ...refreshedPos.scaledCollaterals.keys(),
    ...refreshedPos.scaledDebts.keys(),
  ];

  // GATE: true NAVI on-chain HF (logic_getter_unchecked::user_health_factor + oracle update).
  // Same value the on-chain liquidation_v2 checks. Skip silently if recovered or query failed.
  const naviHF = await getNaviHF(client, pos.address, allPositionAssets);
  if (!isFinite(naviHF) || naviHF >= 1.0) {
    console.log(`[init_bot] skip ${pos.address.slice(0,20)}  naviHF=${isFinite(naviHF) ? naviHF.toFixed(4) : "NaN"}`);
    return;
  }

  const label = oppLabel(freshOpp, state, naviHF);
  // Batch 3: only cetus / cetus-multi flash routes are returned by bestLiquidation.
  console.log(`[init_bot] ⚡ Case1 flash: ${pos.address.slice(0, 20)}  ${label.replace(/\n/g, "  ")}`);

  try {
    const sender  = keypair.getPublicKey().toSuiAddress();
    let currentOpp = freshOpp;
    // Per-asset freshness map; selective oracle bundle for stale ones only (fixes 1502).
    const stalenessMap = await getPythStalenessMap(client, allPositionAssets);
    let tx = await buildLiquidationTx(currentOpp, keypair, MAINNET, client, currentOpp.source,
      async (t) => { await addStaleOracleUpdates(client, t, allPositionAssets, stalenessMap); });
    let retries = 0;

    let inspect = await client.devInspectTransactionBlock({ transactionBlock: tx, sender });

    while (inspect.effects?.status?.status !== "success") {
      const err = inspect.effects?.status?.error ?? "unknown";

      // Race: HF passed gate but recovered before devInspect, or close-factor edge case.
      // Silent skip — gate already verified HF<1.0 a moment ago.
      if (err.includes("1606") || err.includes("1607") || err.includes("InsufficientCoinBalance")) {
        console.log(`[init_bot] ⏭ race skip ${pos.address.slice(0, 20)}: ${err.slice(0, 80)}`);
        return;
      }

      // Retryable with halved repayAmount (up to 8 halvings):
      //   compute_swap_step 6 — pool depth insufficient at this tick
      //   swap_in_pool       — pool boundary / price limit exceeded
      //   NAVI 1502          — repay exceeds close-factor cap (index drift since snapshot)
      const isPoolErr = (err.includes("compute_swap_step") && /,\s*6\)/.test(err)) || err.includes("swap_in_pool");
      const isRetryable = currentOpp.source.startsWith("cetus") && retries < 8 && (
        isPoolErr || err.includes("1502")
      );
      if (isRetryable) {
        retries++;
        const newRepay = currentOpp.repayAmount / 2n;
        const debtPrice   = state.prices.get(currentOpp.debtAsset) ?? 0;
        const debtCfg     = state.configs.get(currentOpp.debtAsset);
        const newRepayUsd = Number(newRepay) / 10 ** (debtCfg?.tokenDec ?? 9) * debtPrice;
        const liqBonus    = state.configs.get(currentOpp.collatAsset)?.liqBonus ?? 0;
        if (newRepayUsd * liqBonus < MIN_PROFIT_USD) {
          const limitTag = `Case1 ${currentOpp.source}`;
          console.log(`[init_bot] ⏭ halving-limit: below min_profit after ${retries} halving(s), skip`);
          await tg(`⏭ <b>Pool limit skip [${limitTag}]</b>\n<code>${pos.address}</code>\n${label}\n<i>pool too thin: profit < $${MIN_PROFIT_USD} after ${retries}× halving</i>`);
          return;
        }
        const errTag = err.includes("swap_in_pool") ? "swap_in_pool" : err.includes("1502") ? "calc-1502" : "liq-limit";
        console.log(`[init_bot] 🔄 ${errTag} — halving repay to ~$${newRepayUsd.toFixed(0)}, retry ${retries}/8`);
        currentOpp = { ...currentOpp, repayAmount: newRepay };
        tx = await buildLiquidationTx(currentOpp, keypair, MAINNET, client, currentOpp.source,
          async (t) => { await addStaleOracleUpdates(client, t, allPositionAssets, stalenessMap); });
        inspect = await client.devInspectTransactionBlock({ transactionBlock: tx, sender });
        continue;
      }

      // Pool exhausted after 8 halvings
      if (currentOpp.source.startsWith("cetus") && retries >= 8 && isPoolErr) {
        const limitTag = `Case1 ${currentOpp.source}`;
        console.log(`[init_bot] ⏭ pool-thin: ${pos.address.slice(0, 20)} exhausted 8 halvings`);
        await tg(`⏭ <b>Pool too thin [${limitTag}]</b>\n<code>${pos.address}</code>\n${label}\n<i>pool depth insufficient even at 1/${2**8}× repay after 8× halving</i>`);
        return;
      }

      console.log(`[init_bot] ⚠️  devInspect fail: ${err.slice(0, 300)}`);
      await tg(`⚠️ <b>devInspect failed</b>\n<code>${pos.address}</code>\n${label}\n<code>${err.slice(0, 200)}</code>`);
      return;
    }
    const caseTag = `Case1 ${currentOpp.source}`;
    console.log(`[init_bot] ✅ devInspect OK — submitting [${caseTag}]`);
    await tg(`🚀 <b>Executing [${caseTag}]</b>\n<code>${pos.address}</code>\n${label}`);

    const bytes = await tx.build({ client });
    const { signature } = await keypair.signTransaction(bytes);
    const result = await client.executeTransactionBlock({
      transactionBlock: bytes,
      signature,
      options: { showEffects: true },
    });

    if (result.effects?.status?.status === "success") {
      console.log(`[init_bot] ✅ SUCCESS [${caseTag}]  digest=${result.digest}`);
      await tg(`✅ <b>Success [${caseTag}]</b>\n<code>${pos.address}</code>\n${label}\n<a href="https://suiscan.xyz/mainnet/tx/${result.digest}">${result.digest.slice(0,20)}…</a>`);
    } else {
      const txErr = result.effects?.status?.error ?? "unknown";
      console.log(`[init_bot] ❌ TX failed: ${txErr}`);
      await tg(`❌ <b>TX failed [${caseTag}]</b>\n<code>${pos.address}</code>\n${txErr.slice(0, 200)}`);
    }
  } catch (e: any) {
    const errMsg = e?.message ?? String(e);
    console.warn(`[init_bot] liquidation error: ${errMsg}`);
    const caseTag = `Case1 ${freshOpp.source}`;
    await tg(`💥 <b>Exception [${caseTag}]</b>\n<code>${pos.address}</code>\n${label}\n<code>${errMsg.slice(0, 200)}</code>`);
  }
}

// ── main ──────────────────────────────────────────────────────────────────────

async function main() {
  mkdirSync("logs", { recursive: true });

  const startMs = Date.now();
  const pool    = new RpcPool(SCAN_RPCS);
  console.log(`[init_bot] ${new Date().toISOString()}  RPCs: ${pool.size}x  ${pool.statusLine()}`);

  const state  = new BotState();
  const client = pool.next().client;

  await loadAssetConfigs(state, client, MAINNET);
  state.loadCetusFees(MAINNET.CETUS_POOLS);

  const keypair = Ed25519Keypair.fromSecretKey(Buffer.from(BOT_KEY, "hex"));
  console.log(`[init_bot] Bot wallet: ${keypair.getPublicKey().toSuiAddress()}`);

  // Seed non-Pyth prices (NS, DEEP, BLUE, BUCK, LBTC, …) from NAVI oracle
  try {
    const oracle = await loadOraclePrices(client, MAINNET);
    for (const [id, p] of oracle) state.prices.set(id, p);
    console.log(`[init_bot] Oracle seed: ${oracle.size} asset prices`);
  } catch (e) {
    console.warn(`[init_bot] Oracle seed failed: ${e}`);
  }

  // Pyth WebSocket keeps SUI/ETH/BTC/… prices live throughout the scan
  const stopPyth = startPythPriceFeed(state);
  await new Promise(r => setTimeout(r, 2000)); // wait for first WS batch

  // Periodically refresh NAVI oracle prices (every 3 min) for any assets not covered by Pyth WS.
  // Without this, non-Pyth assets (AUSD, etc.) freeze at startup values during long scans.
  const oracleRefresh = setInterval(async () => {
    try {
      const oracle = await loadOraclePrices(client, MAINNET);
      for (const [id, p] of oracle) {
        if (!ASSETS[id]?.pyth) state.prices.set(id, p);  // don't override live Pyth prices
      }
    } catch {}
  }, 3 * 60_000);

  console.log(`[init_bot] Prices ready: ${state.prices.size} assets`);
  for (const [id, p] of [...state.prices.entries()].sort((a, b) => a[0] - b[0])) {
    process.stdout.write(`  ${ASSETS[id]?.symbol ?? `a${id}`}=$${p.toFixed(4)}  `);
  }
  console.log();

  // Phase 1: scan all positions (no inline liquidation — pos.hf is Infinity until realign).
  await loadPositions(state, pool, MAINNET, undefined);
  clearInterval(oracleRefresh);

  // Phase 2: 100% HF alignment via batched user_health_factor.
  // Replaces local computeHF entirely — emode + price feed mismatches eliminated by design.
  const allAddrs = [...state.positions.keys()];
  console.log(`[init_bot] Realigning ${allAddrs.length} positions to NAVI HF (batched user_health_factor)...`);
  const t0 = Date.now();
  const hfMap = await getNaviHFBatch(client, allAddrs);
  let aligned = 0, liqCandidates: string[] = [];
  for (const [addr, pos] of state.positions) {
    const hf = hfMap.get(addr);
    if (hf === undefined || !isFinite(hf)) continue;
    pos.hf = hf;
    aligned++;
    if (hf < 1.0) liqCandidates.push(addr);
  }
  console.log(`[init_bot] Aligned ${aligned}/${allAddrs.length} in ${Date.now() - t0}ms, ${liqCandidates.length} liquidatable`);
  savePositionsCache(state);

  // Phase 3: try liquidate each candidate (tryLiquidate has its own naviHF gate for race protection).
  for (const addr of liqCandidates) {
    const pos = state.positions.get(addr);
    if (pos) await tryLiquidate(pos, state, client, keypair);
  }
  stopPyth();

  const elapsed = ((Date.now() - startMs) / 60_000).toFixed(1);

  let liquidatable = 0, cetusFlash = 0, cetusMulti = 0;
  for (const pos of state.positions.values()) {
    if (!isFinite(pos.hf) || pos.hf >= 1.0) continue;
    liquidatable++;
    const opp = state.bestLiquidation(pos);
    if (opp?.source === "cetus")       cetusFlash++;
    else if (opp?.source === "cetus-multi") cetusMulti++;
  }

  console.log(`[init_bot] Done in ${elapsed} min. ${state.positions.size} positions cached.`);
  console.log(`[init_bot] Liquidatable: ${liquidatable}  |  cetus: ${cetusFlash}  |  cetus-multi: ${cetusMulti}`);
}

main().catch(e => {
  console.error("[init_bot] Fatal:", e);
  process.exit(1);
});
