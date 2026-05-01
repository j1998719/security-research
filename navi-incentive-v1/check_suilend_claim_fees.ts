import { SuiClient } from "@mysten/sui/client";
import { Transaction } from "@mysten/sui/transactions";
const client = new SuiClient({ url: "https://fullnode.mainnet.sui.io:443" });

const PKG = "0xf95b06141ed4a174f239417323bde3f209b972f5930d8521ea38a52aff3a6ddf";
const DUMMY = "0x0000000000000000000000000000000000000000000000000000000000001337";

async function main() {
  console.log("=== Suilend claim_fees dry-run ===\n");

  // Find a LendingMarket object
  console.log("--- Finding LendingMarket objects ---");
  let lendingMarketId = "";
  
  // Try to find via events
  try {
    const evts = await client.queryEvents({
      query: { MoveEventModule: { package: PKG, module: "lending_market" } },
      limit: 5, order: "descending",
    });
    console.log(`lending_market events: ${evts.data.length}`);
    for (const e of evts.data.slice(0, 2)) {
      const pj = e.parsedJson as any ?? {};
      console.log(`  ${e.type?.split("::").pop()}: ${JSON.stringify(pj).slice(0,100)}`);
      if (pj.lending_market_id) lendingMarketId = pj.lending_market_id;
    }
  } catch (e: any) { console.log("Events error:", e.message?.slice(0,60)); }

  // Try to find via object type
  if (!lendingMarketId) {
    try {
      // Try with type argument
      for (const typeArg of ["<0x2::sui::SUI>", ""]) {
        const resp = await (client as any).transport.request({
          method: "suix_getOwnedObjects",
          params: [DUMMY, { filter: { StructType: `${PKG}::lending_market::LendingMarket${typeArg}` } }, null, 2],
        });
        const objs = (resp.data ?? []);
        if (objs.length > 0) {
          lendingMarketId = objs[0].data?.objectId;
          console.log(`Found LendingMarket${typeArg}: ${lendingMarketId}`);
          break;
        }
      }
    } catch {}
    
    // Try known Suilend LendingMarket ID from Suilend docs/SDK
    // The main SUI LendingMarket on Suilend
    const knownIds = [
      "0x84030d26d85eaa7035084a057f2f11f701b7e2e4eda87551becbc7c97505ead",
      "0xb2fda3d28b7e80afac93c2a1db6f12e1a0a9c3c0f3d3b7b2a7c7a7a7a7a7a7a",
    ];
    for (const id of knownIds) {
      try {
        const obj = await client.getObject({ id, options: { showType: true } });
        if (obj.data?.type?.includes("LendingMarket")) {
          lendingMarketId = id;
          console.log(`Known LendingMarket found: ${id.slice(0,24)}`);
          break;
        }
      } catch {}
    }
  }

  if (!lendingMarketId) {
    console.log("❌ Could not find LendingMarket object ID");
    console.log("Trying dry-run with placeholder...");
    // Try with a random ID to see if we get an access error or authorization error
    lendingMarketId = "0x84030d26d85eaa7035084a057f2f11f701b7e2e4eda87551becbc7c97505ead";
  }

  // Dry-run: claim_fees(LendingMarket, u64, TxContext)
  console.log(`\n--- Dry-run claim_fees with LendingMarket: ${lendingMarketId?.slice(0,24)} ---`);
  try {
    const tx = new Transaction();
    tx.moveCall({
      target: `${PKG}::lending_market::claim_fees`,
      arguments: [
        tx.object(lendingMarketId),
        tx.pure.u64(0), // reserve index 0
      ],
    });
    const result = await client.devInspectTransactionBlock({
      transactionBlock: tx,
      sender: DUMMY,
    });
    console.log(`Status: ${result.effects.status.status}`);
    if (result.effects.status.error) {
      console.log(`Error: ${result.effects.status.error?.slice(0,300)}`);
      // Check if it's auth error vs object not found
      if (result.effects.status.error.includes("PrivativeFunction") || 
          result.effects.status.error.includes("VMVerification") ||
          result.effects.status.error.includes("cannot be called")) {
        console.log("→ Function is truly private (not callable externally)");
      } else if (result.effects.status.error.includes("unauthorized") ||
                 result.effects.status.error.includes("ENotSuilendOwner")) {
        console.log("→ Auth check failed (accessible but unauthorized)");
      }
    } else {
      console.log("✅ claim_fees executed!");
      const mutated = result.effects.mutatedObjects ?? [];
      console.log(`mutatedObjects: ${mutated.length}`);
      // What was returned?
      const retVals = result.results?.[0]?.returnValues;
      console.log(`Returns: ${JSON.stringify(retVals)?.slice(0,100)}`);
    }
  } catch (e: any) { console.log("Dry-run error:", e.message?.slice(0,100)); }

  // Also verify: can we even add claim_fees to PTB?
  console.log("\n--- Test: is claim_fees reachable from PTB at all? ---");
  console.log("In Sui Move:");
  console.log("  'entry fun' (no public) = entry point only for transactions");
  console.log("  'public entry fun' = entry point + callable from other modules");
  console.log("  'fun' (no modifiers) = private, not callable at all externally");
  console.log("\n  The SDK shows visibility=Private, isEntry=true");
  console.log("  → 'private entry' is NOT standard in Move spec");
  console.log("  → Likely means 'entry fun' with default visibility (module-private)");
  console.log("  → entry fun (non-public) CAN be called from user transactions");
  console.log("  → But cannot be called from other modules in same PTB");
}
main().catch(console.error);
