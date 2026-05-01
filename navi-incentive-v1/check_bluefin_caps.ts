import { SuiClient } from "@mysten/sui/client";
import { Transaction } from "@mysten/sui/transactions";
const client = new SuiClient({ url: "https://fullnode.mainnet.sui.io:443" });

const PKG = "0xc9ba51116d85cfbb401043f5e0710ab582c4b9b04a139b7df223f8f06bb66fa5";

async function main() {
  // 1. Check roles module - who can get FundingRateCap, AdminCap, etc.
  console.log("=== roles module ===");
  try {
    const mod = await client.getNormalizedMoveModule({ package: PKG, module: "roles" });
    console.log("Structs:", Object.keys(mod.structs).join(", "));
    console.log("\nEntry functions:");
    for (const [fnName, fnDef] of Object.entries(mod.exposedFunctions)) {
      if (!fnDef.isEntry) continue;
      const params = fnDef.parameters.map((p, i) => {
        const s = JSON.stringify(p);
        return s.match(/"name":"(\w+)"/)?.[1] ?? `p${i}`;
      });
      console.log(`  ✅ ${fnName}(${params.join(", ")})`);
    }
    console.log("\nPublic functions:");
    for (const [fnName, fnDef] of Object.entries(mod.exposedFunctions)) {
      if (fnDef.isEntry) continue;
      if (fnName.toLowerCase().includes("cap") || fnName.toLowerCase().includes("grant") || fnName.toLowerCase().includes("create")) {
        const params = fnDef.parameters.map((p, i) => {
          const s = JSON.stringify(p);
          return s.match(/"name":"(\w+)"/)?.[1] ?? `p${i}`;
        });
        console.log(`  pub ${fnName}(${params.slice(0,4).join(", ")})`);
      }
    }
  } catch (e: any) { console.log("Error:", e.message?.slice(0,60)); }

  // 2. Check CapabilitiesSafe struct
  console.log("\n=== CapabilitiesSafe struct ===");
  try {
    const mod = await client.getNormalizedMoveModule({ package: PKG, module: "roles" });
    for (const [sName, sDef] of Object.entries(mod.structs)) {
      if (sName.includes("Cap") || sName.includes("Safe") || sName.includes("Role")) {
        const fields = sDef.fields?.map((f: any) => f.name) ?? [];
        console.log(`  ${sName}: ${fields.join(", ")}`);
      }
    }
  } catch (e: any) { console.log("Error:", e.message?.slice(0,60)); }

  // 3. Full set_funding_rate signature
  console.log("\n=== perpetual::set_funding_rate signature ===");
  try {
    const fn = await client.getNormalizedMoveFunction({ package: PKG, module: "perpetual", function: "set_funding_rate" });
    console.log("isEntry:", fn.isEntry);
    fn.parameters.forEach((p, i) => {
      const s = JSON.stringify(p);
      const name = s.match(/"name":"(\w+)"/)?.[1] ?? s.slice(0, 60);
      const isMut = s.includes("MutableReference");
      const isI = s.includes('"I64"') || s.includes('"I128"') || s.includes('"I32"');
      console.log(`  param[${i}] ${isMut?"&mut":""}: ${name} ${isI?"[SIGNED]":""}`);
    });
    console.log("return:", JSON.stringify(fn.return).slice(0, 100));
  } catch (e: any) { console.log("Error:", e.message?.slice(0,60)); }

  // 4. All entry functions in perpetual module  
  console.log("\n=== All perpetual entry functions ===");
  try {
    const mod = await client.getNormalizedMoveModule({ package: PKG, module: "perpetual" });
    for (const [fnName, fnDef] of Object.entries(mod.exposedFunctions)) {
      if (!fnDef.isEntry) continue;
      const params = fnDef.parameters.map((p, i) => {
        const s = JSON.stringify(p);
        const name = s.match(/"name":"(\w+)"/)?.[1] ?? `p${i}`;
        const isI = s.includes('"I64"') || s.includes('"I128"') || s.includes('"I32"');
        return `${isI?"[I!]":""}${name}`;
      });
      console.log(`  ✅ ${fnName}(${params.slice(0,6).join(", ")})`);
    }
  } catch (e: any) { console.log("Error:", e.message?.slice(0,60)); }

  // 5. signed_number module - Bluefin has a custom signed number type
  console.log("\n=== signed_number module ===");
  try {
    const mod = await client.getNormalizedMoveModule({ package: PKG, module: "signed_number" });
    console.log("Structs:", Object.keys(mod.structs).join(", "));
    // Check if signed numbers can be negative
    const signedStruct = (mod.structs as any)["Number"] ?? (mod.structs as any)["SignedNumber"];
    if (signedStruct) {
      console.log(`  Fields: ${signedStruct.fields?.map((f: any) => f.name).join(", ")}`);
    }
  } catch (e: any) { console.log("Error:", e.message?.slice(0,60)); }
}
main().catch(console.error);
