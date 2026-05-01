import { SuiClient } from "@mysten/sui/client";
import { Transaction } from "@mysten/sui/transactions";

const client = new SuiClient({ url: "https://fullnode.mainnet.sui.io:443" });
const DUMMY = "0x0000000000000000000000000000000000000000000000000000000000001337";

// Known Scallop packages
const SCALLOP_LENDING_ORIG = "0xefe8b36d5b2e43728cc323298626b83177803521d195cfb11e15b031e1f462684";

async function main() {
  console.log("=== Find Scallop current package ===\n");
  
  // Check the Version object for Scallop (value = 9 as discovered before)
  // From scallop_zero_test.ts - VERSION_OBJ = "0x07871c4b3c847a0f674510d4978d5cf6ee6d22e2bc05d2e..."
  // Let's find it from the original package
  
  // Get the package object
  const pkgObj = await client.getObject({ 
    id: SCALLOP_LENDING_ORIG, 
    options: { showPreviousTransaction: true } 
  });
  console.log("Scallop orig pkg previousTransaction:", pkgObj.data?.previousTransaction);
  
  // Try to get the UpgradeCap
  const prevTx = pkgObj.data?.previousTransaction;
  if (prevTx) {
    const txDetail = await client.getTransactionBlock({
      digest: prevTx,
      options: { showObjectChanges: true }
    });
    for (const ch of txDetail.objectChanges ?? []) {
      const t = (ch as any).type;
      const objType = (ch as any).objectType ?? "";
      const id = (ch as any).objectId ?? (ch as any).packageId ?? "";
      if (objType.includes("UpgradeCap") || t === "published") {
        console.log(`  ${t}: ${id} [${objType.slice(0,50)}]`);
      }
    }
  }
  
  // Check recent scallop lending transactions to find upgraded package
  const recentTxns = await client.queryTransactionBlocks({
    filter: { MoveFunction: { package: SCALLOP_LENDING_ORIG, module: "borrow" } },
    limit: 5,
    order: "descending",
  });
  console.log("\nRecent borrow txns:", recentTxns.data.length);
  
  // Try querying by known Scallop Market object
  // Market is a well-known Scallop shared object
  const SCALLOP_MARKET = "0xa757975255146dc9686aa823b7838b507f315d704f428cbadad2f4ea061ab349";
  const marketObj = await client.getObject({ id: SCALLOP_MARKET, options: { showContent: true, showPreviousTransaction: true } });
  const mType = (marketObj.data?.content as any)?.type ?? "";
  console.log("\nScallop Market type:", mType);
  
  // Extract package from type
  const pkgFromType = mType.match(/^(0x[0-9a-f]+)::/)?.[1];
  console.log("Package from Market type:", pkgFromType);
  
  if (pkgFromType && pkgFromType !== SCALLOP_LENDING_ORIG) {
    // Check version
    try {
      const mod = await client.getNormalizedMoveModule({ package: pkgFromType, module: "version_methods" });
      const fns = Object.keys(mod.exposedFunctions);
      console.log("version_methods functions:", fns.join(", "));
    } catch(e: any) {
      console.log("No version_methods in", pkgFromType.slice(0,16));
    }
    
    // Try calling current_version
    try {
      const tx = new Transaction();
      tx.setSender(DUMMY);
      tx.moveCall({ target: `${pkgFromType}::version_methods::current_version`, typeArguments: [], arguments: [] });
      const r = await client.devInspectTransactionBlock({ transactionBlock: tx, sender: DUMMY });
      const vBytes = r.results?.[0]?.returnValues?.[0];
      if (vBytes) {
        const v = Buffer.from(vBytes[0]).readBigUInt64LE(0);
        console.log("current_version() =", v.toString());
      }
    } catch(e: any) {
      console.log("Error calling current_version:", (e as any).message?.slice(0,80));
    }
    
    // Check UpgradeCap for this package
    const upgPkg = await client.getObject({ id: pkgFromType, options: { showPreviousTransaction: true }});
    const prevTx2 = upgPkg.data?.previousTransaction;
    if (prevTx2) {
      const txDetail = await client.getTransactionBlock({
        digest: prevTx2,
        options: { showObjectChanges: true }
      });
      console.log("\nObject changes in pkg creation:");
      for (const ch of txDetail.objectChanges ?? []) {
        const t = (ch as any).type;
        const objType = (ch as any).objectType ?? "";
        const id = (ch as any).objectId ?? (ch as any).packageId ?? "";
        if (objType.includes("UpgradeCap") || t === "published") {
          console.log(`  ${t}: ${id} [${objType.slice(0,50)}]`);
          // If UpgradeCap found, read its current package field
          if (objType.includes("UpgradeCap")) {
            const cap = await client.getObject({ id, options: { showContent: true } });
            const f = (cap.data?.content as any)?.fields ?? {};
            console.log("  UpgradeCap.package:", f.package, "version:", f.version);
          }
        }
      }
    }
  }
}

main().catch(console.error);
