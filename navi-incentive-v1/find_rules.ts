import { SuiClient } from "@mysten/sui/client";
const client = new SuiClient({ url: "https://fullnode.mainnet.sui.io:443" });

const INCENTIVE_V3 = "0x62982dad27fb10bb314b3384d5de8d2ac2d72ab2dbeae5d801dbdb9efa816c80";
const SUI_POOL_ID = "0xd853f96edb076b383b20dd450f163797099eafac0c9b320ea9bbc2cb2ec529c7";
const V1_PKG = "0xd899cf7d2b5db716bd2cf55599fb0d5ee38a3061e7b6bb6eebf73fa5bc4c81ca";
const PROTO_PKG = "0xee0041239b89564ce870a7dec5ddc5d114367ab94a1137e90aa0633cb76518e0";
const SUI_TYPE = "0x2::sui::SUI";
const DUMMY = "0x0000000000000000000000000000000000000000000000000000000000001337";
const NAVI_WHALE = "0x7861f12c652dbcf96589413cf5cbc5ebcccd85c2c9f09c25fee76f2a218195c9";

async function main() {
  // Get SUI AssetPool full content including rules
  const poolObj = await client.getObject({ id: SUI_POOL_ID, options: { showContent: true } });
  const pf = (poolObj.data?.content as any)?.fields ?? {};
  const rules = pf.rules?.fields?.contents ?? [];
  console.log(`SUI AssetPool rules (${rules.length} entries):`);
  for (const r of rules) {
    const ruleAddr = r?.fields?.key;
    const ruleVal = r?.fields?.value?.fields ?? {};
    console.log(`  Rule key (address): ${ruleAddr}`);
    console.log(`  Rule fields: global_index=${ruleVal.global_index}`);
    console.log(`  reward_balance: ${JSON.stringify(ruleVal.reward_balance ?? "N/A").slice(0, 100)}`);

    // Check user_index table
    const userIdxId = ruleVal.user_index?.fields?.id?.id;
    const userTotalId = ruleVal.user_total_rewards?.fields?.id?.id;
    const userClaimedId = ruleVal.user_rewards_claimed?.fields?.id?.id;
    console.log(`  user_index table id: ${userIdxId}`);
    if (userIdxId) {
      const entries = await client.getDynamicFields({ parentId: userIdxId });
      console.log(`  user_index entries: ${entries.data.length}`);
      if (entries.data.length > 0) {
        const sampleEntry = await client.getObject({ id: entries.data[0].objectId, options: { showContent: true } });
        const ef = (sampleEntry.data?.content as any)?.fields ?? {};
        console.log(`  Sample: addr=${String(ef.name).slice(0,20)} val=${ef.value}`);
      }
    }
    console.log();
  }

  // Now look for RewardFund — check if it's in the AssetPool's dynamic fields
  console.log("=== SUI_POOL_ID dynamic fields ===");
  const poolDFs = await client.getDynamicFields({ parentId: SUI_POOL_ID });
  console.log(`SUI Pool dynamic fields: ${poolDFs.data.length}`);
  for (const df of poolDFs.data) {
    const obj = await client.getObject({ id: df.objectId, options: { showContent: true, showType: true } });
    const t = obj.data?.type ?? "";
    console.log(`  type=${t.slice(-80)}, id=${df.objectId.slice(0,24)}`);
  }

  // Look at INCENTIVE_V3 object type to understand the type hierarchy
  const iv3 = await client.getObject({ id: INCENTIVE_V3, options: { showContent: true, showType: true } });
  console.log("\nINCENTIVE_V3 object type:", iv3.data?.type?.slice(0, 120));

  // Try getNormalizedMoveStruct for RewardFund to understand it
  try {
    const rewardFundStruct = await client.getNormalizedMoveStruct({ package: V1_PKG, module: "incentive_v3", struct: "RewardFund" });
    console.log("\nRewardFund struct:", JSON.stringify(rewardFundStruct, null, 2).slice(0, 500));
  } catch (e: any) {
    console.log("RewardFund struct error:", e.message?.slice(0, 100));
    // Try the current package
    try {
      const rf2 = await client.getNormalizedMoveStruct({ package: PROTO_PKG, module: "incentive_v3", struct: "RewardFund" });
      console.log("RewardFund (PROTO_PKG):", JSON.stringify(rf2, null, 2).slice(0, 500));
    } catch (e2: any) {
      console.log("Error2:", e2.message?.slice(0, 100));
    }
  }
}
main().catch(console.error);
