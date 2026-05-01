import { SuiClient } from "@mysten/sui/client";
import { Transaction } from "@mysten/sui/transactions";
const client = new SuiClient({ url: "https://fullnode.mainnet.sui.io:443" });

const PKG = "0xf95b06141ed4a174f239417323bde3f209b972f5930d8521ea38a52aff3a6ddf";
const DUMMY = "0x0000000000000000000000000000000000000000000000000000000000001337";
const CLOCK = "0x0000000000000000000000000000000000000000000000000000000000000006";

async function main() {
  console.log("=== Suilend Reward Audit ===\n");

  // 1. Find ALL open reward entry functions (no cap required)
  console.log("--- All open reward entry functions ---");
  const norm = await client.getNormalizedMoveModulesByPackage({ package: PKG });
  const openFns: Array<{mod: string, fn: string, params: string[]}> = [];
  
  for (const [mod, modDef] of Object.entries(norm)) {
    for (const [fnName, fn] of Object.entries(modDef.exposedFunctions)) {
      if (fn.isEntry && /claim|harvest|reward|redeem|collect/i.test(fnName)) {
        const params = fn.parameters.map(p => {
          const s = JSON.stringify(p);
          const name = s.match(/"name":"(\w+)"/)?.[1] ?? s.slice(0,30);
          const isMut = s.includes("MutableReference");
          return `${isMut ? "&mut " : ""}${name}`;
        });
        const hasAdmin = JSON.stringify(fn.parameters).match(/Cap|Admin|ManagerCap|Key/);
        const marker = hasAdmin ? "🔒" : "⚠️";
        console.log(`${marker} ${mod}::${fnName}(${params.join(", ")})`);
        if (!hasAdmin) {
          openFns.push({ mod, fn: fnName, params });
        }
      }
    }
  }

  // 2. Version guard check - LendingMarket struct
  console.log("\n--- LendingMarket version field ---");
  try {
    const st = await client.getNormalizedMoveStruct({ package: PKG, module: "lending_market", struct: "LendingMarket" });
    const verField = st.fields.find(f => f.name === "version");
    console.log(`version field exists: ${!!verField}`);
    if (verField) {
      console.log(`version type: ${JSON.stringify(verField.type).slice(0,60)}`);
    }
    // Check for LendingMarketOwnerCap requirement on claim_rewards
  } catch (e: any) { console.log("Error:", e.message?.slice(0,60)); }

  // 3. Investigate each open function
  for (const { mod, fn, params } of openFns) {
    console.log(`\n--- ${mod}::${fn} deep check ---`);
    try {
      const fnDef = await client.getNormalizedMoveFunction({ package: PKG, module: mod, function: fn });
      console.log(`visibility: ${fnDef.visibility}, isEntry: ${fnDef.isEntry}`);
      console.log("Full params:");
      for (let i = 0; i < fnDef.parameters.length; i++) {
        const p = JSON.stringify(fnDef.parameters[i]);
        const addr = p.match(/"address":"([^"]+)"/)?.[1];
        const name = p.match(/"name":"(\w+)"/)?.[1];
        const isMut = p.includes("MutableReference");
        console.log(`  [${i}]: ${isMut ? "&mut " : ""}${name} (${addr?.slice(0,16)})`);
      }
      console.log(`returns: ${JSON.stringify(fnDef.return).slice(0,100)}`);
      
      // Try dry-run to see if version check blocks it
      console.log(`\n  Dry-run attempt...`);
      const tx = new Transaction();
      // Can't easily dry-run without knowing the actual object IDs
      // But let's check if there are any LendingMarket objects
      try {
        const resp = await (client as any).transport.request({
          method: "suix_queryObjects",
          params: [{ filter: { StructType: `${PKG}::lending_market::LendingMarket<0x2::sui::SUI>` } }, null, 2, true],
        });
        const objs = resp.data ?? [];
        console.log(`  LendingMarket<SUI> objects: ${objs.length}`);
        for (const o of objs.slice(0, 1)) {
          const f = o.data?.content?.fields ?? {};
          console.log(`  version=${f.version}, id=${o.data?.objectId?.slice(0,24)}`);
        }
      } catch {}
    } catch (e: any) { console.log("Error:", e.message?.slice(0,60)); }
  }
  
  // 4. Check if previous "claim_rewards" detection was wrong
  console.log("\n--- All reward-related functions (entry AND non-entry) ---");
  for (const [mod, modDef] of Object.entries(norm)) {
    for (const [fnName, fn] of Object.entries(modDef.exposedFunctions)) {
      if (/reward/i.test(fnName)) {
        console.log(`  ${fn.isEntry ? "entry" : "public"} ${mod}::${fnName}`);
      }
    }
  }
}
main().catch(console.error);
