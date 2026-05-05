/**
 * position-store.ts — Shared position management
 *
 * Extracted from navi-bot.ts so both init_bot.ts (full scan) and
 * navi-bot.ts (monitoring) can share the same logic without duplication.
 *
 * All functions that need network access take (client, addrs) explicitly
 * so the module works in both the init and bot contexts.
 */

import { SuiClient }            from "@mysten/sui/client";
import { writeFileSync, readFileSync } from "fs";
import {
  ASSETS, RAY, HF_SLOW_THRESHOLD, GAS_WALLET_MIST, GAS_FLASH_MIST, GAS_WALLET_SWAP_MIST, MIN_PROFIT_USD,
  AUTO_SWAP, MAX_SLIPPAGE_BPS,
} from "./config.js";
import { RpcPool } from "./network.js";
import type { NetworkAddrs } from "./network.js";

// ── interfaces ────────────────────────────────────────────────────────────────

export interface AssetConfig {
  symbol:       string;
  liqThreshold: number;   // 0-1
  liqBonus:     number;   // 0-1
  closeFactor:  number;   // 0-1 — max fraction of debt repayable in one liquidation
  tokenDec:     number;
  coinType:     string;
}

export interface UserPosition {
  address:           string;
  scaledCollaterals: Map<number, bigint>;
  scaledDebts:       Map<number, bigint>;
  hf:                number;
  lastUpdated:       number;   // Date.now() when balances were fetched
  savedPx?:          Record<number, number>;  // price snapshot at lastUpdated
}

export interface LiquidationOpp {
  borrower:      string;
  debtAsset:     number;
  collatAsset:   number;
  repayAmount:   bigint;
  // Execution mode:
  //   "cetus"       — direct flash_swap on one pool (debt↔collat)
  //   "cetus-multi" — 2-pool flash: borrow debt via debt/SUI pool, swap collat→SUI to repay
  //   "wallet"      — direct spend from bot wallet (requires holding debt coin)
  source:        "cetus" | "cetus-multi" | "wallet" | "wallet-swap";
  viaAsset?:     number;   // pivot asset for cetus-multi (always SUI=0 for now)
  // Profit breakdown (all in USD)
  grossProfitUsd: number;
  cetusFeeUsd:    number;  // combined Cetus fees (0 for wallet)
  gasCostUsd:     number;
  profitUsd:      number;
  hf:             number;
  minSuiOut?:     bigint;  // wallet-swap: min SUI to accept from collat→SUI pool (0n if no collat pool)
}

interface CacheEntry {
  a:  string;
  sc: Record<string, string>;   // assetId → scaledCollateral (bigint as string)
  sd: Record<string, string>;   // assetId → scaledDebt
  hf?: number;                  // HF computed at load time (ts)
  ts?: number;                  // Date.now() when this position's balances were fetched
  si?: Record<string, string>;  // supplyIndex extrapolated to ts, per assetId
  bi?: Record<string, string>;  // borrowIndex extrapolated to ts, per assetId
  px?: Record<string, number>;  // price snapshot at ts (from Pyth WS at load time)
}

export const POSITIONS_CACHE = "logs/positions-cache.json";

const SECONDS_PER_YEAR = BigInt(365 * 24 * 3600);

// NAVI protocol normalizes ALL token amounts to 9-decimal precision internally,
// regardless of the token's real decimals (e.g. USDC=6dec real → 9dec in NAVI tables).
const NAVI_INTERNAL_DEC = 9;

// Asset IDs whose Pool.balance is depleted — deposit_treasury will abort (error 1506).
// wUSDC (asset 1) pool balance is ~$0.008; cannot support any treasury fee.
// Asset 1 = whUSDC (Wormhole USDC, `0x5d4b302...::coin::COIN`). Confirmed depleted by
// devInspect 2026-05-04: liquidation_v2 fails at pool::deposit_treasury with error 1506.
// Distinct from asset 10 (native USDC, `0xdba34672...::usdc::USDC`) which works fine —
// the chain stats showing "USDC→*" liquidations are native USDC (asset 10), not whUSDC.
const DEPLETED_COLLAT_POOLS = new Set([1]);

// ── reserve index cache (module-level, shared within process) ─────────────────

export let storeReservesTableId  = "";
export let storeUserInfosTableId = "";

