import { SuiClient } from "@mysten/sui/client";
const client = new SuiClient({ url: "https://fullnode.mainnet.sui.io:443" });

const INCENTIVE_V3 = "0x62982dad27fb10bb314b3384d5de8d2ac2d72ab2dbeae5d801dbdb9efa816c80";
const FEE_BAG = "0xe4b4d89da5071d1f736f02bc85725aa7d217e6ca38b3c5deea7d7f0a7db64368";
const V1_PKG = "0xd899cf7d2b5db716bd2cf55599fb0d5ee38a3061e7b6bb6eebf73fa5bc4c81ca";
const SUI_TYPE = "0x2::sui::SUI";

async function main() {
  // The fee_balance Bag entries — check one full entry
  const bagDFs = await client.getDynamicFields({ parentId: FEE_BAG });
  console.log(`fee_balance Bag entries: ${bagDFs.data.length}`);

  // Look at the FIRST entry in full detail
  const firstDf = bagDFs.data[0];
  const firstObj = await client.getObject({ id: firstDf.objectId, options: { showContent: true, showType: true } });
  console.log("\n=== First fee_balance entry (FULL) ===");
  console.log(JSON.stringify(firstObj.data?.content, null, 2).slice(0, 1000));

  // The name field has a TypeName — we need to find the SUI entry
  // TypeName for SUI would contain the SUI coin address
  // Let's check if any entry's type contains "sui::SUI"
  console.log("\n=== Scanning for SUI entry ===");
  for (const df of bagDFs.data) {
    const obj = await client.getObject({ id: df.objectId, options: { showContent: true } });
    const nameStr = JSON.stringify((obj.data?.content as any)?.fields?.name ?? "");
    if (nameStr.toLowerCase().includes("sui") || nameStr.includes("0000000000000000000000000000000000000000000000000000000000000002")) {
      console.log("FOUND SUI entry!");
      console.log("  id:", df.objectId);
      console.log("  full content:", JSON.stringify(obj.data?.content, null, 2).slice(0, 800));
      break;
    }
  }

  // Also check how AssetPool is structured via pools
  const iv3Obj = await client.getObject({ id: INCENTIVE_V3, options: { showContent: true } });
  const f = (iv3Obj.data?.content as any)?.fields ?? {};
  const pools = f.pools?.fields?.contents ?? [];

  // Find SUI pool
  console.log("\n=== SUI AssetPool ===");
  for (const pool of pools) {
    const key = String(pool?.fields?.key ?? "");
    if (key.includes("::sui::SUI") || key === "0000000000000000000000000000000000000000000000000000000000000002::sui::SUI") {
      console.log("SUI pool found, key:", key);
      const val = pool?.fields?.value;
      console.log("AssetPool content:", JSON.stringify(val, null, 2).slice(0, 600));

      // See if there's a reward_fund or rules field
      const valFields = val?.fields ?? {};
      for (const [k, v] of Object.entries(valFields)) {
        console.log(`  ${k}: ${JSON.stringify(v).slice(0, 100)}`);
      }
      break;
    }
  }
  console.log("Pool keys (first 5):", pools.slice(0, 5).map((p: any) => p?.fields?.key?.slice(0, 50)));
}
main().catch(console.error);
