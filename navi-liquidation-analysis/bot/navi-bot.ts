/**
 * NAVI Liquidation Monitor Bot
 *
 * Architecture:
 *   PythMonitor ──priceQueue──▶ HFUpdater ──liquidationQueue──▶ Liquidator
 *   EventMonitor ─────────────▶ PositionStore
 *                                    ▲
 *                                 startup load
 *
 * Run:  npm run bot          (live mode — submits transactions)
 *       npm run bot:dry      (dry-run — logs opportunities only)
 *
 * Required env:
 *   NAVI_BOT_KEY   hex private key (no 0x prefix) — only needed in live mode
 */

import { SuiClient } from "@mysten/sui/client";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Transaction } from "@mysten/sui/transactions";
import WebSocket from "ws";
import {
  SUI_RPC, PYTH_WS,
  NAVI_PKG, NAVI_STORAGE, PYTH_ORACLE, CLOCK, ZERO_ADDR,
  RAY, DRY_RUN, MIN_PROFIT_SUI, GAS_BUDGET_MIST,
  HF_SLOW_THRESHOLD, SLOW_INTERVAL_MS, ASSETS,
} from "./config.js";

// ── types ─────────────────────────────────────────────────────────────────────

interface AssetConfig {
  symbol:       string;
  liqThreshold: number;   // e.g. 0.80
  liqBonus:     number;   // e.g. 0.10
  tokenDec:     number;
  coinType:     string;   // "0x2::sui::SUI" etc.
}

interface UserPosition {
  address:    string;
  // asset_id → raw amount in token's smallest unit (BigInt)
  collaterals: Map<number, bigint>;
  debts:       Map<number, bigint>;
  hf:          number;
  lastUpdated: number;   // Date.now()
}

interface LiquidationOpp {
  borrower:    string;
  debtAsset:   number;
  collatAsset: number;
  repayAmount: bigint;   // raw token units
  profitUsd:   number;
  hf:          number;
}

// ── shared state ──────────────────────────────────────────────────────────────

class BotState {
  prices   = new Map<number, number>();         // asset_id → USD price
  configs  = new Map<number, AssetConfig>();     // asset_id → config
  positions= new Map<string, UserPosition>();   // address → position
  // fast tier: positions with HF ≤ HF_SLOW_THRESHOLD
  fastSet  = new Set<string>();

  computeHF(pos: UserPosition): number {
    let collatValue = 0;
    for (const [id, raw] of pos.collaterals) {
      const cfg   = this.configs.get(id);
      const price = this.prices.get(id);
      if (!cfg || !price) continue;
      collatValue += (Number(raw) / 10 ** cfg.tokenDec) * price * cfg.liqThreshold;
    }
    let debtValue = 0;
    for (const [id, raw] of pos.debts) {
      const cfg   = this.configs.get(id);
      const price = this.prices.get(id);
      if (!cfg || !price) continue;
      debtValue += (Number(raw) / 10 ** cfg.tokenDec) * price;
    }
    return debtValue === 0 ? Infinity : collatValue / debtValue;
  }

  bestLiquidation(pos: UserPosition): LiquidationOpp | null {
    const suiPrice = this.prices.get(0) ?? 1;
    let best: LiquidationOpp | null = null;

    for (const [debtId, debtRaw] of pos.debts) {
      const debtCfg   = this.configs.get(debtId);
      const debtPrice = this.prices.get(debtId);
      if (!debtCfg || !debtPrice) continue;

      // NAVI caps repay at 50% of debt
      const repayRaw  = debtRaw / BigInt(2);
      const repayUsd  = (Number(repayRaw) / 10 ** debtCfg.tokenDec) * debtPrice;

      for (const [collatId] of pos.collaterals) {
        const collatCfg = this.configs.get(collatId);
        if (!collatCfg) continue;
        const receivedUsd = repayUsd * (1 + collatCfg.liqBonus);
        const profitUsd   = receivedUsd - repayUsd - (Number(GAS_BUDGET_MIST) / 1e9) * suiPrice;

        if (profitUsd > MIN_PROFIT_SUI * suiPrice) {
          if (!best || profitUsd > best.profitUsd) {
            best = {
              borrower:    pos.address,
              debtAsset:   debtId,
              collatAsset: collatId,
              repayAmount: repayRaw,
              profitUsd,
              hf:          pos.hf,
            };
          }
        }
      }
    }
    return best;
  }
}

// ── logging ───────────────────────────────────────────────────────────────────

