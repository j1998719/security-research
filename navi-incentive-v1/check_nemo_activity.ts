import { SuiClient } from "@mysten/sui/client";
const client = new SuiClient({ url: "https://fullnode.mainnet.sui.io:443" });

const NEMO = "0x2b71664477755b90f9fb71c9c944d5d0d3832fec969260e3f18efc7d855f57c4";
const PY_STATE = "0xc6840365f500bee8732a3a256344a11343936b864c144b7e9de5bb8c54224fbe";

async function main() {
  // 1. Recent transactions on Nemo package
  console.log("=== Recent Nemo package txs ===");
  try {
    const txs = await client.queryTransactionBlocks({
      filter: { MoveFunction: { package: NEMO } },
      limit: 10,
      order: "descending",
      options: { showInput: true },
    });
    console.log(`Recent txs: ${txs.data.length}`);
    for (const tx of txs.data.slice(0, 5)) {
      const calls = (tx.transaction?.data?.transaction as any)?.transactions ?? [];
      const nemoCalls = calls.filter((c: any) => c.MoveCall?.package === NEMO).map((c: any) => `${c.MoveCall.module}::${c.MoveCall.function}`);
      console.log(`  ${tx.digest.slice(0,20)}: [${nemoCalls.join(",")}]`);
    }
  } catch (e: any) { console.log("Error:", e.message?.slice(0,60)); }

  // 2. Check if there's a NEWER Nemo package via events
  console.log("\n=== Finding current Nemo package via events ===");
  try {
    // Look for recent PyState mutations
    const events = await client.queryEvents({
      query: { MoveEventModule: { package: NEMO, module: "py" } },
      limit: 5,
      order: "descending",
    });
    console.log(`Recent py events: ${events.data.length}`);
    for (const e of events.data.slice(0, 3)) {
      console.log(`  ${e.type?.split("::").pop()} @ tx=${e.id.txDigest.slice(0,20)}`);
    }
  } catch (e: any) { console.log("Error:", e.message?.slice(0,60)); }
  
  // 3. Find what Nemo package is CURRENTLY being used (not the old commented one)
  // Look at recent PyState tx history
  console.log("\n=== PyState recent mutations (last 5 txs) ===");
  try {
    // Query objects that mutated PyState
    const txs2 = await client.queryTransactionBlocks({
      filter: { ChangedObject: PY_STATE },
      limit: 5,
      order: "descending",
      options: { showInput: true },
    });
    console.log(`PyState mutation txs: ${txs2.data.length}`);
    for (const tx of txs2.data) {
      const calls = (tx.transaction?.data?.transaction as any)?.transactions ?? [];
      const pkgs = new Set(calls.filter((c: any) => c.MoveCall?.package).map((c: any) => c.MoveCall.package));
      console.log(`  tx=${tx.digest.slice(0,20)} packages=${Array.from(pkgs).map((p: any) => p.slice(0,20)).join(",")}`);
    }
  } catch (e: any) { console.log("Error:", e.message?.slice(0,60)); }

  // 4. Is py::borrow_pt_amount/sy::borrow still callable? (exploit path)
  // Try dry-run with correct type argument
  // First find a PyState of type X - the type arg is the SY token type
  console.log("\n=== PyState type argument ===");
  try {
    const obj = await client.getObject({ id: PY_STATE, options: { showType: true } });
    const typeStr = obj.data?.type ?? "";
    console.log(`Full type: ${typeStr.slice(0, 200)}`);
    // Extract type argument
    const typeArg = typeStr.match(/<(.+)>/)?.[1];
    console.log(`Type arg: ${typeArg?.slice(0,80)}`);
  } catch (e: any) { console.log("Error:", e.message?.slice(0,60)); }
}
main().catch(console.error);
