import { SuiClient } from "@mysten/sui/client";
const client = new SuiClient({ url: "https://fullnode.mainnet.sui.io:443" });

const NEMO = "0x2b71664477755b90f9fb71c9c944d5d0d3832fec969260e3f18efc7d855f57c4";
const ORACLE_PKG = "0xee1ff66985a76b2c0170935fb29144b4007827ed2c4f3d6a1189578afb92bcdd";
const VOUCHER_PKG = "0x8783841625738f73a6b0085f5dad270b4b0bd2e5cdb278dc95201e45bd1a332b";

async function main() {
  // 1. Check FlashLoan type abilities (hot potato = no abilities)
  console.log("=== sy::FlashLoan type abilities ===");
  try {
    const fn = await client.getNormalizedMoveFunction({ package: NEMO, module: "sy", function: "borrow" });
    console.log("borrow isEntry:", fn.isEntry);
    console.log("params:", fn.parameters.length);
    fn.parameters.forEach((p, i) => {
      const s = JSON.stringify(p);
      const name = s.match(/"name":"(\w+)"/)?.[1] ?? s.slice(0,50);
      console.log(`  param[${i}]: ${name}`);
    });
    console.log("returns:", fn.return.map(r => JSON.stringify(r).slice(0,60)).join(", "));
  } catch (e: any) { console.log("Error:", e.message?.slice(0,60)); }

  // Check FlashLoan struct abilities
  console.log("\n--- sy module structs and their abilities ---");
  try {
    const mod = await client.getNormalizedMoveModule({ package: NEMO, module: "sy" });
    for (const [sName, sDef] of Object.entries(mod.structs)) {
      const abilities = (sDef as any).abilities?.abilities ?? [];
      const fields = sDef.fields?.map((f: any) => f.name) ?? [];
      console.log(`  ${sName} abilities:[${abilities.join(",")}] fields:[${fields.slice(0,5).join(",")}]`);
    }
  } catch (e: any) { console.log("Error:", e.message?.slice(0,60)); }

  // 2. PriceVoucher - how is it created?
  console.log("\n=== PriceVoucher creation path ===");
  try {
    const norm = await client.getNormalizedMoveModulesByPackage({ package: NEMO });
    for (const [mod, normMod] of Object.entries(norm)) {
      for (const [fnName, fnDef] of Object.entries((normMod as any).exposedFunctions)) {
        const s = JSON.stringify((fnDef as any).return ?? []);
        if (s.includes("PriceVoucher") || s.includes("Voucher")) {
          const params = ((fnDef as any).parameters ?? []).map((p: any, i: number) => {
            const ps = JSON.stringify(p);
            return ps.match(/"name":"(\w+)"/)?.[1] ?? `p${i}`;
          });
          console.log(`  ${mod}::${fnName}(${params.slice(0,5).join(",")}) → Voucher`);
          console.log(`    isEntry: ${(fnDef as any).isEntry}`);
        }
      }
    }
  } catch (e: any) { console.log("Error:", e.message?.slice(0,60)); }

  // 3. OracleVoucherPackage (0x8783...) - can anyone create a PriceVoucher?
  console.log("\n=== OracleVoucherPackage entry functions ===");
  try {
    const norm = await client.getNormalizedMoveModulesByPackage({ package: VOUCHER_PKG });
    const mods = Object.keys(norm);
    console.log(`Modules: ${mods.join(", ")}`);
    for (const mod of mods) {
      const normMod = norm[mod];
      for (const [fnName, fnDef] of Object.entries((normMod as any).exposedFunctions)) {
        if ((fnDef as any).isEntry) {
          const params = ((fnDef as any).parameters ?? []).map((p: any, i: number) => {
            const s = JSON.stringify(p);
            return s.match(/"name":"(\w+)"/)?.[1] ?? `p${i}`;
          });
          console.log(`  ✅ ${mod}::${fnName}(${params.slice(0,5).join(",")})`);
        }
      }
    }
  } catch (e: any) { console.log("Error:", e.message?.slice(0,60)); }

  // 4. sy::borrow - does it check any state? (get full normalized fn)
  console.log("\n=== All sy module entry/public functions ===");
  try {
    const mod = await client.getNormalizedMoveModule({ package: NEMO, module: "sy" });
    for (const [fnName, fnDef] of Object.entries(mod.exposedFunctions)) {
      const params = fnDef.parameters.map((p, i) => {
        const s = JSON.stringify(p);
        return s.match(/"name":"(\w+)"/)?.[1] ?? `p${i}`;
      });
      const rets = fnDef.return?.map(r => {
        const s = JSON.stringify(r);
        return s.match(/"name":"(\w+)"/)?.[1] ?? s.slice(0,15);
      }) ?? [];
      const mark = fnDef.isEntry ? "✅entry" : "   pub";
      console.log(`  ${mark} ${fnName}(${params.slice(0,5).join(",")}) → [${rets.join(",")}]`);
    }
  } catch (e: any) { console.log("Error:", e.message?.slice(0,60)); }

  // 5. get_sy_amount_in_for_exact_py_out - does it modify state?
  console.log("\n=== py::get_sy_amount_in_for_exact_py_out ===");
  try {
    const fn = await client.getNormalizedMoveFunction({ package: NEMO, module: "py", function: "get_sy_amount_in_for_exact_py_out" });
    console.log("isEntry:", fn.isEntry);
    fn.parameters.forEach((p, i) => {
      const s = JSON.stringify(p);
      const name = s.match(/"name":"(\w+)"/)?.[1] ?? s.slice(0,50);
      const isMut = s.includes("MutableReference");
      console.log(`  param[${i}] ${isMut?"&mut":""}: ${name}`);
    });
  } catch (e: any) { console.log("Error:", e.message?.slice(0,60)); }
}
main().catch(console.error);
