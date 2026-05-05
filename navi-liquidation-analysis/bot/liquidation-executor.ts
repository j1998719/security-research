/**
 * Modular liquidation executor.
 *
 * Source selection (in priority order):
 *   1. CetusFlash  — flash_swap<debtType, collatType> or <collatType, debtType>
 *                    works for cross-asset pairs with a direct Cetus pool
 *   2. NaviFlash   — flashloanPTB for same-asset pairs (debt == collateral type)
 *                    NOTE: same-asset pairs are excluded in bestLiquidation because
 *                    Sui PTB cannot pass the same shared object as two separate
 *                    &mut args in the same Move call (alias check). NAVI's
 *                    liquidation_v2 requires both debtPool and collatPool. So this
 *                    path is effectively dead; all same-asset positions must use wallet.
 *   3. Wallet      — direct coin spend; falls back if flash unavailable
 *
 * Exports a single function: buildLiquidationTx(opp, keypair, addrs, client)
 */

import { Transaction }      from "@mysten/sui/transactions";
import { SuiClient }        from "@mysten/sui/client";
import { Ed25519Keypair }   from "@mysten/sui/keypairs/ed25519";
import { NetworkAddrs }     from "./network.js";
import { CLOCK, GAS_BUDGET_MIST, AUTO_SWAP } from "./config.js";
import {
  MIN_SQRT_PRICE, MAX_SQRT_PRICE, SUI_TYPE,
  cetusFlashSwap, cetusSwapPayAmount, cetusRepayFlashSwap,
  autoSwapCollatToSui,
} from "./cetus.js";

const { flashloanPTB, repayFlashLoanPTB } =
  await import("@naviprotocol/lending" as any) as any;

export interface LiqOpp {
  borrower:    string;
  debtAsset:   number;
  collatAsset: number;
  repayAmount: bigint;
  profitUsd:   number;
  hf:          number;
  minSuiOut?:  bigint;  // wallet-swap: min SUI from collat→SUI pool (0n = no sell-back)
}

type Source = "cetus" | "cetus-multi" | "navi" | "wallet" | "wallet-swap";
export type LiquidationMode = "cetus" | "cetus-multi" | "navi-flash" | "wallet" | "wallet-swap" | "auto";

// ── routing ───────────────────────────────────────────────────────────────────

interface RouteResult {
  source:       Source;
  // Direct Cetus: single pool
  pool?:        string;
  poolIsv?:     number;
  a2b?:         boolean;
  // Multi-hop Cetus or wallet-swap: two pools (debt/SUI + collat/SUI)
  borrowPool?:  { id: string; isv: number; a2b: boolean };
  swapPool?:    { id: string; isv: number; a2b: boolean };  // optional for wallet-swap
}

