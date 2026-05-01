/**
 * Check Mole GlobalStorage package (0x9ec6f17e...) and scan for reward vulnerabilities
 */
import { SuiClient } from "@mysten/sui/client";
const client = new SuiClient({ url: "https://fullnode.mainnet.sui.io:443" });

// The GlobalStorage type is defined in this package
const MOLE_GLOBAL_PKG = "0x9ec6f17e19c5e64c8872779a635235497fd6c71f7b5c23b07f652b02a240c84a";
const MOLE_PKG        = "0x5ffa69ee4ee14d899dcc750df92de12bad4bacf81efa1ae12ee76406804dda7f";

const REWARD_KEYWORDS = ["claim", "harvest", "reward", "collect", "redeem", "pending", "earn", "accrue"];
const VERSION_KEYWORDS = ["version", "check_version", "verify_version", "checked_package_version"];

async function auditPackage(label: string, pkg: string) {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`[${label}] ${pkg}`);
  try {
    const mods = await client.getNormalizedMoveModulesByPackage({ package: pkg });
    const modNames = Object.keys(mods);
    console.log(`Modules (${modNames.length}): ${modNames.join(", ")}`);

    let hasVersionGuard = false;
    const open: string[] = [];
    const indexStructs: string[] = [];

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
        const hasKey = /Receipt|Key|Cap|Ticket|Position|NFT/i.test(paramStr);
        const hasAdmin = /AdminCap|ManagerCap/i.test(paramStr);
        const hasMutRef = paramStr.includes("MutableReference");
        const risk = (!hasKey && !hasAdmin && hasMutRef) ? "⚠️ MUTATING" : ((!hasKey && !hasAdmin) ? "🔍 READONLY" : "✅ GATED");
        const paramNames = fn.parameters.map((p: any) => {
          const s = JSON.stringify(p);
          const isMut = s.includes("MutableReference");
          return (isMut ? "&mut " : "") + (s.match(/"name":"(\w+)"/)?.[1] ?? s.slice(0, 20));
        });
        open.push(`  ${risk} ${fn.visibility}${fn.isEntry?" entry":""} ${modName}::${fnName}(${paramNames.join(", ")})`);
      }

      // Check structs for accumulator patterns
      for (const [stName, st] of Object.entries(mod.structs ?? {}) as [string, any][]) {
        const fields = st.fields ?? [];
        const hasIndex = fields.some((f: any) =>
          /index|reward_debt|acc_per_share|last_index/i.test(f.name)
        );
        if (hasIndex) {
          const relevantFields = fields
            .filter((f: any) => /index|reward|acc_per|share|debt/i.test(f.name))
            .map((f: any) => `${f.name}:${JSON.stringify(f.type).match(/"name":"(\w+)"/)?.[1] ?? "?"}`);
          indexStructs.push(`  ${modName}::${stName}: [${relevantFields.join(", ")}]`);
        }
      }
    }

    console.log(`Version Guard: ${hasVersionGuard ? "✅" : "❌"}`);
    if (open.length > 0) { console.log("Reward/accrue functions:"); for (const o of open) console.log(o); }
    if (indexStructs.length > 0) { console.log("Index/accumulator structs:"); for (const s of indexStructs) console.log(s); }

    // Recent activity
    const txs = await client.queryTransactionBlocks({
      filter: { MoveFunction: { package: pkg } },
      limit: 3, order: "descending",
    });
    console.log(`Recent txs: ${txs.data.length} (latest: ${txs.data[0]?.checkpoint ?? "none"})`);

  } catch (e: any) { console.log(`Error: ${e.message?.slice(0, 80)}`); }
}

async function main() {
  await auditPackage("MOLE_GLOBAL", MOLE_GLOBAL_PKG);

  // Also check if there are older Mole packages via events
  console.log("\n=== Checking for older Mole packages via events ===");
  try {
    const evts = await client.queryEvents({
      query: { MoveEventModule: { package: MOLE_GLOBAL_PKG, module: "global_storage" } },
      limit: 3,
      order: "ascending",
    });
    console.log(`global_storage events: ${evts.data.length}`);
    for (const e of evts.data) {
      console.log(`  ${e.type?.split("::").pop()}: ${JSON.stringify(e.parsedJson ?? {}).slice(0, 80)}`);
    }
  } catch (e: any) { console.log(`Error: ${e.message?.slice(0, 60)}`); }

  // Check vault events on MOLE_GLOBAL_PKG
  try {
    const evts = await client.queryEvents({
      query: { MoveEventModule: { package: MOLE_GLOBAL_PKG, module: "vault" } },
      limit: 3,
      order: "ascending",
    });
    console.log(`vault events: ${evts.data.length}`);
  } catch {}
}

main().catch(console.error);
