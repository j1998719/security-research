import { SuiClient } from "@mysten/sui/client";
const client = new SuiClient({ url: "https://fullnode.mainnet.sui.io:443" });

const TYPUS_V1 = "0xe27969a70f93034de9ce16e6ad661b480324574e68d15a64b513fd90eb2423e5";
const TYPUS_V2 = "0x9003219180252ae6b81d2893b41d430488669027219537236675c0c2924c94d9";

async function checkTypus(label: string, pkg: string) {
  console.log(`\n=== ${label} ===`);

  // 1. Referral registry struct
  console.log("--- trading::MarketRegistry struct ---");
  try {
    const st = await client.getNormalizedMoveStruct({ package: pkg, module: "trading", struct: "MarketRegistry" });
    st.fields?.forEach((f: any) => console.log(`  ${f.name}: ${JSON.stringify(f.type).slice(0, 80)}`));
  } catch (e: any) { console.log("Error:", e.message?.slice(0,60)); }

  // 2. All entry functions in trading module
  console.log("\n--- trading entry functions ---");
  try {
    const mod = await client.getNormalizedMoveModule({ package: pkg, module: "trading" });
    for (const [fnName, fnDef] of Object.entries(mod.exposedFunctions)) {
      if (!fnDef.isEntry) continue;
      const params = fnDef.parameters.map((p, i) => {
        const s = JSON.stringify(p);
        const name = s.match(/"name":"(\w+)"/)?.[1] ?? `p${i}`;
        const isI = s.includes('"I64"') || s.includes('"I128"') || s.includes('"I32"');
        const isMut = s.includes("MutableReference");
        return `${isMut?"&mut ":""}${isI?"[I!]":""}${name}`;
      });
      console.log(`  ✅ ${fnName}(${params.slice(0,6).join(", ")})`);
    }
  } catch (e: any) { console.log("Error:", e.message?.slice(0,60)); }

  // 3. escrow entry functions (might have open registration)
  console.log("\n--- escrow entry functions ---");
  try {
    const mod = await client.getNormalizedMoveModule({ package: pkg, module: "escrow" });
    for (const [fnName, fnDef] of Object.entries(mod.exposedFunctions)) {
      if (!fnDef.isEntry) continue;
      const params = fnDef.parameters.map((p, i) => {
        const s = JSON.stringify(p);
        return s.match(/"name":"(\w+)"/)?.[1] ?? `p${i}`;
      });
      console.log(`  ✅ ${fnName}(${params.slice(0,5).join(", ")})`);
    }
  } catch (e: any) { console.log("Error:", e.message?.slice(0,60)); }

  // 4. admin entry functions (Volo pattern check)
  console.log("\n--- admin entry functions ---");
  try {
    const mod = await client.getNormalizedMoveModule({ package: pkg, module: "admin" });
    for (const [fnName, fnDef] of Object.entries(mod.exposedFunctions)) {
      if (!fnDef.isEntry) continue;
      const params = fnDef.parameters.map((p, i) => {
        const s = JSON.stringify(p);
        const name = s.match(/"name":"(\w+)"/)?.[1] ?? `p${i}`;
        return name;
      });
      const fnLower = fnName.toLowerCase();
      if (fnLower.includes("withdraw") || fnLower.includes("set_fee") || fnLower.includes("update_fee") || fnLower.includes("register")) {
        console.log(`  ✅ ${fnName}(${params.slice(0,5).join(", ")})`);
      }
    }
  } catch (e: any) { console.log("Error:", e.message?.slice(0,60)); }

  // 5. Check if there's a "register_referrer" or similar open function
  console.log("\n--- All modules entry functions matching 'register/referral/rebate' ---");
  try {
    const norm = await client.getNormalizedMoveModulesByPackage({ package: pkg });
    for (const [mod, normMod] of Object.entries(norm)) {
      for (const [fnName, fnDef] of Object.entries((normMod as any).exposedFunctions)) {
        if (!(fnDef as any).isEntry) continue;
        const lower = fnName.toLowerCase();
        if (lower.includes("referr") || lower.includes("rebate") || lower.includes("register") || lower.includes("partner") || lower.includes("builder")) {
          const params = ((fnDef as any).parameters ?? []).map((p: any, i: number) => {
            const s = JSON.stringify(p);
            return s.match(/"name":"(\w+)"/)?.[1] ?? `p${i}`;
          });
          console.log(`  ✅ ${mod}::${fnName}(${params.slice(0,5).join(", ")})`);
        }
      }
    }
  } catch (e: any) { console.log("Error:", e.message?.slice(0,60)); }
}

async function main() {
  await checkTypus("Typus Perp v1", TYPUS_V1);
  await checkTypus("Typus Perp v2", TYPUS_V2);
}
main().catch(console.error);
