/**
 * Round 4 scan: remaining Typus packages + Mole Finance + DoubleUp
 */
import { SuiClient } from "@mysten/sui/client";
const client = new SuiClient({ url: "https://fullnode.mainnet.sui.io:443" });

const DUMMY = "0x0000000000000000000000000000000000000000000000000000000000001337";

const TARGETS: { name: string; pkg: string }[] = [
  // Remaining Typus
  { name: "TYPUS_LAUNCH_AUCTION",    pkg: "0x601a9f900ee01f6458809a881bef6115cc65762e2bd1fa022ea6bb6111862268" },
  { name: "TYPUS_LAUNCH_AIRDROP",    pkg: "0x23f43c4c84788a2acba2aba37610704197821b568e2c3f0a87fe024231bcd3d3" },
  { name: "TYPUS_LAUNCH_FUNDING",    pkg: "0x7dab89563066afa000ee154738aac2cc8e7d3e26cd0b470183db63630ee9f965" },
  { name: "TYPUS_HEDGE",             pkg: "0x15f0d9c093179f38ec90b20ac336750f82921730c25fed63e951d37a1a542bf0" },
  // Mole Finance (leveraged yield)
  // Source: https://github.com/mole-finance/mole-sdk address list
  { name: "MOLE_WORKER",             pkg: "0x87205c8e70dc98f0c03f9c6c05cfefb9f32285e3e27a7fa74b7c6a7d70e00e5b" },
  { name: "MOLE_VAULT",              pkg: "0x51fd6ee1a2ed9fcbde1f1a04af8ca7ff4ebe2acee3ab6fabe6a80d040ed29da2" },
  // DoubleUp / Unihouse
  { name: "DOUBLEUP_BULLSHARK",      pkg: "0xf6c05e2d9301e6e91dc6ab6c3ca918f7d55896e1f1ebb9c5be2fbb7d39fb38c8" },
  { name: "UNIHOUSE_CORE",           pkg: "0xa1f4016e447e3e31deb9af62f3d4bc80802de77c29e1fa64ccfd2bec7e4e2c12" },
];

const REWARD_KEYWORDS = [
  "claim", "harvest", "reward", "withdraw_reward", "collect", "redeem"
];

const VERSION_KEYWORDS = [
  "version", "check_version", "verify_version", "checked_package_version", "assert_version"
];

function hasAdminCap(paramStr: string): boolean {
  return /AdminCap|ManagerCap|AuthorityCap|Operator|Controller|TreasuryCap|owner|authority/i.test(paramStr)
    && !/TypusDepositReceipt|ObligationKey|PositionCap|UnstakeTicket/i.test(paramStr);
}

function hasUserKey(paramStr: string): boolean {
  return /Receipt|Key|Cap|Ticket|Position|NFT/i.test(paramStr);
}

async function scanPackage(name: string, pkg: string) {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`[${name}] ${pkg.slice(0, 20)}...`);

  try {
    const pkgObj = await client.getNormalizedMoveModulesByPackage({ package: pkg });
    const modules = Object.keys(pkgObj);
    console.log(`Modules (${modules.length}): ${modules.join(", ").slice(0, 100)}`);

    let hasVersionGuard = false;
    const findings: string[] = [];

    for (const modName of modules) {
      const mod = pkgObj[modName];
      if (!mod?.exposedFunctions) continue;

      // Check for version guard
      for (const fnName of Object.keys(mod.exposedFunctions)) {
        if (VERSION_KEYWORDS.some(k => fnName.toLowerCase().includes(k))) {
          hasVersionGuard = true;
        }
      }

      // Check for reward functions
      for (const [fnName, fn] of Object.entries(mod.exposedFunctions)) {
        if (!REWARD_KEYWORDS.some(k => fnName.toLowerCase().includes(k))) continue;
        if (fn.visibility === "Private") continue;

        const paramStr = JSON.stringify(fn.parameters);
        const needsUserKey = hasUserKey(paramStr);
        const needsAdminKey = hasAdminCap(paramStr);
        const isEntry = fn.isEntry;

        const risk = (!needsUserKey && !needsAdminKey) ? "⚠️ OPEN" : "✅ GATED";
        findings.push(`  ${risk} ${fn.visibility}${isEntry ? " entry" : ""} ${modName}::${fnName}(${
          fn.parameters.map(p => {
            const s = JSON.stringify(p);
            return s.match(/"name":"(\w+)"/)?.[1] ?? s.slice(0, 30);
          }).join(", ")
        })`);
      }
    }

    console.log(`Version Guard: ${hasVersionGuard ? "✅" : "❌"}`);
    if (findings.length > 0) {
      console.log("Reward functions:");
      for (const f of findings) console.log(f);
    } else {
      console.log("  No reward-related public functions");
    }

    // Check recent activity
    try {
      const txs = await client.queryTransactionBlocks({
        filter: { InputObject: pkg },
        limit: 3,
        order: "descending",
      });
      console.log(`Recent activity: ${txs.data.length > 0 ? txs.data[0].checkpoint + " (latest checkpoint)" : "0 txs"}`);
    } catch {}

  } catch (e: any) {
    console.log(`  ❌ Package not found or error: ${e.message?.slice(0, 80)}`);
  }
}

async function main() {
  console.log("=== Round 4: Typus Launch/Hedge + Mole + DoubleUp ===");
  for (const { name, pkg } of TARGETS) {
    await scanPackage(name, pkg);
  }
  console.log("\n=== Done ===");
}

main().catch(console.error);