export const reserveCache = new Map<number, {
  supplyTableId:    string;
  borrowTableId:    string;
  supplyIndex:      bigint;
  borrowIndex:      bigint;
  lastUpdateSec:    number;
  borrowRatePerSec: bigint;
  supplyRatePerSec: bigint;
}>();

// Extrapolates borrow/supply index to the current second without extra RPC calls.
export function liveIndex(assetId: number, side: "borrow" | "supply"): bigint {
  return indexAt(assetId, side, Date.now());
}

// Same as liveIndex but at a specific timestamp (ms). Used when saving per-position snapshots.
export function indexAt(assetId: number, side: "borrow" | "supply", timestampMs: number): bigint {
  const ri = reserveCache.get(assetId);
  if (!ri || ri.lastUpdateSec === 0) return RAY;
  const elapsed = BigInt(Math.max(0, Math.floor(timestampMs / 1000) - ri.lastUpdateSec));
  if (side === "borrow") {
    return ri.borrowIndex + ri.borrowIndex * ri.borrowRatePerSec * elapsed / RAY;
  }
  return ri.supplyIndex + ri.supplyIndex * ri.supplyRatePerSec * elapsed / RAY;
}

// ── BotState ──────────────────────────────────────────────────────────────────

export class BotState {
  prices         = new Map<number, number>();
  configs        = new Map<number, AssetConfig>();
  positions      = new Map<string, UserPosition>();
  triedAddresses = new Set<string>();
  fastSet        = new Set<string>();
  // "debtCoinType,collatCoinType" or "collatCoinType,debtCoinType" → feeBps
  cetusFees      = new Map<string, number>();

  loadCetusFees(pools: Record<string, { feeBps: number }>) {
    for (const [key, pool] of Object.entries(pools)) {
      this.cetusFees.set(key, pool.feeBps);
    }
  }

  computeHF(pos: UserPosition): number {
    // No collateral loaded yet — treat as unknown rather than HF=0 (avoids false liquidation alerts).
    if (pos.scaledCollaterals.size === 0 && pos.scaledDebts.size > 0) return Infinity;
    for (const id of [...pos.scaledCollaterals.keys(), ...pos.scaledDebts.keys()]) {
      if (!this.configs.has(id)) return Infinity;
    }
    let collatValue = 0;
    const collatDebug: string[] = [];
    for (const [id, scaled] of pos.scaledCollaterals) {
      const cfg   = this.configs.get(id)!;
      const price = this.prices.get(id);
      // Missing price → can't compute HF; treat as unknown/safe to avoid false alerts.
      if (!price) return Infinity;
      const idx    = liveIndex(id, "supply");
      const actual = Number(scaled * idx / RAY) / 10 ** NAVI_INTERNAL_DEC;
      const contrib = actual * price * cfg.liqThreshold;
      collatValue += contrib;
      collatDebug.push(`collat[${id}] scaled=${scaled} idx=${idx} actual=${actual.toFixed(4)} px=${price} liqThr=${cfg.liqThreshold} contrib=${contrib.toFixed(4)}`);
    }
    let debtValue = 0;
    const debtDebug: string[] = [];
    for (const [id, scaled] of pos.scaledDebts) {
      const cfg   = this.configs.get(id)!;
      const price = this.prices.get(id);
      if (!price) return Infinity;
      const idx    = liveIndex(id, "borrow");
      const actual = Number(scaled * idx / RAY) / 10 ** NAVI_INTERNAL_DEC;
      const contrib = actual * price;
      debtValue += contrib;
      debtDebug.push(`debt[${id}] scaled=${scaled} idx=${idx} actual=${actual.toFixed(4)} px=${price} contrib=${contrib.toFixed(4)}`);
    }
    const hf = debtValue === 0 ? Infinity : collatValue / debtValue;
    if (hf < 0.5 && hf !== Infinity) {
      const ts = new Date().toISOString();
      console.log(`[computeHF DEBUG ${ts}] addr=${pos.address.slice(0,16)} HF=${hf.toFixed(4)}`);
      for (const l of collatDebug) console.log(`  ${l}`);
      for (const l of debtDebug)   console.log(`  ${l}`);
    }
    return hf;
  }

