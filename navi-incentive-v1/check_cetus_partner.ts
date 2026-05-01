/**
 * Check Cetus CLMM partner module - could have builder fee system like AftermathFi
 * Package: 0x1eabed72c53feb3805120a081dc15963c204dc8d091542592abaf7a35689b2fb
 */
import { SuiClient } from "@mysten/sui/client";
const client = new SuiClient({ url: "https://fullnode.mainnet.sui.io:443" });

const CETUS_PKG = "0x1eabed72c53feb3805120a081dc15963c204dc8d091542592abaf7a35689b2fb";

async function main() {
  console.log("=== Cetus partner module analysis ===\n");

  // 1. All functions in partner module
  console.log("--- partner module functions ---");
  try {
    const mod = await client.getNormalizedMoveModule({ package: CETUS_PKG, module: "partner" });
    for (const [fnName, fnDef] of Object.entries(mod.exposedFunctions)) {
      const params = fnDef.parameters.map((p, i) => {
        const s = JSON.stringify(p);
        const name = s.match(/"name":"(\w+)"/)?.[1] ?? `p${i}`;
        return name;
      });
      const mark = fnDef.isEntry ? "✅ entry" : "   public";
      console.log(`  ${mark} ${fnName}(${params.slice(0,5).join(", ")})`);
    }
  } catch (e: any) { console.log("Error:", e.message?.slice(0,60)); }

  // 2. Partner struct
  console.log("\n--- Partner struct ---");
  try {
    const mod = await client.getNormalizedMoveModule({ package: CETUS_PKG, module: "partner" });
    for (const [sName, sDef] of Object.entries(mod.structs)) {
      const fields = sDef.fields?.map((f: any) => f.name) ?? [];
      console.log(`  ${sName}: ${fields.join(", ")}`);
    }
  } catch (e: any) { console.log("Error:", e.message?.slice(0,60)); }

  // 3. create_partner signature specifically
  console.log("\n--- create_partner / set_fee signature ---");
  for (const fnName of ["create_partner", "update_partner", "set_fee_rate", "update_fee_rate", "initialize_partner"]) {
    try {
      const fn = await client.getNormalizedMoveFunction({ package: CETUS_PKG, module: "partner", function: fnName });
      const params = fn.parameters.map((p, i) => {
        const s = JSON.stringify(p);
        const name = s.match(/"name":"(\w+)"/)?.[1] ?? `p${i}`;
        const isAdmin = name.toLowerCase().includes("admin") || name.toLowerCase().includes("config");
        return `${isAdmin?"[admin]":""}${name}`;
      });
      console.log(`  ${fnName}(${params.join(", ")}) - isEntry:${fn.isEntry}`);
    } catch {}
  }

  // 4. rewarder module - any non-admin reward setters?
  console.log("\n--- rewarder module functions ---");
  try {
    const mod = await client.getNormalizedMoveModule({ package: CETUS_PKG, module: "rewarder" });
    for (const [fnName, fnDef] of Object.entries(mod.exposedFunctions)) {
      if (!fnDef.isEntry) continue;
      const params = fnDef.parameters.map((p, i) => {
        const s = JSON.stringify(p);
        return s.match(/"name":"(\w+)"/)?.[1] ?? `p${i}`;
      });
      console.log(`  ✅ ${fnName}(${params.slice(0,5).join(", ")})`);
    }
  } catch (e: any) { console.log("Error:", e.message?.slice(0,60)); }

  // 5. Pool swap - does swap accept a fee override param?
  console.log("\n--- pool swap functions ---");
  try {
    const fn = await client.getNormalizedMoveFunction({ package: CETUS_PKG, module: "pool", function: "swap" });
    console.log(`swap isEntry: ${fn.isEntry}`);
    fn.parameters.forEach((p, i) => {
      const s = JSON.stringify(p);
      const name = s.match(/"name":"(\w+)"/)?.[1] ?? s.slice(0,40);
      console.log(`  param[${i}]: ${name}`);
    });
  } catch (e: any) { console.log("Error:", e.message?.slice(0,60)); }
}
main().catch(console.error);