function selectSource(
  debtType:   string,
  collatType: string,
  addrs:      NetworkAddrs,
  hasCash:    boolean,
  debtUsd:    number = 0,
): RouteResult {
  const SUI_TYPE = "0x2::sui::SUI";

  // Helper: find debt/SUI or SUI/debt Cetus pool for a given coin type.
  // Defined at function scope so wallet-swap block can reuse it.
  const findSuiPool = (coinType: string) => {
    const fwd = `${coinType},${SUI_TYPE}`;
    const rev = `${SUI_TYPE},${coinType}`;
    if (addrs.CETUS_POOLS[fwd]) return { ...addrs.CETUS_POOLS[fwd], a2b: false };
    if (addrs.CETUS_POOLS[rev]) return { ...addrs.CETUS_POOLS[rev], a2b: true  };
    return null;
  };

  // 1. Cetus direct: single pool between debt and collateral
  const keyFwd = `${debtType},${collatType}`;
  const keyRev = `${collatType},${debtType}`;
  if (addrs.CETUS_POOLS[keyFwd]) {
    return { source: "cetus", pool: addrs.CETUS_POOLS[keyFwd].id, poolIsv: addrs.CETUS_POOLS[keyFwd].isv, a2b: false };
  }
  if (addrs.CETUS_POOLS[keyRev]) {
    return { source: "cetus", pool: addrs.CETUS_POOLS[keyRev].id, poolIsv: addrs.CETUS_POOLS[keyRev].isv, a2b: true };
  }

  // 2. Cetus multi-hop via SUI: debt/SUI pool + collat/SUI pool
  if (debtType !== SUI_TYPE && collatType !== SUI_TYPE) {
    const borrowPoolEntry = findSuiPool(debtType);
    const swapPoolEntry   = findSuiPool(collatType);
    if (borrowPoolEntry && swapPoolEntry) {
      const swapA2b = addrs.CETUS_POOLS[`${collatType},${SUI_TYPE}`] ? true : false;
      return {
        source:     "cetus-multi",
        borrowPool: { id: borrowPoolEntry.id, isv: borrowPoolEntry.isv, a2b: borrowPoolEntry.a2b },
        swapPool:   { id: swapPoolEntry.id,   isv: swapPoolEntry.isv,   a2b: swapA2b },
      };
    }
  }

  // 3. Wallet-swap via Cetus (AUTO_SWAP=true): buy debt with wallet SUI, sell collat for SUI.
  // Only when no zero-capital flash path exists. Requires debt/SUI Cetus pool.
  // Skip if debtUsd >= 100 — avoid exposing wallet SUI capital on large positions.
  if (AUTO_SWAP && debtType !== SUI_TYPE && debtUsd < 100) {
    const debtSuiPool = findSuiPool(debtType);
    if (debtSuiPool) {
      const collatSuiPool = collatType !== SUI_TYPE ? findSuiPool(collatType) : null;
      const swapA2b = collatType !== SUI_TYPE && addrs.CETUS_POOLS[`${collatType},${SUI_TYPE}`] ? true : false;
      return {
        source:     "wallet-swap",
        borrowPool: { id: debtSuiPool.id, isv: debtSuiPool.isv, a2b: debtSuiPool.a2b },
        swapPool:   collatSuiPool
          ? { id: collatSuiPool.id, isv: collatSuiPool.isv, a2b: swapA2b }
          : undefined,
      };
    }
  }

  // 4. NAVI flash loan: only useful when debt == collat (same coin type, currently blocked by alias check)
  if (debtType === collatType) return { source: "navi" };

  // 5. Wallet fallback — only for small debt (< $100) to avoid tying up capital
  if (debtUsd < 100) return { source: "wallet" };

  // No zero-capital path and debt too large for wallet — skip
  return { source: "wallet" }; // caller checks debtUsd to filter
}

// ── Cetus flash_swap path ─────────────────────────────────────────────────────

