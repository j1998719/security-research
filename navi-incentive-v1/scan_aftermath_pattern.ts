/**
 * Scan for AftermathFi-type vulnerability:
 * Non-admin can set a rate/fee/multiplier parameter that feeds into fund movement
 * 
 * Pattern: entry fn with (fee/rate param: U64 | I64) NOT requiring AdminCap/OwnerCap
 * 
 * Also scan for Volo-type: single AdminCap controlling large fund movement with no timelock
 */
import { SuiClient } from "@mysten/sui/client";
const client = new SuiClient({ url: "https://fullnode.mainnet.sui.io:443" });

// Fee/rate related parameter names (lowercase)
const FEE_KEYWORDS = ["fee", "rate", "factor", "commission", "bps", "spread", "rebate", "discount", "multiplier", "slippage"];
// Admin/capability keywords
const ADMIN_KEYWORDS = ["admincap", "ownercap", "operator", "authority", "authoritycap", "admin_cap", "owner_cap"];

async function scanProtocol(label: string, pkg: string) {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`[${label}] ${pkg.slice(0, 24)}...`);

  try {
    const norm = await client.getNormalizedMoveModulesByPackage({ package: pkg });
    const modules = Object.keys(norm);
    console.log(`Modules: ${modules.join(", ")}`);

    const riskFns: string[] = [];  // AftermathFi pattern
    const adminFns: string[] = []; // Volo pattern candidates

    for (const mod of modules) {
      const normMod = norm[mod];
      for (const [fnName, fnDef] of Object.entries(normMod.exposedFunctions)) {
        if (!fnDef.isEntry) continue;

        const params = fnDef.parameters.map((p, i) => {
          const s = JSON.stringify(p);
          const name = s.match(/"name":"(\w+)"/)?.[1] ?? `p${i}`;
          const isU64 = s.includes('"U64"') || s.includes('"u64"');
          const isI64 = s.includes('"I64"') || s.includes('"i64"') || s.includes('"I128"');
          const isMut = s.includes("MutableReference");
          const isAdmin = ADMIN_KEYWORDS.some(k => name.toLowerCase().includes(k));
          return { name, isU64, isI64, isMut, isAdmin };
        });

        // Check if ANY param looks like a fee/rate (by name)
        const hasFeeParm = params.some(p => FEE_KEYWORDS.some(k => p.name.toLowerCase().includes(k)));
        // Check if the function requires an admin capability
        const requiresAdmin = params.some(p => p.isAdmin);
        // Check if any param is I64 (signed int = could go negative)
        const hasSignedInt = params.some(p => p.isI64);

        if (hasFeeParm && !requiresAdmin) {
          // AftermathFi pattern: fee param, no admin required
          const paramStr = params.map(p => `${p.name}${p.isI64 ? "(I64!)" : p.isU64 ? "(u64)" : ""}`).join(", ");
          riskFns.push(`  🔴 ${mod}::${fnName}(${paramStr})`);
        } else if (hasFeeParm && requiresAdmin) {
          // Admin-gated fee setter - less risky but note it
        }

        if (hasSignedInt && !requiresAdmin) {
          // Signed integer parameter accessible to anyone
          const paramStr = params.filter(p => p.isI64).map(p => p.name).join(", ");
          riskFns.push(`  🟡 ${mod}::${fnName} - signed param(s): ${paramStr}`);
        }

        // Volo pattern: entry fn that moves Coin/Balance, requires only AdminCap
        const fnLower = fnName.toLowerCase();
        if ((fnLower.includes("withdraw") || fnLower.includes("drain") || fnLower.includes("rescue")) && requiresAdmin) {
          const paramStr = params.map(p => p.name).join(", ");
          adminFns.push(`  ⚠️  ${mod}::${fnName}(${paramStr})`);
        }
      }
    }

    if (riskFns.length > 0) {
      console.log(`\n[AftermathFi pattern - non-admin fee/rate setters]:`);
      riskFns.forEach(f => console.log(f));
    } else {
      console.log(`  No AftermathFi-type risk found`);
    }

    if (adminFns.length > 0) {
      console.log(`\n[Volo pattern - admin withdraw functions]:`);
      adminFns.forEach(f => console.log(f));
    }
  } catch (e: any) {
    console.log(`ERROR: ${e.message?.slice(0, 100)}`);
  }
}

async function main() {
  // Will be populated with addresses from agent search
  // For now, scan known Sui DeFi packages we already have
  const TARGETS = [
    // Aftermath Finance AMM (not Perps - Perps was the exploited one)
    { label: "Aftermath AMM", pkg: "0xefe8b36d5b2e43728cc323298626b83177803521d195cfb11e15b031e" },
    // Haedal liquid staking (already checked in round 1, but scan for Volo pattern)
    { label: "Haedal Protocol", pkg: "0xbde4ba4c2e274a60ce15c1cfff9e5c42e41654ac8b6d906a57efa4bd3c29f47d" },
    // NAVI lending (v2 main package)
    { label: "NAVI Lending v2", pkg: "0x834a86970ae93a73faf4fff12634e7a7c69f1b68fc65e59c4061a03cd31be9e2" },
    // Scallop lending main
    { label: "Scallop Lending", pkg: "0xefe8b36d5b2e43728cc323298626b83177803521d195cfb11e15b910e892fddf" },
    // Cetus current (for comparison)
    { label: "Cetus CLMM current", pkg: "0x1eabed72c53feb3805120a081dc15963c204dc8d091542592abaf7a35689b2fb" },
  ];

  for (const t of TARGETS) {
    await scanProtocol(t.label, t.pkg);
    await new Promise(r => setTimeout(r, 200));
  }

  console.log("\n\n=== SCAN COMPLETE ===");
  console.log("🔴 = AftermathFi pattern (non-admin can set fee/rate)");
  console.log("🟡 = Signed integer params (potential negative value issue)");
  console.log("⚠️  = Admin-only withdraw (Volo type risk if admin key compromised)");
}
main().catch(console.error);
