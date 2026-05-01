import { SuiClient } from "@mysten/sui/client";
import { Transaction } from "@mysten/sui/transactions";
const client = new SuiClient({ url: "https://fullnode.mainnet.sui.io:443" });

// Nemo Protocol mainnet addresses
const NEMO_CONTRACT = "0x2b71664477755b90f9fb71c9c944d5d0d3832fec969260e3f18efc7d855f57c4";
const ORACLE_PKG = "0xee1ff66985a76b2c0170935fb29144b4007827ed2c4f3d6a1189578afb92bcdd";
const VOUCHER_PKG = "0x8783841625738f73a6b0085f5dad270b4b0bd2e5cdb278dc95201e45bd1a332b";

async function main() {
  console.log("=== Nemo Protocol Security Audit ===\n");

  // 1. NemoContract modules
  console.log("--- NemoContract modules ---");
  try {
    const norm = await client.getNormalizedMoveModulesByPackage({ package: NEMO_CONTRACT });
    const modules = Object.keys(norm);
    console.log(`Modules (${modules.length}): ${modules.join(", ")}`);

    // Look for the vulnerable function
    for (const mod of modules) {
      const normMod = norm[mod];
      for (const [fnName, fnDef] of Object.entries(normMod.exposedFunctions)) {
        const lower = fnName.toLowerCase();
        // The vulnerable function
        if (lower.includes("sy_amount") || lower.includes("flash") || lower.includes("exact_py") || lower.includes("get_sy")) {
          const params = fnDef.parameters.map((p, i) => {
            const s = JSON.stringify(p);
            return s.match(/"name":"(\w+)"/)?.[1] ?? `p${i}`;
          });
          const returnTypes = fnDef.return?.map(r => {
            const s = JSON.stringify(r);
            return s.match(/"name":"(\w+)"/)?.[1] ?? s.slice(0,20);
          }) ?? [];
          const mark = fnDef.isEntry ? "✅entry" : "   pub";
          console.log(`  🎯 ${mark} ${mod}::${fnName}(${params.slice(0,5).join(",")}) → [${returnTypes.join(",")}]`);
        }
        // Version guard
        if (lower.includes("version")) {
          console.log(`  [VERSION] ${mod}::${fnName}`);
        }
      }
    }

    // Check for flash loan patterns
    console.log("\n--- Flash loan patterns ---");
    for (const mod of modules) {
      const normMod = norm[mod];
      for (const [fnName, fnDef] of Object.entries(normMod.exposedFunctions)) {
        const lower = fnName.toLowerCase();
        if (lower.includes("flash") || lower.includes("borrow")) {
          const returnTypes = fnDef.return?.map(r => {
            const s = JSON.stringify(r);
            return s.match(/"name":"(\w+)"/)?.[1] ?? s.slice(0,25);
          }) ?? [];
          const hasReceipt = returnTypes.some(r => r.toLowerCase().includes("receipt") || r.toLowerCase().includes("hot") || r.toLowerCase().includes("ticket") || r.toLowerCase().includes("promise"));
          const hasCoin = returnTypes.some(r => r === "Coin" || r === "Balance" || r === "balance" || r === "coin");
          const mark = fnDef.isEntry ? "✅entry" : "   pub";
          if (hasCoin || lower.includes("flash")) {
            const risk = hasCoin && !hasReceipt ? "🔴" : "✅";
            console.log(`  ${risk} ${mark} ${mod}::${fnName} → [${returnTypes.join(",")}]`);
          }
        }
      }
    }

    // Version guard check
    let hasVersionGuard = false;
    for (const mod of modules) {
      const normMod = norm[mod];
      for (const [sName, sDef] of Object.entries(normMod.structs)) {
        if (sDef.fields?.some((f: any) => f.name === "version" || f.name === "num")) {
          hasVersionGuard = true;
          const fields = sDef.fields?.map((f: any) => f.name).join(", ");
          console.log(`\n[VERSION STRUCT] ${mod}::${sName}: ${fields}`);
        }
      }
    }
    if (!hasVersionGuard) console.log("\n[VERSION] ❌ No version guard found");

  } catch (e: any) {
    console.log(`ERROR: ${e.message?.slice(0, 100)}`);
  }

  // 2. Recent activity
  console.log("\n--- Recent NemoContract txs ---");
  try {
    const txs = await client.queryTransactionBlocks({
      filter: { InputObject: NEMO_CONTRACT },
      limit: 3,
      order: "descending",
    });
    console.log(`Recent txs: ${txs.data.length}`);
    if (txs.data.length > 0) {
      console.log(`Latest: ${txs.data[0].digest.slice(0,24)}`);
    }
  } catch (e: any) { console.log(`Error: ${e.message?.slice(0,60)}`); }

  // 3. Check OraclePackage - Nemo has their own oracle
  console.log("\n--- OraclePackage modules ---");
  try {
    const norm = await client.getNormalizedMoveModulesByPackage({ package: ORACLE_PKG });
    console.log(`Modules: ${Object.keys(norm).join(", ")}`);
  } catch (e: any) { console.log(`Error: ${e.message?.slice(0,60)}`); }
}
main().catch(console.error);
