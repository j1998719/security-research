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

const { flashloanPTB, repayFlashLoanPTB } =
  await import("@naviprotocol/lending" as any) as any;

// Cetus CLMM sqrt-price limits (max permissive — accept any price movement)
const MIN_SQRT_PRICE = BigInt("4295048016");
const MAX_SQRT_PRICE = BigInt("79226673515401279992447579055");

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
): RouteResult {
  const SUI_TYPE = "0x2::sui::SUI";

  // 1. Cetus direct: single pool between debt and collateral
  const keyFwd = `${debtType},${collatType}`;
  const keyRev = `${collatType},${debtType}`;
  if (addrs.CETUS_POOLS[keyFwd]) {
    // coinA=debt, coinB=collat → a2b=false to get coinA=debt (repay coinB=collat)
    return { source: "cetus", pool: addrs.CETUS_POOLS[keyFwd].id, poolIsv: addrs.CETUS_POOLS[keyFwd].isv, a2b: false };
  }
  if (addrs.CETUS_POOLS[keyRev]) {
    // coinA=collat, coinB=debt → a2b=true to get coinB=debt (repay coinA=collat)
    return { source: "cetus", pool: addrs.CETUS_POOLS[keyRev].id, poolIsv: addrs.CETUS_POOLS[keyRev].isv, a2b: true };
  }

  // 2. Cetus multi-hop via SUI: debt/SUI pool + collat/SUI pool
  //    Not applicable when debt or collat IS SUI (that would be handled above).
  if (debtType !== SUI_TYPE && collatType !== SUI_TYPE) {
    const findSuiPool = (coinType: string) => {
      const fwd = `${coinType},${SUI_TYPE}`;
      const rev = `${SUI_TYPE},${coinType}`;
      if (addrs.CETUS_POOLS[fwd]) return { ...addrs.CETUS_POOLS[fwd], a2b: false }; // coinA=coin, get coinA=coin (debt)
      if (addrs.CETUS_POOLS[rev]) return { ...addrs.CETUS_POOLS[rev], a2b: true  }; // coinA=SUI, coinB=coin → a2b=true gets coinB
      return null;
    };
    const borrowPoolEntry = findSuiPool(debtType);   // borrow debtCoin from debt/SUI pool
    const swapPoolEntry   = findSuiPool(collatType);  // sell collatCoin through collat/SUI pool

    if (borrowPoolEntry && swapPoolEntry) {
      // borrowPool: we want to GET debtCoin
      //   fwd (coinA=debt, coinB=SUI): a2b=false → get coinA=debt, repay coinB=SUI ✓
      //   rev (coinA=SUI,  coinB=debt): a2b=true  → get coinB=debt, repay coinA=SUI ✓
      // swapPool: we want to SELL collatCoin and GET SUI
      //   fwd (coinA=collat, coinB=SUI): a2b=true  → give coinA=collat, get coinB=SUI ✓
      //   rev (coinA=SUI, coinB=collat): a2b=false → give coinB=collat, get coinA=SUI ✓
      const swapA2b = addrs.CETUS_POOLS[`${collatType},${SUI_TYPE}`] ? true : false;
      return {
        source:     "cetus-multi",
        borrowPool: { id: borrowPoolEntry.id, isv: borrowPoolEntry.isv, a2b: borrowPoolEntry.a2b },
        swapPool:   { id: swapPoolEntry.id,   isv: swapPoolEntry.isv,   a2b: swapA2b },
      };
    }
  }

  // 3. Wallet-swap via Cetus (AUTO_SWAP=true): buy debt with wallet SUI, sell collat for SUI.
  // Only fires when no flash path was found above (i.e., cetus-multi pools are not both registered).
  // Requires debt/SUI Cetus pool. collat/SUI pool optional (if absent, keep collatTokens).
  if (AUTO_SWAP && debtType !== SUI_TYPE) {
    const debtSuiPool = findSuiPool(debtType);
    if (debtSuiPool) {
      const collatSuiPool = collatType !== SUI_TYPE ? findSuiPool(collatType) : null;
      // a2b for swapPool: sell collatCoin to get SUI
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

  // 5. Wallet fallback
  return { source: "wallet" };
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
  const cfg = addrs.CETUS_GLOBAL_CONFIG;
  const sqrtPriceLimit = a2b ? MIN_SQRT_PRICE : MAX_SQRT_PRICE;

  // 1. flash_swap — get debt coin; by_amount_in=false → exact output = repayAmount
  const [balDebt, balCollat, receipt] = tx.moveCall({
    target: `${addrs.CETUS_PKG}::pool::flash_swap`,
    typeArguments: a2b
      ? [collatPool.coinType, debtPool.coinType]   // coinA=collat, coinB=debt
      : [debtPool.coinType,   collatPool.coinType], // coinA=debt,   coinB=collat
    arguments: [
      tx.sharedObjectRef({ objectId: cfg.id, initialSharedVersion: cfg.isv, mutable: false }),
      tx.sharedObjectRef({ objectId: cetusPool.id, initialSharedVersion: cetusPool.isv, mutable: true }),
      tx.pure.bool(a2b),
      tx.pure.bool(false), // by_amount_in=false → exact output
      tx.pure.u64(opp.repayAmount),
      tx.pure.u128(sqrtPriceLimit),
      tx.object(CLOCK),
    ],
  });

  // 2. Separate borrowed debt balance from the zero-balance other side.
  //    liquidation_v2 takes Balance<D> directly (not Coin).
  //    a2b=false: flash_swap typeArgs=[D,C] → returns [Balance<D>=amount, Balance<C>=0]
  //    a2b=true:  flash_swap typeArgs=[C,D] → returns [Balance<C>=0, Balance<D>=amount]
  const [balBorrowed, balToDestroy] = a2b
    ? [balCollat, balDebt]   // a2b=true: slot-B=debt borrowed; slot-A=zero
    : [balDebt,   balCollat]; // a2b=false: slot-A=debt borrowed; slot-B=zero

  // Destroy the empty balance (zero-value other side of flash_swap).
  // In both a2b cases, balToDestroy has type Balance<C> (collatPool.coinType).
  tx.moveCall({
    target: "0x2::balance::destroy_zero",
    typeArguments: [collatPool.coinType],
    arguments: [balToDestroy],
  });

  // 3. liquidation_v2 → (Balance<C>, Balance<D>_excess)
  const [collatBalance, excessDebtBalance] = addNaviLiquidationCall(
    tx, opp, balBorrowed, debtPool, collatPool, addrs,
  );

  // 4. How much collateral to repay Cetus
  const [repayAmt] = tx.moveCall({
    target: `${addrs.CETUS_PKG}::pool::swap_pay_amount`,
    typeArguments: a2b
      ? [collatPool.coinType, debtPool.coinType]
      : [debtPool.coinType,   collatPool.coinType],
    arguments: [receipt],
  });

  // 5. Convert collat Balance→Coin so we can split, then convert repay portion back to Balance
  const collatCoin      = tx.moveCall({
    target: "0x2::coin::from_balance",
    typeArguments: [collatPool.coinType],
    arguments: [collatBalance],
  });
  const repayCollatCoin = tx.splitCoins(collatCoin, [repayAmt])[0];
  const repayBalance    = tx.moveCall({
    target: "0x2::coin::into_balance",
    typeArguments: [collatPool.coinType],
    arguments: [repayCollatCoin],
  });
  // Zero-debt Balance for the unused side of repay_flash_swap
  const zeroDebtBalance = tx.moveCall({
    target: "0x2::balance::zero",
    typeArguments: [debtPool.coinType],
    arguments: [],
  });

  // 6. repay_flash_swap
  const [balA, balB] = a2b
    ? [repayBalance, zeroDebtBalance]   // coinA=collat needs repaying
    : [zeroDebtBalance, repayBalance];  // coinB=collat needs repaying
  tx.moveCall({
    target: `${addrs.CETUS_PKG}::pool::repay_flash_swap`,
    typeArguments: a2b
      ? [collatPool.coinType, debtPool.coinType]
      : [debtPool.coinType,   collatPool.coinType],
    arguments: [
      tx.sharedObjectRef({ objectId: cfg.id, initialSharedVersion: cfg.isv, mutable: false }),
      tx.sharedObjectRef({ objectId: cetusPool.id, initialSharedVersion: cetusPool.isv, mutable: true }),
      balA, balB, receipt,
    ],
  });

  // 7. Convert excess debt Balance→Coin and send profit to self
  const excessDebtCoin = tx.moveCall({
    target: "0x2::coin::from_balance",
    typeArguments: [debtPool.coinType],
    arguments: [excessDebtBalance],
  });
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
  const cfg            = addrs.CETUS_GLOBAL_CONFIG;
  const SUI_TYPE       = "0x2::sui::SUI";
  // borrowPool typeArgs depend on a2b direction
  const borrowTypeArgs = borrowCetus.a2b
    ? [SUI_TYPE,            debtPool.coinType]   // coinA=SUI, coinB=debt → a2b gets coinB=debt
    : [debtPool.coinType,   SUI_TYPE];            // coinA=debt, coinB=SUI → a2b=false gets coinA=debt
  // swapPool: we're selling collatCoin to get SUI
  // a2b=true  → coinA=collat, coinB=SUI → sell collat, get SUI
  // a2b=false → coinA=SUI, coinB=collat → impossible for sell-collat
  const swapTypeArgs = swapCetus.a2b
    ? [collatPool.coinType, SUI_TYPE]
    : [SUI_TYPE,            collatPool.coinType];

  const sqrtBorrowLimit = borrowCetus.a2b ? MIN_SQRT_PRICE : MAX_SQRT_PRICE;
  const sqrtSwapLimit   = swapCetus.a2b   ? MIN_SQRT_PRICE : MAX_SQRT_PRICE;

  // ── Step 1: flash borrow debtCoin from borrowPool ──────────────────────────
  const [borrowBalA, borrowBalB, borrowReceipt] = tx.moveCall({
    target: `${addrs.CETUS_PKG}::pool::flash_swap`,
    typeArguments: borrowTypeArgs,
    arguments: [
      tx.sharedObjectRef({ objectId: cfg.id, initialSharedVersion: cfg.isv, mutable: false }),
      tx.sharedObjectRef({ objectId: borrowCetus.id, initialSharedVersion: borrowCetus.isv, mutable: true }),
      tx.pure.bool(borrowCetus.a2b),
      tx.pure.bool(false),               // by_amount_in=false → exact output
      tx.pure.u64(opp.repayAmount),
      tx.pure.u128(sqrtBorrowLimit),
      tx.object(CLOCK),
    ],
  });
  // One side has debtCoin, the other is zero SUI
  const [balDebt, balZeroSui1] = borrowCetus.a2b
    ? [borrowBalB, borrowBalA]   // a2b=true: coinB=debt
    : [borrowBalA, borrowBalB];  // a2b=false: coinA=debt
  tx.moveCall({ target: "0x2::balance::destroy_zero", typeArguments: [SUI_TYPE],          arguments: [balZeroSui1] });

  // ── Step 2: NAVI liquidation_v2 ─────────────────────────────────────────────
  const [balCollat, balExcessDebt] = addNaviLiquidationCall(
    tx, opp, balDebt, debtPool, collatPool, addrs,
  );

  // ── Step 3: determine how much SUI is needed to repay borrowPool ────────────
  const [suiNeeded] = tx.moveCall({
    target: `${addrs.CETUS_PKG}::pool::swap_pay_amount`,
    typeArguments: borrowTypeArgs,
    arguments: [borrowReceipt],
  });

  // ── Step 4: sell collatCoin for exactly suiNeeded SUI via swapPool ──────────
  // by_amount_in=false, amount=suiNeeded → exact SUI output
  const [swapBalA, swapBalB, swapReceipt] = tx.moveCall({
    target: `${addrs.CETUS_PKG}::pool::flash_swap`,
    typeArguments: swapTypeArgs,
    arguments: [
      tx.sharedObjectRef({ objectId: cfg.id, initialSharedVersion: cfg.isv, mutable: false }),
      tx.sharedObjectRef({ objectId: swapCetus.id, initialSharedVersion: swapCetus.isv, mutable: true }),
      tx.pure.bool(swapCetus.a2b),
      tx.pure.bool(false),               // by_amount_in=false → exact SUI output
      suiNeeded,
      tx.pure.u128(sqrtSwapLimit),
      tx.object(CLOCK),
    ],
  });
  // One side is SUI (output), the other is zero
  const [balSuiOut, balZeroCollat] = swapCetus.a2b
    ? [swapBalB, swapBalA]   // a2b=true: coinB=SUI
    : [swapBalA, swapBalB];  // a2b=false: coinA=SUI
  tx.moveCall({ target: "0x2::balance::destroy_zero", typeArguments: [collatPool.coinType], arguments: [balZeroCollat] });

  // ── Step 5: how much collatCoin does swapPool need back ─────────────────────
  const [collatCost] = tx.moveCall({
    target: `${addrs.CETUS_PKG}::pool::swap_pay_amount`,
    typeArguments: swapTypeArgs,
    arguments: [swapReceipt],
  });

  // ── Step 6: split collat repayment from liquidation proceeds ────────────────
  const collatCoin      = tx.moveCall({ target: "0x2::coin::from_balance", typeArguments: [collatPool.coinType], arguments: [balCollat] });
  const collatRepayCoin = tx.splitCoins(collatCoin, [collatCost])[0];
  const collatRepayBal  = tx.moveCall({ target: "0x2::coin::into_balance", typeArguments: [collatPool.coinType], arguments: [collatRepayCoin] });

  // ── Step 7: repay swapPool (collatCoin + zero SUI) ──────────────────────────
  const zeroSui2 = tx.moveCall({ target: "0x2::balance::zero", typeArguments: [SUI_TYPE], arguments: [] });
  const [swapRepayA, swapRepayB] = swapCetus.a2b
    ? [collatRepayBal, zeroSui2]
    : [zeroSui2,       collatRepayBal];
  tx.moveCall({
    target: `${addrs.CETUS_PKG}::pool::repay_flash_swap`,
    typeArguments: swapTypeArgs,
    arguments: [
      tx.sharedObjectRef({ objectId: cfg.id, initialSharedVersion: cfg.isv, mutable: false }),
      tx.sharedObjectRef({ objectId: swapCetus.id, initialSharedVersion: swapCetus.isv, mutable: true }),
      swapRepayA, swapRepayB, swapReceipt,
    ],
  });

  // ── Step 8: repay borrowPool with the SUI from swapPool ─────────────────────
  const zeroDebt = tx.moveCall({ target: "0x2::balance::zero", typeArguments: [debtPool.coinType], arguments: [] });
  // a2b=false (coinA=debt, coinB=SUI): repayA=zero debt, repayB=SUI
  // a2b=true  (coinA=SUI, coinB=debt): repayA=SUI, repayB=zero debt
  const [finalRepayA, finalRepayB] = borrowCetus.a2b
    ? [balSuiOut, zeroDebt]
    : [zeroDebt,  balSuiOut];
  tx.moveCall({
    target: `${addrs.CETUS_PKG}::pool::repay_flash_swap`,
    typeArguments: borrowTypeArgs,
    arguments: [
      tx.sharedObjectRef({ objectId: cfg.id, initialSharedVersion: cfg.isv, mutable: false }),
      tx.sharedObjectRef({ objectId: borrowCetus.id, initialSharedVersion: borrowCetus.isv, mutable: true }),
      finalRepayA, finalRepayB, borrowReceipt,
    ],
  });

  // ── Step 9: transfer profit to sender ───────────────────────────────────────
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
  tx.transferObjects([collatCoin, excessDebtCoin], tx.pure.address(sender));
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
  const SUI_TYPE = "0x2::sui::SUI";
  const cfg      = addrs.CETUS_GLOBAL_CONFIG;

  // borrowPool typeArgs: a2b=true → [SUI, debt]; a2b=false → [debt, SUI]
  const borrowTypeArgs = borrowCetus.a2b
    ? [SUI_TYPE,          debtPool.coinType]
    : [debtPool.coinType, SUI_TYPE];
  const sqrtBorrowLimit = borrowCetus.a2b ? MIN_SQRT_PRICE : MAX_SQRT_PRICE;

  // ── Step 1: flash borrow exact repayAmount debt; pool will want SUI back ────
  const [borrowBalA, borrowBalB, borrowReceipt] = tx.moveCall({
    target: `${addrs.CETUS_PKG}::pool::flash_swap`,
    typeArguments: borrowTypeArgs,
    arguments: [
      tx.sharedObjectRef({ objectId: cfg.id, initialSharedVersion: cfg.isv, mutable: false }),
      tx.sharedObjectRef({ objectId: borrowCetus.id, initialSharedVersion: borrowCetus.isv, mutable: true }),
      tx.pure.bool(borrowCetus.a2b),
      tx.pure.bool(false),              // exact output = repayAmount
      tx.pure.u64(opp.repayAmount),
      tx.pure.u128(sqrtBorrowLimit),
      tx.object(CLOCK),
    ],
  });
  // a2b=true → [SUI,debt]: balA=0(SUI owed), balB=debtAmount
  // a2b=false → [debt,SUI]: balA=debtAmount, balB=0(SUI owed)
  const [balDebt, balZeroSui1] = borrowCetus.a2b
    ? [borrowBalB, borrowBalA]
    : [borrowBalA, borrowBalB];
  tx.moveCall({ target: "0x2::balance::destroy_zero", typeArguments: [SUI_TYPE], arguments: [balZeroSui1] });

  // ── Step 2: NAVI liquidation_v2 ─────────────────────────────────────────────
  const [balCollat, balExcessDebt] = addNaviLiquidationCall(
    tx, opp, balDebt, debtPool, collatPool, addrs,
  );

  // ── Step 3: how much SUI must we pay back to borrowPool? ────────────────────
  const [suiOwed] = tx.moveCall({
    target: `${addrs.CETUS_PKG}::pool::swap_pay_amount`,
    typeArguments: borrowTypeArgs,
    arguments: [borrowReceipt],
  });

  // ── Step 4: pay borrowPool SUI from wallet gas coin ─────────────────────────
  const suiRepayBal  = tx.moveCall({
    target: "0x2::coin::into_balance",
    typeArguments: [SUI_TYPE],
    arguments: [tx.splitCoins(tx.gas, [suiOwed])[0]],
  });
  const zeroDebtBal  = tx.moveCall({ target: "0x2::balance::zero", typeArguments: [debtPool.coinType], arguments: [] });
  const [repayBorrowA, repayBorrowB] = borrowCetus.a2b
    ? [suiRepayBal, zeroDebtBal]  // a2b=true → [SUI,debt]: repay coinA=SUI
    : [zeroDebtBal, suiRepayBal]; // a2b=false → [debt,SUI]: repay coinB=SUI
  tx.moveCall({
    target: `${addrs.CETUS_PKG}::pool::repay_flash_swap`,
    typeArguments: borrowTypeArgs,
    arguments: [
      tx.sharedObjectRef({ objectId: cfg.id, initialSharedVersion: cfg.isv, mutable: false }),
      tx.sharedObjectRef({ objectId: borrowCetus.id, initialSharedVersion: borrowCetus.isv, mutable: true }),
      repayBorrowA, repayBorrowB, borrowReceipt,
    ],
  });

  const collatCoin     = tx.moveCall({ target: "0x2::coin::from_balance", typeArguments: [collatPool.coinType], arguments: [balCollat] });
  const excessDebtCoin = tx.moveCall({ target: "0x2::coin::from_balance", typeArguments: [debtPool.coinType],   arguments: [balExcessDebt] });

  // ── Steps 5-8: sell collat for SUI (only when collat/SUI pool registered) ───
  if (swapCetus && minSuiOut > 0n) {
    // swapCetus.a2b=true → [collat,SUI]: sell coinA=collat, get coinB=SUI
    // swapCetus.a2b=false → [SUI,collat]: sell coinB=collat, get coinA=SUI
    const swapTypeArgs  = swapCetus.a2b
      ? [collatPool.coinType, SUI_TYPE]
      : [SUI_TYPE,            collatPool.coinType];
    const sqrtSwapLimit = swapCetus.a2b ? MIN_SQRT_PRICE : MAX_SQRT_PRICE;

    const [swapBalA, swapBalB, swapReceipt] = tx.moveCall({
      target: `${addrs.CETUS_PKG}::pool::flash_swap`,
      typeArguments: swapTypeArgs,
      arguments: [
        tx.sharedObjectRef({ objectId: cfg.id, initialSharedVersion: cfg.isv, mutable: false }),
        tx.sharedObjectRef({ objectId: swapCetus.id, initialSharedVersion: swapCetus.isv, mutable: true }),
        tx.pure.bool(swapCetus.a2b),
        tx.pure.bool(false),          // exact SUI output = minSuiOut
        tx.pure.u64(minSuiOut),
        tx.pure.u128(sqrtSwapLimit),
        tx.object(CLOCK),
      ],
    });
    // a2b=true → balA=0(collat owed), balB=SUI
    // a2b=false → balA=SUI, balB=0(collat owed)
    const [balSuiOut, balZeroCollat] = swapCetus.a2b
      ? [swapBalB, swapBalA]
      : [swapBalA, swapBalB];
    tx.moveCall({ target: "0x2::balance::destroy_zero", typeArguments: [collatPool.coinType], arguments: [balZeroCollat] });

    const [collatCost] = tx.moveCall({
      target: `${addrs.CETUS_PKG}::pool::swap_pay_amount`,
      typeArguments: swapTypeArgs,
      arguments: [swapReceipt],
    });

    const collatRepayCoin = tx.splitCoins(collatCoin, [collatCost])[0];
    const collatRepayBal  = tx.moveCall({ target: "0x2::coin::into_balance", typeArguments: [collatPool.coinType], arguments: [collatRepayCoin] });
    const zeroSuiBal      = tx.moveCall({ target: "0x2::balance::zero", typeArguments: [SUI_TYPE], arguments: [] });
    const [swapRepayA, swapRepayB] = swapCetus.a2b
      ? [collatRepayBal, zeroSuiBal]
      : [zeroSuiBal,     collatRepayBal];
    tx.moveCall({
      target: `${addrs.CETUS_PKG}::pool::repay_flash_swap`,
      typeArguments: swapTypeArgs,
      arguments: [
        tx.sharedObjectRef({ objectId: cfg.id, initialSharedVersion: cfg.isv, mutable: false }),
        tx.sharedObjectRef({ objectId: swapCetus.id, initialSharedVersion: swapCetus.isv, mutable: true }),
        swapRepayA, swapRepayB, swapReceipt,
      ],
    });

    const suiOutCoin = tx.moveCall({ target: "0x2::coin::from_balance", typeArguments: [SUI_TYPE], arguments: [balSuiOut] });
    tx.transferObjects([collatCoin, suiOutCoin, excessDebtCoin], tx.pure.address(sender));
  } else {
    // No collat/SUI pool: keep collatTokens as profit
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
    if (route.source !== "wallet-swap") throw new Error(`No wallet-swap route for ${opp.debtAsset}→${opp.collatAsset}`);
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
