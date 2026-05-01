import { SuiClient } from "@mysten/sui/client";
const client = new SuiClient({ url: "https://fullnode.mainnet.sui.io:443" });

const INCENTIVE_V3 = "0x62982dad27fb10bb314b3384d5de8d2ac2d72ab2dbeae5d801dbdb9efa816c80";
const PROTO_PKG = "0xee0041239b89564ce870a7dec5ddc5d114367ab94a1137e90aa0633cb76518e0";

async function main() {
  // Get all AssetPools and check how many have rules
  const iv3Obj = await client.getObject({ id: INCENTIVE_V3, options: { showContent: true } });
  const f = (iv3Obj.data?.content as any)?.fields ?? {};
  const pools = f.pools?.fields?.contents ?? [];
  console.log(`Total pools: ${pools.length}`);

  let totalRules = 0;
  for (const pool of pools) {
    const key = String(pool?.fields?.key ?? "").slice(0, 50);
    const val = pool?.fields?.value?.fields ?? {};
    const rules = val.rules?.fields?.contents ?? [];
    if (rules.length > 0) {
      console.log(`\nPool ${key}: ${rules.length} rules`);
      totalRules += rules.length;
      for (const r of rules.slice(0, 2)) {
        const ruleAddr = r?.fields?.key;
        const ruleVal = r?.fields?.value?.fields ?? {};
        console.log(`  Rule addr: ${ruleAddr}`);
        console.log(`  global_index: ${ruleVal.global_index}`);
        const uIdx = ruleVal.user_index?.fields?.id?.id;
        if (uIdx) {
          const entries = await client.getDynamicFields({ parentId: uIdx });
          console.log(`  user_index entries: ${entries.data.length}`);
        }
        const rb = ruleVal.reward_balance?.fields;
        if (rb) console.log(`  reward_balance: ${JSON.stringify(rb).slice(0, 80)}`);
      }
    }
  }
  console.log(`\nTotal rules across all pools: ${totalRules}`);

  // Get RewardFund struct full definition from PROTO_PKG
  const rfStruct = await client.getNormalizedMoveStruct({ package: PROTO_PKG, module: "incentive_v3", struct: "RewardFund" });
  console.log("\nRewardFund struct fields:");
  for (const field of rfStruct.fields) {
    console.log(`  ${field.name}: ${JSON.stringify(field.type).slice(0, 100)}`);
  }
  console.log("abilities:", rfStruct.abilities.abilities);

  // The claim_reward_entry fn - what's param[1] Incentive address?
  const fn = await client.getNormalizedMoveFunction({ package: PROTO_PKG, module: "incentive_v3", function: "claim_reward_entry" });
  const incentiveParam = fn.parameters[1];
  const incentivePkg = (incentiveParam as any)?.MutableReference?.Struct?.address ?? "unknown";
  console.log(`\nclaim_reward_entry Incentive type pkg: ${incentivePkg}`);
  console.log(`INCENTIVE_V3 object pkg: ${INCENTIVE_V3}`);
  console.log(`Are they same? ${incentivePkg === INCENTIVE_V3}`);

  // Check if any RewardFund objects exist (search via type)
  console.log("\n=== Checking INCENTIVE_V3 object type ===");
  const iv3Type = iv3Obj.data?.type ?? "";
  console.log("INCENTIVE_V3 type:", iv3Type);

  // What package is the Incentive object from?
  const iv3PkgInType = iv3Type.match(/^(0x[0-9a-f]+)::/)?.[1] ?? "unknown";
  console.log("INCENTIVE_V3 package in type:", iv3PkgInType);
  console.log("claim_reward_entry expects Incentive from:", incentivePkg);
  console.log("MATCH?", iv3PkgInType === incentivePkg);
}
main().catch(console.error);
