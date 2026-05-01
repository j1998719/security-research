/**
 * Zero-amount deposit test for NAVI
 * Correct object IDs verified from chain
 */
import { SuiClient } from "@mysten/sui/client";
import { Transaction } from "@mysten/sui/transactions";

const client = new SuiClient({ url: "https://fullnode.mainnet.sui.io:443" });

const NAVI_MAIN_PKG = "0xee0041239b89564ce870a7dec5ddc5d114367ab94a1137e90aa0633cb76518e0";
const STORAGE       = "0xbb4e2f4b6205c2e2a2db47aeb4f830796ec7c005f88537ee775986639bc442fe";
const SUI_POOL      = "0x96df0fce3c471489f4debaaa762cf960b3d97820bd1f3f025ff8190730e958c5";
const INCENTIVE_V2  = "0xf87a8acb8b81d14307894d12595541a73f19933f88e1326d5be349c7a6f7559c";
const INCENTIVE_V3  = "0x62982dad27fb10bb314b3384d5de8d2ac2d72ab2dbeae5d801dbdb9efa816c80";
const CLOCK         = "0x0000000000000000000000000000000000000000000000000000000000000006";
const DUMMY         = "0x0000000000000000000000000000000000000000000000000000000000001337";
const SUI_TYPE      = "0x2::sui::SUI";

// entry_deposit params (incentive_v3):
// [0] Clock, [1] Storage, [2] Pool<T>, [3] asset_id U8, [4] Coin<T>, [5] amount U64,
// [6] Incentive (v2), [7] Incentive (v3), [8] ctx

async function testZeroDeposit() {
  console.log("[TEST 1] entry_deposit with amount=0");
  const tx = new Transaction();
  tx.setSender(DUMMY);
  
  const [zeroCoin] = tx.splitCoins(tx.gas, [tx.pure.u64(0)]);
  
  tx.moveCall({
    target: `${NAVI_MAIN_PKG}::incentive_v3::entry_deposit`,
    typeArguments: [SUI_TYPE],
    arguments: [
      tx.object(CLOCK),
      tx.object(STORAGE),
      tx.object(SUI_POOL),
      tx.pure.u8(0),
      zeroCoin,
      tx.pure.u64(0),
      tx.object(INCENTIVE_V2),
      tx.object(INCENTIVE_V3),
    ],
  });
  
  const r = await client.devInspectTransactionBlock({ transactionBlock: tx, sender: DUMMY });
  const status = r.effects?.status?.status;
  const error  = r.effects?.status?.error ?? "";
  console.log("  Result:", status);
  console.log("  Error:", error.slice(0, 300));
  
  if (status === "success") {
    console.log("  🚨 ZERO DEPOSIT ACCEPTED! State mutation with 0 value!");
  } else {
    const code = error.match(/MoveAbort.+?, (\d+)\)/)?.[1];
    if (code) {
      // Check NAVI error codes
      const NAVI_ERRORS: Record<string, string> = {
        "1": "INVALID_AMOUNT (zero check exists!)",
        "2": "PAUSED", 
        "3": "INSUFFICIENT_BALANCE",
        "4": "BORROW_CAP_EXCEEDED",
        "5": "EXCEED_MAX_UTILIZATION",
        "6": "HEALTH_FACTOR_BELOW_ONE",
        "7": "NOT_SUPPORTED",
        "8": "ORACLE_STALE",
        "10": "AMOUNT_MUST_BE_GT_ZERO",
        "100": "INVALID_COIN_TYPE",
      };
      console.log(`  Abort code ${code}: ${NAVI_ERRORS[code] ?? "unknown"}`);
    }
    if (error.includes("command 0")) {
      console.log("  → Failed at split (gas amount = 0 — Sui prevents 0-value splits)");
    }
  }
  return { status, error };
}

async function testTinyDeposit() {
  console.log("\n[TEST 2] entry_deposit with amount=1 MIST (dust boundary)");
  const tx = new Transaction();
  tx.setSender(DUMMY);
  
  const [tinyCoin] = tx.splitCoins(tx.gas, [tx.pure.u64(1)]);
  
  tx.moveCall({
    target: `${NAVI_MAIN_PKG}::incentive_v3::entry_deposit`,
    typeArguments: [SUI_TYPE],
    arguments: [
      tx.object(CLOCK),
      tx.object(STORAGE),
      tx.object(SUI_POOL),
      tx.pure.u8(0),
      tinyCoin,
      tx.pure.u64(1),
      tx.object(INCENTIVE_V2),
      tx.object(INCENTIVE_V3),
    ],
  });
  
  const r = await client.devInspectTransactionBlock({ transactionBlock: tx, sender: DUMMY });
  const status = r.effects?.status?.status;
  const error  = r.effects?.status?.error ?? "";
  console.log("  Result:", status);
  console.log("  Error:", error.slice(0, 300));
  
  if (status === "success") {
    // Check events for minted supply tokens
    const events = r.events ?? [];
    console.log("  Events:", events.length);
    for (const e of events.slice(0, 5)) {
      console.log("   ", e.type, JSON.stringify(e.parsedJson ?? {}).slice(0, 100));
    }
    console.log("  → Check if 1 MIST deposit results in 0 supply tokens (rounding)");
  }
  return { status, error };
}

async function testZeroBorrowV3() {
  console.log("\n[TEST 3] entry_borrow_v2 with amount=0");
  // entry_borrow_v2 params: clock, oracle, storage, incentive_v3, asset_id, amount, incentive_v2, incentive_v3, sui_system, ctx
  // Wait - we need oracle object
  const ORACLE = "0x1568865ed9a0b5ec414220e8f79b3d04c77acc82358f6e5ae4635687392ffbef";
  const SUI_SYSTEM = "0x0000000000000000000000000000000000000000000000000000000000000005";
  
  const tx = new Transaction();
  tx.setSender(DUMMY);
  
  tx.moveCall({
    target: `${NAVI_MAIN_PKG}::incentive_v3::entry_borrow_v2`,
    typeArguments: [SUI_TYPE],
    arguments: [
      tx.object(CLOCK),
      tx.object(ORACLE),
      tx.object(STORAGE),
      tx.object(INCENTIVE_V3),
      tx.pure.u8(0),
      tx.pure.u64(0),   // amount = 0
      tx.object(INCENTIVE_V2),
      tx.object(INCENTIVE_V3),
      tx.object(SUI_SYSTEM),
    ],
  });
  
  const r = await client.devInspectTransactionBlock({ transactionBlock: tx, sender: DUMMY });
  const status = r.effects?.status?.status;
  const error  = r.effects?.status?.error ?? "";
  console.log("  Result:", status);
  console.log("  Error:", error.slice(0, 300));
  
  if (status === "success") {
    console.log("  🚨 ZERO BORROW ACCEPTED!");
  } else {
    const code = error.match(/MoveAbort.+?, (\d+)\)/)?.[1];
    if (code) console.log(`  Abort code: ${code}`);
  }
  return { status, error };
}

async function main() {
  console.log("=".repeat(60));
  console.log("  NAVI Zero-Amount Boundary Tests (Correct Object IDs)");
  console.log("=".repeat(60));
  
  await testZeroDeposit();
  await testTinyDeposit();
  await testZeroBorrowV3();
}

main().catch(console.error);