function addCetusFlashLiquidation(
  tx:          Transaction,
  opp:         LiqOpp,
  debtPool:    { id: string; isv: number; coinType: string },
  collatPool:  { id: string; isv: number; coinType: string },
  cetusPool:   { id: string; isv: number },
  a2b:         boolean,  // false = get coinA(debt), repay coinB(collat); true = get coinB(debt), repay coinA(collat)
  addrs:       NetworkAddrs,
  sender:      string,
): void {
  // The CetusPool entry has coinA/coinB; reconstruct for cetus.ts primitives.
  // a2b=true → typeArgs=[collatType, debtType]; a2b=false → typeArgs=[debtType, collatType]
  const pool = {
    id:    cetusPool.id,
    isv:   cetusPool.isv,
    coinA: a2b ? collatPool.coinType : debtPool.coinType,
    coinB: a2b ? debtPool.coinType   : collatPool.coinType,
    feeBps: 0,
  };

  // 1. flash_swap exact-output repayAmount of debt
  const [rawBalA, rawBalB, receipt] = cetusFlashSwap(
    tx, pool, a2b, false, tx.pure.u64(opp.repayAmount), addrs,
  );

  // a2b=true → [Balance<collat>=0, Balance<debt>=repay]; a2b=false → [Balance<debt>=repay, Balance<collat>=0]
  const [balBorrowed, balToDestroy] = a2b ? [rawBalB, rawBalA] : [rawBalA, rawBalB];
  tx.moveCall({ target: "0x2::balance::destroy_zero", typeArguments: [collatPool.coinType], arguments: [balToDestroy] });

  // 2. NAVI liquidation_v2 → (Balance<C>, Balance<D>_excess)
  const [collatBalance, excessDebtBalance] = addNaviLiquidationCall(
    tx, opp, balBorrowed, debtPool, collatPool, addrs,
  );

  // 3. How much collateral to repay Cetus
  const repayAmt = cetusSwapPayAmount(tx, pool, a2b, receipt, addrs);

  // 4. Split repay portion from collat, convert back to Balance
  const collatCoin      = tx.moveCall({ target: "0x2::coin::from_balance", typeArguments: [collatPool.coinType], arguments: [collatBalance] });
  const repayCollatCoin = tx.splitCoins(collatCoin, [repayAmt])[0];
  const repayBal        = tx.moveCall({ target: "0x2::coin::into_balance", typeArguments: [collatPool.coinType], arguments: [repayCollatCoin] });
  const zeroDebtBal     = tx.moveCall({ target: "0x2::balance::zero", typeArguments: [debtPool.coinType], arguments: [] });
  const [repayA, repayB] = a2b ? [repayBal, zeroDebtBal] : [zeroDebtBal, repayBal];
  cetusRepayFlashSwap(tx, pool, a2b, repayA, repayB, receipt, addrs);

  // 5. Transfer profit to sender
  const excessDebtCoin = tx.moveCall({ target: "0x2::coin::from_balance", typeArguments: [debtPool.coinType], arguments: [excessDebtBalance] });
  tx.transferObjects([collatCoin, excessDebtCoin], tx.pure.address(sender));
}

// ── NAVI flash loan path (same-asset) ─────────────────────────────────────────

async function addNaviFlashLiquidation(
  tx:         Transaction,
  opp:        LiqOpp,
  debtPool:   { id: string; isv: number; coinType: string },
  collatPool: { id: string; isv: number; coinType: string },
  addrs:      NetworkAddrs,
  sender:     string,
): Promise<void> {
  // 1. Flash borrow debtAsset (returns Balance<D>)
  const [balDebt, receipt] = await flashloanPTB(tx, opp.debtAsset, opp.repayAmount, { env: "prod" });

  // 2. liquidation_v2 takes Balance<D> directly (not Coin<D>)
  //    Returns (Balance<C> collat, Balance<D> excess)
  const [collatBalance, excessDebtBalance] = addNaviLiquidationCall(tx, opp, balDebt, debtPool, collatPool, addrs);

  // 3. Repay flash loan with excess Balance<D>
  await repayFlashLoanPTB(tx, opp.debtAsset, receipt, excessDebtBalance, { env: "prod" });

  // 4. Convert collateral Balance<C> → Coin<C> and send profit to self
  const collatCoin = tx.moveCall({
    target: "0x2::coin::from_balance",
    typeArguments: [collatPool.coinType],
    arguments: [collatBalance],
  });
  tx.transferObjects([collatCoin], tx.pure.address(sender));
}

// ── Cetus 2-pool multi-hop flash path ─────────────────────────────────────────
//
// Used when there is no direct debt↔collat Cetus pool, but both coins
// have a X/SUI Cetus pool.  The route is:
//
//   flash_swap(borrowPool, borrow debtCoin, repay SUI)
//   → liquidation_v2(pay debtCoin, receive collatCoin)
//   → flash_swap(swapPool, sell collatCoin, buy SUI)   ← exact-SUI-output
//   → repay borrowPool with SUI from swapPool
//   → repay swapPool with collatCoin from liquidation
//   → profit = remaining collatCoin + excessDebt
//
// Both swaps use by_amount_out so the amounts nest cleanly.

