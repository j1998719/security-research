/**
 * Scan NAVI IncentiveV2, V3 and Spring SUI for version guard issues
 */
import { SuiClient } from "@mysten/sui/client";
import { Transaction } from "@mysten/sui/transactions";
const client = new SuiClient({ url: "https://fullnode.mainnet.sui.io:443" });

const NAVI_V1  = "0xd899cf7d2b5db321e84e78cdcf4e7e97bf2de33c0dea3b5f5db8f53e7b0a3b5e"; // known vulnerable
const NAVI_V2  = "0xf87a8acb8b81d14307894d12595541a73f19933f88e1326d5be349c7a6f7559c";
const NAVI_V3  = "0x62982dad27fb10bb314b3384d5de8d2ac2d72ab2dbeae5d801dbdb9efa816c80";
const SPRING_PKG = "0xb0575765166030556a6eafd3b1b970eba8183ff748860680245b9edd41c716e7";
const DUMMY = "0x0000000000000000000000000000000000000000000000000000000000001337";

const REWARD_KEYWORDS = ["claim", "harvest", "reward", "collect", "redeem", "pending"];
const VERSION_KEYWORDS = ["version", "check_version", "verify_version"];

async function scanPkg(label: string, pkg: string) {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`[${label}] ${pkg}`);
  try {
    const mods = await client.getNormalizedMoveModulesByPackage({ package: pkg });
    const modNames = Object.keys(mods);
    console.log(`Modules: ${modNames.join(", ").slice(0, 120)}`);

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
        const hasKey = /Receipt|Key|Cap|Ticket|Position|NFT|ObligationKey/i.test(paramStr);
        const hasAdmin = /AdminCap|ManagerCap|TreasuryCap/i.test(paramStr);
        const hasMutRef = paramStr.includes("MutableReference");
        const risk = (!hasKey && !hasAdmin && hasMutRef) ? "⚠️" : (!hasKey && !hasAdmin ? "🔍" : "✅");
        const paramNames = fn.parameters.map((p: any) => {
          const s = JSON.stringify(p);
          const isMut = s.includes("MutableReference");
          return (isMut ? "&mut " : "") + (s.match(/"name":"(\w+)"/)?.[1] ?? s.slice(0, 20));
        });
        open.push(`  ${risk} ${fn.visibility}${fn.isEntry?" entry":""} ${modName}::${fnName}(${paramNames.join(", ")})`);
      }
    }

    console.log(`Version Guard: ${hasVersionGuard ? "✅" : "❌"}`);
    if (open.length > 0) { console.log("Reward fns:"); for (const o of open) console.log(o); }
    else console.log("  No reward-related public functions");

    const txs = await client.queryTransactionBlocks({
      filter: { MoveFunction: { package: pkg } }, limit: 2, order: "descending",
    });
    console.log(`Recent txs: ${txs.data.length} (latest cp: ${txs.data[0]?.checkpoint ?? "none"})`);

  } catch (e: any) { console.log(`Error: ${e.message?.slice(0, 80)}`); }
}

async function dryRunNaviV2Claim() {
  console.log("\n=== Dry-run NAVI V2 claim_reward (if exists) ===");
  try {
    const mod = await client.getNormalizedMoveModule({ package: NAVI_V2, module: "incentive_v2" });
    const fns = Object.keys(mod.exposedFunctions).filter(n => n.includes("claim"));
    console.log(`claim functions: ${fns.join(", ")}`);
    for (const fnName of fns.slice(0, 2)) {
      const fn = mod.exposedFunctions[fnName];
      const paramNames = fn.parameters.map((p: any) => {
        const s = JSON.stringify(p);
        return s.match(/"name":"(\w+)"/)?.[1] ?? s.slice(0, 25);
      });
      console.log(`  ${fn.visibility}${fn.isEntry?" entry":""} ${fnName}(${paramNames.join(", ")})`);
    }
  } catch (e: any) { console.log(`Error: ${e.message?.slice(0, 60)}`); }
}

async function main() {
  await scanPkg("NAVI_IncentiveV2", NAVI_V2);
  await scanPkg("NAVI_IncentiveV3", NAVI_V3);
  await scanPkg("SPRING_SUI", SPRING_PKG);
  await dryRunNaviV2Claim();
}

main().catch(console.error);
