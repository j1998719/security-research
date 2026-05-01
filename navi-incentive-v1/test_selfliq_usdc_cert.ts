import { SuiClient } from "@mysten/sui/client";
import { Transaction } from "@mysten/sui/transactions";

const client = new SuiClient({ url: "https://fullnode.mainnet.sui.io:443" });

const NAVI_MAIN_PKG = "0xee0041239b89564ce870a7dec5ddc5d114367ab94a1137e90aa0633cb76518e0";
const STORAGE     = "0xbb4e2f4b6205c2e2a2db47aeb4f830796ec7c005f88537ee775986639bc442fe";
const POOL_USDC   = "0xa02a98f9c88db51c6f5efaaf2261c81f34dd56d86073387e0ef1805ca22e39c8"; // debt
const POOL_CERT   = "0x9790c2c272e15b6bf9b341eb531ef16bcc8ed2b20dfda25d060bf47f5dd88d01"; // collat
const ORACLE_OBJ  = "0x1568865ed9a0b5ec414220e8f79b3d04c77acc82358f6e5ae4635687392ffbef";
const INCENTIVE_V2= "0xf87a8acb8b81d14307894d12595541a73f19933f88e1326d5be349c7a6f7559c";
const INCENTIVE_V3= "0x62982dad27fb10bb314b3384d5de8d2ac2d72ab2dbeae5d801dbdb9efa816c80";
const CLOCK       = "0x0000000000000000000000000000000000000000000000000000000000000006";
const SUI_SYSTEM  = "0x0000000000000000000000000000000000000000000000000000000000000005";

// Known NAVI borrower from real liquidation tx
const BORROWER = "0x3f40bc9aca5e62681904762ef2c04161d9fd142fe4dc2e5348f71cf2cf5207fa";

const USDC_TYPE = "0x5d4b302506645c37ff133b98c4b50a5ae14841659738d6d733d59d0d217a93bf::coin::COIN";
const CERT_TYPE = "0x549e8b69270defbfafd4f94e17ec44cdbdd99820b33bda2278dea3b9a32d3f55::cert::CERT";

async function test() {
  console.log("=== Self-Liquidation Test: sender == borrower ===");
  console.log(`Sender = Borrower = ${BORROWER}`);
  
  const tx = new Transaction();
  tx.setSender(BORROWER); // SENDER IS THE BORROWER
  
  // Create a tiny USDC-like coin (from gas - will fail type check but test routing)
  const [debtCoin] = tx.splitCoins(tx.gas, [tx.pure.u64(1)]);

  tx.moveCall({
    target: `${NAVI_MAIN_PKG}::incentive_v3::entry_liquidation_v2`,
    typeArguments: [USDC_TYPE, CERT_TYPE], // debt=USDC, collat=CERT (vSUI)
    arguments: [
      // [0] Clock
      tx.object(CLOCK),
      // [1] Oracle
      tx.object(ORACLE_OBJ),
      // [2] Storage
      tx.object(STORAGE),
      // [3] debt_asset_id = 1 (USDC)
      tx.pure.u8(1),
      // [4] Pool<USDC>
      tx.object(POOL_USDC),
      // [5] Coin<USDC> (we'll use SUI coin - type mismatch will abort at different point)
      debtCoin,
      // [6] collat_asset_id = 5 (CERT)
      tx.pure.u8(5),
      // [7] Pool<CERT>
      tx.object(POOL_CERT),
      // [8] borrower = SENDER (SELF-LIQUIDATION!)
      tx.pure.address(BORROWER),
      // [9] amount
      tx.pure.u64(13390269),
      // [10] incentive_v2
      tx.object(INCENTIVE_V2),
      // [11] incentive_v3
      tx.object(INCENTIVE_V3),
      // [12] SuiSystem
      tx.object(SUI_SYSTEM),
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
  
  const codes = [...error.matchAll(/(\d{2,})/g)].map(m => m[1]).slice(0, 10);
  console.log("Numbers in error:", codes);
  
  if (status === "success") {
    console.log("\n*** CRITICAL: Self-liquidation SUCCEEDS. No borrower != sender guard. ***");
  } else {
    if (error.includes("SELF_LIQUIDATION") || codes.includes("1038")) {
      console.log(">>> PATCHED: explicit self-liquidation guard");
    } else if (error.includes("TypeMismatch") || error.includes("CoinType")) {
      console.log(">>> Type mismatch (using SUI coin for USDC slot) - test setup issue");
      console.log(">>> Need proper USDC coin - self-liq guard unknown from this test");
    } else if (error.includes("user_not_exist") || codes.some(c => ['30','31'].includes(c))) {
      console.log(">>> User not found - fires before self-liq check");
    } else {
      console.log(">>> Unknown error - analyzing...");
    }
  }
}

test().catch(console.error);
