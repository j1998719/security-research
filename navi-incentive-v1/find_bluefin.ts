import { SuiClient } from "@mysten/sui/client";
const client = new SuiClient({ url: "https://fullnode.mainnet.sui.io:443" });

async function main() {
  // Try to find Bluefin via known event patterns
  // Bluefin is an exchange on Sui, likely emits "TradeExecuted" or "OrderFilled" events
  const candidates = [
    "0x6f5e582ede61fe5395b50c4a449ec11479a54d7ff8e0158247adfda60d98970b",  // from suiscan search
    "0x0a5b4afcbde4a9e4fce52ac617c0f65e10de45f5ad66a4d6b07e63b2e57427d7",
    "0x9b63452e2ded7e7ea76f3b7c35d27fbb2c0e0e8bdc3d95ab78e73d640736d5f4",
  ];
  
  console.log("Checking Bluefin candidates...");
  for (const pkg of candidates) {
    try {
      const norm = await client.getNormalizedMoveModulesByPackage({ package: pkg });
      const mods = Object.keys(norm);
      const hasPerps = mods.some(m => ["perpetual", "perp", "clearing", "settlement", "exchange", "order"].includes(m.toLowerCase()));
      if (hasPerps || mods.length > 3) {
        console.log(`FOUND: ${pkg.slice(0,28)} modules: ${mods.join(", ")}`);
      }
    } catch {}
  }
  
  // Try to find via transaction events with exchange-related module names
  console.log("\nLooking for Bluefin via recent large transactions...");
  // Bluefin address should be findable via their trade events
}
main().catch(console.error);
