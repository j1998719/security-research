import { SuiClient } from "@mysten/sui/client";
import { Transaction } from "@mysten/sui/transactions";

const client = new SuiClient({ url: "https://fullnode.mainnet.sui.io:443" });
const DUMMY = "0x0000000000000000000000000000000000000000000000000000000000001337";

// Known addresses from scallop_zero_test.ts
const SCALLOP_ORIG = "0xefe8b36d5b2e43728cc323298626b83177803521d195cfb11e15b910e892fddf";
const VERSION_OBJ  = "0x07871c4b3c847a0f674510d4978d5cf6f960452795e8ff6f189fd2088a3f6ac7";
const MARKET_OBJ   = "0xa757975255146dc9686aa823b7838b507f315d704f428cbadad2f4ea061939d9";

async function main() {
  console.log("=== Find Scallop current package ===\n");
  
  // Check Market object type — it should point to current package
  const marketObj = await client.getObject({ 
    id: MARKET_OBJ, 
    options: { showContent: true } 
  });
  const mType = (marketObj.data?.content as any)?.type ?? "";
  console.log("Market type:", mType);
  const pkgFromMarket = mType.match(/^(0x[0-9a-f]+)::/)?.[1];
  console.log("Package from Market:", pkgFromMarket);
  
  // Check Version object type
  const versionObj = await client.getObject({ 
    id: VERSION_OBJ, 
    options: { showContent: true } 
  });
  const vType = (versionObj.data?.content as any)?.type ?? "";
  const vFields = (versionObj.data?.content as any)?.fields ?? {};
  console.log("\nVersion type:", vType);
  console.log("Version value:", vFields.value ?? vFields.id ?? JSON.stringify(vFields).slice(0,80));
  const pkgFromVersion = vType.match(/^(0x[0-9a-f]+)::/)?.[1];
  console.log("Package from Version:", pkgFromVersion);
  
  if (pkgFromMarket) {
    // Find UpgradeCap for this package
    const pkg = await client.getObject({ id: pkgFromMarket, options: { showPreviousTransaction: true } });
    const prevTx = pkg.data?.previousTransaction;
    console.log("\npkgFromMarket previousTransaction:", prevTx);
    
    if (prevTx) {
      const txDetail = await client.getTransactionBlock({
        digest: prevTx,
        options: { showObjectChanges: true }
      });
      for (const ch of txDetail.objectChanges ?? []) {
        const t = (ch as any).type;
        const objType = (ch as any).objectType ?? "";
        const id = (ch as any).objectId ?? (ch as any).packageId ?? "";
        if (objType.includes("UpgradeCap")) {
          console.log(`UpgradeCap: ${id}`);
          const cap = await client.getObject({ id, options: { showContent: true } });
          const f = (cap.data?.content as any)?.fields ?? {};
          console.log("  UpgradeCap.package (latest):", f.package, "version:", f.version);
          
          const latestPkg = f.package;
          if (latestPkg) {
            // Call current_version on latest package
            const tx = new Transaction();
            tx.setSender(DUMMY);
            tx.moveCall({ target: `${latestPkg}::version_methods::current_version`, typeArguments: [], arguments: [] });
            const r = await client.devInspectTransactionBlock({ transactionBlock: tx, sender: DUMMY });
            const vBytes = r.results?.[0]?.returnValues?.[0];
            if (vBytes) {
              console.log("  latest pkg current_version():", Buffer.from(vBytes[0]).readBigUInt64LE(0).toString());
            } else {
              console.log("  devInspect status:", r.effects?.status);
            }
          }
        }
        if (t === "published") {
          console.log(`Published: ${id}`);
        }
      }
    }
  }
}

main().catch(console.error);
