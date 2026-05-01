import { SuiClient } from "@mysten/sui/client";
const client = new SuiClient({ url: "https://fullnode.mainnet.sui.io:443" });

const INCENTIVE_V3 = "0x62982dad27fb10bb314b3384d5de8d2ac2d72ab2dbeae5d801dbdb9efa816c80";
const V1_PKG = "0xd899cf7d2b5db716bd2cf55599fb0d5ee38a3061e7b6bb6eebf73fa5bc4c81ca";
const SUI_TYPE = "0x2::sui::SUI";

async function main() {
  // INCENTIVE_V3 has a fee_balance Bag. Let's look at the full content first.
  const obj = await client.getObject({ id: INCENTIVE_V3, options: { showContent: true } });
  const f = (obj.data?.content as any)?.fields ?? {};
  console.log("INCENTIVE_V3 top-level fields:");
  for (const [k, v] of Object.entries(f)) {
    const vs = JSON.stringify(v).slice(0, 120);
    console.log(`  ${k}: ${vs}`);
  }

  // fee_balance is a Bag — get its ID and query dynamic fields
  const feeBagId = f.fee_balance?.fields?.id?.id;
  if (feeBagId) {
    console.log(`\nfee_balance Bag id: ${feeBagId}`);
    const bagDFs = await client.getDynamicFields({ parentId: feeBagId });
    console.log(`fee_balance dynamic fields (${bagDFs.data.length}):`);
    for (const df of bagDFs.data.slice(0, 10)) {
      const o = await client.getObject({ id: df.objectId, options: { showContent: true } });
      const t = (o.data?.content as any)?.type ?? "";
      const subf = JSON.stringify((o.data?.content as any)?.fields ?? {}).slice(0, 200);
      console.log(`  type=${t.slice(-70)}`);
      console.log(`  id=${df.objectId}`);
      console.log(`  fields=${subf}\n`);
    }
  }

  // Also try to find RewardFund objects via object type query (RPC)
  console.log("\n=== Querying RewardFund objects via RPC ===");
  const rewardFundType = `${V1_PKG}::incentive_v3::RewardFund<${SUI_TYPE}>`;
  try {
    const resp = await (client as any).transport.request({
      method: "suix_queryObjects",
      params: [{
        filter: { StructType: rewardFundType },
        options: { showContent: true, showType: true }
      }, null, 5, false],
    });
    const objs = resp.data ?? [];
    console.log(`Found ${objs.length} RewardFund<SUI> objects`);
    for (const o of objs.slice(0, 3)) {
      const rf = o.data?.content?.fields ?? {};
      console.log(`  id=${o.data?.objectId?.slice(0,24)}`);
      console.log(`  fields=${JSON.stringify(rf).slice(0,200)}\n`);
    }
  } catch (e: any) {
    console.log("RPC error:", e.message?.slice(0, 100));
  }

  // Try broader search: any object with RewardFund in type
  console.log("\n=== pools field (VecMap) detail ===");
  const pools = f.pools?.fields?.contents ?? [];
  console.log(`pools count: ${pools.length}`);
  if (pools.length > 0) {
    const first = pools[0];
    console.log("First pool entry:", JSON.stringify(first).slice(0, 300));
  }
}
main().catch(console.error);
