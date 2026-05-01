import { SuiClient } from "@mysten/sui/client";
const client = new SuiClient({ url: "https://fullnode.mainnet.sui.io:443" });

const VOLO = "0x549e8b69270defbfafd4f94e17ec44cdbdd99820b33bda2278dea3b9a32d3f55";

async function main() {
  // Check Volo update_rewards signature
  console.log("=== Volo native_pool::update_rewards ===");
  try {
    const fn = await client.getNormalizedMoveFunction({ package: VOLO, module: "native_pool", function: "update_rewards" });
    console.log("isEntry:", fn.isEntry);
    for (let i = 0; i < fn.parameters.length; i++) {
      const p = JSON.stringify(fn.parameters[i]);
      const name = p.match(/"name":"(\w+)"/)?.[1] ?? p.slice(0, 70);
      const isMut = p.includes("MutableReference");
      console.log(`  [${i}] ${isMut?"&mut":"&"} ${name}`);
    }
  } catch (e: any) { console.log("Error:", e.message?.slice(0, 60)); }

  // Check Volo stake
  console.log("\n=== Volo native_pool::stake ===");
  try {
    const fn = await client.getNormalizedMoveFunction({ package: VOLO, module: "native_pool", function: "stake" });
    console.log("isEntry:", fn.isEntry);
    for (let i = 0; i < fn.parameters.length; i++) {
      const p = JSON.stringify(fn.parameters[i]);
      const name = p.match(/"name":"(\w+)"/)?.[1] ?? p.slice(0, 70);
      console.log(`  [${i}] ${name}`);
    }
  } catch (e: any) { console.log("Error:", e.message?.slice(0, 60)); }

  // Check NativePool struct for version
  console.log("\n=== Volo NativePool struct ===");
  try {
    const st = await client.getNormalizedMoveStruct({ package: VOLO, module: "native_pool", struct: "NativePool" });
    for (const f of st.fields) {
      console.log(`  ${f.name}: ${JSON.stringify(f.type).slice(0, 60)}`);
    }
  } catch (e: any) { console.log("Error:", e.message?.slice(0, 60)); }

  // Is update_rewards callable by anyone? Check if it requires admin cap
  console.log("\n=== Volo modules with version guard ===");
  const mods = await client.getNormalizedMoveModulesByPackage({ package: VOLO });
  for (const [modName, modData] of Object.entries(mods)) {
    const structs = (modData as any).structs ?? {};
    for (const [sname, sd] of Object.entries(structs)) {
      const fields = (sd as any).fields ?? [];
      if (fields.some((f: any) => f.name === "version")) {
        console.log(`  ${modName}::${sname} has version field`);
      }
    }
  }
}
main().catch(console.error);
