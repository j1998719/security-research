import { SuiClient } from "@mysten/sui/client";
const client = new SuiClient({ url: "https://fullnode.mainnet.sui.io:443" });

const NAVI_V1 = "0xd899cf7d2b5db716bd2cf55599fb0d5ee38a3061e7b6bb6eebf73fa5bc4c81ca";
const INCENTIVE_OBJ = "0xaaf735bf83ff564e1b219a0d644de894ef5bdc4b2250b126b2a46dd002331821";

async function main() {
  // 1. Read all dynamic fields of the Incentive object to find IncentiveBal references
  console.log("=== Dynamic fields of Incentive object ===");
  const fields = await client.getDynamicFields({ parentId: INCENTIVE_OBJ });
  console.log(`Dynamic fields: ${fields.data.length}`);
  for (const f of fields.data.slice(0, 10)) {
    console.log(`  name=${JSON.stringify(f.name).slice(0,60)} type=${f.objectType?.slice(-40) ?? "?"}  id=${f.objectId?.slice(0,22)}`);
  }

  // 2. Query pool objects within Incentive
  console.log("\n=== Incentive full content ===");
  const inc = await client.getObject({ id: INCENTIVE_OBJ, options: { showContent: true } });
  const fields2 = (inc.data?.content as any)?.fields ?? {};
  const pools = fields2.pools ?? fields2.incentive_pools ?? fields2.pool_infos ?? [];
  console.log("pools type:", typeof pools, Array.isArray(pools) ? pools.length : JSON.stringify(pools).slice(0,100));
  
  // 3. Query V1 events to find IncentiveBal creation events
  console.log("\n=== V1 events (all modules) ===");
  for (const modName of ["incentive", "pool"]) {
    const evts = await client.queryEvents({
      query: { MoveEventModule: { package: NAVI_V1, module: modName } },
      limit: 5,
      order: "descending",
    });
    if (evts.data.length > 0) {
      console.log(`\n${modName} events (${evts.data.length}):`);
      for (const e of evts.data.slice(0, 3)) {
        console.log(`  ${e.type?.split("::").pop()} tx=${e.id.txDigest.slice(0,20)}`);
        const pj = JSON.stringify(e.parsedJson ?? {});
        console.log(`  ${pj.slice(0, 200)}`);
      }
    }
  }

  // 4. Search for IncentiveBal object IDs by checking a known TX
  // First find an old TX that used V1
  console.log("\n=== Finding old V1 transactions ===");
  const oldTxs = await client.queryTransactionBlocks({
    filter: { MoveFunction: { package: NAVI_V1, module: "incentive" } },
    options: { showInput: true, showObjectChanges: true },
    limit: 5,
    order: "ascending",  // oldest first
  });
  console.log(`Oldest V1 incentive txs: ${oldTxs.data.length}`);
  for (const tx of oldTxs.data) {
    const changes = tx.objectChanges ?? [];
    for (const c of changes) {
      const ct = (c as any).objectType ?? "";
      if (ct.includes("IncentiveBal")) {
        console.log(`  IncentiveBal: id=${(c as any).objectId?.slice(0,26)} type=${ct.slice(-40)}`);
      }
    }
  }
  
  // 5. Check recent V1 add_pool transactions to find pool objects
  const addPoolTxs = await client.queryTransactionBlocks({
    filter: { MoveFunction: { package: NAVI_V1, module: "incentive", function: "add_pool" } },
    options: { showObjectChanges: true },
    limit: 10,
    order: "ascending",
  });
  console.log(`\nadd_pool txs: ${addPoolTxs.data.length}`);
  for (const tx of addPoolTxs.data) {
    const changes = tx.objectChanges ?? [];
    for (const c of changes) {
      const ct = (c as any).objectType ?? "";
      if (ct.includes("ncentive") || ct.includes("Bal")) {
        console.log(`  ${(c as any).type} id=${(c as any).objectId?.slice(0,26)} type=${ct.split("::").pop()}`);
      }
    }
  }
}
main().catch(console.error);
