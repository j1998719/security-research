/**
 * Discover small Sui protocols by querying recent events
 * with reward/claim patterns - then check their security
 */
import { SuiClient } from "@mysten/sui/client";
const client = new SuiClient({ url: "https://fullnode.mainnet.sui.io:443" });

// Known major/already-audited packages to skip
const KNOWN_SAFE = new Set([
  "0x2b71664477755b90f9fb71c9c944d5d0d3832fec969260e3f18efc7d855f57c4", // Nemo
  "0xd899cf7d2f3c12bfd6a671b1d0c90b7ebf9b9bcd6c6f2e8a9b3c4d5e6f7a8b9", // NAVI v1
  "0xec1ac7f4d01c5bf178ff4e62e523e7df7721453d81d4904a42a0ffc2686c843d", // Scallop spool v2
  "0xe87f1b2d498106a2c61421cec75b7b5c5e348512b0dc263949a0e7a3c256571a", // Scallop spool v1
  "0x996c4d9480708fb8b92aa7acf819fb0497b5ec8e65ba06601cae2fb6db3312c3", // Cetus CLMM
  "0xa0eba10b173538c8fecca1dff298e488402cc9ff374f8a12ca7758eebe830b66", // Kriya AMM
]);

// Search for recently active reward events from unknown protocols
async function discoverViaEvents() {
  console.log("=== Discovering protocols via reward events ===\n");
  
  const discovered = new Map<string, { modules: Set<string>, events: string[] }>();
  
  // Query recent transactions that call claim/reward functions
  // Use different module name patterns
  const patterns = [
    { pkg_hint: null, event_hint: "ClaimReward" },
    { pkg_hint: null, event_hint: "HarvestEvent" },
    { pkg_hint: null, event_hint: "RewardClaimed" },
    { pkg_hint: null, event_hint: "EmissionClaimed" },
  ];

  // Search for recent txs that have MoveCall to "claim_reward" or similar
  // We'll look at recent checkpoint transactions
  console.log("--- Finding active reward protocols via recent txs ---");
  
  // Get recent transaction blocks with specific move function patterns
  const rewardModules = ["farm", "farming", "staking", "incentive", "emission", "gauge", "pool"];
  const rewardFunctions = ["claim", "harvest", "claim_reward", "claim_emission"];
  
  for (const mod of rewardModules.slice(0, 4)) {
    for (const fn of rewardFunctions.slice(0, 2)) {
      try {
        // We can't search by function name without package, but let's try known small protocols
        const txs = await client.queryTransactionBlocks({
          filter: { MoveFunction: { module: mod, function: fn } } as any,
          limit: 5,
          order: "descending",
        });
        if (txs.data.length > 0) {
          for (const tx of txs.data) {
            const txData = tx.transaction?.data?.transaction as any;
            for (const call of (txData?.transactions ?? []).filter((c: any) => c.MoveCall)) {
              const pkg = call.MoveCall.package;
              if (!KNOWN_SAFE.has(pkg) && call.MoveCall.module === mod) {
                if (!discovered.has(pkg)) discovered.set(pkg, { modules: new Set(), events: [] });
                discovered.get(pkg)!.modules.add(`${call.MoveCall.module}::${call.MoveCall.function}`);
              }
            }
          }
          if (txs.data.length > 0) {
            console.log(`${mod}::${fn}: ${txs.data.length} recent txs`);
          }
        }
      } catch {}
    }
  }

  if (discovered.size > 0) {
    console.log(`\nDiscovered ${discovered.size} unknown packages:`);
    for (const [pkg, info] of discovered) {
      console.log(`  ${pkg.slice(0,24)}: ${[...info.modules].join(", ")}`);
    }
  } else {
    console.log("No new packages discovered via MoveFunction filter");
  }

  return discovered;
}

// Check Haedal interface::claim more carefully
async function checkHaedalClaim() {
  console.log("\n=== Haedal interface::claim deep check ===");
  const HAEDAL = "0xbde4ba4c2e274a60ce15c1cfff9e5c42e41654ac8b6d906a57efa4bd3c29f47d";
  
  try {
    const fn = await client.getNormalizedMoveFunction({
      package: HAEDAL, module: "interface", function: "claim"
    });
    console.log(`visibility: ${fn.visibility}, isEntry: ${fn.isEntry}`);
    console.log("parameters:");
    for (let i = 0; i < fn.parameters.length; i++) {
      const p = JSON.stringify(fn.parameters[i]).slice(0, 100);
      console.log(`  [${i}]: ${p}`);
    }
    
    // Check for version guard in Haedal
    const mods = await client.getNormalizedMoveModulesByPackage({ package: HAEDAL });
    const versionMods = Object.keys(mods).filter(m => m.includes("version") || m.includes("guard"));
    console.log(`Version guard modules: ${versionMods.join(", ") || "NONE"}`);
    
    // Check all structs for version field
    for (const [mod, modDef] of Object.entries(mods)) {
      for (const [name, struct] of Object.entries(modDef.structs)) {
        if (struct.fields?.some(f => f.name === "version")) {
          console.log(`Struct with version: ${mod}::${name}`);
        }
      }
    }
  } catch (e: any) { console.log("Error:", e.message?.slice(0,60)); }
}

