import { SuiClient } from "@mysten/sui/client";
const client = new SuiClient({ url: "https://fullnode.mainnet.sui.io:443" });

const NAVI_V1 = "0xd899cf7d2b5db716bd2cf55599fb0d5ee38a3061e7b6bb6eebf73fa5bc4c81ca";
const INCENTIVE_OBJ = "0xaaf735bf83ff564e1b219a0d644de894ef5bdc4b2250b126b2a46dd002331821";

// Known IncentiveBal objects from article
const INCENTIVE_BALS = [
  "0xc34b4c",  // ~536 SUI
  "0xd7c7ad",  // ~484 SUI  
  "0xae3be8",  // ~290 SUI
  "0x0ab6a6",  // ~264 SUI
  "0xdaa7d5",  // ~81 SUI
];

async function main() {
  // 1. Check the main Incentive object state
  console.log("=== NAVI V1 Incentive object ===");
  const inc = await client.getObject({ id: INCENTIVE_OBJ, options: { showContent: true, showType: true } });
  if (inc.error) { console.log("Error:", inc.error); }
  else {
    const f = (inc.data?.content as any)?.fields ?? {};
    console.log("Type:", inc.data?.type?.split("::").pop());
    console.log("Fields:", JSON.stringify(f).slice(0, 300));
  }

  // 2. Query all IncentiveBal objects from V1 package
  console.log("\n=== Querying IncentiveBal objects ===");
  try {
    const resp = await (client as any).transport.request({
      method: "suix_queryObjects",
      params: [{ 
        filter: { StructType: `${NAVI_V1}::incentive::IncentiveBal` }
      }, null, 50, false],
    });
    const objs = resp.data ?? [];
    console.log(`Found ${objs.length} IncentiveBal objects`);
    
    let total = 0n;
    for (const o of objs.slice(0, 10)) {
      const f = o.data?.content?.fields ?? {};
      const remaining = BigInt(f.balance ?? f.distributed_amount ?? "0");
      const totalSupply = BigInt(f.total_supply ?? "0");
      const assetId = f.asset_id ?? "?";
      console.log(`  id=${o.data?.objectId?.slice(0,22)} asset=${assetId} balance=${remaining} total=${totalSupply}`);
      total += remaining;
    }
    console.log(`\nTotal balance in first 10: ${total} MIST = ${Number(total)/1e9} SUI`);
  } catch (e: any) {
    console.log("Query error:", e.message?.slice(0, 100));
    
    // Try alternative type name
    try {
      const resp2 = await (client as any).transport.request({
        method: "suix_queryObjects",
        params: [{ 
          filter: { StructType: `${NAVI_V1}::incentive::IncentiveBal<0x2::sui::SUI>` }
        }, null, 20, false],
      });
      const objs2 = resp2.data ?? [];
      console.log(`Found ${objs2.length} IncentiveBal<SUI> objects`);
      for (const o of objs2.slice(0, 5)) {
        const f = o.data?.content?.fields ?? {};
        console.log(`  id=${o.data?.objectId?.slice(0,22)} fields=${JSON.stringify(f).slice(0,120)}`);
      }
    } catch (e2: any) {
      console.log("Alt query error:", e2.message?.slice(0, 80));
    }
  }

  // 3. Check recent V1 activity (to see if exploit already happened)
  console.log("\n=== Recent V1 claim_reward transactions ===");
  const txs = await client.queryTransactionBlocks({
    filter: { MoveFunction: { package: NAVI_V1, module: "incentive", function: "claim_reward" } },
    options: { showEffects: true },
    limit: 5,
    order: "descending",
  });
  console.log(`Recent claim_reward txs: ${txs.data.length}`);
  for (const tx of txs.data) {
    const status = (tx as any).effects?.status?.status ?? "?";
    console.log(`  ${tx.digest.slice(0,22)} status=${status} ts=${tx.timestampMs}`);
  }
}
main().catch(console.error);
