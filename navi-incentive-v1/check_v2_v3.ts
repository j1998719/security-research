import { SuiClient } from "@mysten/sui/client";
import { Transaction } from "@mysten/sui/transactions";

const client = new SuiClient({ url: "https://fullnode.mainnet.sui.io:443" });

// NAVI v2
const V2_PKG       = "0xe66f07e29e47ca9aafe36f66d7c9cbe9d875ecad9ef76e31e17ebfa41efce5a9";
const INCENTIVE_V2 = "0xf87a8acb8b81d14307894d12595541a73f19933f88e1326d5be349c7a6f7559c";

// NAVI v3 / current protocol
const PROTOCOL_PKG = "0xee0041239b89564ce870a7dec5ddc5d114367ab94a1137e90aa0633cb76518e0";
const INCENTIVE_V3 = "0x62982dad27fb10bb314b3384d5de8d2ac2d72ab2dbeae5d801dbdb9efa816c80";
const STORAGE      = "0xbb4e2f4b6205c2e2a2db47aeb4f830796ec7c005f88537ee775986639bc442fe";
const CLOCK        = "0x0000000000000000000000000000000000000000000000000000000000000006";
const DUMMY        = "0x0000000000000000000000000000000000000000000000000000000000001337";
const SUI_TYPE     = "0x2::sui::SUI";

async function checkV2IncentiveBal() {
  console.log("=== [1] NAVI v2 IncentiveBal objects ===");
  // Check the Incentive v2 object
  const obj = await client.getObject({ id: INCENTIVE_V2, options: { showContent: true } });
  const f = (obj.data?.content as any)?.fields ?? {};
  console.log("  IncentiveV2 version field:", f.version ?? "(not found)");
  console.log("  IncentiveV2 type:", obj.data?.type?.slice(0, 60));

  // Check IncentiveFundsPool objects for v2 (mentioned in article: ~$57K stranded)
  // Try to find v2 IncentiveBal objects
  const dynFields = await client.getDynamicFields({ parentId: INCENTIVE_V2 });
  console.log("  v2 dynamic fields count:", dynFields.data.length);
  for (const df of dynFields.data.slice(0, 5)) {
    console.log("   ", df.objectId, df.name);
  }
}

async function testV2ClaimReward() {
  console.log("\n=== [2] v2 claim_reward dry-run (using NAVI whale as account) ===");
  const NAVI_WHALE = "0x7861f12c652dbcf96589413cf5cbc5ebcccd85c2c9f09c25fee76f2a218195c9";

  // Find a v2 IncentiveBal object - we need to search for them
  // From article: v2 IncentiveBal "全部已清零" - but let's verify
  // Try to query for v2 IncentiveBal type objects
  try {
    const tx = new Transaction();
    tx.setSender(DUMMY);
    // Check if v2 claim_reward is callable at all (version guard)
    // We don't have an IncentiveBal address, so this will fail on missing object
    // But the ERROR type will tell us if version guard fires FIRST
    tx.moveCall({
      target: `${V2_PKG}::incentive_v2::claim_reward`,
      typeArguments: [SUI_TYPE],
      arguments: [
        tx.object(INCENTIVE_V2),
        tx.object("0x0000000000000000000000000000000000000000000000000000000000000001"), // fake IncentiveBal
        tx.object(CLOCK),
        tx.object(STORAGE),
        tx.pure.address(NAVI_WHALE),
      ],
    });
    const result = await client.devInspectTransactionBlock({ transactionBlock: tx, sender: DUMMY });
    const status = result.effects?.status;
    console.log("  Status:", status?.status);
    console.log("  Error:", status?.error?.slice(0, 120));
    if (status?.error?.includes("EIncorrectVersion") || status?.error?.includes("version")) {
      console.log("  → VERSION GUARD FIRES FIRST ✓ — v2 claim_reward is blocked");
    } else if (status?.error?.includes("not found") || status?.error?.includes("object")) {
      console.log("  → Object error (got past version check!) — v2 callable if valid IncentiveBal exists");
    }
  } catch(e: any) {
    console.log("  Exception:", e.message?.slice(0, 80));
  }
}

async function checkV3IncentiveIndex() {
  console.log("\n=== [3] v3 incentive_v3 reward index initialization ===");
  // Check the incentive_v3 object state
  const obj = await client.getObject({ id: INCENTIVE_V3, options: { showContent: true } });
  const f = (obj.data?.content as any)?.fields ?? {};
  console.log("  IncentiveV3 type:", obj.data?.type?.slice(0, 80));
  const keys = Object.keys(f).filter(k => k !== "id");
  console.log("  Fields:", keys);

  // Check if v3 has per-user index tracking (would it default to 0?)
  const poolsId = f.pools?.fields?.id?.id ?? f.pool_states?.fields?.id?.id;
  if (poolsId) {
    console.log("  pools table ID:", poolsId);
    const dynFields = await client.getDynamicFields({ parentId: poolsId });
    console.log("  pool count:", dynFields.data.length);
    if (dynFields.data.length > 0) {
      const first = dynFields.data[0];
      const poolObj = await client.getObject({ id: first.objectId, options: { showContent: true } });
      const pf = (poolObj.data?.content as any)?.fields?.value?.fields ?? (poolObj.data?.content as any)?.fields ?? {};
      console.log("  sample pool keys:", Object.keys(pf).slice(0, 12));
      // Look for index tracking per user
      const indexKeys = Object.keys(pf).filter(k => k.includes("index") || k.includes("reward") || k.includes("user"));
      console.log("  index/reward keys:", indexKeys);
    }
  } else {
    console.log("  (no pools table found directly)");
    console.log("  v3 raw fields:", JSON.stringify(f).slice(0, 300));
  }
}

async function testV3ClaimReward() {
  console.log("\n=== [4] v3 claim_reward: does fresh address get historical rewards? ===");
  // Find v3 claim function
  // v3 claim_reward might be in a different module
  // Check what functions exist in incentive_v3 module
  const tx = new Transaction();
  tx.setSender(DUMMY);
  // Try to call v3 claim (need to know exact function name)
  // common names: claim_reward, claim_rewards, harvest
  for (const fnName of ["claim_reward", "claim_rewards", "harvest_reward"]) {
    try {
      const tx2 = new Transaction();
      tx2.setSender(DUMMY);
      tx2.moveCall({
        target: `${PROTOCOL_PKG}::incentive_v3::${fnName}`,
        typeArguments: [SUI_TYPE],
        arguments: [
          tx2.object(INCENTIVE_V3),
          tx2.object(STORAGE),
          tx2.object(CLOCK),
          tx2.pure.u8(0),
          tx2.pure.address(DUMMY),
        ],
      });
      const r = await client.devInspectTransactionBlock({ transactionBlock: tx2, sender: DUMMY });
      console.log(`  ${fnName}: ${r.effects?.status?.status}`);
      if (r.effects?.status?.error) console.log(`    ${r.effects.status.error.slice(0, 100)}`);
    } catch(e: any) {
      if (!e.message?.includes("does not exist")) {
        console.log(`  ${fnName}: error - ${e.message?.slice(0, 60)}`);
      }
    }
  }
}

async function main() {
  await checkV2IncentiveBal();
  await testV2ClaimReward();
  await checkV3IncentiveIndex();
  await testV3ClaimReward();
}

main().catch(console.error);