const log = {
  info:  (...a: unknown[]) => console.log(`[${ts()}] INFO `, ...a),
  warn:  (...a: unknown[]) => console.warn(`[${ts()}] WARN `, ...a),
  error: (...a: unknown[]) => console.error(`[${ts()}] ERROR`, ...a),
  debug: (...a: unknown[]) => process.env.DEBUG && console.debug(`[${ts()}] DEBUG`, ...a),
};
const ts = () => new Date().toISOString().slice(11, 23);

// ── Sui client ────────────────────────────────────────────────────────────────

const client = new SuiClient({ url: SUI_RPC });

// ── startup: load asset configs ───────────────────────────────────────────────

async function loadAssetConfigs(state: BotState) {
  log.info("Loading asset configs from chain...");

  const storageObj = await client.getObject({ id: NAVI_STORAGE, options: { showContent: true } });
  const sFields = (storageObj.data?.content as any)?.fields;
  const reservesTableId: string = sFields?.reserves?.fields?.id?.id;

  const dfs = await client.getDynamicFields({ parentId: reservesTableId });
  const tasks = dfs.data.map(async entry => {
    const assetId = Number(entry.name.value);
    const obj = await client.getObject({ id: entry.objectId, options: { showContent: true } });
    const rf = (obj.data?.content as any)?.fields?.value?.fields;
    const lf = rf?.liquidation_factors?.fields ?? {};
    const meta = ASSETS[assetId];

    state.configs.set(assetId, {
      symbol:       meta?.symbol ?? `asset_${assetId}`,
      liqThreshold: Number(BigInt(lf?.threshold ?? 0) * BigInt(10000) / RAY) / 10000,
      liqBonus:     Number(BigInt(lf?.bonus     ?? 0) * BigInt(10000) / RAY) / 10000,
      tokenDec:     meta?.tokenDec ?? 9,
      coinType:     rf?.coin_type ?? "",
    });
  });

  await Promise.all(tasks);
  log.info(`Loaded ${state.configs.size} asset configs`);
}

// ── position loading ──────────────────────────────────────────────────────────

let reservesTableId = "";
const reserveCache = new Map<number, {
  supplyTableId: string;
  borrowTableId: string;
  supplyIndex:   bigint;
  borrowIndex:   bigint;
}>();

async function ensureReservesTable() {
  if (reservesTableId) return;
  const obj = await client.getObject({ id: NAVI_STORAGE, options: { showContent: true } });
  reservesTableId = (obj.data?.content as any)?.fields?.reserves?.fields?.id?.id;
}

async function getReserveInfo(assetId: number) {
  if (reserveCache.has(assetId)) return reserveCache.get(assetId)!;
  await ensureReservesTable();

  const df = await client.getDynamicFieldObject({
    parentId: reservesTableId,
    name: { type: "u8", value: assetId.toString() },
  });
  const rf = (df.data?.content as any)?.fields?.value?.fields;
  const info = {
    supplyTableId: rf?.supply_balance?.fields?.user_state?.fields?.id?.id as string,
    borrowTableId: rf?.borrow_balance?.fields?.user_state?.fields?.id?.id as string,
    supplyIndex:   BigInt(rf?.current_supply_index ?? RAY.toString()),
    borrowIndex:   BigInt(rf?.current_borrow_index ?? RAY.toString()),
  };
  reserveCache.set(assetId, info);
  return info;
}

async function getScaledBalance(tableId: string, address: string): Promise<bigint> {
  try {
    const df = await client.getDynamicFieldObject({
      parentId: tableId,
      name: { type: "address", value: address },
    });
    if (df.error || !df.data) return 0n;
    const val = (df.data.content as any)?.fields?.value;
    if (typeof val === "string") return BigInt(val);
    const inner = val?.fields?.balance ?? val?.fields?.value ?? "0";
    return BigInt(inner);
  } catch {
    return 0n;
  }
}

async function getUserInfo(address: string): Promise<{ collaterals: number[]; loans: number[] } | null> {
  try {
    const obj = await client.getObject({ id: NAVI_STORAGE, options: { showContent: true } });
    const userInfosTableId: string = (obj.data?.content as any)?.fields?.user_infos?.fields?.id?.id;

    const df = await client.getDynamicFieldObject({
      parentId: userInfosTableId,
      name: { type: "address", value: address },
    });
    if (df.error || !df.data) return null;
    const uif = (df.data.content as any)?.fields?.value?.fields;
    return {
      collaterals: (uif?.collaterals ?? []).map(Number),
      loans:       (uif?.loans       ?? []).map(Number),
    };
  } catch {
    return null;
  }
}

