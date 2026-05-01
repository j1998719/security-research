/**
 * Discover active small DeFi protocols on Sui by:
 * 1. Looking at recent transactions from non-major packages
 * 2. Checking event types for reward/claim patterns
 */
import { SuiClient } from "@mysten/sui/client";
const client = new SuiClient({ url: "https://fullnode.mainnet.sui.io:443" });

// All major known packages to filter out
const MAJOR_PKGS = new Set([
  "0x2b71664477755b90f9fb71c9c944d5d0d3832fec969260e3f18efc7d855f57c4",
  "0xec1ac7f4d01c5bf178ff4e62e523e7df7721453d81d4904a42a0ffc2686c843d",
  "0xe87f1b2d498106a2c61421cec75b7b5c5e348512b0dc263949a0e7a3c256571a",
  "0x996c4d9480708fb8b92aa7acf819fb0497b5ec8e65ba06601cae2fb6db3312c3",
  "0xa0eba10b173538c8fecca1dff298e488402cc9ff374f8a12ca7758eebe830b66",
  "0xbde4ba4c2e274a60ce15c1cfff9e5c42e41654ac8b6d906a57efa4bd3c29f47d",
  "0x11ea791d82b5742cc8cab0bf7946035c97d9001d7c3803a93f119753da66f526",
  "0x83bbe0b3985c5e3857803e2678899b03f3c4a31be75006ab03faf268c014ce41",
  "0x1eabed72c53feb3805120a081dc15963c204dc8d091542592abaf7a35689b2fb",
]);

const REWARD_KEYWORDS = ["claim", "harvest", "reward", "stake", "incentive", "emission"];

async function scanProtocol(pkg: string): Promise<{ risk: string; details: string[] } | null> {
  try {
    const norm = await client.getNormalizedMoveModulesByPackage({ package: pkg });
    const mods = Object.keys(norm);
    
    let hasVersionGuard = false;
    let openRewardFns: string[] = [];
    let indexPatterns: string[] = [];
    
    for (const [mod, modDef] of Object.entries(norm)) {
      // Version guard check
      if (/version|guard/i.test(mod)) hasVersionGuard = true;
      
      for (const [fnName, fn] of Object.entries(modDef.exposedFunctions)) {
        if (/version|check_version|verify_version/i.test(fnName)) hasVersionGuard = true;
        
        if (fn.isEntry && REWARD_KEYWORDS.some(k => fnName.toLowerCase().includes(k))) {
          const paramStr = JSON.stringify(fn.parameters);
          const requiresAdmin = /Cap|Admin|Key|Authority|Governance/i.test(paramStr);
          if (!requiresAdmin) {
            openRewardFns.push(`${mod}::${fnName}`);
          }
        }
      }
      
      for (const [structName, st] of Object.entries(modDef.structs)) {
        const idxFields = st.fields?.filter(f => 
          /^(last_index|index_rewards_paid|reward_debt|acc_reward_per_share|index_per_share)$/i.test(f.name)
        ) ?? [];
        if (idxFields.length > 0) {
          indexPatterns.push(`${mod}::${structName}.[${idxFields.map(f => f.name).join(",")}]`);
        }
      }
    }
    
    if (!hasVersionGuard && (openRewardFns.length > 0 || indexPatterns.length > 0)) {
      return {
        risk: openRewardFns.length > 0 && indexPatterns.length > 0 ? "🔴 HIGH" : "🟡 MEDIUM",
        details: [...openRewardFns.map(f => `open: ${f}`), ...indexPatterns.map(p => `index: ${p}`)]
      };
    }
    return null;
  } catch {
    return null;
  }
}

