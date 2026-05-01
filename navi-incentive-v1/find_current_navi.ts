import { SuiClient } from "@mysten/sui/client";

const client = new SuiClient({ url: "https://fullnode.mainnet.sui.io:443" });

const PROTO_PKG = "0xee0041239b89564ce870a7dec5ddc5d114367ab94a1137e90aa0633cb76518e0";
const MID_PKG   = "0x81c408448d0d57b3e371ea94de1d40bf852784d3e225de1e74acab3e8395c18f";
const DUMMY     = "0x0000000000000000000000000000000000000000000000000000000000001337";

async function main() {
  console.log("=== Find current NAVI package (v15) ===\n");
  
  // Strategy: look at recent real transactions using NAVI, inspect input packages
  const txns = await client.queryTransactionBlocks({
    filter: { MoveFunction: { package: PROTO_PKG, module: "incentive_v3" } },
    limit: 5,
    order: "descending",
  });
  
  console.log("Inspecting recent txns for newer package references...");
  for (const txRef of txns.data) {
    const detail = await client.getTransactionBlock({ 
      digest: txRef.digest, 
      options: { showInput: true, showEffects: false } 
    });
    const prog = (detail.transaction?.data?.transaction as any);
    if (prog?.kind === "ProgrammableTransaction") {
      const allPkgs = new Set<string>();
      for (const cmd of prog.commands ?? []) {
        if (cmd.MoveCall?.package) {
          allPkgs.add(cmd.MoveCall.package);
        }
      }
      console.log(`  tx ${txRef.digest.slice(0,16)}... packages: ${[...allPkgs].join(", ")}`);
    }
  }
  
  // Strategy 2: Look for the latest package via NAVI's upgrade mechanism
  // The Incentive V3 object points to 0x81c4... but that has version=13
  // So: version 15 must be a package that CALLS into 0x81c4 or is the next upgrade
  
  // Let's check what transactions modify the Incentive V3 object
  const INCENTIVE_V3 = "0x62982dad27fb10bb314b3384d5de8d2ac2d72ab2dbeae5d801dbdb9efa816c80";
  
  // Query by inputObject to find who interacts with it
  const recentTxnsOnV3 = await client.queryTransactionBlocks({
    filter: { InputObject: INCENTIVE_V3 },
    limit: 5,
    order: "descending",
  });
  console.log(`\nRecent txns touching IncentiveV3: ${recentTxnsOnV3.data.length}`);
  
  for (const txRef of recentTxnsOnV3.data) {
    const detail = await client.getTransactionBlock({ 
      digest: txRef.digest, 
      options: { showInput: true } 
    });
    const prog = (detail.transaction?.data?.transaction as any);
    if (prog?.kind === "ProgrammableTransaction") {
      const pkgs = new Set<string>();
      for (const cmd of prog.commands ?? []) {
        if (cmd.MoveCall?.package) pkgs.add(cmd.MoveCall.package);
      }
      console.log(`  tx ${txRef.digest.slice(0,16)}... packages: ${[...pkgs].join(", ")}`);
    }
  }
  
  // Strategy 3: Check NAVI's published package history by looking at upgrade events
  // Try to query PublishEvent or UpgradeEvent for NAVI
  const publishEvts = await client.queryEvents({
    query: { MoveEventType: "0x2::package::UpgradeTicket" },
    limit: 3,
    order: "descending",
  });
  console.log("\nUpgradeTicket events:", publishEvts.data.length);
}

main().catch(console.error);
