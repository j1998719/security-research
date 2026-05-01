import { SuiClient } from "@mysten/sui/client";
const client = new SuiClient({ url: "https://fullnode.mainnet.sui.io:443" });

async function main() {
  // Try the deployment TX mentioned in search results
  const deployTx = "ArHfPj2tiBiDCPEfLYUJfmtDdRyXCZSgtzuxtyXbNs1B";
  
  try {
    const tx = await client.getTransactionBlock({
      digest: deployTx,
      options: { showObjectChanges: true, showInput: true },
    });
    console.log("Deployment TX found!");
    const created = tx.objectChanges?.filter(c => c.type === "created" || c.type === "published");
    for (const obj of (created ?? [])) {
      if ((obj as any).packageId) {
        console.log(`Package: ${(obj as any).packageId}`);
      }
      console.log(`  ${JSON.stringify(obj).slice(0, 120)}`);
    }
  } catch (e: any) {
    console.log("TX not found:", e.message?.slice(0, 60));
  }

  // Try fetching from Bluefin docs/contract specs
  // Alternative: look for Bluefin via well-known Sui address patterns
  // Bluefin's old contract on Arbitrum is known; Sui version should be in their SDK
  
  // Search via event patterns from Bluefin's trading
  // Bluefin likely emits OrderFilled or PositionChanged events
  const POTENTIAL_BLUEFIN = [
    "0x3492c874c1e3b3e2984e8c41b589e642d4d0a5d6b7c2f9e8a1b4d7c0f3e6a9b2",
    "0x9a0f1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0",
  ];
  
  // Check these (they'll fail, just testing)
  for (const pkg of POTENTIAL_BLUEFIN) {
    if (pkg.length !== 66) continue;
    try {
      const norm = await client.getNormalizedMoveModulesByPackage({ package: pkg });
      console.log(`FOUND at ${pkg.slice(0,24)}: ${Object.keys(norm).join(",")}`);
    } catch {}
  }
  
  // Alternative: try known Bluefin SDK GitHub raw files
  console.log("\nNote: Bluefin contract addresses are likely private/internal.");
  console.log("Try: https://raw.githubusercontent.com/fireflyprotocol/bluefin-client-python-sui/main/src/bluefin_client_sui/constants.py");
}
main().catch(console.error);
