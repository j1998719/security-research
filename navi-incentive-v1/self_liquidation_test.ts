/**
 * Direction 4: Self-liquidation boundary test
 * Tests whether NAVI allows calling liquidate() with self as borrower
 * Using devInspectTransactionBlock ONLY - no funds moved
 */
import { SuiClient } from "@mysten/sui/client";
import { Transaction } from "@mysten/sui/transactions";

const client = new SuiClient({ url: "https://fullnode.mainnet.sui.io:443" });

const NAVI_MAIN_PKG = "0xee0041239b89564ce870a7dec5ddc5d114367ab94a1137e90aa0633cb76518e0";
const NAVI_V1_PKG   = "0xd899cf7d2b5db716bd2cf55599fb0d5ee38a3061e7b6bb6eebf73fa5bc4c81ca";
const STORAGE       = "0xbb4e2f4b6205c2e2a2db47aeb4f830796ec7c005f88537ee775986639bc442fe";
const INCENTIVE_V3  = "0x62982dad27fb10bb314b3384d5de8d2ac2d72ab2dbeae5d801dbdb9efa816c80";
const INCENTIVE_V2  = "0xf87a8acb8b81d14307894d12595541a73f19933f88e1326d5be349c7a6f7559c";
const ORACLE_OBJ    = "0x1568865ed9a0b5ec414220e8f79b3d04c77acc82358f6e5ae4635687392ffbef";
const CLOCK         = "0x0000000000000000000000000000000000000000000000000000000000000006";
const SUI_SYSTEM    = "0x0000000000000000000000000000000000000000000000000000000000000005";
const DUMMY         = "0x0000000000000000000000000000000000000000000000000000000000001337";

// asset 0=SUI, 1=USDC
const SUI_POOL  = "0xab644b5fd11aa11e930d1c7bc903ef609a9feaf9ffe1b23532ad8441854fbfaf";
const USDC_POOL = "0xeb3903f7748ace73429bd52a70fff278aac1725d3b58afa781f25ce3450ac203";

const SUI_TYPE  = "0x2::sui::SUI";
const USDC_TYPE = "0x5d4b302506645c37ff133b98c4b50a5ae14841659738d6d733d59d0d217a93bf::coin::COIN";

// entry_liquidation_v2 signature:
// [0] Clock, [1] oracle, [2] Storage, [3] debt_asset_id U8, [4] pool<debt_type>,
// [5] coin<debt_type>, [6] collat_asset_id U8, [7] pool<collat_type>, [8] borrower Address,
// [9] liquidation_amount U64, [10] account (AccountCap or similar), [11] incentive_v2,
// [12] SuiSystemState, [13] ctx

async function testSelfLiquidation() {
  console.log("\n[TEST 1] NAVI self-liquidation — entry_liquidation_v2");
  console.log("  Attempt: liquidator=DUMMY, borrower=DUMMY (self)");
  console.log("  If successful: no check against self-liquidation");
  
  const tx = new Transaction();
  tx.setSender(DUMMY);
  
  // Create dust liquidation coin (1 USDC = 1,000,000 units)
  const [debtCoin] = tx.splitCoins(tx.gas, [tx.pure.u64(1)]);  // 0.000000001 SUI for test

  // Try to liquidate DUMMY (self) — SUI collateral, debt in SUI for simplicity
  tx.moveCall({
    target: `${NAVI_MAIN_PKG}::incentive_v3::entry_liquidation_v2`,
    typeArguments: [SUI_TYPE, SUI_TYPE],  // debt_type, collat_type
    arguments: [
      tx.object(CLOCK),
      tx.object(ORACLE_OBJ),
      tx.object(STORAGE),
      tx.pure.u8(0),       // debt asset_id = 0 (SUI)
      tx.object(SUI_POOL), // pool for debt asset
      debtCoin,            // debt coin to repay
      tx.pure.u8(0),       // collat asset_id = 0 (SUI)
      tx.object(SUI_POOL), // pool for collateral (same)
      tx.pure.address(DUMMY),  // borrower = DUMMY (self-liquidation)
      tx.pure.u64(1),      // liquidation_amount = 1
      tx.object(STORAGE),  // THIS IS WRONG but will reveal error type
      tx.object(INCENTIVE_V2),
      tx.object(SUI_SYSTEM),
    ],
  });
  
  const result = await client.devInspectTransactionBlock({
    transactionBlock: tx,
    sender: DUMMY,
  });
  
  const status = result.effects?.status?.status;
  const error  = result.effects?.status?.error ?? "";
  console.log("  Result:", status);
  console.log("  Error:", error.slice(0, 300));
  
  // Interpret result
  if (status === "success") {
    console.log("  🚨 SELF-LIQUIDATION ALLOWED — no check for borrower == sender!");
  } else if (error.includes("self") || error.includes("SELF") || error.includes("SAME") || error.includes("same")) {
    console.log("  ✅ Self-liquidation explicitly blocked");
  } else if (error.includes("health") || error.includes("HEALTH") || error.includes("liquidat")) {
    console.log("  ✅ Failed at health factor check (DUMMY has no position — correct)");
    console.log("  → Self-liquidation check order unclear — need real undercollateralized position");
  } else if (error.includes("InvariantViolation") || error.includes("param")) {
    console.log("  (Parameter type error — need correct account type)");
  }
  
  return { status, error };
}

// Also check entry_liquidation (non-v2 variant) which has fewer params
async function testSelfLiquidationV1() {
  console.log("\n[TEST 2] NAVI self-liquidation — entry_liquidation (V1)");
  
  const tx = new Transaction();
  tx.setSender(DUMMY);
  
  const [debtCoin] = tx.splitCoins(tx.gas, [tx.pure.u64(1)]);

  // entry_liquidation params (10 args, no SuiSystemState):
  // clock, oracle, storage, debt_asset_id, pool_debt, coin, collat_asset_id, pool_collat, borrower, amount, account, incentive_v2, ctx
  tx.moveCall({
    target: `${NAVI_MAIN_PKG}::incentive_v3::entry_liquidation`,
    typeArguments: [SUI_TYPE, SUI_TYPE],
    arguments: [
      tx.object(CLOCK),
      tx.object(ORACLE_OBJ),
      tx.object(STORAGE),
      tx.pure.u8(0),
      tx.object(SUI_POOL),
      debtCoin,
      tx.pure.u8(0),
      tx.object(SUI_POOL),
      tx.pure.address(DUMMY),   // borrower = self
      tx.pure.u64(1),
      tx.object(INCENTIVE_V3),  // account object (wrong, but check error)
      tx.object(INCENTIVE_V2),
    ],
  });
  
  const result = await client.devInspectTransactionBlock({
    transactionBlock: tx,
    sender: DUMMY,
  });
  
  const status = result.effects?.status?.status;
  const error  = result.effects?.status?.error ?? "";
  console.log("  Result:", status);
  console.log("  Error:", error.slice(0, 300));
  
  return { status, error };
}

async function main() {
  console.log("=" .repeat(60));
  console.log("  NAVI Self-Liquidation Test — devInspect ONLY");
  console.log("=" .repeat(60));
  
  await testSelfLiquidation();
  await testSelfLiquidationV1();
}

main().catch(console.error);
