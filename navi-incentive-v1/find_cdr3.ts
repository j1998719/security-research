import { SuiClient } from "@mysten/sui/client";

const client = new SuiClient({ url: "https://fullnode.mainnet.sui.io:443" });
const SCALLOP_ORIG   = "0xefe8b36d5b2e43728cc323298626b83177803521d195cfb11e15b910e892fddf";
const SCALLOP_LATEST = "0xde5c09ad171544aa3724dc67216668c80e754860f419136a68d78504eb2e2805";
const MARKET_OBJ     = "0xa757975255146dc9686aa823b7838b507f315d704f428cbadad2f4ea061939d9";

async function main() {
  // The CoinDecimalsRegistry is created at protocol initialization
  // It's usually an immutable shared object
  // Let's look at the first transactions for the Scallop package to find it
  
  // Get txns by package with older timestamp (ascending order = first txns)
  const txns = await client.queryTransactionBlocks({
    filter: { MoveFunction: { package: SCALLOP_ORIG } },
    limit: 5,
    order: "ascending",
  });
  console.log("First txns for SCALLOP_ORIG:", txns.data.length);
  
  for (const txRef of txns.data) {
    const detail = await client.getTransactionBlock({
      digest: txRef.digest,
      options: { showObjectChanges: true }
    });
    for (const ch of detail.objectChanges ?? []) {
      const objType = (ch as any).objectType ?? "";
      if (objType.includes("CoinDecimalsRegistry")) {
        console.log("Found CoinDecimalsRegistry:", ch);
      }
    }
    // Also check all created objects
    const created = (detail.objectChanges ?? []).filter((c: any) => c.type === "created");
    if (created.length > 0) {
      console.log(`  tx ${txRef.digest.slice(0,20)} created:`, 
        created.map((c: any) => `${c.objectId}[${c.objectType?.split("::").pop() ?? "?"}]`).join(", "));
    }
  }
  
  // Check the Market object's dynamic fields for CDR reference
  const COIN_DECIMALS_MODULE = "coin_decimals_registry";
  
  // Try to find CDR via suix_getOwnedObjects
  const cdrs = await client.getOwnedObjects({
    owner: "0x0000000000000000000000000000000000000000000000000000000000000000", // shared
    filter: {
      StructType: `${SCALLOP_ORIG}::${COIN_DECIMALS_MODULE}::CoinDecimalsRegistry`
    },
    limit: 5
  });
  console.log("CDR via getOwnedObjects (shared addr):", cdrs.data.length);
  
  // Try GetDynamicFields on market to find CDR
  const dynFields = await client.getDynamicFields({ parentId: MARKET_OBJ, limit: 5 });
  console.log("\nMarket dynamic fields:", dynFields.data.length);
  for (const f of dynFields.data) {
    console.log("  ", f.objectType?.slice(0, 80), f.objectId);
  }
}

main().catch(console.error);