async function loadUserPosition(state: BotState, address: string): Promise<void> {
  try {
    const info = await getUserInfo(address);
    if (!info || (info.collaterals.length === 0 && info.loans.length === 0)) return;

    const pos: UserPosition = {
      address,
      collaterals: new Map(),
      debts:       new Map(),
      hf:          Infinity,
      lastUpdated: Date.now(),
    };

    // read supply balances
    await Promise.all(info.collaterals.map(async assetId => {
      const ri     = await getReserveInfo(assetId);
      const scaled = await getScaledBalance(ri.supplyTableId, address);
      if (scaled > 0n) {
        const actual = scaled * ri.supplyIndex / RAY;
        if (actual > 0n) pos.collaterals.set(assetId, actual);
      }
    }));

    // read borrow balances
    await Promise.all(info.loans.map(async assetId => {
      const ri     = await getReserveInfo(assetId);
      const scaled = await getScaledBalance(ri.borrowTableId, address);
      if (scaled > 0n) {
        const actual = scaled * ri.borrowIndex / RAY;
        if (actual > 0n) pos.debts.set(assetId, actual);
      }
    }));

    if (pos.collaterals.size === 0 && pos.debts.size === 0) return;

    pos.hf = state.computeHF(pos);
    pos.lastUpdated = Date.now();
    state.positions.set(address, pos);
    if (pos.hf <= HF_SLOW_THRESHOLD) state.fastSet.add(address);
  } catch (e) {
    log.debug(`loadUserPosition ${address.slice(0, 16)}... failed: ${e}`);
  }
}

async function loadPositions(state: BotState) {
  log.info("Bootstrapping positions from recent borrow events...");
  const eventType = `${NAVI_PKG}::event::BorrowEvent`;
  const borrowers = new Set<string>();
  let cursor: any = null;

  for (let page = 0; page < 40; page++) {
    const res = await client.queryEvents({
      query: { MoveEventType: eventType },
      cursor,
      limit: 50,
      order: "descending",
    });
    for (const ev of res.data) {
      const addr = (ev.parsedJson as any)?.user;
      if (addr) borrowers.add(addr);
    }
    if (!res.hasNextPage) break;
    cursor = res.nextCursor;
    await sleep(50);
  }

  log.info(`Found ${borrowers.size} unique borrowers, loading positions...`);

  const list = [...borrowers];
  for (let i = 0; i < list.length; i += 10) {
    await Promise.all(list.slice(i, i + 10).map(a => loadUserPosition(state, a)));
    await sleep(100);
  }

  log.info(`Loaded ${state.positions.size} positions, ${state.fastSet.size} in fast tier`);
}

// ── Pyth price monitor ────────────────────────────────────────────────────────

type PriceCallback = (assetId: number, price: number) => void;

function startPythMonitor(onPrice: PriceCallback) {
  const feedMap = new Map<string, number>();
  for (const [idStr, meta] of Object.entries(ASSETS)) {
    if (meta.pyth) feedMap.set(meta.pyth, Number(idStr));
  }
  const feedIds = [...feedMap.keys()];

  function connect() {
    log.info("Connecting to Pyth Hermes WebSocket...");
    const ws = new WebSocket(PYTH_WS);

    ws.on("open", () => {
      ws.send(JSON.stringify({ type: "subscribe", ids: feedIds, verbose: false, binary: false }));
      log.info(`Subscribed to ${feedIds.length} Pyth feeds`);
    });

    ws.on("message", raw => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type !== "price_update") return;
        const feedId  = "0x" + msg.price_feed?.id;
        const assetId = feedMap.get(feedId);
        if (assetId === undefined) return;
        const p     = msg.price_feed.price;
        const price = parseInt(p.price) * Math.pow(10, parseInt(p.expo));
        onPrice(assetId, price);
      } catch { /* ignore parse errors */ }
    });

    ws.on("close", () => { log.warn("Pyth WS closed, reconnecting in 3s..."); setTimeout(connect, 3000); });
    ws.on("error", e   => log.warn("Pyth WS error:", e.message));
  }

  connect();
}

// ── event monitor: track new borrows ─────────────────────────────────────────

