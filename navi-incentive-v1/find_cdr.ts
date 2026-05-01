import { SuiClient } from "@mysten/sui/client";

const client = new SuiClient({ url: "https://fullnode.mainnet.sui.io:443" });
const SCALLOP_LATEST = "0xde5c09ad171544aa3724dc67216668c80e754860f419136a68d78504eb2e2805";

async function main() {
  // borrow_entry signature to see what CDR type it expects
  const fn = await client.getNormalizedMoveFunction({
    package: SCALLOP_LATEST, module: "borrow", function: "borrow_entry"
  });
  console.log("borrow_entry params:");
  fn.parameters.forEach((p, i) => {
    const s = JSON.stringify(p);
    const isMut = s.includes("MutableReference");
    const isRef = s.includes("Reference");
    const name = s.match(/"name":"(\w+)"/)?.[1] ?? s.slice(0, 80);
    console.log(`  [${i}]: ${isMut ? "&mut " : isRef ? "& " : ""}${name}`);
  });
  
  // Find CoinDecimalsRegistry from recent Scallop borrow transactions
  const txns = await client.queryTransactionBlocks({
    filter: { MoveFunction: { package: SCALLOP_LATEST, module: "borrow", function: "borrow_entry" } },
    limit: 3,
    order: "descending",
  });
  
  console.log(`\nRecent borrow_entry txns: ${txns.data.length}`);
  for (const txRef of txns.data) {
    const detail = await client.getTransactionBlock({
      digest: txRef.digest,
      options: { showInput: true }
    });
    const prog = (detail.transaction?.data?.transaction as any);
    if (prog?.kind === "ProgrammableTransaction") {
      console.log("\ntx:", txRef.digest.slice(0,20));
      for (const inp of prog.inputs ?? []) {
        if (inp.type === "object") {
          console.log("  object input:", inp.objectId ?? inp.object?.ImmOrOwnedObject?.objectId ?? JSON.stringify(inp).slice(0,80));
        }
      }
    }
  }
}

main().catch(console.error);
