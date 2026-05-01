import { SuiClient } from "@mysten/sui/client";
import { Transaction } from "@mysten/sui/transactions";
const client = new SuiClient({ url: "https://fullnode.mainnet.sui.io:443" });

const DUMMY = "0x0000000000000000000000000000000000000000000000000000000000001337";

// From Typus config-mainnet.json
const PACKAGES = [
  // PACKAGE_ORIGIN (deprecated original versions)
  { label: "DOV_SINGLE_ORIGIN", pkg: "0x321848bf1ae327a9e022ccb3701940191e02fa193ab160d9c0e49cd3c003de3a" },
  { label: "PERP_ORIGIN", pkg: "0x9003219180252ae6b81d2893b41d430488669027219537236675c0c2924c94d9" },
  { label: "STAKE_POOL (unchanged)", pkg: "0xd280f3a072bca4b7b5b450f40c82a30b3935cd1d12d927eb9d1f790520a83d3b" },
  { label: "SAFU_ORIGIN", pkg: "0xa7bedeaa28ff3defa50d012812618178727f530bc5a70af5d03fc6424a984cc7" },
  { label: "TYPUS_ORIGIN", pkg: "0x4b0f4ee1a40ce37ec81c987cc4e76a665419e74b863319492fc7d26f708b835a" },
  { label: "FRAMEWORK_ORIGIN", pkg: "0xb4f25230ba74837d8299e92951306100c4a532e8c48cc3d8828abe9b91c8b274" },
  // PACKAGE (current upgraded versions for comparison)
  { label: "DOV_SINGLE_CURRENT", pkg: "0xcf20d3a2a6f31a0d04d0aa93840491ceb5dc6181d5ae0eeb2669458222ec08a6" },
  { label: "PERP_CURRENT", pkg: "0x347af1dcb901d78c2b8b3de307792b2fe3f70dfc67061e0ed894f34484c00c1d" },
];

const REWARD_KEYWORDS = ["claim", "harvest", "reward", "redeem", "collect", "earn"];
const INDEX_FIELDS = ["last_index", "index_rewards_paid", "reward_debt", "acc_reward", "index", "reward_index", "accumulated_reward"];

async function scanPkg(label: string, pkg: string) {
  try {
    const norm = await client.getNormalizedMoveModulesByPackage({ package: pkg });
    const mods = Object.keys(norm);
    
    let hasVersionGuard = false;
    const openFns: string[] = [];
    const indexPatterns: string[] = [];
    
    for (const [mod, modDef] of Object.entries(norm)) {
      if (/version|guard/i.test(mod)) hasVersionGuard = true;
      
      for (const [fnName, fn] of Object.entries(modDef.exposedFunctions)) {
        if (/version/i.test(fnName)) hasVersionGuard = true;
        
        if ((fn.isEntry || fn.visibility === "Public") && 
            REWARD_KEYWORDS.some(k => fnName.toLowerCase().includes(k))) {
          const paramStr = JSON.stringify(fn.parameters);
          const hasAdmin = /Cap|Admin|Key|Auth|Operator/i.test(paramStr);
          if (!hasAdmin && fn.visibility !== "Friend" && !(fn.visibility === "Private" && !fn.isEntry)) {
            openFns.push(`${mod}::${fnName}(entry=${fn.isEntry})`);
          }
        }
      }
      
      for (const [sName, st] of Object.entries(modDef.structs)) {
        // Look specifically for reward accumulator patterns
        const idxFields = st.fields?.filter(f => {
          const name = f.name.toLowerCase();
          return name === "last_index" || name === "index_rewards_paid" || 
                 name === "reward_debt" || name === "acc_reward_per_share" ||
                 name === "reward_per_share" || name === "index_per_share" ||
                 (name === "index" && sName.toLowerCase().includes("user")) ||
                 (name === "index" && sName.toLowerCase().includes("stake")) ||
                 (name === "index" && sName.toLowerCase().includes("position"));
        }) ?? [];
        if (idxFields.length > 0) {
          indexPatterns.push(`${mod}::${sName}.[${idxFields.map(f=>f.name).join(",")}]`);
        }
      }
    }
    
    const risk = !hasVersionGuard && openFns.length > 0 && indexPatterns.length > 0 ? "🔴 HIGH" :
                 !hasVersionGuard && openFns.length > 0 ? "🟡 MEDIUM" :
                 !hasVersionGuard && indexPatterns.length > 0 ? "🟡 CHECK" : "✅";
    
    const indicator = risk.includes("HIGH") ? "🔴" : risk.includes("MEDIUM") || risk.includes("CHECK") ? "🟡" : "✅";
    console.log(`${indicator} [${label}]`);
    if (risk !== "✅") {
      console.log(`   pkg: ${pkg.slice(0,24)}...`);
      console.log(`   modules: ${mods.slice(0,6).join(",")}`);
      openFns.forEach(f => console.log(`   open: ${f}`));
      indexPatterns.forEach(p => console.log(`   index: ${p}`));
      console.log(`   versionGuard: ${hasVersionGuard}`);
    }
    
    return { risk, openFns, indexPatterns, hasVersionGuard, mods };
  } catch (e: any) {
    console.log(`⬛ [${label}] ${e.message?.slice(0,60)}`);
    return null;
  }
}

async function main() {
  console.log("=== Typus Finance Package Scan ===\n");
  
  const results = new Map<string, any>();
  for (const p of PACKAGES) {
    const r = await scanPkg(p.label, p.pkg);
    if (r) results.set(p.label, { ...r, pkg: p.pkg });
    await new Promise(r => setTimeout(r, 200));
  }
  
  // Deep dive any flagged packages
  const risky = [...results.entries()].filter(([, v]) => v.risk !== "✅");
  
  if (risky.length > 0) {
    console.log("\n=== Deep Dive on Flagged Packages ===\n");
    for (const [label, info] of risky) {
      console.log(`\n--- ${label}: ${info.pkg?.slice(0,24)} ---`);
      // Show full module list
      console.log(`All modules: ${info.mods.join(", ")}`);
      
      // Check recent activity
      try {
        const txs = await client.queryTransactionBlocks({
          filter: { InputObject: info.pkg },
          limit: 3, order: "descending",
        });
        console.log(`Recent txs: ${txs.data.length}`);
        if (txs.data.length > 0) {
          console.log(`Latest @ cp ${txs.data[0].checkpoint}`);
        }
      } catch {}
    }
  }
}
main().catch(console.error);
