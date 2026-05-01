/**
 * Scan Bluefin and Typus Perp for AftermathFi/Volo patterns
 */
import { SuiClient } from "@mysten/sui/client";
const client = new SuiClient({ url: "https://fullnode.mainnet.sui.io:443" });

const FEE_KEYWORDS = ["fee", "rate", "commission", "bps", "spread", "rebate", "discount", "builder", "referral", "partner"];
const ADMIN_KEYWORDS = ["admincap", "ownercap", "operator", "authority", "authoritycap", "admin_cap", "owner_cap", "governancecap"];

async function scanProtocol(label: string, pkg: string) {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`[${label}] ${pkg.slice(0, 28)}...`);

  try {
    const norm = await client.getNormalizedMoveModulesByPackage({ package: pkg });
    const modules = Object.keys(norm);
    console.log(`Modules: ${modules.join(", ")}`);

    for (const mod of modules) {
      const normMod = norm[mod];
      
      // Check for fee-related structs (AftermathFi pattern)
      for (const [sName, sDef] of Object.entries(normMod.structs)) {
        const feeFields = sDef.fields?.filter((f: any) => 
          FEE_KEYWORDS.some(k => f.name.toLowerCase().includes(k))
        ).map((f: any) => f.name) ?? [];
        if (feeFields.length > 0) {
          console.log(`  [STRUCT] ${mod}::${sName} has fee fields: ${feeFields.join(", ")}`);
        }
      }

      // Check entry functions for fee/rate params without admin
      for (const [fnName, fnDef] of Object.entries(normMod.exposedFunctions)) {
        if (!fnDef.isEntry) continue;
        
        const params = fnDef.parameters.map((p, i) => {
          const s = JSON.stringify(p);
          const name = s.match(/"name":"(\w+)"/)?.[1] ?? `p${i}`;
          const isI64 = s.includes('"I64"') || s.includes('"i64"') || s.includes('"I128"') || s.includes("I32");
          const isAdmin = ADMIN_KEYWORDS.some(k => name.toLowerCase().includes(k));
          const isFee = FEE_KEYWORDS.some(k => name.toLowerCase().includes(k));
          return { name, isI64, isAdmin, isFee };
        });

        const hasFeeParm = params.some(p => p.isFee);
        const requiresAdmin = params.some(p => p.isAdmin);
        const hasSignedInt = params.some(p => p.isI64);
        const fnLower = fnName.toLowerCase();

        // AftermathFi: fee param, NO admin cap
        if (hasFeeParm && !requiresAdmin) {
          const ps = params.map(p => `${p.isFee?"[fee]":""}${p.isI64?"[I64!]":""}${p.name}`).join(", ");
          console.log(`  🔴 AftermathFi? ${mod}::${fnName}(${ps})`);
        }
        
        // Signed integer, no admin - potential negative value issue
        if (hasSignedInt && !requiresAdmin) {
          const signedPs = params.filter(p => p.isI64).map(p => p.name).join(", ");
          console.log(`  🟡 Signed int (no admin): ${mod}::${fnName} - ${signedPs}`);
        }

        // Volo: admin-only fund withdrawal
        if (requiresAdmin && (fnLower.includes("withdraw") || fnLower.includes("drain") || fnLower.includes("transfer") || fnLower.includes("rescue"))) {
          const ps = params.map(p => p.name).slice(0,4).join(", ");
          console.log(`  ⚠️  Volo? ${mod}::${fnName}(${ps})`);
        }
      }
    }
  } catch (e: any) {
    console.log(`ERROR: ${e.message?.slice(0, 100)}`);
  }
}

async function main() {
  const TARGETS = [
    { label: "Bluefin Perps", pkg: "0xb9b92f069eb185d9fe1fcc988e7d89b3b48e5f58d879a0dbc4187bff8f8e6946" },
    { label: "Typus Perp v1 (pre Jan 2026)", pkg: "0xe27969a70f93034de9ce16e6ad661b480324574e68d15a64b513fd90eb2423e5" },
    { label: "Typus Perp v2 (post Jan 2026)", pkg: "0x9003219180252ae6b81d2893b41d430488669027219537236675c0c2924c94d9" },
  ];
  for (const t of TARGETS) {
    await scanProtocol(t.label, t.pkg);
    await new Promise(r => setTimeout(r, 300));
  }
  console.log("\n=== DONE ===");
}
main().catch(console.error);
