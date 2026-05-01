import { SuiClient } from "@mysten/sui/client";
import { Transaction } from "@mysten/sui/transactions";

const client = new SuiClient({ url: "https://fullnode.mainnet.sui.io:443" });
const PROTO_PKG    = "0xee0041239b89564ce870a7dec5ddc5d114367ab94a1137e90aa0633cb76518e0";
const INCENTIVE_V3 = "0x62982dad27fb10bb314b3384d5de8d2ac2d72ab2dbeae5d801dbdb9efa816c80";
const STORAGE      = "0xbb4e2f4b6205c2e2a2db47aeb4f830796ec7c005f88537ee775986639bc442fe";
const CLOCK        = "0x0000000000000000000000000000000000000000000000000000000000000006";
const SUI_TYPE     = "0x2::sui::SUI";
const DUMMY        = "0x0000000000000000000000000000000000000000000000000000000000001337";
const NAVI_WHALE   = "0x7861f12c652dbcf96589413cf5cbc5ebcccd85c2c9f09c25fee76f2a218195c9";
const RAY          = 1_000_000_000_000_000_000_000_000_000n;

// ─── Step 1: Inspect v3 Rule for global_index and user_index for fresh address ─

async function inspectV3Rule() {
  console.log("=== v3 Rule: global_index and user_index table ===\n");

  // Get first AssetPool from INCENTIVE_V3
  const iv3Obj = await client.getObject({ id: INCENTIVE_V3, options: { showContent: true } });
  const pools = (iv3Obj.data?.content as any)?.fields?.pools?.fields?.contents ?? [];
  
  let suiPoolKey = "";
  for (const p of pools) {
    const key = String(p?.fields?.key ?? "");
    if (key.includes("sui::SUI") || key.includes("::sui::")) { suiPoolKey = key; break; }
  }
  console.log("SUI pool key:", suiPoolKey.slice(0, 60));

  // Get Rule objects (dynamic fields of each AssetPool)
  // First find the AssetPool by querying v3 dynamic fields
  const df = await client.getDynamicFields({ parentId: INCENTIVE_V3 });
  console.log(`INCENTIVE_V3 dynamic fields: ${df.data.length}`);

  // Try to get Rule struct directly
  // getNormalizedMoveFunction for claim_reward_entry to understand exact params
  const fn = await client.getNormalizedMoveFunction({ package: PROTO_PKG, module: "incentive_v3", function: "claim_reward_entry" });
  console.log("\nclaim_reward_entry params:");
  for (const p of fn.parameters) {
    const ps = JSON.stringify(p);
    if (ps.includes("Struct")) {
      const name = ps.match(/"name":"(\w+)"/)?.[1] ?? ps.slice(0, 40);
      const isMut = ps.includes("MutableReference");
      console.log(`  ${isMut ? "&mut " : "& "}${name}`);
    } else {
      console.log(`  ${ps.slice(0, 30)}`);
    }
  }
  return fn;
}

// ─── Step 2: Dry-run claim_reward_entry for fresh address ─────────────────────

