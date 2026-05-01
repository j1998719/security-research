import { SuiClient } from "@mysten/sui/client";
import { Transaction } from "@mysten/sui/transactions";

const client = new SuiClient({ url: "https://fullnode.mainnet.sui.io:443" });
const V2_PKG       = "0xe66f07e2a8d9cf793da1e0bca98ff312b3ffba57228d97cf23a0613fddf31b65";
const INCENTIVE_V2 = "0xf87a8acb8b81d14307894d12595541a73f19933f88e1326d5be349c7a6f7559c";
const STORAGE      = "0xbb4e2f4b6205c2e2a2db47aeb4f830796ec7c005f88537ee775986639bc442fe";
const CLOCK        = "0x0000000000000000000000000000000000000000000000000000000000000006";
const PROTO_PKG    = "0xee0041239b89564ce870a7dec5ddc5d114367ab94a1137e90aa0633cb76518e0";
const INCENTIVE_V3 = "0x62982dad27fb10bb314b3384d5de8d2ac2d72ab2dbeae5d801dbdb9efa816c80";
const DUMMY        = "0x0000000000000000000000000000000000000000000000000000000000001337";
const SUI_TYPE     = "0x2::sui::SUI";

async function testV2() {
  console.log("=== Test 1: v2 claim_reward — version guard? ===");
  // v2 claim_reward signature: &Clock, &mut Incentive, &mut IncentiveFundsPool, &mut Storage, U8, U8
  // Use fake IncentiveFundsPool — if version guard fires FIRST, error is about version not object
  const tx = new Transaction();
  tx.setSender(DUMMY);
  tx.moveCall({
    target: `${V2_PKG}::incentive_v2::claim_reward`,
    typeArguments: [SUI_TYPE],
    arguments: [
      tx.object(CLOCK),
      tx.object(INCENTIVE_V2),
      tx.object("0x0000000000000000000000000000000000000000000000000000000000000001"), // fake pool
      tx.object(STORAGE),
      tx.pure.u8(0),  // asset
      tx.pure.u8(0),  // pool_id
    ],
  });
  const r = await client.devInspectTransactionBlock({ transactionBlock: tx, sender: DUMMY });
  const status = r.effects?.status;
  console.log("Status:", status?.status);
  const err = status?.error ?? "";
  if (err.includes("EIncorrectVersion") || (err.includes("incentive_v2") && err.includes("verify"))) {
    console.log("→ VERSION GUARD FIRES ✓ — v2 blocked");
  } else if (err.includes("not found") || err.includes("DynamicFieldNotFound") || err.includes("object")) {
    console.log("→ Passed version check! Object lookup failed next.");
    console.log("→ v2 claim_reward IS callable if valid IncentiveFundsPool exists");
    console.log("Error:", err.slice(0, 150));
  } else {
    console.log("Error:", err.slice(0, 150));
  }
}

async function checkV2FundsPools() {
  console.log("\n=== Test 2: Find v2 IncentiveFundsPool objects (from old deployment) ===");
  // The article mentioned old v2 deployment: 0xa49c5d1c...
  // Check IncentiveFundsPool objects in that deployment
  const OLD_V2_PKG = "0xa49c5d1c8f0a9eaa4e1c0c461c2b5dfb6e88213876739e56db1afb3649a8af26";
  const OLD_INCENTIVE = "0x952b6726bbcc08eb14f38a3632a3f98b823f301468d7de36f1d05faaef1bdd2a";
  
  // Check the old incentive object
  const obj = await client.getObject({ id: OLD_INCENTIVE, options: { showContent: true, showType: true } }).catch(() => null);
  if (obj?.data) {
    const f = (obj.data?.content as any)?.fields ?? {};
    console.log("Old Incentive type:", obj.data.type?.slice(0, 60));
    console.log("Old Incentive version:", f.version);
    console.log("Old Incentive fields:", Object.keys(f));
  } else {
    console.log("Old Incentive not found or inaccessible");
  }
  
  // Check funds pool from article
  const CERT_POOL = "0x1ca8af58e427f0e1be3bd6e3a83cd29cd5e72e93f5c38b50f9e7c5ef7b84eea5";
  const SUI_POOL_OLD = "0x524e28ef0562ad3c6fbaadf12b5abc4a2d52a4a81e41fa08fc3e2cf8b3568e4e";
  for (const [label, id] of [["CERT pool", CERT_POOL], ["SUI pool (old)", SUI_POOL_OLD]]) {
    const p = await client.getObject({ id, options: { showContent: true, showType: true } }).catch(() => null);
    if (p?.data) {
      const pf = (p.data?.content as any)?.fields ?? {};
      const bal = pf.balance ?? pf.amount ?? "(unknown)";
      console.log(`\n${label} (${id.slice(0,18)}...):`);
      console.log(`  type: ${p.data.type?.slice(0, 60)}`);
      console.log(`  balance: ${typeof bal === 'string' ? (Number(bal)/1e9).toFixed(2) : JSON.stringify(bal).slice(0,40)}`);
    }
  }
}

async function checkV3IndexInit() {
  console.log("\n=== Test 3: v3 PoolState struct — user index initialization ===");
  
  // Get IncentiveV3 pool state structure
  const obj = await client.getObject({ id: INCENTIVE_V3, options: { showContent: true } });
  const f = (obj.data?.content as any)?.fields ?? {};
  
  // pools is VecMap
  const pools = f.pools?.fields?.contents ?? [];
  console.log(`v3 pool count: ${pools.length}`);
  
  if (pools.length > 0) {
    const samplePool = pools[0];
    const key = samplePool?.fields?.key; // coin type string
    const pf = samplePool?.fields?.value?.fields ?? {};
    console.log(`\nSample pool key (coin type): ${String(key).slice(0, 60)}`);
    console.log("Pool state fields:", Object.keys(pf));
    
    // The key question: is there a per-user index Table?
    for (const [k, v] of Object.entries(pf)) {
      const vStr = JSON.stringify(v).slice(0, 80);
      if (vStr.includes("table") || vStr.includes("Table")) {
        console.log(`\n  FIELD WITH TABLE: ${k} = ${vStr}`);
        // Check what's in this table
        const tableId = (v as any)?.fields?.id?.id;
        if (tableId) {
          const tdf = await client.getDynamicFields({ parentId: tableId });
          console.log(`    Table entries: ${tdf.data.length}`);
          if (tdf.data.length > 0) {
            const first = tdf.data[0];
            const entry = await client.getObject({ id: first.objectId, options: { showContent: true } });
            const ef = (entry.data?.content as any)?.fields ?? {};
            console.log(`    Entry structure: ${JSON.stringify(ef).slice(0, 120)}`);
          }
        }
      } else if (k.includes("index") || k.includes("reward") || k.includes("accrued")) {
        console.log(`  ${k}: ${vStr}`);
      }
    }
  }
  
  // Check v3 getNormalizedMoveModule for PoolState struct
  const mod = await client.getNormalizedMoveModulesByPackage({ package: PROTO_PKG }).catch(() => null);
  if (mod?.incentive_v3) {
    const structs = mod.incentive_v3.structs;
    console.log("\nv3 structs:", Object.keys(structs));
    for (const [name, s] of Object.entries(structs)) {
      if (name.includes("Pool") || name.includes("User") || name.includes("Reward")) {
        const fields = s.fields.map((f: any) => f.name);
        console.log(`  ${name}: [${fields.join(", ")}]`);
      }
    }
  }
}

async function main() {
  await testV2();
  await checkV2FundsPools();
  await checkV3IndexInit();
}

main().catch(console.error);
