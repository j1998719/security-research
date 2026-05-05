/**
 * Cetus CLMM helpers — PTB primitives and auto-swap routing.
 *
 * All Cetus pool addresses live in NetworkAddrs.CETUS_POOLS (network.ts).
 * This module provides:
 *   - Low-level PTB primitives: cetusFlashSwap / cetusRepayFlashSwap
 *   - High-level: autoSwapCollatToSui  (single-hop or two-hop via USDC)
 *
 * Used by liquidation-executor.ts for collateral→SUI conversion in wallet liquidations.
 */

import { Transaction } from "@mysten/sui/transactions";
import { CLOCK }       from "./config.js";
import { NetworkAddrs, CetusPool } from "./network.js";

export const MIN_SQRT_PRICE = BigInt("4295048016");
export const MAX_SQRT_PRICE = BigInt("79226673515401279992447579055");

// Native USDC used as two-hop intermediate (deepest SUI pairs use USDC)
export const NATIVE_USDC = "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC";
export const SUI_TYPE    = "0x2::sui::SUI";

// ── pool lookup helpers ───────────────────────────────────────────────────────

/** Direct coinType↔SUI Cetus pool, or undefined. */
export function findSuiPool(coinType: string, addrs: NetworkAddrs): CetusPool | undefined {
  return addrs.CETUS_POOLS[`${coinType},${SUI_TYPE}`]
      ?? addrs.CETUS_POOLS[`${SUI_TYPE},${coinType}`];
}

/** coinType↔USDC Cetus pool (for two-hop), or undefined. */
export function findUsdcPool(coinType: string, addrs: NetworkAddrs): CetusPool | undefined {
  if (coinType === NATIVE_USDC) return undefined;
  return addrs.CETUS_POOLS[`${coinType},${NATIVE_USDC}`]
      ?? addrs.CETUS_POOLS[`${NATIVE_USDC},${coinType}`];
}

/** USDC↔SUI pool — always needed for two-hop path. */
export function findUsdcSuiPool(addrs: NetworkAddrs): CetusPool | undefined {
  return addrs.CETUS_POOLS[`${NATIVE_USDC},${SUI_TYPE}`]
      ?? addrs.CETUS_POOLS[`${SUI_TYPE},${NATIVE_USDC}`];
}

// ── low-level PTB primitives ──────────────────────────────────────────────────

type TxArg = ReturnType<Transaction["pure"]["bool"]>;

/**
 * Calls pool::flash_swap.
 * Returns [balA, balB, receipt] — same order as Cetus Move return.
 *
 * by_amount_in=true  → give `amount` of "in" token, receive as much "out" as possible.
 * by_amount_in=false → receive exact `amount` of "out" token.
 */
export function cetusFlashSwap(
  tx:          Transaction,
  pool:        CetusPool,
  a2b:         boolean,
  byAmountIn:  boolean,
  amount:      TxArg,
  addrs:       NetworkAddrs,
): [TxArg, TxArg, TxArg] {
  const cfg       = addrs.CETUS_GLOBAL_CONFIG;
  const typeArgs  = [pool.coinA, pool.coinB];  // must match Pool<coinA,coinB> regardless of direction
  const sqrtLimit = a2b ? MIN_SQRT_PRICE : MAX_SQRT_PRICE;
  return tx.moveCall({
    target:        `${addrs.CETUS_PKG}::pool::flash_swap`,
    typeArguments: typeArgs,
    arguments: [
      tx.sharedObjectRef({ objectId: cfg.id,  initialSharedVersion: cfg.isv,  mutable: false }),
      tx.sharedObjectRef({ objectId: pool.id, initialSharedVersion: pool.isv, mutable: true }),
      tx.pure.bool(a2b),
      tx.pure.bool(byAmountIn),
      amount,
      tx.pure.u128(sqrtLimit),
      tx.object(CLOCK),
    ],
  }) as unknown as [TxArg, TxArg, TxArg];
}

/** Calls pool::swap_pay_amount → returns [pay_amount]. */
export function cetusSwapPayAmount(
  tx:    Transaction,
  pool:  CetusPool,
  a2b:   boolean,
  receipt: TxArg,
  addrs: NetworkAddrs,
): TxArg {
  const typeArgs = [pool.coinA, pool.coinB];  // must match Pool<coinA,coinB> regardless of direction
  const [amt] = tx.moveCall({
    target:        `${addrs.CETUS_PKG}::pool::swap_pay_amount`,
    typeArguments: typeArgs,
    arguments:     [receipt],
  }) as unknown as [TxArg];
  return amt;
}

