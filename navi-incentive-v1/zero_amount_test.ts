/**
 * Direction 2: Zero-Amount / Dust Boundary Test
 * Tests NAVI, Scallop, and Suilend for zero-value edge cases
 * Using devInspectTransactionBlock ONLY - no funds moved
 */
import { SuiClient } from "@mysten/sui/client";
import { Transaction } from "@mysten/sui/transactions";

const client = new SuiClient({ url: "https://fullnode.mainnet.sui.io:443" });

// NAVI objects
const NAVI_MAIN_PKG  = "0xee0041239b89564ce870a7dec5ddc5d114367ab94a1137e90aa0633cb76518e0";
const NAVI_V1_PKG    = "0xd899cf7d2b5db716bd2cf55599fb0d5ee38a3061e7b6bb6eebf73fa5bc4c81ca";
const STORAGE        = "0xbb4e2f4b6205c2e2a2db47aeb4f830796ec7c005f88537ee775986639bc442fe";
const INCENTIVE_V3   = "0x62982dad27fb10bb314b3384d5de8d2ac2d72ab2dbeae5d801dbdb9efa816c80";
const INCENTIVE_V2   = "0xf87a8acb8b81d14307894d12595541a73f19933f88e1326d5be349c7a6f7559c";
const CLOCK          = "0x0000000000000000000000000000000000000000000000000000000000000006";
const DUMMY          = "0x0000000000000000000000000000000000000000000000000000000000001337";
const SUI_TYPE       = "0x2::sui::SUI";

// NAVI SUI pool (asset_id=0)
// Need to get the pool object ID for SUI
async function getNaviSuiPool() {
  // Get reserves table from storage
  const storageObj = await client.getObject({ id: STORAGE, options: { showContent: true } });
  const f = (storageObj.data?.content as any)?.fields ?? {};
  const reservesId = f.reserves?.fields?.id?.id ?? f.reserves?.fields?.contents?.fields?.id;
  console.log("  reserves table ID:", reservesId);
  
  if (!reservesId) return null;
  
  // Query dynamic fields for asset 0 (SUI)
  const suiPoolDf = await client.getDynamicFieldObject({
    parentId: reservesId,
    name: { type: "u8", value: "0" },
  });
  const pf = (suiPoolDf.data?.content as any)?.fields?.value?.fields ?? {};
  console.log("  SUI pool fields:", Object.keys(pf).slice(0, 15));
  return suiPoolDf.data?.objectId;
}

async function testNaviZeroDeposit() {
  console.log("\n[TEST 1] NAVI incentive_v3::entry_deposit(amount=0)");
  
  const pool = await getNaviSuiPool();
  console.log("  SUI pool object:", pool);
  
  // Build TX with 0-value coin
  const tx = new Transaction();
  tx.setSender(DUMMY);
  
  // Create zero-amount SUI coin by splitting
  const [zeroCoin] = tx.splitCoins(tx.gas, [tx.pure.u64(0)]);
  
  tx.moveCall({
    target: `${NAVI_MAIN_PKG}::incentive_v3::entry_deposit`,
    typeArguments: [SUI_TYPE],
    arguments: [
      tx.object(CLOCK),
      tx.object(STORAGE),
      tx.object(INCENTIVE_V3),
      tx.pure.u8(0),       // asset_id = 0 (SUI)
      zeroCoin,            // zero-value coin object
      tx.pure.u64(0),      // amount = 0
      tx.object(INCENTIVE_V2),
      tx.object(NAVI_V1_PKG),  // this might be wrong, need actual pool_manager
    ],
  });
  
  const result = await client.devInspectTransactionBlock({
    transactionBlock: tx,
    sender: DUMMY,
  });
  
  const status = result.effects?.status?.status;
  const error  = result.effects?.status?.error ?? "";
  console.log("  Result:", status);
  console.log("  Error:", error.slice(0, 200));
  
  if (status === "success") {
    console.log("  ⚠️  ZERO DEPOSIT SUCCEEDED — state mutation with 0 value?");
  } else if (error.includes("0, 0") || error.includes("amount") || error.includes("zero")) {
    console.log("  ✅ Zero amount explicitly rejected");
  } else {
    console.log("  (parameter error — wrong object IDs)");
  }
}

async function testNaviZeroBorrow() {
  console.log("\n[TEST 2] NAVI incentive_v3::entry_borrow(amount=0)");

  const tx = new Transaction();
  tx.setSender(DUMMY);
  
  tx.moveCall({
    target: `${NAVI_MAIN_PKG}::incentive_v3::entry_borrow`,
    typeArguments: [SUI_TYPE],
    arguments: [
      tx.object(CLOCK),
      tx.object(STORAGE),
      tx.object(INCENTIVE_V3),
      tx.pure.u8(0),       // asset_id = 0 (SUI)
      tx.pure.u64(0),      // borrow amount = 0
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
  console.log("  Error:", error.slice(0, 200));
  
  if (status === "success") {
    console.log("  🚨 ZERO BORROW SUCCEEDED — can create debt-less position!");
  } else {
    // Check which command failed
    const cmd = error.match(/in command (\d+)/)?.[1];
    console.log("  Command failed:", cmd);
  }
}

async function main() {
  console.log("=" .repeat(60));
  console.log("  Zero-Amount Boundary Tests — devInspect ONLY");
  console.log("=" .repeat(60));
  
  await testNaviZeroDeposit();
  await testNaviZeroBorrow();
}

main().catch(console.error);
