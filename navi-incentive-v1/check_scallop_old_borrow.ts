/**
 * Check Scallop OLD_BORROW_INCENTIVE_PROTOCOL_ID for vulnerability
 * Found in scallop-io/sui-scallop-sdk constants
 */
import { SuiClient } from "@mysten/sui/client";
const client = new SuiClient({ url: "https://fullnode.mainnet.sui.io:443" });

// From SDK: old borrow incentive object
const OLD_BORROW_INCENTIVE_OBJ = "0xc63072e7f5f4983a2efaf5bdba1480d5e7d74d57948e1c7cc436f8e22cbeb410";

async function main() {
  // Check what type this object is
  const obj = await client.getObject({ id: OLD_BORROW_INCENTIVE_OBJ, options: { showContent: true, showType: true } });
  if (obj.error) {
    console.log("Error:", obj.error);
    return;
  }
  
  const type = obj.data?.type ?? "unknown";
  console.log("Type:", type);
  const fields = (obj.data?.content as any)?.fields ?? {};
  console.log("Fields:", JSON.stringify(fields).slice(0, 400));
  
  // Extract the package from the type
  const pkgMatch = type.match(/^(0x[0-9a-f]+)::/);
  const pkg = pkgMatch?.[1];
  if (!pkg) { console.log("Cannot extract package"); return; }
  
  console.log("\nPackage:", pkg);
  
  // Check all modules and entry functions
  const mods = await client.getNormalizedMoveModulesByPackage({ package: pkg });
  console.log("Modules:", Object.keys(mods).join(", "));
  
  const REWARD_KW = ["claim", "reward", "harvest", "redeem"];
  let hasVersionGuard = false;
  const rewardEntries: string[] = [];
  
  for (const [modName, modData] of Object.entries(mods)) {
    const structs = (modData as any).structs ?? {};
    for (const [_, sd] of Object.entries(structs)) {
      if (((sd as any).fields ?? []).some((f: any) => f.name === "version")) hasVersionGuard = true;
    }
    const fns = (modData as any).exposedFunctions ?? {};
    for (const [fnName, fnData] of Object.entries(fns)) {
      if (REWARD_KW.some(kw => fnName.toLowerCase().includes(kw)) && (fnData as any).isEntry) {
        rewardEntries.push(`${modName}::${fnName}`);
      }
    }
  }
  
  console.log(`Version guard: ${hasVersionGuard ? "YES" : "⚠️NO"}`);
  console.log(`Reward entry functions: ${rewardEntries.length}`);
  for (const fn of rewardEntries) console.log(`  ⚡ ${fn}`);
  
  // Check user reward struct if any
  for (const [modName, modData] of Object.entries(mods)) {
    const structs = (modData as any).structs ?? {};
    for (const [sname, sd] of Object.entries(structs)) {
      const sfields = (sd as any).fields ?? [];
      if (sfields.some((f: any) => ["index", "last_index", "user_index", "reward_index"].includes(f.name))) {
        console.log(`\n  ${modName}::${sname} (reward tracking struct):`);
        for (const f of sfields) console.log(`    ${f.name}: ${JSON.stringify(f.type).slice(0, 60)}`);
      }
    }
  }
}
main().catch(console.error);