async function main() {
  console.log("=== Discover Active Sui DeFi Protocols ===\n");
  
  const discovered = new Map<string, { label: string; mods: string }>();
  
  // Method 1: Look at recent events with reward-like type names
  // Query from well-known Sui checkpoint range for recent activity
  console.log("--- Method: scan recent MoveCall transactions ---");
  
  // Get the latest checkpoint number
  let latestCheckpoint: bigint;
  try {
    const resp = await client.getLatestCheckpointSequenceNumber();
    latestCheckpoint = BigInt(resp);
    console.log(`Latest checkpoint: ${latestCheckpoint}`);
  } catch {
    latestCheckpoint = BigInt(50000000);
  }
  
  // Look at transactions involving "incentive" or "farm" modules on recent activity
  // via querying transaction blocks with specific function patterns
  const searchMods = ["farm", "farming", "staking_reward", "emission", "gauge", "masterchef", "rewarder"];
  
  for (const mod of searchMods) {
    try {
      const txs = await client.queryTransactionBlocks({
        filter: { MoveFunction: { module: mod } } as any,
        limit: 5,
        order: "descending",
        options: { showInput: true },
      });
      if (txs.data.length > 0) {
        console.log(`\nModule '${mod}': ${txs.data.length} recent txs`);
        for (const tx of txs.data.slice(0, 3)) {
          const txData = tx.transaction?.data?.transaction as any;
          for (const call of (txData?.transactions ?? []).filter((c: any) => c.MoveCall && c.MoveCall.module === mod)) {
            const pkg = call.MoveCall.package;
            if (!MAJOR_PKGS.has(pkg) && !discovered.has(pkg)) {
              discovered.set(pkg, { label: `${mod}::${call.MoveCall.function}`, mods: mod });
              console.log(`  🆕 NEW: ${pkg.slice(0,24)}... ${mod}::${call.MoveCall.function}`);
            }
          }
        }
      }
    } catch {}
    await new Promise(r => setTimeout(r, 100));
  }

  // Method 2: Search for specific event type names
  console.log("\n--- Method: scan event types ---");
  const eventTypes = [
    "ClaimRewardEvent", "HarvestEvent", "RewardClaimedEvent", 
    "StakeRewardEvent", "EmissionEvent", "ClaimEmission"
  ];
  // Can't wildcard search, but try known small protocols
  
  // Method 3: Check specific small Sui protocols by correct address
  const knownSmall = [
    // Turbos Finance farming
    { pkg: "0x9632f61a796fc54952d9151d80b319b623b91b21b4e9e4e7df7e2a0b9c8f6f62", label: "Turbos Farm" },
    // DEEP token farming (DeepBook)
    { pkg: "0xdeeb7a4662eec9f2f3def03fb937a663dddaa2e215b8078a284d026b7946c270", label: "DEEP Token" },
    // FUD token farming
    { pkg: "0x76cb819b01abed502bee8a702b4c2d547532c12f25522b28b9d1364b4ce325ab", label: "FUD" },
    // Sui ecosystem staking
    { pkg: "0xf325ce1300e8dac124071d3152c5c5ee6174914f8bc2161e88329cf579246efc", label: "AE Token" },
  ];

  console.log("\n--- Checking known small protocol addresses ---");
  for (const p of knownSmall) {
    const result = await scanProtocol(p.pkg);
    if (result) {
      console.log(`\n🚨 [${p.label}] ${p.pkg.slice(0,24)}... → ${result.risk}`);
      for (const d of result.details) console.log(`  ${d}`);
    } else {
      process.stdout.write(`✅ ${p.label} | `);
    }
    await new Promise(r => setTimeout(r, 100));
  }
  
  console.log("\n\n--- Scanning discovered packages ---");
  for (const [pkg, info] of discovered) {
    console.log(`\nChecking ${info.label} (${pkg.slice(0,24)})...`);
    const result = await scanProtocol(pkg);
    if (result) {
      console.log(`🚨 ${result.risk}: ${result.details.join(", ")}`);
    } else {
      console.log("✅ SAFE or not a reward contract");
    }
  }
}
main().catch(console.error);
