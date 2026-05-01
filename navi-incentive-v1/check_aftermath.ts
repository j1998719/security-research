/**
 * Check Aftermath Finance for deprecated staking/reward packages
 */
import { SuiClient } from "@mysten/sui/client";
const client = new SuiClient({ url: "https://fullnode.mainnet.sui.io:443" });

const REWARD_KEYWORDS = ["claim", "reward", "harvest", "collect", "redeem", "earn", "incentive", "emission"];

async function checkPackage(label: string, pkg: string) {
  console.log(`\n=== [${label}] ${pkg.slice(0, 24)}... ===`);
  try {
    const norm = await client.getNormalizedMoveModulesByPackage({ package: pkg });
    const modules = Object.keys(norm);
    console.log(`Modules: ${modules.join(", ")}`);

    let hasVersionGuard = false;
    const rewardEntries: string[] = [];

    for (const mod of modules) {
      const normMod = norm[mod];
      for (const [fnName, fnDef] of Object.entries(normMod.exposedFunctions)) {
        const lower = fnName.toLowerCase();
        if (REWARD_KEYWORDS.some(k => lower.includes(k)) && fnDef.isEntry) {
          const params = fnDef.parameters.map(p => {
            const s = JSON.stringify(p);
            return s.match(/"name":"(\w+)"/)?.[1] ?? s.slice(0, 20);
          });
          rewardEntries.push(`  ✅ ${mod}::${fnName}(${params.slice(0,4).join(",")})`);
        }
        const allLower = mod + fnName;
        if (allLower.toLowerCase().includes("version") || allLower.toLowerCase().includes("versioned")) {
          hasVersionGuard = true;
        }
      }
      for (const [sName, sDef] of Object.entries(normMod.structs)) {
        if (sDef.fields?.some((f: any) => f.name === "version")) {
          hasVersionGuard = true;
        }
      }
    }

    console.log(`Version guard: ${hasVersionGuard ? "✅ YES" : "❌ NONE ⚠️"}`);
    if (rewardEntries.length > 0) {
      console.log(`Reward entry functions:\n${rewardEntries.join("\n")}`);
    }
  } catch (e: any) {
    console.log(`ERROR: ${e.message?.slice(0, 100)}`);
  }
}

async function main() {
  // Aftermath packages - find real addresses via their Sui mainnet deployments
  const TARGETS = [
    // From Aftermath SDK / their GitHub
    { label: "Aftermath Staking af_sui", pkg: "0x7f6ce7ade63857c4fd16ef7783fed2dfc4d7fb7e40615abdb653030b76aef0c6" },
    { label: "Aftermath Farms v1", pkg: "0x1eabed72c53feb3805120a081dc15963c204dc8d091542592abaf7a35689b2fb" },
    // Spring Sui liquid staking
    { label: "Spring Sui staking", pkg: "0x3f45e3be6278a8b9d89d3ac44b71d4c07c6a0f1e84b07daf" },
    // Bucket Protocol BUCK
    { label: "Bucket Protocol", pkg: "0xce7ff77a83ea0cb6fd39bd8748e2ec89a3f41e8efdc3f4eb123e0ca37b184db2" },
  ];

  for (const t of TARGETS) {
    await checkPackage(t.label, t.pkg);
    await new Promise(r => setTimeout(r, 200));
  }
}
main().catch(console.error);
