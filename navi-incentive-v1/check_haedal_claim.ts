import { SuiClient } from "@mysten/sui/client";
const client = new SuiClient({ url: "https://fullnode.mainnet.sui.io:443" });

const HAEDAL = "0xbde4ba4c2e274a60ce15c1cfff9e5c42e41654ac8b6d906a57efa4bd3c29f47d";
const SUSPICIOUS = "0xede0f472ec1e7bbad84755fdfa8241a4d620253eac1d15e0eef2b4cb89c06616";

async function main() {
  // 1. Check Haedal claim signature
  console.log("=== Haedal interface::claim ===");
  const fn = await client.getNormalizedMoveFunction({ package: HAEDAL, module: "interface", function: "claim" });
  console.log("isEntry:", fn.isEntry);
  for (let i = 0; i < fn.parameters.length; i++) {
    const p = JSON.stringify(fn.parameters[i]);
    const name = p.match(/"name":"(\w+)"/)?.[1] ?? p.slice(0, 80);
    const isMut = p.includes("MutableReference");
    console.log(`  [${i}] ${isMut?"&mut":"ref"} ${name}: ${p.slice(0, 100)}`);
  }
  
  // 2. Haedal StakedSui struct — does it track user reward index?
  console.log("\n=== Haedal structs with state tracking ===");
  const mods = await client.getNormalizedMoveModulesByPackage({ package: HAEDAL });
  for (const [modName, modData] of Object.entries(mods)) {
    const structs = (modData as any).structs ?? {};
    for (const [sname, sd] of Object.entries(structs)) {
      const fields = (sd as any).fields ?? [];
      if (fields.length > 0 && fields.length < 15) {
        const fieldNames = fields.map((f: any) => f.name).join(", ");
        if (fieldNames.includes("reward") || fieldNames.includes("staked") || fieldNames.includes("pool") || fieldNames.includes("exchange")) {
          console.log(`  ${modName}::${sname}: ${fieldNames}`);
        }
      }
    }
  }
  
  // 3. Check Haedal version guard — even though no version field, check function calls
  console.log("\n=== Haedal Staking struct ===");
  try {
    const st = await client.getNormalizedMoveStruct({ package: HAEDAL, module: "manage", struct: "Staking" });
    if (st) for (const f of st.fields) console.log(`  ${f.name}: ${JSON.stringify(f.type).slice(0,60)}`);
  } catch {}
  
  // 4. Check suspicious package
  console.log("\n=== Suspicious 0xede0f472...::c1::s1dhflr ===");
  try {
    const susMods = await client.getNormalizedMoveModulesByPackage({ package: SUSPICIOUS });
    console.log("Modules:", Object.keys(susMods).join(", "));
    for (const [modName, modData] of Object.entries(susMods)) {
      const fns = (modData as any).exposedFunctions ?? {};
      for (const [fnName, fnData] of Object.entries(fns)) {
        const vis = (fnData as any).isEntry ? "[entry]" : "[pub]";
        console.log(`  ${vis} ${modName}::${fnName}`);
      }
    }
  } catch (e: any) { console.log("Error:", e.message?.slice(0, 80)); }
  
  // 5. Look for Haedal protocol packages from events
  console.log("\n=== Haedal recent claim events ===");
  const claimEvts = await client.queryEvents({
    query: { MoveEventModule: { package: HAEDAL, module: "interface" } },
    limit: 5, order: "descending",
  });
  console.log(`Events: ${claimEvts.data.length}`);
  for (const e of claimEvts.data.slice(0, 3)) {
    console.log(`  ${e.type?.split("::").pop()} tx=${e.id.txDigest.slice(0,20)}`);
    const pj = JSON.stringify(e.parsedJson ?? {});
    console.log(`  ${pj.slice(0, 150)}`);
  }
}
main().catch(console.error);