  bestLiquidation(pos: UserPosition, minProfit = MIN_PROFIT_USD): LiquidationOpp | null {
    const suiPrice = this.prices.get(0) ?? 1;
    // Batch 3: 041c-style — only cetus flash (direct + multi-hop). No wallet, no wallet-swap.
    let bestFlash:  LiquidationOpp | null = null;

    for (const [debtId, scaled] of pos.scaledDebts) {
      const debtCfg   = this.configs.get(debtId);
      const debtPrice = this.prices.get(debtId);
      if (!debtCfg || !debtPrice) continue;

      const debtRaw  = scaled * liveIndex(debtId, "borrow") / RAY;
      // Use on-chain close factor (capped at 50% if not loaded yet).
      const cf        = debtCfg.closeFactor > 0 ? debtCfg.closeFactor : 0.5;
      const maxDebtRaw = BigInt(Math.floor(Number(debtRaw) * cf));
      // NAVI internal = 9-dec; use that for USD valuation
      const maxDebtUsd = (Number(maxDebtRaw) / 10 ** NAVI_INTERNAL_DEC) * debtPrice;

      for (const [collatId, cScaled] of pos.scaledCollaterals) {
        // Sui PTB cannot pass the same shared object as two separate &mut args
        // in one Move call. NAVI's liquidation_v2 takes both debtPool and
        // collatPool as &mut Pool — same-asset pairs would alias the same object.
        if (collatId === debtId) continue;
        // Skip collateral pools whose Pool.balance is depleted (deposit_treasury would fail).
        if (DEPLETED_COLLAT_POOLS.has(collatId)) continue;

        const collatCfg   = this.configs.get(collatId);
        const collatPrice = this.prices.get(collatId);
        if (!collatCfg || !collatPrice) continue;

        // actual collateral available (USD) — 9-dec internal
        const collatRaw = cScaled * liveIndex(collatId, "supply") / RAY;
        const collatUsd = (Number(collatRaw) / 10 ** NAVI_INTERNAL_DEC) * collatPrice;

        // repay is capped by close factor and by what collateral can actually cover (with bonus)
        const maxRepayByCollat = collatUsd / (1 + collatCfg.liqBonus);
        const repayUsd  = Math.min(maxDebtUsd, maxRepayByCollat);
        if (repayUsd <= 0) continue;

        // Apply 0.5% haircut: on-chain index may have advanced since we read it,
        // causing the actual debt to differ slightly from our off-chain estimate.
        // This prevents calculator MoveAbort from repayAmount exceeding on-chain max.
        const repayRaw       = BigInt(Math.floor(repayUsd / debtPrice * 10 ** debtCfg.tokenDec * 0.995));
        const receivedUsd    = repayUsd * (1 + collatCfg.liqBonus);
        const grossProfitUsd = receivedUsd - repayUsd;  // liqBonus * repayUsd

        const collatCoinType = this.configs.get(collatId)?.coinType ?? "";
        const debtCoinType   = this.configs.get(debtId)?.coinType   ?? "";
        const suiCoinType    = this.configs.get(0)?.coinType        ?? "0x2::sui::SUI";

        const cetusFeeBps = (a: string, b: string) =>
          this.cetusFees.get(`${a},${b}`) ?? this.cetusFees.get(`${b},${a}`);

        // ── Cetus direct flash (single pool: debt↔collat) ─────────────────────
        const directFeeBps = cetusFeeBps(debtCoinType, collatCoinType);
        if (directFeeBps !== undefined) {
          const cetusFeeUsd = receivedUsd * directFeeBps / 10000;
          const gasCostUsd  = (Number(GAS_FLASH_MIST) / 1e9) * suiPrice;
          const profitUsd   = grossProfitUsd - cetusFeeUsd - gasCostUsd;
          if (profitUsd > minProfit && (!bestFlash || profitUsd > bestFlash.profitUsd)) {
            bestFlash = { borrower: pos.address, debtAsset: debtId, collatAsset: collatId, repayAmount: repayRaw, source: "cetus", grossProfitUsd, cetusFeeUsd, gasCostUsd, profitUsd, hf: pos.hf };
          }
        }

        // ── Cetus multi-hop flash via SUI (debt/SUI pool + collat/SUI pool) ───
        // Skip when debt or collat IS SUI (no second hop needed / would be same-pool issue).
        if (debtCoinType !== suiCoinType && collatCoinType !== suiCoinType) {
          const borrowFeeBps = cetusFeeBps(debtCoinType, suiCoinType);  // debt/SUI pool
          const swapFeeBps   = cetusFeeBps(collatCoinType, suiCoinType); // collat/SUI pool
          if (borrowFeeBps !== undefined && swapFeeBps !== undefined) {
            // borrowFee: charged on debtAmount from the debt/SUI pool
            const borrowFeeUsd  = repayUsd * borrowFeeBps / 10000;
            // swapFee: charged on receivedCollat going through collat/SUI pool
            const swapFeeUsd    = receivedUsd * swapFeeBps / 10000;
            const cetusFeeUsd   = borrowFeeUsd + swapFeeUsd;
            const gasCostUsd    = (Number(GAS_FLASH_MIST) / 1e9) * suiPrice;
            const profitUsd     = grossProfitUsd - cetusFeeUsd - gasCostUsd;
            if (profitUsd > minProfit && (!bestFlash || profitUsd > bestFlash.profitUsd)) {
              bestFlash = { borrower: pos.address, debtAsset: debtId, collatAsset: collatId, repayAmount: repayRaw, source: "cetus-multi", viaAsset: 0, grossProfitUsd, cetusFeeUsd, gasCostUsd, profitUsd, hf: pos.hf };
            }
          }
        }

        // Batch 3: 041c-style — only zero-capital cetus flash routes (direct + multi-hop).
        // Wallet / wallet-swap modes removed: capital cost + adds PTB complexity for
        // marginal extra opportunities. Pure flash-loan only matches the 100%-hit pattern.
      }
    }
    return bestFlash;
  }
}

