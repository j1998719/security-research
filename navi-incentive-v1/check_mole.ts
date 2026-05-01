/**
 * Audit Mole Finance leveraged yield farming package
 */
import { SuiClient } from "@mysten/sui/client";
const client = new SuiClient({ url: "https://fullnode.mainnet.sui.io:443" });

const MOLE_PKG = "0x5ffa69ee4ee14d899dcc750df92de12bad4bacf81efa1ae12ee76406804dda7f";
const DUMMY = "0x0000000000000000000000000000000000000000000000000000000000001337";

const REWARD_KEYWORDS = ["claim", "harvest", "reward", "collect", "redeem", "pending", "earn"];
const VERSION_KEYWORDS = ["version", "check_version", "verify_version", "checked_package_version"];

async function main() {
  console.log("=== Mole Finance Audit ===\n");

  let mods: Record<string, any>;
  try {
    mods = await client.getNormalizedMoveModulesByPackage({ package: MOLE_PKG });
  } catch (e: any) {
    console.log(`Package error: ${e.message?.slice(0, 100)}`);
    return;
  }

  const modNames = Object.keys(mods);
  console.log(`Modules (${modNames.length}): ${modNames.join(", ")}`);

  let hasVersionGuard = false;
  const findings: { risk: string; line: string }[] = [];

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
      const hasAdmin = /AdminCap|ManagerCap|TreasuryCap|authority|AdminKey/i.test(paramStr);
      const paramNames = fn.parameters.map((p: any) => {
        const s = JSON.stringify(p);
        return s.match(/"name":"(\w+)"/)?.[1] ?? s.slice(0, 25);
      });
      const risk = (!hasKey && !hasAdmin) ? "⚠️" : "✅";
      findings.push({
        risk,
        line: `  ${risk} ${fn.visibility}${fn.isEntry?" entry":""} ${modName}::${fnName}(${paramNames.join(", ")})`
      });
    }
  }

  console.log(`\nVersion Guard: ${hasVersionGuard ? "✅" : "❌"}`);
  if (findings.length > 0) {
    console.log("Reward functions:");
    for (const f of findings) console.log(f.line);
  } else {
    console.log("No reward-related public functions found");
  }

  // Check for reward-index / masterchef-style structs
  console.log("\n--- Struct fields (reward-related) ---");
  for (const modName of modNames) {
    const mod = mods[modName];
    for (const [stName, st] of Object.entries(mod.structs ?? {}) as [string, any][]) {
      const fields = st.fields ?? [];
      const hasIndex = fields.some((f: any) =>
        /index|reward_debt|acc_per_share|last_index|pendingReward/i.test(f.name)
      );
      if (hasIndex) {
        console.log(`  ${modName}::${stName}:`);
        for (const f of fields) {
          if (/index|reward|acc_per|share|pending/i.test(f.name)) {
            console.log(`    *** ${f.name}: ${JSON.stringify(f.type).slice(0,60)}`);
          }
        }
      }
    }
  }

  // Recent activity
  console.log("\n--- Recent activity ---");
  try {
    const txs = await client.queryTransactionBlocks({
      filter: { MoveFunction: { package: MOLE_PKG } },
      limit: 3,
      order: "descending",
    });
    console.log(`Recent txs: ${txs.data.length}`);
    for (const tx of txs.data) {
      const d = tx.transaction?.data?.transaction as any;
      const calls = d?.transactions ?? [];
      for (const c of calls.slice(0,2)) {
        if (c.MoveCall) console.log(`  ${c.MoveCall.module}::${c.MoveCall.function} @ cp${tx.checkpoint}`);
      }
    }
  } catch (e: any) { console.log(`Error: ${e.message?.slice(0,60)}`); }
}

main().catch(console.error);
