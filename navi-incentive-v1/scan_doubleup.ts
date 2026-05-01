/**
 * Scan DoubleUp Unihouse + find Mole Finance
 */
import { SuiClient } from "@mysten/sui/client";
const client = new SuiClient({ url: "https://fullnode.mainnet.sui.io:443" });

const UNIHOUSE_CORE = "0x2f2226a22ebeb7a0e63ea39551829b238589d981d1c6dd454f01fcc513035593";
const UNIHOUSE_PKG  = "0x39b389ebfc91fc0a6be7cff84dae9cca67c4074820429e5cf00e6ed6b35aef41";

const REWARD_KEYWORDS = ["claim", "harvest", "reward", "withdraw_reward", "collect", "redeem"];
const VERSION_KEYWORDS = ["version", "check_version", "verify_version", "checked_package_version"];

async function auditPackage(label: string, pkg: string) {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`[${label}] ${pkg.slice(0, 22)}...`);
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

      for (const [fnName, fn] of Object.entries(mod.exposedFunctions)) {
        if (!REWARD_KEYWORDS.some(k => fnName.toLowerCase().includes(k))) continue;
        if (fn.visibility === "Private") continue;
        const paramStr = JSON.stringify(fn.parameters);
        const hasKey = /Receipt|Key|Cap|Ticket|Position|NFT|ObligationKey/i.test(paramStr);
        const hasAdmin = /AdminCap|ManagerCap|TreasuryCap|authority/i.test(paramStr);
        const paramNames = fn.parameters.map(p => {
          const s = JSON.stringify(p);
          return s.match(/"name":"(\w+)"/)?.[1] ?? s.slice(0, 25);
        });
        if (!hasKey && !hasAdmin) {
          open.push(`  ⚠️ ${fn.visibility}${fn.isEntry?" entry":""} ${modName}::${fnName}(${paramNames.join(", ")})`);
        } else {
          open.push(`  ✅ ${fn.visibility}${fn.isEntry?" entry":""} ${modName}::${fnName}(${paramNames.join(", ")})`);
        }
      }
    }

    console.log(`Version Guard: ${hasVersionGuard ? "✅" : "❌"}`);
    if (open.length > 0) { console.log("Reward fns:"); for (const o of open) console.log(o); }
    else console.log("  No reward-related public functions");

    // Check recent txs
    const txs = await client.queryTransactionBlocks({
      filter: { InputObject: pkg }, limit: 3, order: "descending",
    });
    console.log(`Recent txs: ${txs.data.length > 0 ? txs.data[0].checkpoint : "0"}`);
  } catch (e: any) { console.log(`Error: ${e.message?.slice(0, 80)}`); }
}

async function findMoleFinance() {
  console.log("\n=== Searching Mole Finance via known patterns ===");
  // Mole Finance is a leveraged yield farming protocol
  // Try querying events from known patterns
  const candidates = [
    // From various Sui ecosystem lists
    "0x3c7bfc4a5b04a56e10b1a5c6c39bfd68a5e1d0a3f2c8e2f64a5b7d3e9f1c2b4",
    "0x9b88f5a6a12ac40e66bba87f6a23ee41b71f68b47c15e9c69e6b5a12a567890a",
  ];
  // Actually let me query events for "leveraged" or "farm" type events
  console.log("  (Need to find via GitHub/docs - trying explorer approach)");

  // Query for any Sui packages with "mole" in events
  try {
    const txs = await client.queryTransactionBlocks({
      filter: { FromAddress: "0x0000000000000000000000000000000000000000000000000000000000000000" },
      limit: 1,
    });
  } catch {}
}

async function main() {
  await auditPackage("UNIHOUSE_CORE", UNIHOUSE_CORE);
  await auditPackage("UNIHOUSE_PKG",  UNIHOUSE_PKG);
  await findMoleFinance();
}

main().catch(console.error);