// ── simple logger type (matches navi-bot's log object interface) ──────────────

export interface StoreLogger {
  info:  (...a: unknown[]) => void;
  warn:  (...a: unknown[]) => void;
  debug: (...a: unknown[]) => void;
}

const defaultLog: StoreLogger = {
  info:  (...a) => console.log(...a),
  warn:  (...a) => console.warn(...a),
  debug: () => {},
};

// ── storage tables ────────────────────────────────────────────────────────────

export async function ensureStorageTables(client: SuiClient, addrs: NetworkAddrs) {
  if (storeReservesTableId && storeUserInfosTableId) return;
  const obj = await client.getObject({ id: addrs.NAVI_STORAGE.id, options: { showContent: true } });
  const f = (obj.data?.content as any)?.fields;
  if (!storeReservesTableId)  storeReservesTableId  = f?.reserves?.fields?.id?.id;
  if (!storeUserInfosTableId) storeUserInfosTableId = f?.user_info?.fields?.id?.id;
}

export async function getReserveInfo(client: SuiClient, addrs: NetworkAddrs, assetId: number) {
  if (reserveCache.has(assetId)) return reserveCache.get(assetId)!;
  await ensureStorageTables(client, addrs);

  const df = await client.getDynamicFieldObject({
    parentId: storeReservesTableId,
    name: { type: "u8", value: assetId.toString() },
  });
  const rf = (df.data?.content as any)?.fields?.value?.fields;

  const rawTs = Number(rf?.last_update_timestamp ?? rf?.last_update_at ?? 0);
  const lastUpdateSec = rawTs > 1e12 ? Math.floor(rawTs / 1000) : rawTs;
  const borrowRateAnnual = BigInt(rf?.borrow_rate ?? "0");
  const supplyRateAnnual = BigInt(rf?.supply_rate ?? "0");

  const info = {
    supplyTableId:    rf?.supply_balance?.fields?.user_state?.fields?.id?.id as string,
    borrowTableId:    rf?.borrow_balance?.fields?.user_state?.fields?.id?.id as string,
    supplyIndex:      BigInt(rf?.current_supply_index ?? RAY.toString()),
    borrowIndex:      BigInt(rf?.current_borrow_index ?? RAY.toString()),
    lastUpdateSec,
    borrowRatePerSec: borrowRateAnnual / SECONDS_PER_YEAR,
    supplyRatePerSec: supplyRateAnnual / SECONDS_PER_YEAR,
  };
  reserveCache.set(assetId, info);
  return info;
}

