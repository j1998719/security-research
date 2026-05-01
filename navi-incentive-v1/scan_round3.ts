/**
 * Round 3 scan: FlowX CLMM, Scallop veSCA, Kriya AMM, Kai Finance kSUI
 * Looking for: no version guard + reward entry fn + uninitialized user index
 */
import { SuiClient } from "@mysten/sui/client";
const client = new SuiClient({ url: "https://fullnode.mainnet.sui.io:443" });

const TARGETS = [
  { label: "FlowX CLMM FaaS", pkg: "0x25929e7f29e0a30eb4e692952ba1b5b65a3a4d65ab5f2a32e1ba3edcb587f26d" },
  { label: "Scallop veSCA", pkg: "0x1158813b32962c2d22888fae257d5f2365b03631f0cd5d5b912ccdf51ff4e2f2" },
  { label: "Kriya AMM", pkg: "0xa0eba10b173538c8fecca1dff298e488402cc9ff374f8a12ca7758eebe830b66" },
  { label: "Kai Finance kSUI", pkg: "0xfa7ac3951fdca92c5200d468d31a365eb03b2be9936fde615e69f0c1274ad3a0" },
];

// Keywords for reward/incentive entry functions
const REWARD_KEYWORDS = ["claim", "reward", "harvest", "collect", "redeem", "earn", "incentive", "emission"];

async function checkPackage(label: string, pkg: string) {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`[${label}] ${pkg.slice(0, 20)}...`);

  // 1. Get all modules
  let modules: string[] = [];
  try {
    const norm = await client.getNormalizedMoveModulesByPackage({ package: pkg });
    modules = Object.keys(norm);
    console.log(`  Modules (${modules.length}): ${modules.join(", ")}`);
  } catch (e: any) {
    console.log(`  ERROR getting modules: ${e.message?.slice(0, 80)}`);
    return;
  }

  // 2. For each module, find entry functions related to rewards
  const interestingFns: { module: string; fn: string; isEntry: boolean; params: string[] }[] = [];
  const versionGuardFound: string[] = [];

  for (const mod of modules) {
    try {
      const normMod = await client.getNormalizedMoveModule({ package: pkg, module: mod });
      for (const [fnName, fnDef] of Object.entries(normMod.exposedFunctions)) {
        const lower = fnName.toLowerCase();
        const isRewardFn = REWARD_KEYWORDS.some(k => lower.includes(k));
        if (isRewardFn) {
          const paramTypes = fnDef.parameters.map(p => {
            const s = JSON.stringify(p);
            const name = s.match(/"name":"(\w+)"/)?.[1] ?? s.slice(0, 40);
            return name;
          });
          interestingFns.push({ module: mod, fn: fnName, isEntry: fnDef.isEntry, params: paramTypes });
        }

        // Check for version guard patterns in struct names
        const lower2 = mod.toLowerCase() + fnName.toLowerCase();
        if (lower2.includes("version") || lower2.includes("guard") || lower2.includes("versioned")) {
          versionGuardFound.push(`${mod}::${fnName}`);
        }
      }
    } catch {}
  }

  // 3. Check structs for version field
  for (const mod of modules.slice(0, 8)) {
    try {
      const normMod = await client.getNormalizedMoveModule({ package: pkg, module: mod });
      for (const [structName, structDef] of Object.entries(normMod.structs)) {
        const hasVersion = structDef.fields?.some(f => f.name === "version" || f.name === "version_id");
        if (hasVersion) {
          versionGuardFound.push(`struct ${mod}::${structName} has version field`);
        }
        // Check for index-tracking fields (reward accumulator pattern)
        const hasIndex = structDef.fields?.some(f =>
          f.name.includes("index") || f.name.includes("reward_debt") || f.name.includes("acc_reward")
        );
        if (hasIndex) {
          const indexFields = structDef.fields?.filter(f =>
            f.name.includes("index") || f.name.includes("reward_debt") || f.name.includes("acc_reward")
          ).map(f => f.name);
          console.log(`  [INDEX PATTERN] ${mod}::${structName} → fields: ${indexFields?.join(", ")}`);
        }
      }
    } catch {}
  }

  console.log(`\n  Version guard signals: ${versionGuardFound.length > 0 ? versionGuardFound.slice(0, 3).join("; ") : "NONE FOUND ⚠️"}`);

  if (interestingFns.length === 0) {
    console.log(`  No reward-related entry functions found`);
  } else {
    console.log(`\n  Reward-related functions (${interestingFns.length}):`);
    for (const f of interestingFns) {
      const entryMark = f.isEntry ? "✅ entry" : "   public";
      console.log(`  ${entryMark} ${f.module}::${f.fn}(${f.params.slice(0, 4).join(", ")})`);
    }
  }

  // 4. Check recent transactions
  try {
    const recentTxs = await client.queryTransactionBlocks({
      filter: { InputObject: pkg },
      options: { showInput: false },
      limit: 5,
      order: "descending",
    });
    console.log(`\n  Recent txs using this pkg: ${recentTxs.data.length}`);
    if (recentTxs.data.length > 0) {
      console.log(`  Latest: ${recentTxs.data[0].digest.slice(0, 20)} @ checkpoint ${recentTxs.data[0].checkpoint}`);
    }
  } catch {}
}

async function main() {
  for (const t of TARGETS) {
    await checkPackage(t.label, t.pkg);
    await new Promise(r => setTimeout(r, 300));
  }

  console.log("\n\n=== SUMMARY ===");
  console.log("Review above for:");
  console.log("  - [INDEX PATTERN] structs → potential reward accumulator");
  console.log("  - '✅ entry' functions → directly callable");
  console.log("  - 'NONE FOUND' version guard → unprotected deprecated package");
}

main().catch(console.error);
