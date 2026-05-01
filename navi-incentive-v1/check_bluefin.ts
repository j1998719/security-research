import { SuiClient } from "@mysten/sui/client";
const client = new SuiClient({ url: "https://fullnode.mainnet.sui.io:443" });

const BLUEFIN_PKG = "0xc9ba51116d85cfbb401043f5e0710ab582c4b9b04a139b7df223f8f06bb66fa5";
const FEE_KW = ["fee", "rate", "commission", "bps", "spread", "rebate", "discount", "builder", "referral"];
const ADMIN_KW = ["admincap", "ownercap", "admin_cap", "owner_cap", "operator", "authority", "govern"];

async function main() {
  console.log("=== Bluefin Perps Package Scan ===\n");
  
  const norm = await client.getNormalizedMoveModulesByPackage({ package: BLUEFIN_PKG });
  const modules = Object.keys(norm);
  console.log(`Modules: ${modules.join(", ")}\n`);

  for (const mod of modules) {
    const normMod = norm[mod];
    const entries = Object.entries(normMod.exposedFunctions).filter(([,fn]) => (fn as any).isEntry);
    
    if (entries.length === 0) continue;
    
    const riskFns: string[] = [];
    
    for (const [fnName, fnDef] of entries as any) {
      const params = fnDef.parameters.map((p: any, i: number) => {
        const s = JSON.stringify(p);
        const name = s.match(/"name":"(\w+)"/)?.[1] ?? `p${i}`;
        const isI = s.includes('"I64"') || s.includes('"I128"') || s.includes('"I32"');
        const isAdmin = ADMIN_KW.some(k => name.toLowerCase().includes(k));
        const isFee = FEE_KW.some(k => name.toLowerCase().includes(k));
        return { name, isI, isAdmin, isFee };
      });
      
      const hasFee = params.some((p: any) => p.isFee);
      const hasAdmin = params.some((p: any) => p.isAdmin);
      const hasSigned = params.some((p: any) => p.isI);
      
      if (hasFee && !hasAdmin) {
        const ps = params.map((p: any) => `${p.isFee?"[fee]":""}${p.isI?"[I!]":""}${p.name}`).join(",");
        riskFns.push(`  🔴 ${mod}::${fnName}(${ps})`);
      }
      if (hasSigned && !hasAdmin) {
        const sp = params.filter((p: any) => p.isI).map((p: any) => p.name).join(",");
        riskFns.push(`  🟡 ${mod}::${fnName} signed: ${sp}`);
      }
      const fnLower = fnName.toLowerCase();
      if (hasAdmin && (fnLower.includes("withdraw") || fnLower.includes("drain") || fnLower.includes("rescue"))) {
        riskFns.push(`  ⚠️  ${mod}::${fnName}(${params.map((p: any) => p.name).slice(0,4).join(",")})`);
      }
    }
    
    if (riskFns.length > 0) {
      console.log(`Module: ${mod}`);
      riskFns.forEach(f => console.log(f));
    }
  }
  
  // Also check for version guard in structs
  let hasVersionGuard = false;
  for (const [mod, normMod] of Object.entries(norm)) {
    for (const [sName, sDef] of Object.entries((normMod as any).structs ?? {})) {
      if ((sDef as any).fields?.some((f: any) => f.name === "version" || f.name === "version_id")) {
        hasVersionGuard = true;
      }
    }
    for (const [fnName] of Object.entries((normMod as any).exposedFunctions ?? {})) {
      if (fnName.toLowerCase().includes("version") || fnName.toLowerCase().includes("versioned")) {
        hasVersionGuard = true;
      }
    }
  }
  console.log(`\nVersion guard signals: ${hasVersionGuard ? "✅ YES" : "❌ NONE"}`);
  
  // Check all entry functions for open registration (builder/partner)
  console.log("\n--- Open registration entry functions ---");
  for (const [mod, normMod] of Object.entries(norm)) {
    for (const [fnName, fnDef] of Object.entries((normMod as any).exposedFunctions ?? {})) {
      if (!(fnDef as any).isEntry) continue;
      const lower = fnName.toLowerCase();
      if (lower.includes("register") || lower.includes("partner") || lower.includes("builder") || lower.includes("referral") || lower.includes("code")) {
        const params = ((fnDef as any).parameters ?? []).map((p: any, i: number) => {
          const s = JSON.stringify(p);
          return s.match(/"name":"(\w+)"/)?.[1] ?? `p${i}`;
        });
        const hasAdmin = params.some((p: string) => ADMIN_KW.some(k => p.toLowerCase().includes(k)));
        console.log(`  ${hasAdmin ? "🔒 admin" : "🔓 open"} ${mod}::${fnName}(${params.slice(0,5).join(",")})`);
      }
    }
  }
  
  // Recent activity
  const txs = await client.queryTransactionBlocks({
    filter: { InputObject: BLUEFIN_PKG },
    limit: 3,
    order: "descending",
  });
  console.log(`\nRecent txs: ${txs.data.length}`);
}
main().catch(console.error);
