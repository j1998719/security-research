import { SuiClient } from "@mysten/sui/client";
import { Transaction } from "@mysten/sui/transactions";

const client = new SuiClient({ url: "https://fullnode.mainnet.sui.io:443" });

// v15 package
const NAVI_V15_PKG  = "0x1e4a13a0494d5facdbe8473e74127b838c2d446ecec0ce262e2eddafa77259cb";
const NAVI_MAIN_PKG = "0xee0041239b89564ce870a7dec5ddc5d114367ab94a1137e90aa0633cb76518e0";
const STORAGE       = "0xbb4e2f4b6205c2e2a2db47aeb4f830796ec7c005f88537ee775986639bc442fe";
const SUI_POOL      = "0x96df0fce3c471489f4debaaa762cf960b3d97820bd1f3f025ff8190730e958c5";
const ORACLE_OBJ    = "0x1568865ed9a0b5ec414220e8f79b3d04c77acc82358f6e5ae4635687392ffbef";
const INCENTIVE_V2  = "0xf87a8acb8b81d14307894d12595541a73f19933f88e1326d5be349c7a6f7559c";
const INCENTIVE_V3  = "0x62982dad27fb10bb314b3384d5de8d2ac2d72ab2dbeae5d801dbdb9efa816c80";
const CLOCK         = "0x0000000000000000000000000000000000000000000000000000000000000006";
const SUI_SYSTEM    = "0x0000000000000000000000000000000000000000000000000000000000000005";

// Use known undercollateralized borrower (or any real NAVI borrower for testing)
// For devInspect, we use a dummy sender but set borrower = sender
const DUMMY = "0x0000000000000000000000000000000000000000000000000000000000001337";
const SUI_TYPE = "0x2::sui::SUI";

async function testSelfLiqV2() {
  console.log("=== NAVI Self-Liquidation Test v3 ===");
  console.log("Testing: entry_liquidation_v2 from v15 package");
  console.log("Sender = borrower_addr = DUMMY (self-liquidation attempt)");
  
  const tx = new Transaction();
  tx.setSender(DUMMY);
  
  // Split 1 MIST for the debt coin
  const [debtCoin] = tx.splitCoins(tx.gas, [tx.pure.u64(1)]);

  // entry_liquidation_v2 signature (14 params):
  // clock, oracle, &mut storage, debt_asset_id(u8), &mut pool<debt>, coin<debt>,
  // collat_asset_id(u8), &mut pool<collat>, borrower_addr(address), amount(u64),
  // &mut incentive_v2, &mut incentive_v3, &mut sui_system, &mut ctx
  tx.moveCall({
    target: `${NAVI_MAIN_PKG}::incentive_v3::entry_liquidation_v2`,
    typeArguments: [SUI_TYPE, SUI_TYPE],
    arguments: [
      tx.object(CLOCK),
      tx.object(ORACLE_OBJ),
      tx.object(STORAGE),
      tx.pure.u8(0),         // debt asset_id = 0 (SUI)
      tx.object(SUI_POOL),   // pool<SUI>
      debtCoin,              // coin<SUI>
      tx.pure.u8(0),         // collat asset_id = 0 (SUI)  
      tx.object(SUI_POOL),   // pool<SUI> (same pool for simplicity)
      tx.pure.address(DUMMY),// borrower = DUMMY = sender (SELF-LIQUIDATION)
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
  console.log("Result:", status);
  console.log("Error:", error.slice(0, 500));
  
  // Interpret
  if (status === "success") {
    console.log("\n>>> VULNERABLE: Self-liquidation accepted! No borrower != sender check.");
  } else {
    // Map error codes
    const abortMatch = error.match(/abort_code: (\d+)|, (\d+)\)/);
    const code = abortMatch ? (abortMatch[1] || abortMatch[2]) : null;
    console.log("\nAbort code:", code);
    
    if (code === "1000" || error.includes("SELF_LIQUIDATION") || error.includes("self")) {
      console.log(">>> PATCHED: Explicit self-liquidation check.");
    } else if (code === "1100" || error.includes("not_liquidatable") || error.includes("health_factor")) {
      console.log(">>> Failed at health factor check (DUMMY has no position).");
      console.log(">>> Cannot confirm self-liquidation guard from this test.");
      console.log(">>> Need real undercollateralized position where sender == borrower.");
    } else if (error.includes("user_not_exist")) {
      console.log(">>> Failed: DUMMY has no lending position.");
      console.log(">>> Error occurs before self-liquidation check (if any).");
    } else if (error.includes("InvalidReferenceArgument")) {
      console.log(">>> Type error - wrong pool reference format.");
    } else if (code === "30" || code === "31") {
      console.log(">>> Error 30/31: user not found in storage.");
      console.log(">>> This fires before any borrower != sender check.");
    }
  }
  
  return { status, error };
}

// Also test using the internal `liquidation` non-entry function through a wrapper
// to see if the self-check is in the inner or outer function

async function testIsLiquidatableCall() {
  console.log("\n=== Test: is_liquidatable(storage, borrower=DUMMY, liquidator=DUMMY) ===");
  
  const tx = new Transaction();
  tx.setSender(DUMMY);
  
  // Call is_liquidatable(storage, borrower_addr, liquidator_addr) where both are DUMMY
  tx.moveCall({
    target: `${NAVI_V15_PKG}::storage::is_liquidatable`,
    typeArguments: [],
    arguments: [
      tx.object(STORAGE),
      tx.pure.address(DUMMY), // borrower
      tx.pure.address(DUMMY), // liquidator = borrower (self)
    ],
  });
  
  const result = await client.devInspectTransactionBlock({
    transactionBlock: tx,
    sender: DUMMY,
  });
  
  const status = result.effects?.status?.status;
  const error  = result.effects?.status?.error ?? "";
  console.log("Result:", status);
  console.log("Error:", error.slice(0, 400));
  
  if (status === "success") {
    const returnValues = result.results?.[0]?.returnValues;
    console.log("Return (is_liquidatable):", returnValues);
    console.log(">>> is_liquidatable does NOT abort for self-reference — returns bool");
  }
  
  return { status, error };
}

async function main() {
  await testSelfLiqV2();
  await testIsLiquidatableCall();
}

main().catch(console.error);