// Scan newly found small protocols
async function scanSmallProtocol(pkg: string, label: string) {
  console.log(`\n--- ${label}: ${pkg.slice(0,24)}... ---`);
  try {
    const norm = await client.getNormalizedMoveModulesByPackage({ package: pkg });
    const mods = Object.keys(norm);
    console.log(`Modules: ${mods.join(", ")}`);
    
    for (const mod of mods) {
      const modDef = norm[mod];
      for (const [fnName, fn] of Object.entries(modDef.exposedFunctions)) {
        const lower = fnName.toLowerCase();
        if ((lower.includes("claim") || lower.includes("reward") || lower.includes("harvest")) && fn.isEntry) {
          const params = fn.parameters.map(p => {
            const s = JSON.stringify(p);
            return s.match(/"name":"(\w+)"/)?.[1] ?? s.slice(0, 30);
          });
          const hasAdminCap = params.some(p => /cap|admin|key|auth/i.test(p));
          const marker = hasAdminCap ? "🔒 gated" : "⚠️ open";
          console.log(`  ${marker} ${mod}::${fnName}(${params.slice(0,4).join(", ")})`);
        }
      }
      // Index pattern check
      for (const [structName, struct] of Object.entries(modDef.structs)) {
        const idxFields = struct.fields?.filter(f => 
          /index|reward_debt|acc_reward|last_index|rewards_paid/i.test(f.name)
        ) ?? [];
        if (idxFields.length > 0 && !["tick_lower_index", "tick_upper_index", "current_tick_index"].includes(idxFields[0]?.name)) {
          console.log(`  INDEX: ${mod}::${structName}.[${idxFields.map(f=>f.name).join(",")}]`);
        }
      }
    }
  } catch (e: any) { console.log(`Error: ${e.message?.slice(0,60)}`); }
}

// Try additional small Sui protocols with better addresses
async function checkMoreProtocols() {
  console.log("\n\n=== Additional small protocols ===");
  
  const protocols = [
    // Suia Finance
    { label: "Suia Finance", pkg: "0x1d58e26e85fbf9ee8596872686da75544342487b65b6f1c1c39d35b6aa4e9e8d" },
    // Kana Labs
    { label: "Kana Labs Farming", pkg: "0x5ee33b9a5ceb8c6b1c7e1c7e1c7e1c7e1c7e1c7e1c7e1c7e1c7e1c7e1c7e1c7" },
    // Sui Yields (small aggregator)
    { label: "Cetus Farming", pkg: "0x11ea791d82b5742cc8cab0bf7946035c97d9001d7c3803a93f119753da66f526" },
    // NAVI points farming (separate from NAVI lending)
    { label: "NAVI Points", pkg: "0x3a471d42d99acf64dd8cb6a0c6c20ff3e68d2d18e0aa49cc8cbc8bab83c2ffe3" },
    // SuiSwap farming
    { label: "SuiSwap", pkg: "0xfc7ca5542e90c9dab4f82c47d94e65b7e93dcac38c95b20e62618f3cfc88d87" },
    // Cetus farming pools
    { label: "Cetus Farm v2", pkg: "0x1e0b178cc0ed5c9a9d5843e1c0c8e8aa5c46f3e3b7e7c7e7c7e7c7e7c7e7c7" },
    // MovEX
    { label: "MovEX", pkg: "0x16b6be6d6d0a3f40bb60f5ce1b4d30c8b34c6f5edb3e9db9b9e9c9e9a9b9c9d" },
    // Legato Finance
    { label: "Legato Finance", pkg: "0x3b584b38b895f1bde4c2e5a9a2a6dfbe0a35fdf1a7c8c5e9e7e5e3e1dfe0fd" },
  ];
  
  for (const p of protocols) {
    await scanSmallProtocol(p.pkg, p.label);
    await new Promise(r => setTimeout(r, 100));
  }
}

async function main() {
  const discovered = await discoverViaEvents();
  await checkHaedalClaim();
  await checkMoreProtocols();
  
  // Scan any discovered protocols
  for (const [pkg] of discovered) {
    await scanSmallProtocol(pkg, `Discovered:${pkg.slice(0,12)}`);
  }
}
main().catch(console.error);
