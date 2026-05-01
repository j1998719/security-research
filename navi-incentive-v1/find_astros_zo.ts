/**
 * Find Astros and Zo perps packages via on-chain transaction analysis
 * Astros is integrated with NAVI; Zo is a Sui-native perps protocol
 */
import { SuiClient } from "@mysten/sui/client";
const client = new SuiClient({ url: "https://fullnode.mainnet.sui.io:443" });

// NAVI v2 storage object (main protocol object)
const NAVI_STORAGE = "0xbb4e2f4b6205c2e2a2db47aeb4f830796ec7c005f88537ee775986639bc442fe";
const NAVI_PKG = "0x834a86970ae93a73faf4fff12634e7a7c69f1b68fc65e59c4061a03cd31be9e2";

async function main() {
  // 1. Find callers of NAVI's deposit/borrow functions in recent txs - Astros would show up
  console.log("=== Finding Astros via NAVI interaction txs ===\n");
  
  try {
    const txs = await client.queryTransactionBlocks({
      filter: { MoveFunction: { package: NAVI_PKG, module: "lending", function: "deposit" } },
      options: { showInput: true },
      limit: 10,
      order: "descending",
    });
    console.log(`Recent NAVI deposit txs: ${txs.data.length}`);
    
    // Find which packages are calling NAVI deposit
    const callerPkgs = new Set<string>();
    for (const tx of txs.data) {
      const calls = (tx.transaction?.data?.transaction as any)?.transactions ?? [];
      for (const c of calls) {
        if (c.MoveCall?.package && !c.MoveCall.package.startsWith("0x000000000000000000000000000000000000000000000000000000000000")) {
          callerPkgs.add(c.MoveCall.package);
        }
      }
    }
    console.log(`Unique caller packages: ${callerPkgs.size}`);
    for (const pkg of callerPkgs) {
      if (pkg !== NAVI_PKG) {
        console.log(`  Caller: ${pkg.slice(0,30)}...`);
        // Quick check modules
        try {
          const norm = await client.getNormalizedMoveModulesByPackage({ package: pkg });
          const modules = Object.keys(norm);
          console.log(`    Modules: ${modules.join(", ")}`);
        } catch {}
      }
    }
  } catch (e: any) {
    console.log("Error:", e.message?.slice(0, 80));
  }

  // 2. Search for Zo protocol via event queries
  console.log("\n=== Finding Zo Protocol ===");
  // Zo might emit events with "zo" in the module name
  // Try common Zo module names
  const ZO_GUESSES = [
    "0x2c68443db9e8c813b194010c11040a3ce59f47e4eb97a2ec3b4f6c4b6f2d3a5e",
    "0x9c58b67b9ded6f8b5b3a7b5f0e4a3d2c1b0f9e8d7c6b5a4938271605040302010",
  ];
  
  for (const pkg of ZO_GUESSES) {
    if (pkg.length !== 66) continue;
    try {
      const norm = await client.getNormalizedMoveModulesByPackage({ package: pkg });
      console.log(`Found: ${pkg.slice(0,24)} - modules: ${Object.keys(norm).join(",")}`);
    } catch {}
  }
  
  // 3. Try to find any perps protocol via event type search
  console.log("\n=== Searching for perps-related events ===");
  // Look for any recent large tx with perp-related patterns
  const recentTxs = await client.queryTransactionBlocks({
    filter: { FromAddress: "0x0000000000000000000000000000000000000000000000000000000000001337" },
    limit: 1,
  });
  // This won't work, just testing the API
  
  // 4. Try known Aftermath perps package (the one that was actually exploited)
  console.log("\n=== Aftermath Perps package ===");
  // From the exploit analysis in April 2026, the perps package had builder_code_fee
  // Aftermath's AMM address is long 0x, their Perps is different
  // Check potential perps addresses
  const AFTERMATH_PERPS_CANDIDATES = [
    "0x4c0dce55aaab2f72fc7e3b56dbd3f8e8a3bc5b6d9f2c1e4a7b0d3f6c9e2a5b8",  // guess
    "0xdd21bb8398b65d01b2b68eb3c2d36b8c8f13ab5dce2f7e9a0c3b6d9f2e5a8c1",  // guess
  ];
  
  console.log("(Aftermath Perps address not found from public sources)");
  console.log("Looking via recent protocol events...");
  
  // Actually look for AftermathFi perps via their AMM swap events
  try {
    const evts = await client.queryEvents({
      query: { MoveEventModule: { 
        package: "0xefe8b36d5b2e43728cc323298626b83177803521d195cfb11e15b910e892fddf",
        module: "pool"
      }},
      limit: 3,
      order: "descending",
    });
    console.log(`Aftermath AMM pool events: ${evts.data.length}`);
  } catch (e: any) {
    console.log(`Error: ${e.message?.slice(0,60)}`);
  }
}
main().catch(console.error);
