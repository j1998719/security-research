/**
 * Find actual NAVI IncentiveV2/V3 package addresses via shared object types
 */
import { SuiClient } from "@mysten/sui/client";
const client = new SuiClient({ url: "https://fullnode.mainnet.sui.io:443" });

const NAVI_INCENTIVE_V2_OBJ = "0xf87a8acb8b81d14307894d12595541a73f19933f88e1326d5be349c7a6f7559c";
const NAVI_INCENTIVE_V3_OBJ = "0x62982dad27fb10bb314b3384d5de8d2ac2d72ab2dbeae5d801dbdb9efa816c80";
const NAVI_VSUI_PKG = "0x68d22cf8bdbcd11ecba1e094922873e4080d4d11133e2443fddda0bfd11dae20";
const NAVI_MAIN_PKG = "0xee0041239b89564ce870a7dec5ddc5d114367ab94a1137e90aa0633cb76518e0";

const REWARD_KEYWORDS = ["claim", "harvest", "reward", "collect", "redeem"];
const VERSION_KEYWORDS = ["version", "check_version", "verify_version"];

async function getObjType(id: string, label: string) {
  console.log(`\n--- ${label}: ${id.slice(0, 22)} ---`);
  try {
    const obj = await client.getObject({ id, options: { showType: true } });
    const type = obj.data?.type ?? "not an object";
    console.log(`  Type: ${type.slice(0, 150)}`);
    const pkgMatch = type.match(/^(0x[a-f0-9]{64})::/);
    if (pkgMatch) console.log(`  *** Defining package: ${pkgMatch[1]} ***`);
    return pkgMatch?.[1];
  } catch (e: any) { console.log(`  Error: ${e.message?.slice(0, 60)}`); return null; }
}

async function scanPkg(label: string, pkg: string) {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`[${label}] ${pkg}`);
  try {
    const mods = await client.getNormalizedMoveModulesByPackage({ package: pkg });
    const modNames = Object.keys(mods);
    console.log(`Modules: ${modNames.join(", ").slice(0, 150)}`);

    let hasVersionGuard = false;
    const open: string[] = [];

    for (const modName of modNames) {
      const mod = mods[modName];
      if (!mod?.exposedFunctions) continue;

      for (const fnName of Object.keys(mod.exposedFunctions)) {
        if (VERSION_KEYWORDS.some(k => fnName.toLowerCase().includes(k))) hasVersionGuard = true;
      }

      for (const [fnName, fn] of Object.entries(mod.exposedFunctions) as [string, any][]) {
        if (!REWARD_KEYWORDS.some(k => fnName.toLowerCase().includes(k))) continue;
        if (fn.visibility === "Private") continue;
        const paramStr = JSON.stringify(fn.parameters);
        const hasKey = /Receipt|Key|Cap|Ticket|Position|NFT|Obligation/i.test(paramStr);
        const hasAdmin = /AdminCap|ManagerCap|TreasuryCap/i.test(paramStr);
        const hasMutRef = paramStr.includes("MutableReference");
        const risk = (!hasKey && !hasAdmin && hasMutRef) ? "⚠️" : (!hasKey && !hasAdmin ? "🔍" : "✅");
        const paramNames = fn.parameters.map((p: any) => {
          const s = JSON.stringify(p);
          return (s.includes("MutableReference") ? "&mut " : "") + (s.match(/"name":"(\w+)"/)?.[1] ?? s.slice(0, 20));
        });
        open.push(`  ${risk} ${fn.visibility}${fn.isEntry?" entry":""} ${modName}::${fnName}(${paramNames.join(", ")})`);
      }
    }

    console.log(`Version Guard: ${hasVersionGuard ? "✅" : "❌"}`);
    if (open.length > 0) { for (const o of open) console.log(o); }
    else console.log("  No public reward functions");

    const txs = await client.queryTransactionBlocks({
      filter: { MoveFunction: { package: pkg } }, limit: 2, order: "descending",
    });
    console.log(`Recent txs: ${txs.data.length} (cp: ${txs.data[0]?.checkpoint ?? "none"})`);

  } catch (e: any) { console.log(`Error: ${e.message?.slice(0, 80)}`); }
}

async function main() {
  // 1. Find which packages define IncentiveV2/V3 types
  const v2Pkg = await getObjType(NAVI_INCENTIVE_V2_OBJ, "IncentiveV2");
  const v3Pkg = await getObjType(NAVI_INCENTIVE_V3_OBJ, "IncentiveV3");

  if (v2Pkg && v2Pkg !== NAVI_MAIN_PKG) await scanPkg("NAVI_IncentiveV2_PKG", v2Pkg);
  if (v3Pkg && v3Pkg !== NAVI_MAIN_PKG) await scanPkg("NAVI_IncentiveV3_PKG", v3Pkg);

  // 2. Scan main NAVI package
  await scanPkg("NAVI_MAIN", NAVI_MAIN_PKG);

  // 3. Scan vSui Protocol Package
  await scanPkg("NAVI_VSUI", NAVI_VSUI_PKG);
}

main().catch(console.error);
