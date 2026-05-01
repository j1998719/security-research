import { SuiClient } from "@mysten/sui/client";

const client = new SuiClient({ url: "https://fullnode.mainnet.sui.io:443" });

async function main() {
  const UPGRADE_CAP = "0xdba1b40f3537441b51d2848fc0a149610e48e67c1cc48c6ad641767622000623";
  const PROTO_PKG   = "0xee0041239b89564ce870a7dec5ddc5d114367ab94a1137e90aa0633cb76518e0";
  
  // Strategy: Get the UpgradeCap to understand the upgrade history chain
  // The UpgradeCap has a 'package' field pointing to the latest package ID
  const upgCap = await client.getObject({ id: UPGRADE_CAP, options: { showContent: true } });
  const fields = (upgCap.data?.content as any)?.fields ?? {};
  console.log("UpgradeCap fields:", JSON.stringify(fields, null, 2));
  
  // The 'package' field in UpgradeCap = latest package ID after all upgrades
  const latestPkg = fields.package;
  if (latestPkg && latestPkg !== PROTO_PKG) {
    console.log("\n==> Latest package via UpgradeCap:", latestPkg);
    
    // Check this package's constants::version
    const { Transaction } = await import("@mysten/sui/transactions");
    const DUMMY = "0x0000000000000000000000000000000000000000000000000000000000001337";
    
    try {
      const tx = new Transaction();
      tx.setSender(DUMMY);
      tx.moveCall({ target: `${latestPkg}::constants::version`, typeArguments: [], arguments: [] });
      const r = await client.devInspectTransactionBlock({ transactionBlock: tx, sender: DUMMY });
      const vBytes = r.results?.[0]?.returnValues?.[0];
      if (vBytes) {
        const v = Buffer.from(vBytes[0]).readBigUInt64LE(0);
        console.log("Latest package constants::version() =", v.toString());
      } else {
        console.log("devInspect status:", r.effects?.status);
      }
    } catch(e: any) {
      console.log("Error calling version:", e.message?.slice(0, 100));
    }
  } else {
    console.log("UpgradeCap.package:", latestPkg, "(same as PROTO_PKG or null)");
  }
  
  // Also look for any transactions that reference the upgrade cap
  const upgTxns = await client.queryTransactionBlocks({
    filter: { InputObject: UPGRADE_CAP },
    limit: 5,
    order: "descending",
  });
  console.log("\nTxns using UpgradeCap:", upgTxns.data.length);
  for (const tx of upgTxns.data) {
    console.log("  digest:", tx.digest);
    // Get objectChanges to find published packages
    const detail = await client.getTransactionBlock({
      digest: tx.digest,
      options: { showObjectChanges: true }
    });
    for (const ch of detail.objectChanges ?? []) {
      if ((ch as any).type === "published") {
        console.log("  Published package:", (ch as any).packageId);
      }
    }
  }
}

main().catch(console.error);
