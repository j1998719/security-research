import { SuiClient } from "@mysten/sui/client";
const client = new SuiClient({ url: "https://fullnode.mainnet.sui.io:443" });

const SCRIPT_PKG = "0x6f5e582ede61fe5395b50c4a449ec11479a54d7ff8e0158247adfda60d98970b";

async function main() {
  // Check partner_script module - how do partners get created and set fees?
  console.log("=== Cetus partner_script module ===\n");
  
  const mod = await client.getNormalizedMoveModule({ package: SCRIPT_PKG, module: "partner_script" });
  
  console.log("Exposed functions:");
  for (const [fnName, fnDef] of Object.entries(mod.exposedFunctions)) {
    const params = fnDef.parameters.map((p, i) => {
      const s = JSON.stringify(p);
      const name = s.match(/"name":"(\w+)"/)?.[1] ?? `p${i}`;
      const isMut = s.includes("MutableReference");
      return `${isMut?"&mut ":""}${name}`;
    });
    const mark = fnDef.isEntry ? "✅ entry" : "   public";
    console.log(`  ${mark} ${fnName}(${params.slice(0,6).join(", ")})`);
  }
  
  console.log("\nStructs:");
  for (const [sName] of Object.entries(mod.structs)) {
    console.log(`  ${sName}`);
  }
  
  // Check router_with_partner - this is where fee overrides might happen
  console.log("\n=== router_with_partner module ===");
  try {
    const routerMod = await client.getNormalizedMoveModule({ package: SCRIPT_PKG, module: "router_with_partner" });
    for (const [fnName, fnDef] of Object.entries(routerMod.exposedFunctions)) {
      if (!fnDef.isEntry) continue;
      const params = fnDef.parameters.map((p, i) => {
        const s = JSON.stringify(p);
        const name = s.match(/"name":"(\w+)"/)?.[1] ?? `p${i}`;
        return name;
      });
      console.log(`  ✅ ${fnName}(${params.slice(0,6).join(", ")})`);
    }
  } catch (e: any) { console.log("Error:", e.message?.slice(0,60)); }
  
  // Check pool_script for fee parameters
  console.log("\n=== pool_script - fee-related entry functions ===");
  try {
    const poolMod = await client.getNormalizedMoveModule({ package: SCRIPT_PKG, module: "pool_script" });
    for (const [fnName, fnDef] of Object.entries(poolMod.exposedFunctions)) {
      if (!fnDef.isEntry) continue;
      const lower = fnName.toLowerCase();
      if (!lower.includes("fee") && !lower.includes("reward") && !lower.includes("collect") && !lower.includes("partner")) continue;
      const params = fnDef.parameters.map((p, i) => {
        const s = JSON.stringify(p);
        return s.match(/"name":"(\w+)"/)?.[1] ?? `p${i}`;
      });
      console.log(`  ✅ ${fnName}(${params.slice(0,6).join(", ")})`);
    }
  } catch (e: any) { console.log("Error:", e.message?.slice(0,60)); }
}
main().catch(console.error);