function addCetusMultiHopFlashLiquidation(
  tx:          Transaction,
  opp:         LiqOpp,
  debtPool:    { id: string; isv: number; coinType: string },
  collatPool:  { id: string; isv: number; coinType: string },
  borrowCetus: { id: string; isv: number; a2b: boolean },  // debt/SUI pool, direction to borrow debtCoin
  swapCetus:   { id: string; isv: number; a2b: boolean },  // collat/SUI pool, direction to sell collatCoin
  addrs:       NetworkAddrs,
  sender:      string,
): void {
  // Build CetusPool descriptors for low-level helpers
  // borrowPool: a2b=true → [SUI, debt]; a2b=false → [debt, SUI]
  const borrowPool = {
    id:     borrowCetus.id,
    isv:    borrowCetus.isv,
    coinA:  borrowCetus.a2b ? SUI_TYPE            : debtPool.coinType,
    coinB:  borrowCetus.a2b ? debtPool.coinType   : SUI_TYPE,
    feeBps: 0,
  };
  // swapPool: a2b=true → [collat, SUI]; a2b=false → [SUI, collat]
  const swapPool = {
    id:     swapCetus.id,
    isv:    swapCetus.isv,
    coinA:  swapCetus.a2b ? collatPool.coinType : SUI_TYPE,
    coinB:  swapCetus.a2b ? SUI_TYPE            : collatPool.coinType,
    feeBps: 0,
  };

  // ── Step 1: flash borrow exact debtCoin from borrowPool ─────────────────────
  const [borrowBalA, borrowBalB, borrowReceipt] = cetusFlashSwap(
    tx, borrowPool, borrowCetus.a2b, false, tx.pure.u64(opp.repayAmount), addrs,
  );
  const [balDebt, balZeroSui1] = borrowCetus.a2b
    ? [borrowBalB, borrowBalA]
    : [borrowBalA, borrowBalB];
  tx.moveCall({ target: "0x2::balance::destroy_zero", typeArguments: [SUI_TYPE], arguments: [balZeroSui1] });

  // ── Step 2: NAVI liquidation_v2 ─────────────────────────────────────────────
  const [balCollat, balExcessDebt] = addNaviLiquidationCall(
    tx, opp, balDebt, debtPool, collatPool, addrs,
  );

  // ── Step 3: how much SUI does borrowPool need back ──────────────────────────
  const suiNeeded = cetusSwapPayAmount(tx, borrowPool, borrowCetus.a2b, borrowReceipt, addrs);

  // ── Step 4: flash sell collat for exactly suiNeeded SUI via swapPool ────────
  const [swapBalA, swapBalB, swapReceipt] = cetusFlashSwap(
    tx, swapPool, swapCetus.a2b, false, suiNeeded, addrs,
  );
  const [balSuiOut, balZeroCollat] = swapCetus.a2b
    ? [swapBalB, swapBalA]
    : [swapBalA, swapBalB];
  tx.moveCall({ target: "0x2::balance::destroy_zero", typeArguments: [collatPool.coinType], arguments: [balZeroCollat] });

  // ── Step 5: split collat repayment from liquidation proceeds ────────────────
  const collatCost     = cetusSwapPayAmount(tx, swapPool, swapCetus.a2b, swapReceipt, addrs);
  const collatCoin     = tx.moveCall({ target: "0x2::coin::from_balance", typeArguments: [collatPool.coinType], arguments: [balCollat] });
  const collatRepayBal = tx.moveCall({ target: "0x2::coin::into_balance", typeArguments: [collatPool.coinType], arguments: [tx.splitCoins(collatCoin, [collatCost])[0]] });

  // ── Step 6: repay swapPool (collatCoin → pool) ──────────────────────────────
  const zeroSui2 = tx.moveCall({ target: "0x2::balance::zero", typeArguments: [SUI_TYPE], arguments: [] });
  const [swapRepayA, swapRepayB] = swapCetus.a2b
    ? [collatRepayBal, zeroSui2]
    : [zeroSui2,       collatRepayBal];
  cetusRepayFlashSwap(tx, swapPool, swapCetus.a2b, swapRepayA, swapRepayB, swapReceipt, addrs);

  // ── Step 7: repay borrowPool with SUI from swapPool ─────────────────────────
  const zeroDebt = tx.moveCall({ target: "0x2::balance::zero", typeArguments: [debtPool.coinType], arguments: [] });
  const [finalRepayA, finalRepayB] = borrowCetus.a2b
    ? [balSuiOut, zeroDebt]
    : [zeroDebt,  balSuiOut];
  cetusRepayFlashSwap(tx, borrowPool, borrowCetus.a2b, finalRepayA, finalRepayB, borrowReceipt, addrs);

  // ── Step 8: transfer profit to sender ───────────────────────────────────────
  const excessDebtCoin = tx.moveCall({ target: "0x2::coin::from_balance", typeArguments: [debtPool.coinType], arguments: [balExcessDebt] });
  tx.transferObjects([collatCoin, excessDebtCoin], tx.pure.address(sender));
}

