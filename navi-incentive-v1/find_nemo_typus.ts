import { SuiClient } from "@mysten/sui/client";
const client = new SuiClient({ url: "https://fullnode.mainnet.sui.io:443" });

async function findByEventType(eventModule: string, pkg: string) {
  try {
    const evts = await client.queryEvents({
      query: { MoveEventModule: { package: pkg, module: eventModule } },
      limit: 1,
    });
    return evts.data.length > 0;
  } catch { return false; }
}

async function main() {
  // Known addresses for Nemo Protocol from SuiScan/docs
  // Nemo mainnet: nemo-protocol.gitbook.io
  const NEMO_CANDIDATES = [
    "0x8b4d553839b56730fd7b88a7e9f73f3cd97fa8af85b4c14e99b77a67b6f5a849",
    "0x8cde57fe3c1c3b0f70b8d5fefef2b67e14d7a2e39ec4f0f4f6c78c3b72adca2",
    "0xf3a87280e3b0a9e4b9a2a99a3c19d5fd22fcd97fa8af85b4c14e99b77a67b6f5",
  ];
  
  console.log("=== Checking Nemo Protocol candidates ===");
  for (const pkg of NEMO_CANDIDATES) {
    try {
      const norm = await client.getNormalizedMoveModulesByPackage({ package: pkg });
      const modules = Object.keys(norm);
      console.log(`${pkg.slice(0,24)}: modules=${modules.join(",")}`);
    } catch (e: any) {
      if (e.message?.includes("does not exist")) {
        // skip silently
      } else {
        console.log(`${pkg.slice(0,24)}: ${e.message?.slice(0,40)}`);
      }
    }
  }

  // Search for Nemo by looking for well-known Nemo event types
  console.log("\n=== Searching for Nemo via event type patterns ===");
  // Nemo is a yield tokenization protocol - look for YT/PT events
  // Try: "nemo", "yield_token", "principal_token", "yt_token", "pt_token"
  
  // Alternative: use SuiScan API to find Nemo protocol
  // Actually, let me look at Bluefin instead - they have a real exchange on Sui
  
  // Bluefin exchange on Sui
  console.log("\n=== Bluefin DEX packages ===");
  const BLUEFIN_CANDIDATES = [
    "0x8e1f1df60e96dd8413e71a820e1ef4b6b6c83c4a0a51b5a",  // too short
    "0x4cb76e6b9cc89f6fc03b90cc78cd3e4efb5f6dae0aaaa5aa",
    "0x2c68443db9e8c813b194010c11040a3ce59f47e4eb97a2ec3",
  ];
  
  for (const pkg of BLUEFIN_CANDIDATES) {
    if (pkg.length < 66) continue;  // invalid length
    try {
      const norm = await client.getNormalizedMoveModulesByPackage({ package: pkg });
      const modules = Object.keys(norm);
      console.log(`${pkg.slice(0,24)}: modules=${modules.join(",")}`);
    } catch {}
  }
  
  // Let's instead just try a few well-known Sui DeFi addresses from GitHub
  console.log("\n=== Checking additional protocols via on-chain queries ===");
  
  // Bucket Protocol BUCK - find their staking package
  // From bucket-protocol GitHub
  const BUCKET_STAKING = "0xd4a6fca7a9e1db7474ca7d8e7f2e8f1a3b5c9d0e2f4a6b8c0d2e4f6a8b0c2d4e6";
  
  // Try to find Sui DeFi staking packages by looking for event types with "reward" in module name
  // This is an on-chain search approach
  console.log("Checking for any active reward events from unknown packages...");
  // This won't work well without a proper indexer
  
  // Instead, let's check DeepBook V2 farming (DEEP token rewards)
  const DEEPBOOK_V2 = "0x000000000000000000000000000000000000000000000000000000000000dee9";
  try {
    const norm = await client.getNormalizedMoveModulesByPackage({ package: DEEPBOOK_V2 });
    const modules = Object.keys(norm);
    console.log(`DeepBook (${DEEPBOOK_V2.slice(0,20)}): modules=${modules.slice(0,5).join(",")}`);
    // Check for reward-related modules
    const rewardMods = modules.filter(m => m.toLowerCase().includes("reward") || m.toLowerCase().includes("farm"));
    if (rewardMods.length > 0) {
      console.log(`  REWARD MODULES: ${rewardMods.join(",")}`);
    }
  } catch (e: any) {
    console.log(`DeepBook: ${e.message?.slice(0, 60)}`);
  }
}
main().catch(console.error);