async function eventMonitor(state: BotState) {
  const eventType = `${NAVI_PKG}::event::BorrowEvent`;
  let cursor: any = null;

  while (true) {
    try {
      const res = await client.queryEvents({
        query: { MoveEventType: eventType },
        cursor,
        limit: 20,
        order: "ascending",
      });
      for (const ev of res.data) {
        const addr = (ev.parsedJson as any)?.user;
        if (addr && !state.positions.has(addr)) {
          await loadUserPosition(state, addr);
          log.info(`Tracked new borrower ${addr.slice(0, 20)}...`);
        }
      }
      if (res.hasNextPage) cursor = res.nextCursor;
    } catch (e) {
      log.warn("Event monitor error:", e);
    }
    await sleep(10_000);
  }
}

// ── HF updater ────────────────────────────────────────────────────────────────

async function hfUpdater(
  state: BotState,
  onLiquidatable: (opp: LiquidationOpp) => void,
) {
  let lastSlowSweep = 0;

  while (true) {
    const now = Date.now();

    // fast tier: recompute on every tick (prices already updated by PythMonitor)
    for (const addr of state.fastSet) {
      const pos = state.positions.get(addr);
      if (!pos) { state.fastSet.delete(addr); continue; }

      const hf = state.computeHF(pos);
      pos.hf = hf;
      pos.lastUpdated = now;

      if (hf < 1.0) {
        const opp = state.bestLiquidation(pos);
        if (opp) {
          log.warn(`LIQUIDATABLE ${addr.slice(0, 16)}... HF=${hf.toFixed(4)} profit=$${opp.profitUsd.toFixed(2)}`);
          onLiquidatable(opp);
        }
        state.fastSet.delete(addr);
      } else if (hf > HF_SLOW_THRESHOLD) {
        state.fastSet.delete(addr);  // demote to slow tier
      }
    }

    // slow tier sweep
    if (now - lastSlowSweep > SLOW_INTERVAL_MS) {
      lastSlowSweep = now;
      for (const [addr, pos] of state.positions) {
        if (state.fastSet.has(addr)) continue;  // already in fast tier
        const hf = state.computeHF(pos);
        const prevHf = pos.hf;
        pos.hf = hf;
        pos.lastUpdated = now;

        if (hf < 1.0) {
          const opp = state.bestLiquidation(pos);
          if (opp) {
            log.warn(`[SLOW] LIQUIDATABLE ${addr.slice(0, 16)}... HF=${hf.toFixed(4)}`);
            onLiquidatable(opp);
          }
        } else if (hf <= HF_SLOW_THRESHOLD && prevHf > HF_SLOW_THRESHOLD) {
          log.info(`Promoted ${addr.slice(0, 16)}... to fast tier (HF=${hf.toFixed(4)})`);
          state.fastSet.add(addr);
        }
      }
    }

    await sleep(50);  // ~20 iterations/s idle
  }
}

// ── liquidator ────────────────────────────────────────────────────────────────

async function liquidator(state: BotState, opp: LiquidationOpp, keypair: Ed25519Keypair | null) {
  if (DRY_RUN) {
    log.info(
      `[DRY-RUN] Would liquidate ${opp.borrower.slice(0, 16)}...` +
      ` debtAsset=${opp.debtAsset} collatAsset=${opp.collatAsset}` +
      ` repay=${opp.repayAmount} profit≈$${opp.profitUsd.toFixed(2)}`
    );
    return;
  }

  if (!keypair) {
    log.error("No keypair loaded — set NAVI_BOT_KEY env var to enable live mode");
    return;
  }

  // re-verify HF is still < 1.0 (race condition guard)
  const pos = state.positions.get(opp.borrower);
  if (!pos || pos.hf >= 1.0) {
    log.debug(`Skip ${opp.borrower.slice(0, 16)}...: HF recovered`);
    return;
  }

  try {
    const digest = await executeLiquidation(opp, keypair);
    log.info(
      `[TX SUCCESS] ${digest}` +
      ` | borrower=${opp.borrower.slice(0, 20)}...` +
      ` | debt=${opp.debtAsset} collat=${opp.collatAsset}` +
      ` | profit≈$${opp.profitUsd.toFixed(2)}`
    );
    state.positions.delete(opp.borrower);
    state.fastSet.delete(opp.borrower);
  } catch (e) {
    log.error(`[TX FAILED] ${opp.borrower.slice(0, 20)}...:`, e);
  }
}

