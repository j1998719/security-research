import { SuiClient } from "@mysten/sui/client";
import { Transaction } from "@mysten/sui/transactions";

const client = new SuiClient({ url: "https://fullnode.mainnet.sui.io:443" });

const NAVI_MAIN_PKG = "0xee0041239b89564ce870a7dec5ddc5d114367ab94a1137e90aa0633cb76518e0";
const SUI_POOL      = "0x96df0fce3c471489f4debaaa762cf960b3d97820bd1f3f025ff8190730e958c5";
const STORAGE       = "0xbb4e2f4b6205c2e2a2db47aeb4f830796ec7c005f88537ee775986639bc442fe";
const ORACLE_OBJ    = "0x1568865ed9a0b5ec414220e8f79b3d04c77acc82358f6e5ae4635687392ffbef";
const INCENTIVE_V2  = "0xf87a8acb8b81d14307894d12595541a73f19933f88e1326d5be349c7a6f7559c";
const INCENTIVE_V3  = "0x62982dad27fb10bb314b3384d5de8d2ac2d72ab2dbeae5d801dbdb9efa816c80";
const CLOCK         = "0x0000000000000000000000000000000000000000000000000000000000000006";
const SUI_SYSTEM    = "0x0000000000000000000000000000000000000000000000000000000000000005";
const DUMMY         = "0x0000000000000000000000000000000000000000000000000000000000001337";
const SUI_TYPE      = "0x2::sui::SUI";

async function testSelfLiquidationV2() {
  console.log("\n[TEST] entry_liquidation_v2: borrower = sender (DUMMY)");
  console.log("  Parameters: SUI/SUI, Pool<SUI>, debt=1, collat=0, borrower=DUMMY");

  const tx = new Transaction();
  tx.setSender(DUMMY);
  
  // Split 1 MIST from gas to use as liquidation coin
  const [debtCoin] = tx.splitCoins(tx.gas, [tx.pure.u64(1)]);

  tx.moveCall({
    target: `${NAVI_MAIN_PKG}::incentive_v3::entry_liquidation_v2`,
    typeArguments: [SUI_TYPE, SUI_TYPE],
    arguments: [
      tx.object(CLOCK),
      tx.object(ORACLE_OBJ),
      tx.object(STORAGE),
      tx.pure.u8(0),         // debt asset_id = SUI
      tx.object(SUI_POOL),   // Pool<SUI> for debt
      debtCoin,              // Coin<SUI> to repay
      tx.pure.u8(0),         // collat asset_id = SUI
      tx.object(SUI_POOL),   // Pool<SUI> for collateral (same)
      tx.pure.address(DUMMY), // borrower = DUMMY = sender (self-liquidation)
      tx.pure.u64(1),        // amount = 1 MIST
      tx.object(INCENTIVE_V2),
      tx.object(INCENTIVE_V3),
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
  console.log("  Error:", error.slice(0, 400));
  
  if (status === "success") {
    console.log("\n  🚨 SELF-LIQUIDATION ALLOWED — protocol does NOT check borrower != sender!");
    console.log("  Attack vector: deposit collateral → borrow → self-liquidate → bypass liquidation penalty");
  } else {
    const errorCode = error.match(/abort code: (\d+)|, (\d+)\)/)?.[1] ?? error.match(/\), (\d+)\)/)?.[1];
    
    if (error.includes("self") || error.includes("SAME_ADDRESS") || error.includes("SELF_LIQUIDATION")) {
      console.log("  ✅ Explicit self-liquidation block found");
    } else if (error.includes("health") || error.includes("HEALTH_FACTOR") || error.includes("undercollateral")) {
      console.log("  → Failed at health factor check");
      console.log("  → Self-liquidation check order is AFTER health factor");
      console.log("  → DUMMY has no position, so health factor fails first");
      console.log("  ⚠️  Cannot determine self-liquidation guard from this test");
    } else if (error.includes("user_not_exist") || errorCode === "30" || errorCode === "31") {
      console.log("  → Failed because DUMMY has no lending position");
      console.log("  ⚠️  Self-liquidation guard unclear — need existing undercollateralized position");
    } else if (error.includes("InvariantViolation")) {
      console.log("  (type error — wrong object IDs)");
    } else if (errorCode) {
      console.log(`  → Abort code ${errorCode} — need NAVI error code mapping`);
    }
    
    console.log("  → NAVI logic.move self-check: needs source code review");
    console.log("  → Known: NAVI doc says liquidator != borrower but no source confirmation");
  }
  
  return { status, error };
}

// Also test zero-amount liquidation
async function testZeroAmountLiquidation() {
  console.log("\n[TEST] entry_liquidation_v2: amount=0");
  
  const tx = new Transaction();
  tx.setSender(DUMMY);
  
  const [zeroCoin] = tx.splitCoins(tx.gas, [tx.pure.u64(0)]);

  tx.moveCall({
    target: `${NAVI_MAIN_PKG}::incentive_v3::entry_liquidation_v2`,
    typeArguments: [SUI_TYPE, SUI_TYPE],
    arguments: [
      tx.object(CLOCK),
      tx.object(ORACLE_OBJ),
      tx.object(STORAGE),
      tx.pure.u8(0),
      tx.object(SUI_POOL),
      zeroCoin,              // ZERO coin
      tx.pure.u8(0),
      tx.object(SUI_POOL),
      tx.pure.address("0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef"),
      tx.pure.u64(0),        // amount = 0
      tx.object(INCENTIVE_V2),
      tx.object(INCENTIVE_V3),
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
  
  if (status === "success") {
    console.log("  🚨 ZERO-AMOUNT LIQUIDATION ACCEPTED!");
  }
  
  return { status, error };
}

async function main() {
  console.log("=" .repeat(60));
  console.log("  NAVI Direction 4: Liquidation Boundary Tests");
  console.log("=" .repeat(60));
  
  await testSelfLiquidationV2();
  await testZeroAmountLiquidation();
}

main().catch(console.error);