/**
 * Calls pool::repay_flash_swap.
 * `payA` and `payB` are Balance<coinA> and Balance<coinB> respectively
 * (pass balance::zero for the side that isn't being repaid).
 */
export function cetusRepayFlashSwap(
  tx:    Transaction,
  pool:  CetusPool,
  a2b:   boolean,
  payA:  TxArg,
  payB:  TxArg,
  receipt: TxArg,
  addrs: NetworkAddrs,
): void {
  const cfg      = addrs.CETUS_GLOBAL_CONFIG;
  const typeArgs = [pool.coinA, pool.coinB];  // must match Pool<coinA,coinB> regardless of direction
  tx.moveCall({
    target:        `${addrs.CETUS_PKG}::pool::repay_flash_swap`,
    typeArguments: typeArgs,
    arguments: [
      tx.sharedObjectRef({ objectId: cfg.id,  initialSharedVersion: cfg.isv,  mutable: false }),
      tx.sharedObjectRef({ objectId: pool.id, initialSharedVersion: pool.isv, mutable: true }),
      payA, payB, receipt,
    ],
  });
}

// ── high-level swap helpers ───────────────────────────────────────────────────

/**
 * Single-hop swap: give all of `collatCoin` (by_amount_in), receive Balance<SUI>.
 * Repays the flash pool with split from `collatCoin`.
 *
 * `collatCoin` is a Coin<collatType> — after this call it becomes dust (zero or near-zero).
 * Returns Balance<SUI>.
 */
export function swapCoinForSuiOnehop(
  tx:          Transaction,
  collatCoin:  TxArg,
  collatType:  string,
  pool:        CetusPool,        // collatType↔SUI pool
  addrs:       NetworkAddrs,
): TxArg {
  const a2b = pool.coinA === collatType;
  const collatAmt = tx.moveCall({
    target: "0x2::coin::value",
    typeArguments: [collatType],
    arguments: [collatCoin],
  });

  const [balA, balB, receipt] = cetusFlashSwap(tx, pool, a2b, true, collatAmt, addrs);
  const [balZeroCollat, balSuiOut] = a2b ? [balA, balB] : [balB, balA];
  tx.moveCall({ target: "0x2::balance::destroy_zero", typeArguments: [collatType], arguments: [balZeroCollat] });

  const cost       = cetusSwapPayAmount(tx, pool, a2b, receipt, addrs);
  const repayCoin  = tx.splitCoins(collatCoin, [cost])[0];
  const repayBal   = tx.moveCall({ target: "0x2::coin::into_balance", typeArguments: [collatType], arguments: [repayCoin] });
  const zeroSuiBal = tx.moveCall({ target: "0x2::balance::zero", typeArguments: [SUI_TYPE], arguments: [] });
  const [repayA, repayB] = a2b ? [repayBal, zeroSuiBal] : [zeroSuiBal, repayBal];
  cetusRepayFlashSwap(tx, pool, a2b, repayA, repayB, receipt, addrs);

  return balSuiOut;
}

/**
 * Two-hop swap: collat → USDC → SUI.
 * Used when no direct collat/SUI pool exists, or when USDC path has deeper liquidity.
 *
 * `collatCoin` becomes dust after this call.
 * Returns Balance<SUI>.
 */