export async function getScaledBalance(client: SuiClient, tableId: string, address: string): Promise<bigint> {
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

export async function getUserInfo(
  client: SuiClient,
  addrs: NetworkAddrs,
  address: string,
): Promise<{ collaterals: number[]; loans: number[] } | null> {
  try {
    await ensureStorageTables(client, addrs);
    const df = await client.getDynamicFieldObject({
      parentId: storeUserInfosTableId,
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

export async function loadUserPosition(
  state: BotState,
  client: SuiClient,
  addrs: NetworkAddrs,
  address: string,
  prefetched?: { collaterals: number[]; loans: number[] },
): Promise<void> {
  state.triedAddresses.add(address);
  try {
    const info = prefetched ?? await getUserInfo(client, addrs, address);
    if (!info || info.loans.length === 0) return;  // no debt → can't be liquidated

    const pos: UserPosition = {
      address,
      scaledCollaterals: new Map(),
      scaledDebts:       new Map(),
      hf:          Infinity,
      lastUpdated: Date.now(),
    };

    await Promise.all([
      ...info.collaterals.map(async assetId => {
        const ri     = await getReserveInfo(client, addrs, assetId);
        const scaled = await getScaledBalance(client, ri.supplyTableId, address);
        if (scaled > 0n) pos.scaledCollaterals.set(assetId, scaled);
      }),
      ...info.loans.map(async assetId => {
        const ri     = await getReserveInfo(client, addrs, assetId);
        const scaled = await getScaledBalance(client, ri.borrowTableId, address);
        if (scaled > 0n) pos.scaledDebts.set(assetId, scaled);
      }),
    ]);

    if (pos.scaledDebts.size === 0) return;  // balance confirmed empty on-chain

    pos.lastUpdated = Date.now();
    // 100% match policy: pos.hf is set ONLY by batched user_health_factor downstream.
    // Leave Infinity here — naviHF realign will populate the real value within ~10s.
    pos.hf = Infinity;
    if (state.prices.size > 0) {
      pos.savedPx = Object.fromEntries(state.prices) as Record<number, number>;
    }
    state.positions.set(address, pos);
    // fastSet membership is decided after naviHF realign (not at scan time).
  } catch {
    // silent — individual position failures are expected
  }
}

// ── asset config loader ───────────────────────────────────────────────────────

export async function loadAssetConfigs(
  state: BotState,
  client: SuiClient,
  addrs: NetworkAddrs,
  log: StoreLogger = defaultLog,
) {
  log.info("Loading asset configs from chain...");
  const storageObj = await client.getObject({ id: addrs.NAVI_STORAGE.id, options: { showContent: true } });
  const sFields = (storageObj.data?.content as any)?.fields;
  const reservesTableId: string = sFields?.reserves?.fields?.id?.id;

  const dfs = await client.getDynamicFields({ parentId: reservesTableId });

  // Fetch in batches of 5 with retry to avoid 429 on public RPCs
  const fetchWithRetry = async (id: string, retries = 5): Promise<any> => {
    for (let i = 0; i < retries; i++) {
      try {
        return await client.getObject({ id, options: { showContent: true } });
      } catch (e: any) {
        if (e?.status === 429 || e?.message?.includes("429")) {
          await new Promise(r => setTimeout(r, 1000 * (i + 1)));
        } else throw e;
      }
    }
    throw new Error(`getObject ${id} failed after ${retries} retries`);
  };

  for (let i = 0; i < dfs.data.length; i += 5) {
    const batch = dfs.data.slice(i, i + 5);
    await Promise.all(batch.map(async entry => {
      const assetId = Number(entry.name.value);
      const obj = await fetchWithRetry(entry.objectId);
      const rf = (obj.data?.content as any)?.fields?.value?.fields;
      const lf = rf?.liquidation_factors?.fields ?? {};
      const meta = ASSETS[assetId];
      state.configs.set(assetId, {
        symbol:       meta?.symbol ?? `asset_${assetId}`,
        liqThreshold: Number(BigInt(lf?.threshold ?? 0) * BigInt(10000) / RAY) / 10000,
        liqBonus:     Number(BigInt(lf?.bonus     ?? 0) * BigInt(10000) / RAY) / 10000,
        closeFactor:  Number(BigInt(lf?.ratio     ?? 0) * BigInt(10000) / RAY) / 10000,
        tokenDec:     meta?.tokenDec ?? 9,
        // addrs.POOLS[assetId].coinType is already 0x-prefixed canonical form.
        // On-chain rf.coin_type lacks "0x" and uses padded addresses — do not use directly.
        coinType:     addrs.POOLS[assetId]?.coinType ?? "",
      });
    }));
    if (i + 5 < dfs.data.length) await new Promise(r => setTimeout(r, 200));
  }
  log.info(`Loaded ${state.configs.size} asset configs`);
}

// ── NAVI on-chain oracle prices ───────────────────────────────────────────────
// Reads price_oracles table from ORACLE_CONFIG. Returns Map<assetId, USD price>.
// Covers all 36 NAVI assets including NS/DEEP/BLUE/BUCK/LBTC that have no Pyth feed.
// Call after loadAssetConfigs; merge into state.prices for assets missing Pyth data.
export async function loadOraclePrices(
  client: SuiClient,
  addrs:  NetworkAddrs,
): Promise<Map<number, number>> {
  const prices = new Map<number, number>();
  try {
    const oracleObj = await client.getObject({
      id: addrs.PYTH_ORACLE.id,
      options: { showContent: true },
    });
    const priceTableId: string | undefined =
      (oracleObj.data?.content as any)?.fields?.price_oracles?.fields?.id?.id;
    if (!priceTableId) return prices;

    let cursor: string | null | undefined;
    const dfEntries: Array<{ objectId: string; assetId: number }> = [];
    do {
      const page = await client.getDynamicFields({ parentId: priceTableId, cursor: cursor ?? undefined, limit: 100 });
      for (const df of page.data) dfEntries.push({ objectId: df.objectId, assetId: Number(df.name.value) });
      cursor = page.hasNextPage ? page.nextCursor : null;
    } while (cursor);

    const objs = await client.multiGetObjects({ ids: dfEntries.map(e => e.objectId), options: { showContent: true } });
    for (let i = 0; i < objs.length; i++) {
      const vf = (objs[i].data?.content as any)?.fields?.value?.fields;
      if (!vf) continue;
      const price = Number(vf.value) / 10 ** Number(vf.decimal);
      if (price > 0) prices.set(dfEntries[i].assetId, price);
    }
  } catch (e) {
    console.warn(`[oracle] loadOraclePrices failed: ${e}`);
  }
  return prices;
}

// ── full position scanner ─────────────────────────────────────────────────────

export async function loadPositions(
  state: BotState,
  pool:  RpcPool,
  addrs: NetworkAddrs,
  log:   StoreLogger = defaultLog,
  onLiquidatable?: (pos: UserPosition, state: BotState) => Promise<void>,
): Promise<void> {
  // Try each RPC in pool until ensureStorageTables succeeds (handles 403/429 on primary)
  let ensureOk = false;
  for (let i = 0; i < pool.size + 1; i++) {
    const { client: ec, url: eu } = pool.next();
    try {
      await ensureStorageTables(ec, addrs);
      ensureOk = true;
      break;
    } catch (e: any) {
      if (e?.status === 403 || e?.status === 429 || String(e).includes("403") || String(e).includes("429")) {
        pool.markError(eu, true, log.warn);
        log.warn(`[SCAN] ensureStorageTables failed on ${eu.slice(0, 40)}: ${e?.status ?? e}`);
      } else throw e;
    }
  }
  if (!ensureOk) throw new Error("ensureStorageTables failed on all RPCs");
  log.info(`Scanning user_info table (full coverage, pipelined, ${pool.size} RPC(s))...`);

  type ActiveEntry = { address: string; collaterals: number[]; loans: number[] };
  const active: ActiveEntry[] = [];
  type Page = Array<{ address: string; objectId: string }>;
  const pageQueue: Page[] = [];
  let scanDone = false;
  let totalScanned = 0;
  const scanStartMs = Date.now();

  const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

  const isTransientErr = (e: any) =>
    e?.status === 429
    || e?.status === 403    // dwellir returns 403 for quota exceeded
    || String(e).includes("429")
    || String(e).includes("403")
    || String(e).includes("UND_ERR_SOCKET")
    || String(e).includes("fetch failed")
    || String(e).includes("ECONNRESET")
    || String(e).includes("ENOTFOUND")   // DNS resolution failure
    || String(e).includes("ECONNREFUSED")
    || String(e).includes("ETIMEDOUT");

  // multiGetObjects limit is 50 per call — split page into sub-batches
  const fetchPage = async (page: Page): Promise<ActiveEntry[]> => {
    const BATCH = 50;
    const result: ActiveEntry[] = [];
    for (let start = 0; start < page.length; start += BATCH) {
      const sub = page.slice(start, start + BATCH);
      for (let attempt = 0; attempt < 8; attempt++) {
        const { client, url } = pool.next();
        try {
          const objs = await client.multiGetObjects({ ids: sub.map(e => e.objectId), options: { showContent: true } });
          for (let j = 0; j < objs.length; j++) {
            const uif = (objs[j].data?.content as any)?.fields?.value?.fields;
            if (!uif) continue;
            const collaterals = (uif.collaterals ?? []).map(Number);
            const loans       = (uif.loans       ?? []).map(Number);
            if (loans.length === 0) continue;
            result.push({ address: sub[j].address, collaterals, loans });
          }
          break;
        } catch (e: any) {
          if (isTransientErr(e)) {
            const is429 = e?.status === 429 || String(e).includes("429");
            pool.markError(url, is429, log.warn);
            await sleep(Math.min(2000 * Math.pow(2, attempt), 30_000));
          } else throw e;
        }
      }
    }
    return result;
  };

  // Phase 1 producer: paginate cursor sequentially with throttle to avoid 429s
  const producer = async () => {
    let cursor: string | null | undefined = undefined;
    while (true) {
      let res;
      for (let attempt = 0; attempt < 8; attempt++) {
        const { client, url } = pool.next();
        try {
          res = await client.getDynamicFields({
            parentId: storeUserInfosTableId,
            cursor: cursor ?? undefined,
            limit: 200,
          });
          break;
        } catch (e: any) {
          const isRateLimit = e?.status === 429 || e?.status === 403
            || String(e).includes("429") || String(e).includes("403")
            || String(e).includes("UND_ERR_SOCKET");
          if (isRateLimit) {
            pool.markError(url, true, log.warn);
            log.warn(`[SCAN] rate-limited (${e?.status ?? "?"}) at ${totalScanned} — pool: ${pool.statusLine()}`);
            await sleep(Math.min(5000 * Math.pow(2, attempt), 60_000));
          } else throw e;
        }
      }
      if (!res) throw new Error("getDynamicFields failed after 8 attempts");
      const page: Page = res.data.map(df => ({ address: df.name.value as string, objectId: df.objectId }));
      pageQueue.push(page);
      totalScanned += page.length;
      if (totalScanned % 10_000 === 0) {
        const elapsedMin = (Date.now() - scanStartMs) / 60_000;
        const rate = totalScanned / elapsedMin;   // entries/min
        log.info(`  ... scanned ${totalScanned} entries  (${elapsedMin.toFixed(1)} min  ~${Math.round(rate)}/min  active=${active.length})`);
      }
      if (!res.hasNextPage) break;
      cursor = res.nextCursor;
      await sleep(150);
    }
    scanDone = true;
    log.info(`${totalScanned} total entries in user_info table`);
  };

  // Phase 2+3 pipelined: consumers fetch page info AND immediately load balances.
  // This means balance loading starts as soon as first active users are found,
  // without waiting for the entire user_info table scan to complete.
  const INCREMENTAL_SAVE_EVERY = 1000;
  let totalLoaded = 0;
  let lastSaveAt  = 0;
  const alertedSet = new Set<string>(); // prevent duplicate liquidation attempts

  const consumer = async () => {
    while (!scanDone || pageQueue.length > 0) {
      const page = pageQueue.shift();
      if (!page) { await sleep(20); continue; }
      const found = await fetchPage(page);
      active.push(...found);

      // Load balances for this batch immediately — no waiting for full scan
      await Promise.all(found.map(e => {
        const { client } = pool.next();
        return loadUserPosition(state, client, addrs, e.address, { collaterals: e.collaterals, loans: e.loans });
      }));

      // Inline liquidation: alert on newly found liquidatable positions
      if (onLiquidatable) {
        for (const e of found) {
          if (alertedSet.has(e.address)) continue;
          const pos = state.positions.get(e.address);
          if (pos && isFinite(pos.hf) && pos.hf < 1.0) {
            alertedSet.add(e.address);
            onLiquidatable(pos, state).catch(err => log.warn(`[LIQBOT] ${e.address.slice(0,10)}: ${err}`));
          }
        }
      }

      totalLoaded += found.length;
      if (totalLoaded - lastSaveAt >= INCREMENTAL_SAVE_EVERY) {
        savePositionsCache(state, log);
        lastSaveAt = totalLoaded;
        const liquidatable = [...state.positions.values()].filter(p => isFinite(p.hf) && p.hf < 1.0).length;
        log.info(`  [SAVE] scanned=${totalScanned} active=${active.length} loaded=${totalLoaded} positions=${state.positions.size} liquidatable=${liquidatable}`);
      }
    }
  };
  const CONSUMERS = Number(process.env.SCAN_CONSUMERS ?? "2");
  await Promise.all([producer(), ...Array.from({ length: CONSUMERS }, () => consumer())]);

  log.info(`${active.length} users with active positions, ${state.positions.size} loaded`);

  // Phase 4: prune positions no longer in user_info (fully repaid/liquidated)
  const activeSet = new Set(active.map(e => e.address));
  let pruned = 0;
  for (const addr of [...state.positions.keys()]) {
    if (!activeSet.has(addr)) {
      state.positions.delete(addr);
      state.fastSet.delete(addr);
      pruned++;
    }
  }
  if (pruned > 0) log.info(`[PRUNE] Removed ${pruned} stale positions`);
  log.info(`Loaded ${state.positions.size} positions, ${state.fastSet.size} in fast tier`);
}

// ── cache I/O ─────────────────────────────────────────────────────────────────

export function savePositionsCache(
  state: BotState,
  log: StoreLogger = defaultLog,
) {
  try {
    const entries: CacheEntry[] = [];

    for (const [addr, pos] of state.positions) {
      const sc: Record<string, string> = {};
      const sd: Record<string, string> = {};
      for (const [id, v] of pos.scaledCollaterals) sc[id] = v.toString();
      for (const [id, v] of pos.scaledDebts)         sd[id] = v.toString();
      if (Object.keys(sc).length === 0 && Object.keys(sd).length === 0) continue;

      // Per-position index snapshot at exact load time (pos.lastUpdated)
      const ts = pos.lastUpdated;
      const si: Record<string, string> = {};
      const bi: Record<string, string> = {};
      for (const id of pos.scaledCollaterals.keys()) si[id] = indexAt(id, "supply", ts).toString();
      for (const id of pos.scaledDebts.keys())       bi[id] = indexAt(id, "borrow", ts).toString();

      // Per-position price snapshot — captured by loadUserPosition via state.prices
      // at that exact moment (Pyth WS keeps this current during long scans)
      const px: Record<string, number> | undefined = pos.savedPx
        ? pos.savedPx as Record<string, number>
        : undefined;

      entries.push({ a: addr, sc, sd, hf: isFinite(pos.hf) ? pos.hf : undefined, ts, si, bi, px });
    }
    writeFileSync(POSITIONS_CACHE, JSON.stringify({ version: 3, savedAt: Date.now(), positions: entries }));
    log.debug(`[CACHE] Saved ${entries.length} positions`);
  } catch (e) {
    log.warn(`[CACHE] Save failed: ${e}`);
  }
}

export async function loadPositionsFromCache(
  state:  BotState,
  client: SuiClient,
  addrs:  NetworkAddrs,
  log:    StoreLogger = defaultLog,
): Promise<number> {
  try {
    const raw  = readFileSync(POSITIONS_CACHE, "utf8");
    const data = JSON.parse(raw);
    if (data.version !== 2 && data.version !== 3) return 0;
    const entries: CacheEntry[] = data.positions ?? [];

    // Pre-fetch reserve infos needed for HF computation
    const assetIds = new Set<number>();
    for (const e of entries) {
      for (const k of Object.keys(e.sc)) assetIds.add(Number(k));
      for (const k of Object.keys(e.sd)) assetIds.add(Number(k));
    }
    await ensureStorageTables(client, addrs);
    await Promise.all([...assetIds].map(id => getReserveInfo(client, addrs, id).catch(() => {})));

    for (const e of entries) {
      const pos: UserPosition = {
        address:           e.a,
        scaledCollaterals: new Map(Object.entries(e.sc).map(([k, v]) => [Number(k), BigInt(v)])),
        scaledDebts:       new Map(Object.entries(e.sd).map(([k, v]) => [Number(k), BigInt(v)])),
        hf:          Infinity,
        lastUpdated: e.ts ?? Date.now(),
      };
      // 100% match policy: leave hf=Infinity, naviHF realign will populate.
      state.positions.set(e.a, pos);
      state.triedAddresses.add(e.a);
    }
    return entries.length;
  } catch {
    return 0;
  }
}
