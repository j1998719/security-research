import { SuiClient } from "@mysten/sui/client";
const client = new SuiClient({ url: "https://fullnode.mainnet.sui.io:443" });

const TARGETS = [
  // Volo liquid staking
  { label: "Volo staking", pkg: "0x549e8b69270defbfafd4f94e17ec44cdbdd99820b33bda2278dea3b9a32d3f55" },
  // Haedal
  { label: "Haedal staking", pkg: "0x8c43e4d3e8b7d7ca6c4e5b2c3f7d61e37e8a2f6fbe9b1a8e5bd1cac9c27c0a3" },
  // Kriya DEX
  { label: "Kriya DEX", pkg: "0x5c45d10c26c5fb53bfaff819237aa12aa4a25d68e2f1bde2831b09f7f50e7e55" },
  // Bucket Protocol
  { label: "Bucket", pkg: "0xce7ff77a83ea0cb6fd39bd8748e2ec89a3f41e8efdc3f4eb123e0ca37b184db2" },
  // Mole Protocol
  { label: "Mole", pkg: "0x9f3b0559b8d11a9c8e3b2f31a4c17d8e2b4f5a6c3d7e8f9a2b1c4d5e6f7a8b9" },
  // Navi Protocol incentive V2
  { label: "NAVI incentive V2 mid", pkg: "0x81c44854a3b854cd7d3ce48a7c8a21e8a8d0893e2af3a80e3b524b93ee58060d" },
  // Scallop V3 (current)  
  { label: "Scallop spool V3", pkg: "0x472fc7d4c3534a8ec8c2f5d7a557a43050eab057aaab853e8910968ddc84fc9f" },
  // Typus Finance
  { label: "Typus", pkg: "0xd7c38c9f8be1da69e35b1eff8b6c20ab1a2d8a2c4d5e6f7a8b9c0d1e2f3a4b5c" },
];

const REWARD_KW = ["claim", "reward", "harvest", "redeem", "collect_reward", "stake", "unstake"];

async function main() {
  for (const { label, pkg } of TARGETS) {
    try {
      const mods = await client.getNormalizedMoveModulesByPackage({ package: pkg });
      const modNames = Object.keys(mods);
      
      let hasVersionGuard = false;
      const rewardEntries: string[] = [];
      
      for (const [modName, modData] of Object.entries(mods)) {
        const structs = (modData as any).structs ?? {};
        for (const [_, sd] of Object.entries(structs)) {
          if (((sd as any).fields ?? []).some((f: any) => f.name === "version")) hasVersionGuard = true;
        }
        const fns = (modData as any).exposedFunctions ?? {};
        for (const [fnName, fnData] of Object.entries(fns)) {
          if (REWARD_KW.some(kw => fnName.toLowerCase().includes(kw)) && (fnData as any).isEntry) {
            rewardEntries.push(`${modName}::${fnName}`);
          }
        }
      }
      
      console.log(`${label}: modules=${modNames.length} version_guard=${hasVersionGuard ? "YES" : "⚠️NO"} reward_entries=${rewardEntries.length}`);
      if (rewardEntries.length > 0) {
        for (const fn of rewardEntries) console.log(`  ⚡ ${fn}`);
      }
    } catch (e: any) {
      // skip missing packages
    }
  }
}
main().catch(console.error);
