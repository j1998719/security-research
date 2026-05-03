/**
 * init_bot.ts — Slow liquidator + full position snapshot
 *
 * Scans every address in the NAVI user_info table. For each active account:
 *   • Snapshot: record scaled balances, indices, prices, and HF at load time
 *   • Liquidate: if HF < 1.0 and a profitable Cetus flash-loan opportunity exists,
 *     run devInspect then submit immediately
 *
 * Every 1000 active accounts → incremental save to logs/positions-cache.json.
 * Final save at end of scan — used by navi-bot.ts on startup to warm its fast-set.
 *
 * Complements navi-bot.ts (event-driven, fast) by covering all accounts once per run.
 *
 * Usage:
 *   npx tsx bot/init_bot.ts           # full scan + liquidation
 *   SCAN_ONLY=1 npx tsx bot/init_bot.ts  # snapshot only, skip liquidation
 */

import { mkdirSync } from "fs";

import WebSocket from "ws";
import { SuiClient } from "@mysten/sui/client";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Transaction } from "@mysten/sui/transactions";
import { SuiPriceServiceConnection, SuiPythClient } from "@pythnetwork/pyth-sui-js";
const { getHealthFactor: naviGetHealthFactor } =
  await import("@naviprotocol/lending" as any) as any;
import { MAINNET, SCAN_RPCS, RpcPool } from "./network.js";
import {
  BotState, UserPosition,
  loadAssetConfigs, loadOraclePrices, loadPositions, savePositionsCache,
  liveIndex,
} from "./position-store.js";
import { buildLiquidationTx } from "./liquidation-executor.js";
import { ASSETS, RAY, MIN_PROFIT_USD, BOT_KEY } from "./config.js";
import { tg } from "./telegram.js";

const SCAN_ONLY = process.env.SCAN_ONLY === "1";

// ── Oracle price updates for liquidation TX ───────────────────────────────────
const pythConn = new SuiPriceServiceConnection("https://hermes.pyth.network");
let _pythClient: SuiPythClient | null = null;
function getPythClient(client: SuiClient): SuiPythClient {
  if (!_pythClient) _pythClient = new SuiPythClient(client, MAINNET.PYTH_STATE_ID, MAINNET.WORMHOLE_STATE_ID);
  return _pythClient;
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
    try {
      const updates = await pythConn.getPriceFeedsUpdateData([...pythFeeds.keys()]);
      await getPythClient(client).updatePriceFeeds(tx, updates, [...pythFeeds.keys()]);
    } catch (e) {
      console.warn(`[init_bot] Pyth VAA push failed (proceeding without): ${e}`);
    }
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
      const bestDebug  = state.bestLiquidation(pos, -Infinity);
      const collatSyms = [...pos.scaledCollaterals.keys()].map(id => state.configs.get(id)?.symbol ?? `a${id}`).join(",");
      const debtSyms   = [...pos.scaledDebts.keys()].map(id => state.configs.get(id)?.symbol ?? `a${id}`).join(",");
      // Check if all debt assets are also in collateral (same-asset-only positions)
      const debtIds    = [...pos.scaledDebts.keys()];
      const sameAsset  = debtIds.every(id => pos.scaledCollaterals.has(id)) && [...pos.scaledCollaterals.keys()].every(id => pos.scaledDebts.has(id));
      const debugLabel = bestDebug
        ? oppLabel(bestDebug, state, pos.hf)
        : sameAsset
          ? `same-asset pair (collat=[${collatSyms}] debt=[${debtSyms}]) — cross-asset liquidation not possible`
          : `no valid cross-asset pair found for collat=[${collatSyms}] debt=[${debtSyms}]`;
      const msg = sameAsset
        ? `📋 <b>Case3: same-asset</b>\n<code>${pos.address}</code>\n${debtSyms} debt=$${debtUsd.toFixed(2)}  HF=${pos.hf.toFixed(3)}\nCross-asset liquidation not possible`
        : `📋 <b>Case3: below threshold</b>\n<code>${pos.address}</code>\nHF=${pos.hf.toFixed(3)}  debt=$${debtUsd.toFixed(2)}  collat=[${collatSyms}]→debt=[${debtSyms}]\n${debugLabel}`;
      console.log(`[init_bot] ${msg.replace(/<[^>]+>/g, "").replace(/\n/g, "  ")}`);
      await tg(msg);
    }
    return;
  }

  const label = oppLabel(opp, state, pos.hf);

  // ── Case 2: wallet opportunity ──────────────────────────────────────────────
  if (opp.source === "wallet") {
    console.log(`[init_bot] 🎯 Case2 wallet: ${pos.address.slice(0, 20)}  ${label.replace(/\n/g, "  ")}`);
    await tg(`🎯 <b>Case2: Wallet liquidation</b>\n<code>${pos.address}</code>\n${label}`);
    // Auto-execute wallet liquidations where debt=SUI (split from gas, no token needed)
    if (opp.debtAsset !== 0) return;
    console.log(`[init_bot] 🎯 SUI-debt wallet — attempting auto-execute`);
  } else {
    // ── Case 1: flash loan opportunity ────────────────────────────────────────
    console.log(`[init_bot] ⚡ Case1 flash: ${pos.address.slice(0, 20)}  ${label.replace(/\n/g, "  ")}`);
  }

  try {
    // Pre-check: verify position is still liquidatable on-chain.
    // Positions found during a slow cache scan may have been liquidated by faster bots.
    // Skip silently if HF ≥ 1.0 (no TG noise for stale cache entries).
    try {
      const liveHf: number = await naviGetHealthFactor(pos.address, { client, env: "prod" });
      if (!isFinite(liveHf) || liveHf >= 1.0) {
        console.log(`[init_bot] ⏭ skip ${pos.address.slice(0, 20)}... — already liquidated (on-chain HF=${isFinite(liveHf) ? liveHf.toFixed(3) : "∞"})`);
        return;
      }
    } catch { /* RPC error — proceed and let devInspect catch it */ }

    const sender  = keypair.getPublicKey().toSuiAddress();
    let currentOpp = opp;
    let tx = await buildLiquidationTx(currentOpp, keypair, MAINNET, client, currentOpp.source,
      (t, da, ca) => addOracleUpdates(client, t, da, ca));
    let retries = 0;

    let inspect = await client.devInspectTransactionBlock({ transactionBlock: tx, sender });

    while (inspect.effects?.status?.status !== "success") {
      const err = inspect.effects?.status?.error ?? "unknown";
      // 1606 = NAVI "not liquidatable" (already cleared by another bot)
      // InsufficientCoinBalance = flash-loan repay short (race condition or marginal position)
      if (err.includes("1606") || err.includes("InsufficientCoinBalance")) {
        console.log(`[init_bot] ⏭ stale-liq skip ${pos.address.slice(0, 20)}: ${err.slice(0, 120)}`);
        return;
      }
      // Cetus compute_swap_step error 6 = pool liquidity insufficient for requested amount.
      // Halve repayAmount and retry until the pool can support it or we drop below min_profit.
      const isCetusLiqLimit = err.includes("compute_swap_step") && /,\s*6\)/.test(err);
      if (isCetusLiqLimit && currentOpp.source.startsWith("cetus") && retries < 8) {
        retries++;
        const newRepay = currentOpp.repayAmount / 2n;
        const debtPrice = state.prices.get(currentOpp.debtAsset) ?? 0;
        const debtCfg   = state.configs.get(currentOpp.debtAsset);
        const newRepayUsd = Number(newRepay) / 10 ** (debtCfg?.tokenDec ?? 9) * debtPrice;
        const liqBonus    = state.configs.get(currentOpp.collatAsset)?.liqBonus ?? 0;
        if (newRepayUsd * liqBonus < MIN_PROFIT_USD) {
          console.log(`[init_bot] ⏭ cetus-liq-limit: below min_profit after ${retries} halving(s), skip`);
          return;
        }
        console.log(`[init_bot] 🔄 Cetus liq-limit (err 6) — halving repay to ~$${newRepayUsd.toFixed(0)}, retry ${retries}/8`);
        currentOpp = { ...currentOpp, repayAmount: newRepay };
        tx = await buildLiquidationTx(currentOpp, keypair, MAINNET, client, currentOpp.source,
          (t, da, ca) => addOracleUpdates(client, t, da, ca));
        inspect = await client.devInspectTransactionBlock({ transactionBlock: tx, sender });
        continue;
      }
      console.log(`[init_bot] ⚠️  devInspect fail: ${err.slice(0, 300)}`);
      await tg(`⚠️ devInspect failed\n${pos.address.slice(0, 20)}\n${label}\n${err.slice(0, 300)}`);
      return;
    }
    const caseTag = currentOpp.source === "wallet" ? "Case2 wallet" : `Case1 ${currentOpp.source}`;
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
    console.warn(`[init_bot] liquidation error: ${e?.message ?? e}`);
  }
}

