import { SuiClient } from "@mysten/sui/client";
const client = new SuiClient({ url: "https://fullnode.mainnet.sui.io:443" });

const POOLS_TABLE = "0x0ebae351150474aa81540f08261bfd46ba0fc5fd598777711bb0b4a2b9ce3e21";
const NAVI_V1 = "0xd899cf7d2b5db716bd2cf55599fb0d5ee38a3061e7b6bb6eebf73fa5bc4c81ca";

async function main() {
  // Check for all add_pool txs (full pagination)
  let all: any[] = [];
  let cursor: string | undefined;
  while (true) {
    const r = await client.queryTransactionBlocks({
      filter: { MoveFunction: { package: NAVI_V1, module: "incentive", function: "add_pool" } },
      options: { showObjectChanges: true, showInput: true },
      limit: 50, order: "ascending", cursor,
    });
    all = all.concat(r.data);
    if (!r.hasNextPage || !r.nextCursor) break;
    cursor = r.nextCursor;
  }
  console.log(`Total add_pool txs: ${all.length}`);
  
  // Extract both IncentiveBal and PoolInfo IDs
  for (const tx of all) {
    for (const c of (tx.objectChanges ?? []) as any[]) {
      if (c.type === "created") {
        const type = c.objectType ?? "";
        if (type.includes("IncentiveBal") || type.includes("PoolInfo")) {
          console.log(`  ${c.type} ${type.split("::").pop()} id=${c.objectId}`);
        }
      }
    }
  }
  
  // Also check PoolInfo dynamic fields to find IncentiveBal IDs stored there
  console.log("\n=== PoolInfo dynamic fields for asset 0 ===");
  try {
    const df = await client.getDynamicFieldObject({
      parentId: POOLS_TABLE, name: { type: "u8", value: "0" },
    });
    const dfFields = await client.getDynamicFields({ 
      parentId: (df.data?.content as any)?.fields?.id?.id ?? df.data?.objectId ?? ""
    });
    console.log(`PoolInfo[asset=0] dynamic fields: ${dfFields.data.length}`);
    for (const f of dfFields.data.slice(0, 5)) {
      console.log(`  ${JSON.stringify(f.name)} → ${f.objectType?.slice(-30)}`);
    }
  } catch (e: any) { console.log("Error:", e.message?.slice(0,80)); }

  // What if IncentiveBal IDs are stored as dynamic fields of the IncentiveV1 Table?
  console.log("\n=== Checking PoolsTable entries ===");
  const poolsParent = await client.getDynamicFields({ parentId: POOLS_TABLE });
  console.log(`Entries: ${poolsParent.data.length}`);
  for (const f of poolsParent.data) {
    console.log(`  key=${JSON.stringify(f.name.value)} type=${f.objectType?.split("::").pop()} id=${f.objectId?.slice(0,22)}`);
  }
}
main().catch(console.error);
