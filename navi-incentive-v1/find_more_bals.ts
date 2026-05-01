import { SuiClient } from "@mysten/sui/client";
const client = new SuiClient({ url: "https://fullnode.mainnet.sui.io:443" });

const NAVI_V1 = "0xd899cf7d2b5db716bd2cf55599fb0d5ee38a3061e7b6bb6eebf73fa5bc4c81ca";
const POOL_INFO_ASSET0 = "0xc8f8165bfcda1e3e3ea2e7ef1001726d14c6f3e86318d06ec83c16e2b7ec1316";
const POOL_INFO_ASSET1 = "0x9f187f216d4d550c4d93ad2971f559b314535af533d8cdcb5ae64c50a90657aa";
const POOL_INFO_ASSET2 = "0x413f0cd218330b87a634"; // partial

async function main() {
  // Get all V1 incentive module entry functions
  console.log("=== V1 incentive module functions ===");
  const mods = await client.getNormalizedMoveModulesByPackage({ package: NAVI_V1 });
  const incFns = (mods as any).incentive?.exposedFunctions ?? {};
  for (const [fn, data] of Object.entries(incFns)) {
    const vis = (data as any).isEntry ? "[entry]" : "[pub  ]";
    console.log(`  ${vis} ${fn}`);
  }

  // Check how IncentiveBal objects are created — look at object changes for add_pool
  console.log("\n=== All V1 transactions that create IncentiveBal ===");
  let allTxs: any[] = [];
  let cursor: string | undefined;
  while (true) {
    const r = await client.queryTransactionBlocks({
      filter: { ChangedObject: NAVI_V1 },  // Any tx touching V1 package
      options: { showObjectChanges: true },
      limit: 50, order: "ascending", cursor,
    });
    allTxs = allTxs.concat(r.data);
    if (!r.hasNextPage || !r.nextCursor || allTxs.length > 200) break;
    cursor = r.nextCursor;
  }
  
  const balIds = new Set<string>();
  for (const tx of allTxs) {
    for (const c of (tx.objectChanges ?? []) as any[]) {
      if (c.type === "created" && (c.objectType ?? "").includes("IncentiveBal")) {
        balIds.add(c.objectId);
      }
    }
  }
  console.log(`Found ${balIds.size} IncentiveBal objects across ${allTxs.length} txs`);
  
  // Also try looking for IncentiveBal objects in MoveFunction queries  
  console.log("\n=== Checking all V1 module functions for IncentiveBal creation ===");
  for (const [modName, modData] of Object.entries(mods)) {
    const fns = (modData as any).exposedFunctions ?? {};
    const entries = Object.entries(fns).filter(([_, f]) => (f as any).isEntry);
    if (entries.length > 0) console.log(`  ${modName}: ${entries.map(([n]) => n).join(", ")}`);
  }
  
  // Check PoolInfo asset 0 full content
  console.log("\n=== PoolInfo asset 0 full content ===");
  const pi = await client.getObject({ id: POOL_INFO_ASSET0, options: { showContent: true } });
  const f = (pi.data?.content as any)?.fields ?? {};
  // Show all top-level field keys and sample values
  for (const [k, v] of Object.entries(f)) {
    const vs = JSON.stringify(v).slice(0, 100);
    console.log(`  ${k}: ${vs}`);
  }
}
main().catch(console.error);