// ── wallet direct path ────────────────────────────────────────────────────────

async function addWalletLiquidation(
  tx:         Transaction,
  opp:        LiqOpp,
  sender:     string,
  debtPool:   { id: string; isv: number; coinType: string },
  collatPool: { id: string; isv: number; coinType: string },
  addrs:      NetworkAddrs,
  client:     SuiClient,
): Promise<void> {
  // Build repay Coin, then convert to Balance<D> for liquidation_v2
  let repayCoin;
  if (opp.debtAsset === 0) {
    repayCoin = tx.splitCoins(tx.gas, [tx.pure.u64(opp.repayAmount)])[0];
  } else {
    const coins = await client.getCoins({ owner: sender, coinType: debtPool.coinType });
    if (coins.data.length === 0) throw new Error(`No ${debtPool.coinType} coins in wallet`);
    const objs = coins.data.map(c => tx.object(c.coinObjectId));
    if (objs.length > 1) tx.mergeCoins(objs[0], objs.slice(1));
    repayCoin = tx.splitCoins(objs[0], [tx.pure.u64(opp.repayAmount)])[0];
  }
  // liquidation_v2 requires Balance<D>, not Coin<D>
  const repayBalance = tx.moveCall({
    target: "0x2::coin::into_balance",
    typeArguments: [debtPool.coinType],
    arguments: [repayCoin],
  });

  const [collatBalance, excessDebtBalance] = addNaviLiquidationCall(
    tx, opp, repayBalance, debtPool, collatPool, addrs,
  );
  const collatCoin     = tx.moveCall({
    target: "0x2::coin::from_balance",
    typeArguments: [collatPool.coinType],
    arguments: [collatBalance],
  });
  const excessDebtCoin = tx.moveCall({
    target: "0x2::coin::from_balance",
    typeArguments: [debtPool.coinType],
    arguments: [excessDebtBalance],
  });

  if (AUTO_SWAP) {
    const swapResult = autoSwapCollatToSui(tx, collatCoin, collatPool.coinType, addrs);
    if (swapResult) {
      const suiProfitCoin = tx.moveCall({ target: "0x2::coin::from_balance", typeArguments: [SUI_TYPE], arguments: [swapResult.suiBal] });
      tx.transferObjects([collatCoin, suiProfitCoin, excessDebtCoin, ...swapResult.dustCoins], tx.pure.address(sender));
    } else {
      tx.transferObjects([collatCoin, excessDebtCoin], tx.pure.address(sender));
    }
  } else {
    tx.transferObjects([collatCoin, excessDebtCoin], tx.pure.address(sender));
  }
}

