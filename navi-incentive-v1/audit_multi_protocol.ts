/**
 * Multi-Protocol Deprecated Contract Audit
 * Targets: Cetus CLMM, integrate; Suilend; Kriya
 * Checks: deprecated (package_id ≠ published_at) entry functions with reward/claim semantics
 */
import { SuiClient } from "@mysten/sui/client";
const client = new SuiClient({ url: "https://fullnode.mainnet.sui.io:443" });

const TARGETS = [
  // Cetus CLMM original package (deprecated — published_at differs)
  { label: "Cetus clmm_pool (original)", pkg: "0x1eabed72c53feb3805120a081dc15963c204dc8d091542592abaf7a35689b2fb" },
  // Cetus integrate original package
  { label: "Cetus integrate (original)", pkg: "0x996c4d9480708fb8b92aa7acf819fb0497b5ec8e65ba06601cae2fb6db3312c3" },
  // Cetus config package
  { label: "Cetus config", pkg: "0x95b8d278b876cae22206131fb9724f701c9444515813042f54f0a426c9a3bc2f" },
  // Suilend main pool
  { label: "Suilend main package", pkg: "0xf95b06141ed4a174f239417323bde3f209b972f5930d8521ea38a52aff3a6ddf" },
  // SpringSui
  { label: "SpringSui", pkg: "0x83556891f4a0f233ce7b05cfe7f957d4020492a34f5405b2cb9377d060bef4bf" },
];

const REWARD_KEYWORDS = ["claim", "reward", "harvest", "redeem", "collect", "stake", "unstake", "withdraw_reward", "collect_fee"];

async function main() {
  for (const { label, pkg } of TARGETS) {
    console.log(`\n${"=".repeat(60)}`);
    console.log(`${label}`);
    console.log(`Package: ${pkg.slice(0, 26)}...`);

    try {
      const modules = await client.getNormalizedMoveModulesByPackage({ package: pkg });
      const modNames = Object.keys(modules);
      console.log(`Modules (${modNames.length}): ${modNames.join(", ").slice(0, 100)}`);

      const rewardFns: { mod: string; fn: string; isEntry: boolean }[] = [];
      for (const [modName, modData] of Object.entries(modules)) {
        const fns = (modData as any).exposedFunctions ?? {};
        for (const [fnName, fnData] of Object.entries(fns)) {
          const isReward = REWARD_KEYWORDS.some(kw => fnName.toLowerCase().includes(kw));
          if (isReward) {
            rewardFns.push({ mod: modName, fn: fnName, isEntry: (fnData as any).isEntry });
          }
        }
      }

      if (rewardFns.length === 0) {
        console.log("  No reward/claim functions found");
      } else {
        console.log(`  Reward-related functions (${rewardFns.length}):`);
        for (const { mod, fn, isEntry } of rewardFns) {
          const mark = isEntry ? "[entry]" : "[pub  ]";
          console.log(`    ${mark} ${mod}::${fn}`);
        }
      }
    } catch (e: any) {
      console.log(`  Error: ${e.message?.slice(0, 80)}`);
    }
  }
}
main().catch(console.error);