async function executeLiquidation(opp: LiquidationOpp, keypair: Ed25519Keypair): Promise<string> {
  const collatCfg = state_ref!.configs.get(opp.collatAsset);
  const debtCfg   = state_ref!.configs.get(opp.debtAsset);
  if (!collatCfg || !debtCfg) throw new Error("missing asset config");

  const tx = new Transaction();
  tx.setGasBudget(GAS_BUDGET_MIST);

  /**
   * PTB:
   *  1. Split repay coin from gas (if debt is SUI) or use coin object
   *  2. call entry_liquidation_v2(storage, clock, oracle, borrower, repay_coin, collat_type)
   *  3. Transfer received collateral to self
   *
   * For non-SUI debt: need to source the repay coin from wallet balance.
   * For now we implement SUI-as-debt path directly; other assets require
   * fetching the wallet's coin objects of the right type.
   */

  // Determine repay coin
  let repayCoin;
  if (opp.debtAsset === 0) {
    // SUI: split from gas coin
    repayCoin = tx.splitCoins(tx.gas, [tx.pure.u64(opp.repayAmount)]);
  } else {
    // Non-SUI: find wallet coins of the debt type
    const sender = keypair.getPublicKey().toSuiAddress();
    const coins = await client.getCoins({ owner: sender, coinType: debtCfg.coinType });
    if (coins.data.length === 0) throw new Error(`No ${debtCfg.symbol} coins in wallet`);
    const coinObjs = coins.data.map(c => tx.object(c.coinObjectId));
    // merge all coins into one if needed, then split exact repay amount
    if (coinObjs.length > 1) tx.mergeCoins(coinObjs[0], coinObjs.slice(1));
    repayCoin = tx.splitCoins(coinObjs[0], [tx.pure.u64(opp.repayAmount)]);
  }

  // call entry_liquidation_v2
  const [collateralCoin] = tx.moveCall({
    target: `${NAVI_PKG}::incentive_v3::entry_liquidation_v2`,
    typeArguments: [debtCfg.coinType, collatCfg.coinType],
    arguments: [
      tx.object(NAVI_STORAGE),
      tx.object(CLOCK),
      tx.object(PYTH_ORACLE),
      tx.pure.address(opp.borrower),
      Array.isArray(repayCoin) ? repayCoin[0] : repayCoin,
    ],
  });

  // transfer collateral to self
  const sender = keypair.getPublicKey().toSuiAddress();
  tx.transferObjects([collateralCoin], tx.pure.address(sender));

  const result = await client.signAndExecuteTransaction({
    transaction: tx,
    signer: keypair,
    options: { showEffects: true },
  });

  if (result.effects?.status?.status !== "success") {
    throw new Error(`TX failed: ${JSON.stringify(result.effects?.status)}`);
  }
  return result.digest;
}

// ── util ──────────────────────────────────────────────────────────────────────

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

// module-level reference so executeLiquidation can read configs
let state_ref: BotState | null = null;

// ── main ──────────────────────────────────────────────────────────────────────

async function main() {
  const fs = await import("fs");
  fs.mkdirSync("logs", { recursive: true });

  log.info(`Starting NAVI liquidation bot (${DRY_RUN ? "DRY-RUN" : "LIVE"})...`);

  // load keypair
  let keypair: Ed25519Keypair | null = null;
  if (!DRY_RUN) {
    const key = process.env.NAVI_BOT_KEY;
    if (!key) {
      log.error("NAVI_BOT_KEY not set — aborting live mode. Use DRY_RUN=1 to test.");
      process.exit(1);
    }
    keypair = Ed25519Keypair.fromSecretKey(Buffer.from(key, "hex"));
    log.info(`Wallet: ${keypair.getPublicKey().toSuiAddress()}`);
  }

  const state = new BotState();
  state_ref = state;

  // startup
  await loadAssetConfigs(state);
  await loadPositions(state);

  // liquidation queue (simple in-memory, dedup by borrower)
  const inFlight = new Set<string>();
  const enqueue = (opp: LiquidationOpp) => {
    if (inFlight.has(opp.borrower)) return;
    inFlight.add(opp.borrower);
    liquidator(state, opp, keypair)
      .finally(() => inFlight.delete(opp.borrower));
  };

  // start Pyth price monitor — updates state.prices + triggers fast-tier HF
  startPythMonitor((assetId, price) => {
    state.prices.set(assetId, price);
  });

  log.info("All systems started, monitoring...");

  // run async loops concurrently
  await Promise.all([
    eventMonitor(state),
    hfUpdater(state, enqueue),
  ]);
}

main().catch(e => {
  console.error("Fatal:", e);
  process.exit(1);
});