// ── wallet-swap path ──────────────────────────────────────────────────────────
//
// Used when no flash path exists but debt/SUI Cetus pool is available.
// Route:
//   flash_swap(debtSuiPool, borrow exact debtAmount)
//   → liquidation_v2 (pay debt, receive collat)
//   → repay debtSuiPool with SUI from tx.gas (wallet pays)
//   → optionally flash_swap(collatSuiPool, sell collat for ≥ minSuiOut SUI)
//   → repay collatSuiPool with collat from liquidation proceeds
//   → transfer remaining collat + SUI profit to sender

function addWalletSwapLiquidation(
  tx:          Transaction,
  opp:         LiqOpp,
  debtPool:    { id: string; isv: number; coinType: string },
  collatPool:  { id: string; isv: number; coinType: string },
  borrowCetus: { id: string; isv: number; a2b: boolean },  // debt/SUI pool; a2b to get debtCoin
  swapCetus:   { id: string; isv: number; a2b: boolean } | undefined,  // collat/SUI pool
  minSuiOut:   bigint,
  addrs:       NetworkAddrs,
  sender:      string,
): void {
  // borrowPool: a2b=true → [SUI, debt]; a2b=false → [debt, SUI]
  const borrowPool = {
    id:     borrowCetus.id,
    isv:    borrowCetus.isv,
    coinA:  borrowCetus.a2b ? SUI_TYPE            : debtPool.coinType,
    coinB:  borrowCetus.a2b ? debtPool.coinType   : SUI_TYPE,
    feeBps: 0,
  };

  // ── Step 1: flash borrow exact repayAmount debt; pool will want SUI back ────
  const [borrowBalA, borrowBalB, borrowReceipt] = cetusFlashSwap(
    tx, borrowPool, borrowCetus.a2b, false, tx.pure.u64(opp.repayAmount), addrs,
  );
  const [balDebt, balZeroSui1] = borrowCetus.a2b
    ? [borrowBalB, borrowBalA]
    : [borrowBalA, borrowBalB];
  tx.moveCall({ target: "0x2::balance::destroy_zero", typeArguments: [SUI_TYPE], arguments: [balZeroSui1] });

  // ── Step 2: NAVI liquidation_v2 ─────────────────────────────────────────────
  const [balCollat, balExcessDebt] = addNaviLiquidationCall(
    tx, opp, balDebt, debtPool, collatPool, addrs,
  );

  // ── Step 3: how much SUI must we pay back to borrowPool? ────────────────────
  const suiOwed = cetusSwapPayAmount(tx, borrowPool, borrowCetus.a2b, borrowReceipt, addrs);

  // ── Step 4: pay borrowPool SUI from wallet gas coin ─────────────────────────
  const suiRepayBal = tx.moveCall({ target: "0x2::coin::into_balance", typeArguments: [SUI_TYPE], arguments: [tx.splitCoins(tx.gas, [suiOwed])[0]] });
  const zeroDebtBal = tx.moveCall({ target: "0x2::balance::zero", typeArguments: [debtPool.coinType], arguments: [] });
  const [repayBorrowA, repayBorrowB] = borrowCetus.a2b
    ? [suiRepayBal, zeroDebtBal]
    : [zeroDebtBal, suiRepayBal];
  cetusRepayFlashSwap(tx, borrowPool, borrowCetus.a2b, repayBorrowA, repayBorrowB, borrowReceipt, addrs);

  const collatCoin     = tx.moveCall({ target: "0x2::coin::from_balance", typeArguments: [collatPool.coinType], arguments: [balCollat] });
  const excessDebtCoin = tx.moveCall({ target: "0x2::coin::from_balance", typeArguments: [debtPool.coinType],   arguments: [balExcessDebt] });

  // ── Steps 5-8: sell collat for SUI using registered swapCetus pool ──────────
  if (swapCetus && minSuiOut > 0n) {
    // swapCetus.a2b=true → pool is [collat,SUI]; exact output = minSuiOut SUI
    const swapPool = {
      id:     swapCetus.id,
      isv:    swapCetus.isv,
      coinA:  swapCetus.a2b ? collatPool.coinType : SUI_TYPE,
      coinB:  swapCetus.a2b ? SUI_TYPE            : collatPool.coinType,
      feeBps: 0,
    };
    const [swapBalA, swapBalB, swapReceipt] = cetusFlashSwap(
      tx, swapPool, swapCetus.a2b, false, tx.pure.u64(minSuiOut), addrs,
    );
    const [balSuiOut, balZeroCollat] = swapCetus.a2b
      ? [swapBalB, swapBalA]
      : [swapBalA, swapBalB];
    tx.moveCall({ target: "0x2::balance::destroy_zero", typeArguments: [collatPool.coinType], arguments: [balZeroCollat] });

    const collatCost     = cetusSwapPayAmount(tx, swapPool, swapCetus.a2b, swapReceipt, addrs);
    const collatRepayBal = tx.moveCall({ target: "0x2::coin::into_balance", typeArguments: [collatPool.coinType], arguments: [tx.splitCoins(collatCoin, [collatCost])[0]] });
    const zeroSuiBal     = tx.moveCall({ target: "0x2::balance::zero", typeArguments: [SUI_TYPE], arguments: [] });
    const [swapRepayA, swapRepayB] = swapCetus.a2b
      ? [collatRepayBal, zeroSuiBal]
      : [zeroSuiBal,     collatRepayBal];
    cetusRepayFlashSwap(tx, swapPool, swapCetus.a2b, swapRepayA, swapRepayB, swapReceipt, addrs);

    const suiOutCoin = tx.moveCall({ target: "0x2::coin::from_balance", typeArguments: [SUI_TYPE], arguments: [balSuiOut] });
    tx.transferObjects([collatCoin, suiOutCoin, excessDebtCoin], tx.pure.address(sender));
  } else {
    tx.transferObjects([collatCoin, excessDebtCoin], tx.pure.address(sender));
  }
}

