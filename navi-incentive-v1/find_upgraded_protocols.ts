/**
 * Find Sui DeFi protocols with upgrade histories
 * Strategy: check known protocol packages for upgrade chains
 */
import { SuiClient } from "@mysten/sui/client";
const client = new SuiClient({ url: "https://fullnode.mainnet.sui.io:443" });

// Known Sui DeFi protocol packages to check
const TARGETS = [
  // Aftermath Finance
  { label: "Aftermath staking", pkg: "0x7f6ce7ade63857c4fd16ef7783fed2dfc4d7fb7e40615abdb653030b76aef0c6" },
  { label: "Aftermath AMM", pkg: "0xefe170ec0be4d762196bedecd7a065816576198a6527c99282a2551aaa7da38c" },
  // Haedal Protocol
  { label: "Haedal", pkg: "0xdbe86b4d93e1b457fd7f9cde2f63f9e2eb1c92e6c1c3b7c8c63ad2feeb5f3f4" },
  // BlueMove DEX
  { label: "BlueMove", pkg: "0xb24b6789e088b876afabca733bed2299fbc9e2d6369be4d1acfa17d8145454d9" },
  // Bucket Protocol
  { label: "Bucket", pkg: "0xce7ff77a83ea0cb6fd39bd8748e2ec89a3f41e8efdc3f4eb123e0ca37b184db2" },
  // Navi Protocol (V1, original)
  { label: "NAVI V1 original", pkg: "0xd899cf7d2b5db716bd2cf55599fb0d5ee38a3061e7b6bb6eebf73fa5bc4c81ca" },
  // FlowX Finance  
  { label: "FlowX", pkg: "0xba153169476e8c3114962261d1edc70de5ad9781b83cc617ecc8c1923191cae0" },
  // Turbos Finance farm
  { label: "Turbos CLMM", pkg: "0x91bfbc386a41afcfd9b2533058d7e915a1d3829089cc268ff4333d54d6339ca1" },
];

const REWARD_KEYWORDS = ["claim", "reward", "harvest", "redeem", "collect_reward", "stake"];

async function checkProtocol(label: string, pkg: string) {
  try {
    const modules = await client.getNormalizedMoveModulesByPackage({ package: pkg });
    const modNames = Object.keys(modules);
    
    const rewardEntries: string[] = [];
    for (const [modName, modData] of Object.entries(modules)) {
      const fns = (modData as any).exposedFunctions ?? {};
      for (const [fnName, fnData] of Object.entries(fns)) {
        const isReward = REWARD_KEYWORDS.some(kw => fnName.toLowerCase().includes(kw));
        if (isReward && (fnData as any).isEntry) {
          rewardEntries.push(`${modName}::${fnName}`);
        }
      }
    }

    // Check if any structs have version fields
    let hasVersionGuard = false;
    for (const [modName, modData] of Object.entries(modules)) {
      const structs = (modData as any).structs ?? {};
      for (const [structName, structData] of Object.entries(structs)) {
        const fields = (structData as any).fields ?? [];
        if (fields.some((f: any) => f.name === "version")) {
          hasVersionGuard = true;
        }
      }
    }

    if (rewardEntries.length > 0 || !hasVersionGuard) {
      console.log(`\n${label} (${pkg.slice(0, 20)}...)`);
      console.log(`  Modules: ${modNames.join(", ").slice(0, 80)}`);
      console.log(`  Version guard: ${hasVersionGuard ? "YES" : "⚠️  NO"}`);
      if (rewardEntries.length > 0) {
        console.log(`  Reward entry fns: ${rewardEntries.join(", ")}`);
      }
    }
  } catch (e: any) {
    // Package doesn't exist, skip
  }
}

async function main() {
  console.log("Scanning Sui DeFi protocols for reward entry functions without version guards...\n");
  await Promise.all(TARGETS.map(({ label, pkg }) => checkProtocol(label, pkg)));
  console.log("\nDone.");
}
main().catch(console.error);
