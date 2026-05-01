/**
 * Check Nemo Protocol and Typus Finance for deprecated reward packages
 * Nemo: had Sep 2025 $2.6M exploit (already done), but may have other old packages
 */
import { SuiClient } from "@mysten/sui/client";
const client = new SuiClient({ url: "https://fullnode.mainnet.sui.io:443" });

const REWARD_KEYWORDS = ["claim", "reward", "harvest", "collect", "redeem", "earn", "incentive"];

async function checkPkg(label: string, pkg: string) {
  console.log(`\n=== [${label}] ${pkg.slice(0, 28)}... ===`);
  try {
    const norm = await client.getNormalizedMoveModulesByPackage({ package: pkg });
    const modules = Object.keys(norm);
    console.log(`Modules: ${modules.join(", ")}`);

    let hasVersionGuard = false;
    const rewardEntries: string[] = [];
    const indexPatterns: string[] = [];

    for (const mod of modules) {
      const normMod = norm[mod];
      for (const [fnName, fnDef] of Object.entries(normMod.exposedFunctions)) {
        if (fnDef.isEntry && REWARD_KEYWORDS.some(k => fnName.toLowerCase().includes(k))) {
          const params = fnDef.parameters.map(p => {
            const s = JSON.stringify(p);
            return s.match(/"name":"(\w+)"/)?.[1] ?? "?";
          });
          rewardEntries.push(`  ✅ ${mod}::${fnName}(${params.slice(0,4).join(",")})`);
        }
        const allLower = (mod + fnName).toLowerCase();
        if (allLower.includes("version") || allLower.includes("versioned")) hasVersionGuard = true;
      }
      for (const [sName, sDef] of Object.entries(normMod.structs)) {
        if (sDef.fields?.some((f: any) => f.name === "version")) hasVersionGuard = true;
        const idxFields = sDef.fields?.filter((f: any) =>
          f.name.includes("index") || f.name.includes("reward_debt") || f.name === "accrued_rewards"
        ).map((f: any) => f.name);
        if (idxFields && idxFields.length > 0) {
          indexPatterns.push(`${mod}::${sName}[${idxFields.join(",")}]`);
        }
      }
    }

    console.log(`Version guard: ${hasVersionGuard ? "✅ YES" : "❌ NONE ⚠️"}`);
    if (indexPatterns.length > 0) console.log(`INDEX PATTERNS: ${indexPatterns.slice(0,4).join("; ")}`);
    if (rewardEntries.length > 0) console.log(`Reward entries:\n${rewardEntries.join("\n")}`);

    // Recent activity check
    const txs = await client.queryTransactionBlocks({
      filter: { InputObject: pkg },
      limit: 3,
      order: "descending",
    });
    console.log(`Recent pkg txs: ${txs.data.length}`);
  } catch (e: any) {
    console.log(`ERROR: ${e.message?.slice(0, 100)}`);
  }
}

async function main() {
  // Nemo Protocol packages from nemo-protocol GitHub (search for mainnet addresses)
  // Their staking/yield split packages
  const TARGETS = [
    // Nemo Protocol - mainnet packages (from nemo SDK / suiscan)
    { label: "Nemo Protocol (PT/YT split)", pkg: "0x937ac6c4aff06d5fd155b19acc00491d9e5f5570f973024c6f6a0a29ffc39aea" },
    // Nemo might have farming/incentive package
    { label: "Nemo Incentive (guess)", pkg: "0xbe61fc4f83df1b81975e3da6fef78c33e07eebc8e17da48e2fbb45bd52e6a8f5" },
    // Typus Finance - DOV (DeFi Option Vault) staking  
    { label: "Typus Finance DOV", pkg: "0xf82dc05634970553615eef6112a1ac4fb7bf10272bf6cbe0f80ef44a6c489385" },
    // Typus v2 staking
    { label: "Typus v2 (staking)", pkg: "0x4a2a24c6e9f5f1f9e60a6e9c1d2b5a9e7c8f0d3b2e5a8c1f4b7e0d3c6f9a2b5e8" },
  ];

  for (const t of TARGETS) {
    await checkPkg(t.label, t.pkg);
    await new Promise(r => setTimeout(r, 200));
  }
}
main().catch(console.error);