// ── shared: NAVI liquidation_v2 call ─────────────────────────────────────────

function addNaviLiquidationCall(
  tx:           Transaction,
  opp:          LiqOpp,
  repayBalance: ReturnType<typeof tx.moveCall>,  // Balance<D> — on-chain type
  debtPool:     { id: string; isv: number; coinType: string },
  collatPool:   { id: string; isv: number; coinType: string },
  addrs:        NetworkAddrs,
): [ReturnType<typeof tx.moveCall>, ReturnType<typeof tx.moveCall>] {
  // liquidation_v2 signature (on-chain verified):
  //   (&Clock, &Oracle, &mut Storage, u8, &mut Pool<D>, Balance<D>,
  //    u8, &mut Pool<C>, address, &mut IncentiveV2, &mut IncentiveV3, &mut SuiSystemState)
  //   → (Balance<C>, Balance<D>)
  //
  // Use tx.object() (auto-resolved by SDK) for all protocol objects — matches how
  // the NAVI SDK calls these. sharedObjectRef with manual ISV caused InvalidReferenceArgument.
  return tx.moveCall({
    target: `${addrs.NAVI_PKG}::incentive_v3::liquidation_v2`,
    typeArguments: [debtPool.coinType, collatPool.coinType],
    arguments: [
      tx.object(CLOCK),
      tx.object(addrs.PYTH_ORACLE.id),
      tx.object(addrs.NAVI_STORAGE.id),
      tx.pure.u8(opp.debtAsset),
      tx.object(debtPool.id),
      repayBalance,
      tx.pure.u8(opp.collatAsset),
      tx.object(collatPool.id),
      tx.pure.address(opp.borrower),
      tx.object(addrs.NAVI_INCENTIVE_V2.id),
      tx.object(addrs.NAVI_INCENTIVE_V3.id),
      tx.object("0x0000000000000000000000000000000000000000000000000000000000000005"),
    ],
  }) as any;
}

// ── public entry ─────────────────────────────────────────────────────────────

