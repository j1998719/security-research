import { SuiClient } from "@mysten/sui/client";
const client = new SuiClient({ url: "https://fullnode.mainnet.sui.io:443" });

const V1_PKG = "0xd899cf7d2b5db716bd2cf55599fb0d5ee38a3061e7b6bb6eebf73fa5bc4c81ca";
const PROTO_PKG = "0xee0041239b89564ce870a7dec5ddc5d114367ab94a1137e90aa0633cb76518e0";
// NAVX coin type (BLUE pool rule reward_coin_type)
const NAVX = "0xa99b8952d4f7d947ea77fe0ecdcc9e5fc0bcab2841d6e2a5aa00c3044e5544b5::navx::NAVX";
const SUI_TYPE = "0x2::sui::SUI";
const DUMMY = "0x0000000000000000000000000000000000000000000000000000000000001337";

async function main() {
  // Try to query for RewardFund objects
  const rewardFundTypeSUI = `${V1_PKG}::incentive_v3::RewardFund<${SUI_TYPE}>`;
  const rewardFundTypeNAVX = `${V1_PKG}::incentive_v3::RewardFund<${NAVX}>`;

  for (const rfType of [rewardFundTypeSUI, rewardFundTypeNAVX]) {
    console.log(`\nQuerying: ${rfType.slice(0, 80)}...`);
    try {
      const resp = await (client as any).transport.request({
        method: "suix_queryObjects",
        params: [{ filter: { StructType: rfType } }, null, 5, false],
      });
      console.log(`  Found: ${resp.data?.length ?? 0} objects`);
      for (const o of (resp.data ?? []).slice(0, 3)) {
        console.log(`  id=${o.data?.objectId} type=${o.data?.type?.slice(-50)}`);
      }
    } catch (e: any) {
      console.log(`  RPC error: ${e.message?.slice(0, 80)}`);
    }
  }

  // Try broader type query without type param
  const baseType = `${V1_PKG}::incentive_v3::RewardFund`;
  console.log(`\nQuerying base type (no type param)...`);
  try {
    const resp = await (client as any).transport.request({
      method: "suix_queryObjects",
      params: [{ filter: { StructType: baseType } }, null, 10, false],
    });
    console.log(`  Found: ${resp.data?.length ?? 0} objects`);
    for (const o of (resp.data ?? []).slice(0, 5)) {
      console.log(`  id=${o.data?.objectId}`);
    }
  } catch (e: any) {
    console.log(`  RPC error: ${e.message?.slice(0, 80)}`);
  }

  // Also: look for NAVI transactions that call create_reward_fund
  // to find object IDs created by this function
  // Search the NAVI whale or admin for recent transactions
  const NAVI_WHALE = "0x7861f12c652dbcf96589413cf5cbc5ebcccd85c2c9f09c25fee76f2a218195c9";
  console.log("\n=== NAVI whale owned objects ===");
  const owned = await client.getOwnedObjects({
    owner: NAVI_WHALE,
    options: { showType: true },
    filter: { Package: V1_PKG },
  });
  console.log(`  Objects from V1_PKG: ${owned.data.length}`);
  for (const o of owned.data.slice(0, 5)) {
    console.log(`  id=${o.data?.objectId} type=${String(o.data?.type).slice(-60)}`);
  }

  // Try PROTO_PKG
  const owned2 = await client.getOwnedObjects({
    owner: NAVI_WHALE,
    options: { showType: true },
    filter: { Package: PROTO_PKG },
  });
  console.log(`  Objects from PROTO_PKG: ${owned2.data.length}`);
  for (const o of owned2.data.slice(0, 5)) {
    console.log(`  id=${o.data?.objectId} type=${String(o.data?.type).slice(-60)}`);
  }

  // Check BLUE Rule's actual ID is an object
  const BLUE_RULE_ID = "0x48a9d53c9bac92d21754af7ead5cce6c528b11a329bc9b6d24198984c99614c9";
  const ruleObj = await client.getObject({ id: BLUE_RULE_ID, options: { showContent: true, showType: true, showOwner: true } });
  console.log("\n=== BLUE Rule object (is it shared?) ===");
  console.log("type:", ruleObj.data?.type?.slice(0, 80));
  console.log("owner:", JSON.stringify(ruleObj.data?.owner).slice(0, 100));

  // Is the rule INSIDE the INCENTIVE_V3 object (i.e., not a standalone shareable object)?
  // Let's check the AssetPool ID from BLUE pool
  const INCENTIVE_V3 = "0x62982dad27fb10bb314b3384d5de8d2ac2d72ab2dbeae5d801dbdb9efa816c80";
  const iv3Obj = await client.getObject({ id: INCENTIVE_V3, options: { showContent: true } });
  const pools = (iv3Obj.data?.content as any)?.fields?.pools?.fields?.contents ?? [];
  const bluePool = pools.find((p: any) => String(p?.fields?.key ?? "").startsWith("e1b45a0e"));
  if (bluePool) {
    const apId = bluePool?.fields?.value?.fields?.id?.id;
    console.log("\nBLUE AssetPool id:", apId);
    // Check if the AssetPool is a separate object
    if (apId) {
      const apObj = await client.getObject({ id: apId, options: { showType: true, showOwner: true } });
      console.log("AssetPool type:", apObj.data?.type?.slice(0, 80));
      console.log("AssetPool owner:", JSON.stringify(apObj.data?.owner).slice(0, 80));
    }
  }
}
main().catch(console.error);