export function swapCoinForSuiTwohop(
  tx:            Transaction,
  collatCoin:    TxArg,
  collatType:    string,
  collatUsdcPool: CetusPool,    // collatType↔USDC pool
  usdcSuiPool:    CetusPool,    // USDC↔SUI pool
  addrs:         NetworkAddrs,
): TxArg {
  // ── Hop 1: collatType → USDC ─────────────────────────────────────────────────
  const a2b1 = collatUsdcPool.coinA === collatType;
  const collatAmt = tx.moveCall({
    target: "0x2::coin::value",
    typeArguments: [collatType],
    arguments: [collatCoin],
  });

  const [h1BalA, h1BalB, h1Receipt] = cetusFlashSwap(tx, collatUsdcPool, a2b1, true, collatAmt, addrs);
  const [balZeroCollat1, balUsdcOut] = a2b1 ? [h1BalA, h1BalB] : [h1BalB, h1BalA];
  tx.moveCall({ target: "0x2::balance::destroy_zero", typeArguments: [collatType], arguments: [balZeroCollat1] });

  const cost1      = cetusSwapPayAmount(tx, collatUsdcPool, a2b1, h1Receipt, addrs);
  const repayCoin1 = tx.splitCoins(collatCoin, [cost1])[0];
  const repayBal1  = tx.moveCall({ target: "0x2::coin::into_balance", typeArguments: [collatType], arguments: [repayCoin1] });
  const zeroUsdc1  = tx.moveCall({ target: "0x2::balance::zero", typeArguments: [NATIVE_USDC], arguments: [] });
  const [r1A, r1B] = a2b1 ? [repayBal1, zeroUsdc1] : [zeroUsdc1, repayBal1];
  cetusRepayFlashSwap(tx, collatUsdcPool, a2b1, r1A, r1B, h1Receipt, addrs);

  // ── Hop 2: USDC → SUI ────────────────────────────────────────────────────────
  const a2b2   = usdcSuiPool.coinA === NATIVE_USDC;
  const usdcCoin = tx.moveCall({ target: "0x2::coin::from_balance", typeArguments: [NATIVE_USDC], arguments: [balUsdcOut] });
  const usdcAmt  = tx.moveCall({ target: "0x2::coin::value",        typeArguments: [NATIVE_USDC], arguments: [usdcCoin] });

  const [h2BalA, h2BalB, h2Receipt] = cetusFlashSwap(tx, usdcSuiPool, a2b2, true, usdcAmt, addrs);
  const [balZeroUsdc2, balSuiOut]   = a2b2 ? [h2BalA, h2BalB] : [h2BalB, h2BalA];
  tx.moveCall({ target: "0x2::balance::destroy_zero", typeArguments: [NATIVE_USDC], arguments: [balZeroUsdc2] });

  const cost2      = cetusSwapPayAmount(tx, usdcSuiPool, a2b2, h2Receipt, addrs);
  const repayCoin2 = tx.splitCoins(usdcCoin, [cost2])[0];
  const repayBal2  = tx.moveCall({ target: "0x2::coin::into_balance", typeArguments: [NATIVE_USDC], arguments: [repayCoin2] });
  const zeroSui2   = tx.moveCall({ target: "0x2::balance::zero", typeArguments: [SUI_TYPE], arguments: [] });
  const [r2A, r2B] = a2b2 ? [repayBal2, zeroSui2] : [zeroSui2, repayBal2];
  cetusRepayFlashSwap(tx, usdcSuiPool, a2b2, r2A, r2B, h2Receipt, addrs);

  // usdcCoin is zero-value after full split; destroy to avoid dangling object
  tx.moveCall({ target: "0x2::coin::destroy_zero", typeArguments: [NATIVE_USDC], arguments: [usdcCoin] });

  return balSuiOut;
}

/**
 * Auto-routing: swap collatCoin → SUI using best available path.
 *
 * Priority:
 *   1. Direct collatType↔SUI pool  (single-hop)
 *   2. collatType↔USDC + USDC↔SUI  (two-hop)
 *
 * Returns [Balance<SUI>, extra_dust_coins_to_transfer].
 * extra_dust_coins_to_transfer: intermediate Coin objects (e.g. usdcCoin dust) that must
 *   be transferred to sender. For single-hop this is empty.
 *
 * Returns null if no path is available.
 */
export function autoSwapCollatToSui(
  tx:         Transaction,
  collatCoin: TxArg,
  collatType: string,
  addrs:      NetworkAddrs,
): { suiBal: TxArg; dustCoins: TxArg[] } | null {
  if (collatType === SUI_TYPE) return null;

  const suiPool = findSuiPool(collatType, addrs);
  if (suiPool) {
    const suiBal = swapCoinForSuiOnehop(tx, collatCoin, collatType, suiPool, addrs);
    return { suiBal, dustCoins: [] };
  }

  const usdcPool    = findUsdcPool(collatType, addrs);
  const usdcSuiPool = findUsdcSuiPool(addrs);
  if (usdcPool && usdcSuiPool) {
    const suiBal = swapCoinForSuiTwohop(tx, collatCoin, collatType, usdcPool, usdcSuiPool, addrs);
    // usdcCoin dust is handled inside swapCoinForSuiTwohop (already split out, caller transfers collatCoin)
    return { suiBal, dustCoins: [] };
  }

  return null;  // no Cetus path available — caller transfers collatCoin as-is
}
