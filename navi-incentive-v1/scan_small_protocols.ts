/**
 * Scan smaller Sui DeFi protocols for NAVI/Scallop-type vulnerabilities
 * Strategy: find packages with claim_reward/harvest entry fns + no version guard
 */
import { SuiClient } from "@mysten/sui/client";
const client = new SuiClient({ url: "https://fullnode.mainnet.sui.io:443" });

// Smaller Sui DeFi protocols - sourced from ecosystem listings
const CANDIDATES = [
  // Liquid staking
  { label: "Aftermath LST", pkg: "0x549e8b69173537e32f85a87d1a9b5a11a76ae540e97bcd54c49e3b7c33a6d7f5" },
  { label: "Hasui (Haedal)", pkg: "0xbde4ba4c2e274a60ce15c1cfff9e5c42e41654ac8b6d906a57efa4bd3c29f47d" },
  // Farming / yield aggregator
  { label: "SuiFarm", pkg: "0x1eabed72c53feb3805120a081dc15963c204dc8d091542592abaf7a35689b2fb" },
  { label: "Doubleup", pkg: "0x4f5d79e3b3a0f5a87c82c76b0e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7" },
  // Interest Protocol
  { label: "Interest Protocol", pkg: "0x5306f64e312b581766351c07af79c72fcb1cd25147157fdc2f8ad76de9a3fb6a" },
  // Ondo Finance on Sui
  { label: "Ondo on Sui", pkg: "0x3a5143bb1196e3bcdfee49a59cdc0b6e8ff49f48d9a18e4e5f3d6e5c0f2b8e9c" },
  // DeepBook v3
  { label: "DeepBook", pkg: "0x2c8d603bc51326b8c13cef9dd07031a408a48dddb541963357661df5d3204809" },
  // Turbos CLMM farming
  { label: "Turbos Farm", pkg: "0x9632f61a796fc54952d9151d80b319b623b91b21b4e9e4e7df7e2a0b9c8f6f62" },
  // SuiNS staking
  { label: "SuiNS", pkg: "0x22fa05f21b1ad71442491220bb9338f7b7095fe35000ef88d5400d28523bdd93" },
  // Momentum Safe
  { label: "Sui Liquid", pkg: "0xf5ff7d5ba73b581bca6b4b9fa0049cd320360abd154b809f8700a8fd3cfaf91" },
];

const REWARD_KEYWORDS = ["claim", "reward", "harvest", "collect", "redeem", "emission", "incentive"];
const INDEX_KEYWORDS = ["index", "reward_debt", "acc_reward", "last_index", "rewards_paid"];
const VERSION_SIGNALS = ["version", "guard", "versioned", "verify_version", "check_version"];

async function checkProtocol(label: string, pkg: string): Promise<{
  label: string, risk: string, details: string[]
}> {
  const details: string[] = [];
  let hasVersionGuard = false;
  let hasRewardEntry = false;
  let hasIndexPattern = false;
  let modules: string[] = [];

  try {
    const norm = await client.getNormalizedMoveModulesByPackage({ package: pkg });
    modules = Object.keys(norm);
  } catch (e: any) {
    return { label, risk: "SKIP", details: [`Package error: ${e.message?.slice(0,40)}`] };
  }

  // Check each module
  for (const mod of modules) {
    try {
      const normMod = await client.getNormalizedMoveModule({ package: pkg, module: mod });
      
      // Version guard check
      if (VERSION_SIGNALS.some(s => mod.toLowerCase().includes(s))) {
        hasVersionGuard = true;
        details.push(`version guard module: ${mod}`);
      }
      
      for (const [fnName, fn] of Object.entries(normMod.exposedFunctions)) {
        const lower = fnName.toLowerCase();
        
        // Version guard in function names
        if (VERSION_SIGNALS.some(s => lower.includes(s))) {
          hasVersionGuard = true;
        }
        
        // Reward entry functions
        if (REWARD_KEYWORDS.some(k => lower.includes(k)) && fn.isEntry) {
          // Check if requires admin/cap
          const paramStr = JSON.stringify(fn.parameters);
          const requiresAdmin = /Cap|Admin|Key|Authority|Governance/i.test(paramStr);
          if (!requiresAdmin) {
            hasRewardEntry = true;
            details.push(`⚠️ reward entry (no admin): ${mod}::${fnName}`);
          }
        }
      }
      
      // Index pattern in structs
      for (const [structName, struct] of Object.entries(normMod.structs)) {
        const indexFields = struct.fields?.filter(f => 
          INDEX_KEYWORDS.some(k => f.name.toLowerCase().includes(k))
        ) ?? [];
        if (indexFields.length > 0) {
          hasIndexPattern = true;
          details.push(`index pattern: ${mod}::${structName}.[${indexFields.map(f => f.name).join(",")}]`);
        }
      }
    } catch {}
  }

  // Version guard check via struct fields
  if (!hasVersionGuard) {
    for (const mod of modules.slice(0, 5)) {
      try {
        const normMod = await client.getNormalizedMoveModule({ package: pkg, module: mod });
        for (const [name, struct] of Object.entries(normMod.structs)) {
          if (struct.fields?.some(f => f.name === "version" || f.name === "version_id")) {
            hasVersionGuard = true;
            break;
          }
        }
      } catch {}
      if (hasVersionGuard) break;
    }
  }

  let risk = "SAFE";
  if (hasRewardEntry && hasIndexPattern && !hasVersionGuard) {
    risk = "🔴 HIGH";
  } else if (hasRewardEntry && !hasVersionGuard) {
    risk = "🟡 MEDIUM";
  } else if (hasIndexPattern && !hasVersionGuard) {
    risk = "🟡 MEDIUM";
  }

  details.push(`modules(${modules.length}): ${modules.slice(0,6).join(",")}`);
  details.push(`versionGuard=${hasVersionGuard} rewardEntry=${hasRewardEntry} indexPattern=${hasIndexPattern}`);
  
  return { label, risk, details };
}

async function main() {
  console.log("=== Small Protocol Scan ===\n");
  
  const results = [];
  for (const c of CANDIDATES) {
    const r = await checkProtocol(c.label, c.pkg);
    results.push(r);
    const indicator = r.risk.includes("HIGH") ? "🔴" : r.risk.includes("MEDIUM") ? "🟡" : r.risk === "SKIP" ? "⬛" : "✅";
    console.log(`${indicator} [${r.label}] ${r.risk}`);
    for (const d of r.details.filter(d => d.startsWith("⚠️") || d.startsWith("index"))) {
      console.log(`   ${d}`);
    }
    await new Promise(r => setTimeout(r, 150));
  }

  console.log("\n=== Summary ===");
  const risky = results.filter(r => r.risk.includes("HIGH") || r.risk.includes("MEDIUM"));
  if (risky.length === 0) {
    console.log("No high/medium risk protocols found in this batch");
  } else {
    for (const r of risky) {
      console.log(`${r.risk}: ${r.label}`);
      r.details.forEach(d => console.log(`  ${d}`));
    }
  }
}
main().catch(console.error);
