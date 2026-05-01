import { SuiClient } from "@mysten/sui/client";
const client = new SuiClient({ url: "https://fullnode.mainnet.sui.io:443" });

async function checkPkg(label: string, pkg: string) {
  try {
    const mods = await client.getNormalizedMoveModulesByPackage({ package: pkg });
    const modNames = Object.keys(mods);
    let hasVersionGuard = false;
    const rewardEntries: string[] = [];
    
    for (const [modName, modData] of Object.entries(mods)) {
      const structs = (modData as any).structs ?? {};
      for (const [_, sd] of Object.entries(structs)) {
        if (((sd as any).fields ?? []).some((f: any) => f.name === "version" || f.name === "package_version")) hasVersionGuard = true;
      }
      const fns = (modData as any).exposedFunctions ?? {};
      for (const [fnName, fnData] of Object.entries(fns)) {
        const isReward = ["claim", "reward", "harvest", "redeem_reward", "collect_reward"].some(kw => fnName.toLowerCase().includes(kw));
        if (isReward && (fnData as any).isEntry) rewardEntries.push(`${modName}::${fnName}`);
      }
    }
    
    console.log(`${label} (${pkg.slice(0,18)}...) modules=${modNames.length} version_guard=${hasVersionGuard?"YES":"⚠️NO"} reward_entries=${rewardEntries.length}`);
    if (rewardEntries.length > 0) for (const fn of rewardEntries) console.log(`  ⚡ ${fn}`);
    return { hasVersionGuard, rewardEntries };
  } catch { return null; }
}

async function main() {
  // Find NAVI intermediate packages via object's upgrade cap
  console.log("=== Searching NAVI upgrade chain ===");
  const NAVI_V1 = "0xd899cf7d2b5db716bd2cf55599fb0d5ee38a3061e7b6bb6eebf73fa5bc4c81ca";
  const naviPkg = await client.getObject({ id: NAVI_V1, options: { showContent: false } });
  console.log("NAVI V1 pkg:", JSON.stringify(naviPkg.data ?? naviPkg.error).slice(0, 100));

  // Search for protocols via known events
  console.log("\n=== Protocol scan ===");
  
  // Haedal staking 
  await checkPkg("Haedal staking", "0x75b23bde4de9aca930d8c1f1780aa65ee777d8b33c3045b053af0cbeb2c3b8d3");
  // Kai Finance
  await checkPkg("Kai Finance", "0x3492c874c1e3b3e2984e8c41b589e642d4d0a5d6d2ede0d2e6a6e3c3b4c5d6e7");
  // AlphaFi
  await checkPkg("AlphaFi", "0x9bbd650b8442abb082c20f3bc95a9434a8d47b4bef98b0d827db0bc79439a2cd");
  // Nemo Protocol
  await checkPkg("Nemo", "0x0e20b9eeda9ff9daf9cf9b68b3f46c8c5d54e1b0b70d9e37b7f1e24d5c6f9a3");
  // MBox
  await checkPkg("MBox", "0xf57c765e4b85cef07fba65c9aba55df8d8c6a0b56e2e4a8d3a9b1c5d7e6f2a4");
  // Aldrin AMM  
  await checkPkg("Aldrin", "0x4e0629fa51a62b0c1d7c7b9fc89237ec5b6f630d7798ad3f06d820afb93a995a");
  // Port Finance
  await checkPkg("Port Finance", "0x009b54e57192680ac84cd3b8c61ef03a7b77c8e12ffe0b86b92c7aec46d4e7b2");
  // Scallop lend
  await checkPkg("Scallop lend", "0x4c20d0a4f4f70e1d5e61e63a10a4abeec40f9e4c8e5bb2d8e8c0b3f2e4a5b9c1");
  // Typus Finance
  await checkPkg("Typus DOV", "0x3c2fd2a5f0f3a4b7d9c8e2b1f4e6a3d5c7b9f0e2d4c6b8a9f1e3d5c7b9f0e2");
}
main().catch(console.error);
