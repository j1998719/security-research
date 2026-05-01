import { SuiClient } from "@mysten/sui/client";
const client = new SuiClient({ url: "https://fullnode.mainnet.sui.io:443" });

// Old Borrow Incentive from Scallop SDK
const OLD_BORROW_INCENTIVE = "0xc63072e7f5f4983a2efaf5bdba1480d5e7d74d57948e1c7cc436f8e22cbeb410";
const DUMMY = "0x0000000000000000000000000000000000000000000000000000000000001337";

async function main() {
  console.log("=== Scallop Old Borrow Incentive (correct address) ===\n");
  
  try {
    const norm = await client.getNormalizedMoveModulesByPackage({ package: OLD_BORROW_INCENTIVE });
    const mods = Object.keys(norm);
    console.log(`Modules: ${mods.join(", ")}`);
    
    for (const [mod, modDef] of Object.entries(norm)) {
      // Check for version guard
      if (/version/i.test(mod)) console.log(`✅ Version guard module: ${mod}`);
      
      for (const [fnName, fn] of Object.entries(modDef.exposedFunctions)) {
        if (/version/i.test(fnName)) console.log(`✅ Version fn: ${mod}::${fnName}`);
        
        // Check open reward functions
        if (fn.isEntry && /claim|harvest|reward|stake/i.test(fnName)) {
          const params = fn.parameters.map(p => {
            const s = JSON.stringify(p);
            return s.match(/"name":"(\w+)"/)?.[1] ?? s.slice(0,30);
          });
          const hasAdmin = /Cap|Admin|Key|Obligation/i.test(JSON.stringify(fn.parameters));
          console.log(`${hasAdmin ? "🔒" : "⚠️"} ${mod}::${fnName}(${params.join(", ")})`);
        }
      }
      
      // Check for index patterns
      for (const [sName, st] of Object.entries(modDef.structs)) {
        const idxFields = st.fields?.filter(f => /index|reward_debt|acc_reward/i.test(f.name)) ?? [];
        if (idxFields.length > 0) {
          console.log(`  INDEX: ${mod}::${sName}.[${idxFields.map(f=>f.name).join(",")}]`);
        }
      }
    }
  } catch (e: any) { console.log("Error:", e.message?.slice(0,80)); }
}
main().catch(console.error);
