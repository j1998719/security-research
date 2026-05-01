import { SuiClient } from "@mysten/sui/client";

const client = new SuiClient({ url: "https://fullnode.mainnet.sui.io:443" });
const SCALLOP_ORIG = "0xefe8b36d5b2e43728cc323298626b83177803521d195cfb11e15b910e892fddf";

async function main() {
  // Try querying borrow from original package (which has most history)
  const txns = await client.queryTransactionBlocks({
    filter: { MoveFunction: { package: SCALLOP_ORIG, module: "borrow", function: "borrow_entry" } },
    limit: 3,
    order: "descending",
  });
  
  console.log(`Recent borrow_entry txns from orig pkg: ${txns.data.length}`);
  
  // Try borrow module
  for (const txRef of txns.data) {
    const detail = await client.getTransactionBlock({
      digest: txRef.digest,
      options: { showInput: true }
    });
    const prog = (detail.transaction?.data?.transaction as any);
    if (prog?.kind === "ProgrammableTransaction") {
      const objects: string[] = [];
      for (const inp of prog.inputs ?? []) {
        if (inp.type === "object") {
          const id = inp.objectId ?? inp.object?.ImmOrOwnedObject?.objectId ?? inp.object?.SharedObject?.objectId;
          if (id) objects.push(id);
        }
      }
      console.log(`tx ${txRef.digest.slice(0,20)} objects: ${objects.join(", ")}`);
      
      // The CoinDecimalsRegistry is typically an immutable object
      // Let's check each object
      for (const id of objects) {
        const obj = await client.getObject({ id, options: { showContent: false, showOwner: true } });
        const owner = (obj.data?.owner as any);
        if (owner?.Immutable !== undefined || owner === "Immutable") {
          console.log(`  Immutable object (potential CDR): ${id}`);
        }
      }
    }
  }
  
  // Alternative: query by the CoinDecimalsRegistry type
  const objs = await client.queryObjects({
    filter: { StructType: `${SCALLOP_ORIG}::coin_decimals_registry::CoinDecimalsRegistry` },
    options: { showContent: false },
  });
  console.log("\nCoinDecimalsRegistry objects:", objs.data.length);
  for (const o of objs.data) {
    console.log("  id:", o.data?.objectId, "owner:", JSON.stringify(o.data?.owner).slice(0,50));
  }
}

main().catch(console.error);
