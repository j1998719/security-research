/**
 * Deep check: Cetus Farming 0x11ea791d...
 * Suspicious: PositionRewardInfo has reward_debt + harvest/collect are open entry fns
 */
import { SuiClient } from "@mysten/sui/client";
import { Transaction } from "@mysten/sui/transactions";
const client = new SuiClient({ url: "https://fullnode.mainnet.sui.io:443" });

const PKG = "0x11ea791d82b5742cc8cab0bf7946035c97d9001d7c3803a93f119753da66f526";
const DUMMY = "0x0000000000000000000000000000000000000000000000000000000000001337";
const CLOCK = "0x0000000000000000000000000000000000000000000000000000000000000006";

async function main() {
  console.log("=== Cetus Farming Deep Audit ===\n");

  // 1. PositionRewardInfo struct - the key vulnerability pattern
  console.log("--- PositionRewardInfo struct ---");
  try {
    const st = await client.getNormalizedMoveStruct({ package: PKG, module: "pool", struct: "PositionRewardInfo" });
    console.log(`abilities: [${st.abilities.abilities.join(", ")}]`);
    for (const f of st.fields) {
      console.log(`  ${f.name}: ${JSON.stringify(f.type).slice(0,60)}`);
    }
    // reward_debt starts at 0 for new positions?
    console.log("\n  KEY: if reward_debt=0 for new positions AND global accumulated_reward is large → EXPLOIT");
  } catch (e: any) { console.log("Error:", e.message?.slice(0,60)); }

  // 2. Pool struct - does it have accumulated reward index?
  console.log("\n--- Pool struct (key fields) ---");
  try {
    const st = await client.getNormalizedMoveStruct({ package: PKG, module: "pool", struct: "Pool" });
    const interestingFields = st.fields.filter(f => 
      /reward|index|acc|emission|rate|debt/i.test(f.name)
    );
    for (const f of interestingFields) {
      console.log(`  ${f.name}: ${JSON.stringify(f.type).slice(0,80)}`);
    }
    console.log(`  (total fields: ${st.fields.length})`);
  } catch (e: any) { console.log("Error:", e.message?.slice(0,60)); }

  // 3. harvest function signature
  console.log("\n--- harvest function ---");
  try {
    const fn = await client.getNormalizedMoveFunction({ package: PKG, module: "router", function: "harvest" });
    console.log(`isEntry: ${fn.isEntry}, visibility: ${fn.visibility}`);
    console.log("parameters:");
    for (let i = 0; i < fn.parameters.length; i++) {
      const p = JSON.stringify(fn.parameters[i]);
      const name = p.match(/"name":"(\w+)"/)?.[1] ?? p.slice(0,40);
      console.log(`  [${i}]: ${name} ${p.includes("MutableReference") ? "(&mut)" : ""}`);
    }
  } catch (e: any) { console.log("Error:", e.message?.slice(0,60)); }

  // 4. collect_clmm_reward function signature
  console.log("\n--- collect_clmm_reward function ---");
  try {
    const fn = await client.getNormalizedMoveFunction({ package: PKG, module: "router", function: "collect_clmm_reward" });
    console.log(`isEntry: ${fn.isEntry}, visibility: ${fn.visibility}`);
    console.log("parameters:");
    for (let i = 0; i < fn.parameters.length; i++) {
      const p = JSON.stringify(fn.parameters[i]);
      const name = p.match(/"name":"(\w+)"/)?.[1] ?? p.slice(0,50);
      console.log(`  [${i}]: ${name} ${p.includes("MutableReference") ? "(&mut)" : ""}`);
    }
  } catch (e: any) { console.log("Error:", e.message?.slice(0,60)); }

  // 5. Version guard check
  console.log("\n--- Version guard ---");
  try {
    const norm = await client.getNormalizedMoveModulesByPackage({ package: PKG });
    const mods = Object.keys(norm);
    console.log(`All modules: ${mods.join(", ")}`);
    
    // Check config module
    const config = norm["config"];
    if (config) {
      const hasVersion = Object.values(config.structs).some(s => 
        s.fields?.some(f => f.name === "version")
      );
      console.log(`config structs with version: ${hasVersion}`);
      
      // Check GlobalConfig specifically
      const gc = config.structs["GlobalConfig"];
      if (gc) {
        console.log("GlobalConfig fields:");
        for (const f of gc.fields.slice(0, 8)) {
          console.log(`  ${f.name}: ${JSON.stringify(f.type).slice(0,50)}`);
        }
      }
    }
  } catch (e: any) { console.log("Error:", e.message?.slice(0,60)); }

  // 6. RewarderManager struct
  console.log("\n--- RewarderManager struct ---");
  try {
    const st = await client.getNormalizedMoveStruct({ package: PKG, module: "rewarder", struct: "RewarderManager" });
    for (const f of st.fields) {
      console.log(`  ${f.name}: ${JSON.stringify(f.type).slice(0,80)}`);
    }
  } catch (e: any) { console.log("Error:", e.message?.slice(0,60)); }

  // 7. WrappedPositionNFT — can anyone create one?
  console.log("\n--- WrappedPositionNFT creation ---");
  try {
    // Look for mint/create/wrap functions for WrappedPositionNFT
    const norm = await client.getNormalizedMoveModulesByPackage({ package: PKG });
    for (const [mod, modDef] of Object.entries(norm)) {
      for (const [fnName, fn] of Object.entries(modDef.exposedFunctions)) {
        const lower = fnName.toLowerCase();
        const retStr = JSON.stringify(fn.return);
        if (retStr.includes("WrappedPositionNFT") || lower.includes("wrap") || lower.includes("mint_position")) {
          const params = fn.parameters.map(p => JSON.stringify(p).match(/"name":"(\w+)"/)?.[1] ?? "?");
          console.log(`  ${mod}::${fnName}(${params.join(", ")}) → WrappedPositionNFT (entry=${fn.isEntry})`);
        }
      }
    }
  } catch (e: any) { console.log("Error:", e.message?.slice(0,60)); }

  // 8. Find actual RewarderManager and Pool objects on-chain
  console.log("\n--- On-chain objects ---");
  try {
    const resp = await (client as any).transport.request({
      method: "suix_queryObjects",
      params: [{ filter: { StructType: `${PKG}::rewarder::RewarderManager` } }, null, 3, false],
    });
    const objs = resp.data ?? [];
    console.log(`RewarderManager objects: ${objs.length}`);
    for (const o of objs.slice(0, 2)) {
      const f = o.data?.content?.fields ?? {};
      console.log(`  id=${o.data?.objectId?.slice(0,20)} fields=${Object.keys(f).join(",")}`);
    }
  } catch (e: any) { console.log("Error:", e.message?.slice(0,60)); }
}
main().catch(console.error);