// ── main ──────────────────────────────────────────────────────────────────────

async function main() {
  mkdirSync("logs", { recursive: true });

  const startMs = Date.now();
  const pool    = new RpcPool(SCAN_RPCS);
  console.log(`[init_bot] ${new Date().toISOString()}  RPCs: ${pool.size}x  ${pool.statusLine()}`);
  if (SCAN_ONLY) console.log("[init_bot] SCAN_ONLY — liquidation disabled");

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

  console.log(`[init_bot] Prices ready: ${state.prices.size} assets`);
  for (const [id, p] of [...state.prices.entries()].sort((a, b) => a[0] - b[0])) {
    process.stdout.write(`  ${ASSETS[id]?.symbol ?? `a${id}`}=$${p.toFixed(4)}  `);
  }
  console.log();

  // Scan: snapshot every active account; liquidate immediately if HF < 1.0
  const onLiquidatable = SCAN_ONLY
    ? undefined
    : (pos: UserPosition, st: BotState) => tryLiquidate(pos, st, client, keypair);

  await loadPositions(state, pool, MAINNET, undefined, onLiquidatable);
  savePositionsCache(state);
  stopPyth();

  const elapsed = ((Date.now() - startMs) / 60_000).toFixed(1);

  let liquidatable = 0, cetusFlash = 0, cetusMulti = 0, wallet = 0;
  for (const pos of state.positions.values()) {
    if (!isFinite(pos.hf) || pos.hf >= 1.0) continue;
    liquidatable++;
    const opp = state.bestLiquidation(pos);
    if (opp?.source === "cetus")       cetusFlash++;
    else if (opp?.source === "cetus-multi") cetusMulti++;
    else if (opp?.source === "wallet") wallet++;
  }

  console.log(`[init_bot] Done in ${elapsed} min. ${state.positions.size} positions cached.`);
  console.log(`[init_bot] Liquidatable: ${liquidatable}  |  cetus: ${cetusFlash}  |  cetus-multi: ${cetusMulti}  |  wallet: ${wallet}`);
}

main().catch(e => {
  console.error("[init_bot] Fatal:", e);
  process.exit(1);
});