export async function buildLiquidationTx(
  opp:      LiqOpp,
  keypair:  Ed25519Keypair,
  addrs:    NetworkAddrs,
  client:   SuiClient,
  mode:     LiquidationMode = "auto",
  // Optional oracle update callback (from navi-bot.ts addOracleUpdates)
  addOracle?: (tx: Transaction, debtAsset: number, collatAsset: number) => Promise<void>,
): Promise<Transaction> {
  const debtPool   = addrs.POOLS[opp.debtAsset];
  const collatPool = addrs.POOLS[opp.collatAsset];
  if (!debtPool)   throw new Error(`No pool for debtAsset=${opp.debtAsset}`);
  if (!collatPool) throw new Error(`No pool for collatAsset=${opp.collatAsset}`);

  const sender = keypair.getPublicKey().toSuiAddress();
  const tx = new Transaction();
  tx.setSender(sender);
  tx.setGasBudget(GAS_BUDGET_MIST);
  const rgp = await client.getReferenceGasPrice();
  tx.setGasPrice(rgp * 2n);

  // Oracle price refresh (async: fetches Pyth VAA from Hermes + pushes in PTB)
  await addOracle?.(tx, opp.debtAsset, opp.collatAsset);

  let route: RouteResult;
  if (mode === "wallet") {
    route = { source: "wallet" };
  } else if (mode === "navi-flash") {
    route = { source: "navi" };
  } else if (mode === "wallet-swap") {
    route = selectSource(debtPool.coinType, collatPool.coinType, addrs, false);
    // If selectSource found a zero-capital flash route (cetus/cetus-multi), use it —
    // it's strictly better than wallet-swap. Only throw if no usable route at all.
    if (route.source === "wallet" || route.source === "navi") {
      throw new Error(`No flash/swap route for ${opp.debtAsset}→${opp.collatAsset}`);
    }
  } else if (mode === "cetus") {
    route = selectSource(debtPool.coinType, collatPool.coinType, addrs, false);
    if (route.source !== "cetus") throw new Error(`No direct Cetus pool for ${opp.debtAsset}→${opp.collatAsset}`);
  } else if (mode === "cetus-multi") {
    route = selectSource(debtPool.coinType, collatPool.coinType, addrs, false);
    if (route.source !== "cetus-multi") throw new Error(`No multi-hop route for ${opp.debtAsset}→${opp.collatAsset}`);
  } else {
    // auto: honour opp.source from bestLiquidation if available, else selectSource
    const autoMode = (opp as any).source as string | undefined;
    if (autoMode === "wallet-swap" || autoMode === "cetus-multi") {
      route = selectSource(debtPool.coinType, collatPool.coinType, addrs, false);
    } else {
      const hasCash = opp.debtAsset === 0;
      route = selectSource(debtPool.coinType, collatPool.coinType, addrs, hasCash);
    }
  }

  if (route.source === "cetus") {
    addCetusFlashLiquidation(tx, opp, debtPool, collatPool, { id: route.pool!, isv: route.poolIsv! }, route.a2b!, addrs, sender);
  } else if (route.source === "cetus-multi") {
    addCetusMultiHopFlashLiquidation(tx, opp, debtPool, collatPool, route.borrowPool!, route.swapPool!, addrs, sender);
  } else if (route.source === "wallet-swap") {
    addWalletSwapLiquidation(
      tx, opp, debtPool, collatPool,
      route.borrowPool!,
      route.swapPool,
      (opp as any).minSuiOut ?? 0n,
      addrs, sender,
    );
  } else if (route.source === "navi") {
    await addNaviFlashLiquidation(tx, opp, debtPool, collatPool, addrs, sender);
  } else {
    await addWalletLiquidation(tx, opp, sender, debtPool, collatPool, addrs, client);
  }

  return tx;
}

export function liquidationSource(debtType: string, collatType: string, addrs: NetworkAddrs): Source {
  const { source } = selectSource(debtType, collatType, addrs, false);
  return source;
}
