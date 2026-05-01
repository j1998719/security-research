/**
 * Chain-first discovery: find packages via object type queries
 * Strategy: Look for objects with known DeFi patterns
 */
import { SuiClient } from "@mysten/sui/client";
const client = new SuiClient({ url: "https://fullnode.mainnet.sui.io:443" });

async function main() {
  console.log("=== Chain-First Protocol Discovery ===\n");

  // 1. Find packages by searching for IncentiveBal-like objects
  // NAVI V1's IncentiveBal is: 0xd899cf7d...::incentive_v1::IncentiveBal
  // Are there other protocols with similar struct names?
  console.log("--- Searching for incentive-type objects ---");
  
  const structPatterns = [
    // Farming reward objects
    "RewardPool", "IncentivePool", "IncentiveFund", "EmissionPool",
    "FarmingPool", "StakingReward", "RewardVault", "ClaimableReward",
  ];
  
  // We can't search by partial type, but we can look at common patterns
  // Let me try to find protocols via their upgrade capabilities
  
  // 2. Get recent MovePublish transactions to find new protocols
  console.log("--- Recent published packages (MovePublish) ---");
  try {
    const txs = await client.queryTransactionBlocks({
      filter: { Transaction: "Publish" } as any,
      limit: 20,
      order: "descending",
      options: { showInput: true },
    });
    if (txs.data.length > 0) {
      console.log(`Found ${txs.data.length} recent publish txs`);
    }
  } catch (e: any) { console.log("Publish filter:", e.message?.slice(0,60)); }

  // 3. Use a known liquid staking protocol's token to trace back to the package
  // stSUI (Haedal), mSUI (Aftermath), vSUI (Volo), sSUI (Spring)
  // Let's look at hsui token
  
  // 4. Look at top Sui protocols by TVL - try known addresses one more time
  // These are from known ecosystem data:
  const betterCandidates = [
    // Scallop's borrowIncentive (different module from spool)
    { label: "Scallop BorrowIncentive", pkg: "0xc63072e7db5b82e38f38e78de6d9ca5af32ccdb25a3c6bb4ddd3601f55e88c3a" },
    // Aftermath AMM farming
    { label: "Aftermath AMM Farm", pkg: "0x7f6ce7ade149bf3c43e5d74b4f6cffc78e309d37df5d77be175baece5cd3b3c6" },
    // Mole Finance
    { label: "Mole Finance vault", pkg: "0x21d6e3fee1c9be8b1bf7efab74dd823d35b4a5c2a9f27b88b7ba7d95f5a10780" },
    // NAVI Protocol v2 (current)
    { label: "NAVI V2", pkg: "0x779b5c547976899f5474f3a5bc0db36ddf4697ad7e5a901db0415c22f0caa9df" },
    // Suilend v2
    { label: "Suilend v2", pkg: "0xf95b06141ed4a174f239417323bde3f209b972f5930d8521ea38a52aff3a6ddf" },
    // Legato Finance actual
    { label: "Legato vault", pkg: "0x3b5e0af1c7a2a06e1e1e2e3e4e5e6e7e8e9e0e1e2e3e4e5e6e7e8e9e0e1e2e3" },
  ];

  console.log("\n--- Better candidate scan ---");
  for (const c of betterCandidates) {
    try {
      const norm = await client.getNormalizedMoveModulesByPackage({ package: c.pkg });
      const mods = Object.keys(norm);
      
      // Quick reward check
      let openReward = false;
      let hasIndex = false;
      let hasVersion = false;
      
      for (const [mod, modDef] of Object.entries(norm)) {
        if (/version/i.test(mod)) hasVersion = true;
        for (const [fn, fnDef] of Object.entries(modDef.exposedFunctions)) {
          if (/version/i.test(fn)) hasVersion = true;
          if (fnDef.isEntry && /claim|harvest|reward/i.test(fn)) {
            const p = JSON.stringify(fnDef.parameters);
            if (!/Cap|Admin|Key/i.test(p)) openReward = true;
          }
        }
        for (const [sn, st] of Object.entries(modDef.structs)) {
          if (st.fields?.some(f => /reward_debt|last_index|index_rewards_paid/i.test(f.name))) hasIndex = true;
        }
      }
      
      const risk = !hasVersion && openReward && hasIndex ? "🔴" :
                   !hasVersion && (openReward || hasIndex) ? "🟡" : "✅";
      
      console.log(`${risk} [${c.label}] mods: ${mods.slice(0,4).join(",")}`);
      if (risk !== "✅") {
        console.log(`   openReward=${openReward} hasIndex=${hasIndex} hasVersion=${hasVersion}`);
      }
    } catch (e: any) {
      if (e.message?.includes("does not exist")) {
        process.stdout.write(`⬛ ${c.label} | `);
      }
    }
    await new Promise(r => setTimeout(r, 100));
  }
  
  // 5. NAVI V2 modules check - what does the current NAVI lending look like?
  console.log("\n\n--- NAVI V2 (0x779b5c...) module check ---");
  const NAVI_V2 = "0x779b5c547976899f5474f3a5bc0db36ddf4697ad7e5a901db0415c22f0caa9df";
  try {
    const norm = await client.getNormalizedMoveModulesByPackage({ package: NAVI_V2 });
    const mods = Object.keys(norm);
    console.log(`NAVI V2 modules (${mods.length}): ${mods.slice(0,10).join(", ")}...`);
    
    // Check if there are incentive-related modules
    const incentiveMods = mods.filter(m => /incentive|reward|emission|farm/i.test(m));
    console.log(`Incentive modules: ${incentiveMods.join(", ") || "none"}`);
    
    // Check version in current_version module
    if (norm["current_version"]) {
      console.log("Has current_version module ✅");
    }
  } catch (e: any) { console.log("Error:", e.message?.slice(0,60)); }
}
main().catch(console.error);
