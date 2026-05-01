/**
 * Find the OLD (pre-patch) Nemo package from before September 2025
 * The current patched package is 0x2b71664...
 * The vulnerable one would be earlier
 */
import { SuiClient } from "@mysten/sui/client";
const client = new SuiClient({ url: "https://fullnode.mainnet.sui.io:443" });

const CURRENT_NEMO = "0x2b71664477755b90f9fb71c9c944d5d0d3832fec969260e3f18efc7d855f57c4";
const PY_STATE = "0xc6840365f500bee8732a3a256344a11343936b864c144b7e9de5bb8c54224fbe";
const MARKET_STATE = "0x7472959314b24ebfbd4da49cc36abb3da29f722746019c692407aaf6b47e9a08";

async function main() {
  // 1. Find the original deployment of PyState (creation tx)
  // PyState was created at initial_shared_version: 497676326
  console.log("=== Finding original Nemo package deployment ===\n");

  // Get the transaction that created PyState
  try {
    // Query transactions that created objects near that checkpoint
    const txs = await client.queryTransactionBlocks({
      filter: { ChangedObject: PY_STATE },
      limit: 50,
      order: "ascending",  // Get the oldest first
      options: { showInput: true, showObjectChanges: true },
    });
    
    if (txs.data.length > 0) {
      const oldest = txs.data[0];
      console.log(`Oldest PyState tx: ${oldest.digest}`);
      const changes = oldest.objectChanges ?? [];
      const created = changes.filter(c => c.type === "created" || c.type === "published");
      for (const c of created) {
        if ((c as any).packageId) {
          console.log(`  📦 Package: ${(c as any).packageId}`);
        }
        if ((c as any).objectId) {
          console.log(`  📦 Object: ${(c as any).objectId?.slice(0,30)} type=${JSON.stringify((c as any).objectType ?? "?").slice(0,60)}`);
        }
      }
      
      // Find what packages were called in this tx
      const calls = (oldest.transaction?.data?.transaction as any)?.transactions ?? [];
      const pkgs = new Set(calls.filter((c: any) => c.MoveCall).map((c: any) => c.MoveCall.package));
      console.log(`  Packages called: ${Array.from(pkgs).map((p: any) => p.slice(0,30)).join(", ")}`);
    }
  } catch (e: any) {
    console.log("Error:", e.message?.slice(0,80));
  }

  // 2. Try to find old Nemo package by checking early events
  console.log("\n=== Finding old Nemo via early events ===");
  try {
    // Look for oldest py events - these would reference the original package
    const events = await client.queryEvents({
      query: { MoveEventType: `${CURRENT_NEMO}::py::FlashLoanPosition` },
      limit: 3,
      order: "ascending",
    });
    console.log(`PyState events from current pkg: ${events.data.length}`);
  } catch {}

  // 3. Check the Nemo GoSDK for older package addresses
  // The config file showed commented-out addresses - let's check ALL addresses in the model
  console.log("\n=== Checking for other Nemo state objects from SDK ===");
  
  // PyStore: 0x0f589f1f...
  const PY_STORE = "0x0f589f1f1937b39cc51cd04b66dffe69ff6358693a5014dac75d6621730dbd9b";
  try {
    const obj = await client.getObject({ id: PY_STORE, options: { showType: true, showContent: true } });
    const type = obj.data?.type ?? "";
    const fields = (obj.data?.content as any)?.fields ?? {};
    console.log(`PyStore type: ${type.slice(0,80)}`);
    console.log(`  fields: ${Object.keys(fields).join(", ")}`);
    // Check what packages created/use this
  } catch (e: any) { console.log(`PyStore: ${e.message?.slice(0,60)}`); }

  // 4. Check MarketState for recent activity
  console.log("\n=== MarketState activity ===");
  try {
    const txs = await client.queryTransactionBlocks({
      filter: { ChangedObject: MARKET_STATE },
      limit: 5,
      order: "descending",
      options: { showInput: true },
    });
    console.log(`Recent MarketState txs: ${txs.data.length}`);
    for (const tx of txs.data.slice(0,3)) {
      const calls = (tx.transaction?.data?.transaction as any)?.transactions ?? [];
      const pkgs = [...new Set(calls.filter((c: any) => c.MoveCall).map((c: any) => c.MoveCall.package))];
      console.log(`  ${tx.digest.slice(0,20)}: pkgs=${pkgs.map((p: any) => p.slice(0,20)).join(",")}`);
    }
  } catch (e: any) { console.log("Error:", e.message?.slice(0,60)); }

  // 5. Enumerate all Nemo-related packages by checking upgrade cap
  console.log("\n=== Looking for Nemo upgrade history ===");
  try {
    // Get package info - shows original package ID
    const pkg = await client.getNormalizedMoveModulesByPackage({ package: CURRENT_NEMO });
    // Check modules for upgrade_cap mentions
    console.log(`Current Nemo modules: ${Object.keys(pkg).join(", ")}`);
    // Try to get package object directly
    const pkgObj = await client.getObject({ id: CURRENT_NEMO, options: { showContent: true } });
    console.log(`Package version: ${pkgObj.data?.version}`);
  } catch (e: any) { console.log("Error:", e.message?.slice(0,60)); }
}
main().catch(console.error);