async function testV3Claim(fn: any) {
  console.log("\n=== v3 claim_reward_entry dry-run ===\n");
  
  // claim_reward_entry needs: &Clock, &mut Incentive, &mut Storage, asset:U8, &mut TxContext
  // Let's try calling it with dummy address and see if:
  // A. version guard fires
  // B. user_index=0 gives historical reward (VULNERABLE)
  // C. user_index not found → error (SAFE — means new users can't claim)
  // D. user not found in supply_balance → reward = 0 (SAFE)
  
  for (const [label, sender] of [["dummy (0 balance)", DUMMY], ["NAVI whale", NAVI_WHALE]]) {
    const tx = new Transaction();
    tx.setSender(sender);
    tx.moveCall({
      target: `${PROTO_PKG}::incentive_v3::claim_reward_entry`,
      typeArguments: [SUI_TYPE],
      arguments: [
        tx.object(CLOCK),
        tx.object(INCENTIVE_V3),
        tx.object(STORAGE),
        tx.pure.u8(0),  // asset 0 (SUI)
      ],
    });
    const r = await client.devInspectTransactionBlock({ transactionBlock: tx, sender });
    const status = r.effects?.status?.status;
    const error = r.effects?.status?.error ?? "";
    console.log(`[${label}]`);
    console.log(`  Status: ${status}`);
    if (status === "success") {
      const retVals = r.results?.[0]?.returnValues ?? [];
      console.log(`  ✅ CALLABLE — return values: ${retVals.length}`);
      // Check if any coins were returned
      const events = r.events ?? [];
      const rewardEvents = events.filter((e: any) => e.type?.includes("RewardClaimed") || e.type?.includes("reward"));
      console.log(`  Reward events: ${rewardEvents.length}`);
      if (rewardEvents.length > 0) console.log(`  Event: ${JSON.stringify(rewardEvents[0]).slice(0, 150)}`);
    } else {
      if (error.includes("EIncorrectVersion") || error.includes("version")) {
        console.log(`  → VERSION GUARD fires`);
      } else {
        const fn = error.match(/function_name: Some\("([^"]+)"\)/)?.[1];
        const code = error.match(/}, (\d+)\)/)?.[1];
        console.log(`  Error fn: ${fn}, code: ${code}`);
        console.log(`  Error: ${error.slice(0, 100)}`);
      }
    }
    console.log();
  }
}

// ─── Step 3: Check if global_index is large (would be historical reward) ──────

async function checkV3GlobalIndex() {
  console.log("=== v3 global_index values (Rule objects) ===\n");

  // Find Rule objects via dynamic fields of AssetPool
  // Need to navigate: INCENTIVE_V3 → AssetPool → Rules table → Rule
  const iv3Obj = await client.getObject({ id: INCENTIVE_V3, options: { showContent: true } });
  const f = (iv3Obj.data?.content as any)?.fields ?? {};
  const pools = f.pools?.fields?.contents ?? [];
  
  // Get first 3 pools
  for (const pool of pools.slice(0, 3)) {
    const poolId = pool?.fields?.value?.fields?.id?.id ?? pool?.fields?.value;
    const coinType = String(pool?.fields?.key ?? "").slice(0, 50);
    if (!poolId || typeof poolId !== "string") continue;
    
    const poolObj = await client.getObject({ id: poolId, options: { showContent: true } });
    const pf = (poolObj.data?.content as any)?.fields ?? {};
    const rulesId = pf.rules?.fields?.id?.id;
    if (!rulesId) continue;
    
    const ruleDFs = await client.getDynamicFields({ parentId: rulesId });
    for (const rdf of ruleDFs.data.slice(0, 2)) {
      const ruleObj = await client.getObject({ id: rdf.objectId, options: { showContent: true } });
      const rf = (ruleObj.data?.content as any)?.fields?.value?.fields ?? 
                 (ruleObj.data?.content as any)?.fields ?? {};
      const globalIdx = rf.global_index ?? "(not found)";
      const userIdxTableId = rf.user_index?.fields?.id?.id;
      
      console.log(`Pool ${coinType.slice(-20)}:`);
      console.log(`  global_index: ${globalIdx}`);
      
      if (userIdxTableId) {
        const userEntries = await client.getDynamicFields({ parentId: userIdxTableId });
        console.log(`  user_index table entries: ${userEntries.data.length}`);
        if (userEntries.data.length > 0) {
          const e = await client.getObject({ id: userEntries.data[0].objectId, options: { showContent: true } });
          const ef = (e.data?.content as any)?.fields ?? {};
          console.log(`  Sample user entry: address=${ef.name?.slice(0,20)}, index=${ef.value}`);
        }
      }
      console.log();
    }
  }
}

async function main() {
  const fn = await inspectV3Rule();
  await testV3Claim(fn);
  await checkV3GlobalIndex();
}

main().catch(console.error);
