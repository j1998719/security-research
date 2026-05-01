import { SuiClient } from "@mysten/sui/client";

const client = new SuiClient({ url: "https://fullnode.mainnet.sui.io:443" });

// NAVI packages from different rounds of auditing
// 0xee00... = PROTO_PKG (version 14 in constants)
// 0xd899... = V1
// 0x81c4... = MID

// Strategy 1: Get upgrade history from NAVI core package
// The UpgradeCap for 0xee00... package will track upgrade history

async function main() {
  // Get the package object itself to find its original ID
  const PROTO_PKG = "0xee0041239b89564ce870a7dec5ddc5d114367ab94a1137e90aa0633cb76518e0";
  
  console.log("=== Finding NAVI v15 package ===\n");
  
  // Get package object info
  const pkgObj = await client.getObject({ id: PROTO_PKG, options: { showContent: true, showBcs: false } });
  console.log("Package type:", pkgObj.data?.type);
  
  // Try to find recent NAVI transactions and look at package versions
  // Search for transactions from NAVI packages
  const txns = await client.queryTransactionBlocks({
    filter: { MoveFunction: { package: PROTO_PKG, module: "incentive_v3" } },
    limit: 3,
    order: "descending",
  });
  console.log(`\nRecent txns using 0xee00 package: ${txns.data.length}`);
  for (const tx of txns.data) {
    console.log("  tx:", tx.digest, "checkpoint:", tx.checkpoint);
  }
  
  // The incentive_v3 module functions are also in upgraded packages
  // Let's look at what package created/upgraded NAVI
  // Try to find the package by looking at recent transactions from known NAVI contracts
  
  const INCENTIVE_V3 = "0x62982dad27fb10bb314b3384d5de8d2ac2d72ab2dbeae5d801dbdb9efa816c80";
  const iv3 = await client.getObject({ id: INCENTIVE_V3, options: { showContent: true } });
  const f = (iv3.data?.content as any) ?? {};
  
  // The type field shows which package version created/last modified this object
  console.log("\nIncentive V3 object type:", f.type);
  // The package ID in the type string IS the current package!
  
  // Parse the package ID from the type
  const typeStr = f.type as string || "";
  const pkgInType = typeStr.match(/^(0x[0-9a-f]+)::/)?.[1];
  console.log("Package ID from type:", pkgInType);
  
  if (pkgInType && pkgInType !== PROTO_PKG) {
    console.log("\n==> Found different package ID! Checking version...");
    const newPkg = pkgInType;
    
    // Check if this package has incentive_v3::constants::version
    try {
      const mod = await client.getNormalizedMoveModule({ package: newPkg, module: "constants" });
      const fns = Object.keys(mod.exposedFunctions);
      console.log("constants module functions:", fns.join(", "));
    } catch(e: any) {
      console.log("No constants module in", newPkg);
    }
  } else {
    console.log("\nType package matches PROTO_PKG or not found.");
  }
  
  // Also try the NAVI V1 package's upgrade path
  // NAVI probably has a published package list on-chain
  // Let's look for recent transactions that call entry_deposit
  const depositTxns = await client.queryTransactionBlocks({
    filter: { MoveFunction: { package: PROTO_PKG, module: "incentive_v3", function: "entry_deposit" } },
    limit: 5,
    order: "descending",
  });
  console.log(`\nRecent entry_deposit calls on 0xee00 package: ${depositTxns.data.length}`);
  for (const tx of depositTxns.data) {
    // Get full tx to see which package it called
    const detail = await client.getTransactionBlock({ digest: tx.digest, options: { showInput: true } });
    const prog = (detail.transaction?.data?.transaction as any);
    if (prog?.kind === "ProgrammableTransaction") {
      for (const cmd of prog.commands ?? []) {
        if (cmd.MoveCall) {
          const mc = cmd.MoveCall;
          if (mc.function === "entry_deposit" || mc.function === "entry_borrow_v2") {
            console.log(`  ${tx.digest}: ${mc.package}::${mc.module}::${mc.function}`);
          }
        }
      }
    }
  }
}

main().catch(console.error);
