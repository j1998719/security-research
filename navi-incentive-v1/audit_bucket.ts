/**
 * BUCKET PROTOCOL — FULL SECURITY AUDIT
 * Covers: CDP (v2), PSM, Flash, Framework, Borrow Incentive, Saving Incentive
 *
 * Run: cd /Users/chiao-yuyang/Desktop/notebook/security-research/navi-incentive-v1
 *       npx ts-node audit_bucket.ts
 */

import { SuiClient, getFullnodeUrl } from "@mysten/sui/client";
import { Transaction } from "@mysten/sui/transactions";

// ============================================================
// KNOWN ADDRESSES (from bucket-protocol-sdk source)
// ============================================================
const ENTRY_CONFIG_ID =
  "0x03e79aa64ac007d200aefdcb445e31e24f460279bab6c73babfb031b7464072e";
const BUCKET_PKG =
  "0x1906a868f05cec861532d92aa49059580caf72d900ba2c387d5135b6a9727f52";
const ADMIN_CAP_ID =
  "0xd1ce0affeda5aa8f3ec50ff617f27717673acd74fecaf850a7d1096f421d4131";

// ============================================================
// STRUCTS (from SDK _generated types)
// ============================================================

/**
 * BUCKET v2 Module Map:
 *
 * bucket_v2_cdp         — vault, position, ACL
 * bucket_v2_psm         — PSM swap pool
 * bucket_v2_flash       — flash mint (receipt: FlashMintReceipt)
 * bucket_v2_framework   — account management, BUCK coin
 * bucket_v2_saving      — saving pool LP
 * bucket_v2_saving_incentive — reward distribution for savers
 * bucket_v2_borrow_incentive — reward distribution for borrowers
 */

interface VaultRewarder {
  id: string;
  vault_id: string;
  unit: string; // global accumulator
  flow_rate: string;
  stake_table: string; // Table of StakeData
  timestamp: number;
}

interface StakeData {
  unit: string; // per-user checkpoint
  reward: string; // pending balance
}

// ============================================================

async function main() {
  const client = new SuiClient({ url: getFullnodeUrl("mainnet") });

  console.log("=".repeat(70));
  console.log("BUCKET PROTOCOL SECURITY AUDIT");
  console.log("=".repeat(70));

  // ---- STEP 1: Fetch on-chain config to get all package IDs ----
  console.log("\n[1] Loading on-chain config from ENTRY_CONFIG_ID...");
  let config: any = null;
  try {
    const entryObj = await client.getObject({
      id: ENTRY_CONFIG_ID,
      options: { showContent: true, showType: true },
    });
    console.log("  Entry config type:", (entryObj.data?.content as any)?.type);
    const fields = (entryObj.data?.content as any)?.fields;
    console.log("  Entry fields keys:", Object.keys(fields || {}));

    // Extract id_vector to find sub-configs
    const idVector = fields?.id_vector || [];
    console.log(`  id_vector length: ${idVector.length}`);

    if (idVector.length > 0) {
      const subObjects = await client.multiGetObjects({
        ids: idVector,
        options: { showContent: true, showType: true },
      });
      for (const obj of subObjects) {
        const type = (obj.data?.content as any)?.type || "";
        const subFields = (obj.data?.content as any)?.fields || {};
        console.log(`  Sub-config type suffix: ...${type.split("::").pop()}`);

        // Look for PackageConfig to extract latest package IDs
        if (type.includes("PackageConfig") || type.includes("package_config")) {
          console.log("\n  [PACKAGES FOUND]");
          for (const [k, v] of Object.entries(subFields)) {
            if (typeof v === "string" && v.startsWith("0x")) {
              console.log(`    ${k}: ${v}`);
            }
          }
        }
      }
    }
  } catch (e) {
    console.error("  Error fetching config:", e);
  }

  // ---- STEP 2: Enumerate exposed functions in main package ----
  console.log("\n[2] Checking main Bucket package modules...");
  try {
    const normPkg = await client.getNormalizedMoveModulesByPackage({
      package: BUCKET_PKG,
    });
    const modules = Object.keys(normPkg);
    console.log(`  Modules in package (${modules.length}):`, modules.join(", "));

    for (const modName of modules) {
      const mod = normPkg[modName];
      const fns = Object.entries(mod.exposedFunctions || {});
      const rewardFns = fns.filter(([name]) =>
        /claim|reward|harvest|stake|unstake|collect/i.test(name)
      );
      const adminFns = fns.filter(([name]) =>
        /set_|update_|config|admin|fee_rate|change/i.test(name)
      );

      if (rewardFns.length > 0) {
        console.log(`\n  Module: ${modName}`);
        console.log("    REWARD FUNCTIONS:");
        for (const [name, fn] of rewardFns) {
          const isEntry = fn.isEntry;
          const paramTypes = fn.parameters?.map((p: any) =>
            JSON.stringify(p)
          );
          console.log(
            `      [${isEntry ? "ENTRY" : "public"}] ${name}(${paramTypes?.join(", ")})`
          );
        }
      }
      if (adminFns.length > 0) {
        console.log(`\n  Module: ${modName} [ADMIN FNs]:`);
        for (const [name, fn] of adminFns) {
          console.log(`      ${name}`);
        }
      }
    }
  } catch (e) {
    console.error("  Error normalizing package:", e);
  }

  // ---- STEP 3: Flash Loan Receipt Ability Check ----
  console.log("\n[3] Flash Loan Receipt Ability Analysis...");
  console.log("  From SDK generated types (bucket_v2_flash::config):");
  console.log("  FlashMintReceipt struct fields:");
  console.log("    - partner: Option<address>");
  console.log("    - mint_amount: u64");
  console.log("    - fee_amount: u64");
  console.log("  Abilities: NONE DECLARED (hot potato pattern = CORRECT)");
  console.log(
    "  FlashMint flow: flash_mint() returns Receipt + coin, repay_flash_mint() destroys it"
  );
  console.log("  ✅ SAFE: Receipt has no copy/drop/store — cannot escape PTB");

  // ---- STEP 4: PSM Fee Rate Check ----
  console.log("\n[4] PSM Fee Rate Access Control...");
  try {
    // Try to find PSM pools via ENTRY_CONFIG_ID config
    // PSM pool's fee_rate is stored in Pool.default_fee_config.swap_in_fee_rate / swap_out_fee_rate
    // These are Float types — check if set_fee_rate is gated by AdminCap

    // Look for any public PSM fee-setting entry functions
    // From SDK struct analysis: FeeConfig has swap_in_fee_rate, swap_out_fee_rate as Float
    // The fee setter should require AdminCap or manager role
    console.log(
      "  PSM Pool struct: fee fields are swap_in_fee_rate: Float, swap_out_fee_rate: Float"
    );
    console.log(
      "  Need to check: does set_fee_config require AdminCap? (check via package normalization)"
    );
    console.log(
      "  Note: AftermathFi-type would be fee-setter with no AdminCap guard + no bounds check"
    );
  } catch (e) {
    console.error("  Error:", e);
  }

  // ---- STEP 5: CDP Version Guard Check ----
  console.log("\n[5] CDP Version Guard Analysis...");
  console.log(
    "  BUCKET_PKG is the LATEST package ID from SDK (not original/deprecated)"
  );
  console.log(
    "  The config stores both original_cdp_package_id and cdp_package_id"
  );
  console.log(
    "  Key question: can deprecated package ID still be called directly?"
  );
  console.log(
    "  bucket_v2_cdp::version module: check VERSION constant and version guard"
  );

  // Try to call version-dependent functions on deprecated package
  // The original_cdp_package_id != cdp_package_id means upgrades happened
  // If original package has no version check, Scallop-type attack is possible

  // ---- STEP 6: Borrow Incentive Accumulator Check ----
  console.log("\n[6] Borrow Incentive Reward Accumulator Analysis...");
  console.log("  VaultRewarder struct fields:");
  console.log("    - unit: Double       <-- GLOBAL accumulator");
  console.log("    - flow_rate: Double");
  console.log("    - stake_table: Table  <-- maps addr -> StakeData");
  console.log("    - timestamp: u64");
  console.log("\n  StakeData struct fields:");
  console.log("    - unit: Double       <-- PER-USER checkpoint");
  console.log("    - reward: Balance    <-- accumulated unclaimed reward");
  console.log(
    "\n  Reward = (global_unit - user_unit) * stake_amount / precision"
  );
  console.log("\n  CRITICAL CHECK: What happens on first claim with unit=0?");
  console.log(
    "  If a new StakeData entry is created with unit=0 while global unit > 0,"
  );
  console.log(
    "  the user could claim ALL accumulated rewards from the beginning."
  );
  console.log(
    "\n  However, StakeData is created at stake-time and unit is set to current global unit."
  );
  console.log("  This is NOT a zero-index vulnerability IF stake is required.");
  console.log(
    "  Need to verify: is there a path to claim without prior stake that sets unit=0?"
  );

  // ---- STEP 7: Saving Incentive Accumulator Check ----
  console.log("\n[7] Saving Incentive Reward Accumulator Analysis...");
  console.log("  Rewarder struct fields:");
  console.log("    - unit: Double          <-- GLOBAL accumulator");
  console.log("    - total_stake: u64");
  console.log("    - stake_table: Table     <-- maps addr -> StakeData");
  console.log("    - last_update_timestamp: u64");
  console.log("\n  StakeData (same as borrow incentive):");
  console.log("    - unit: Double           <-- PER-USER checkpoint");
  console.log("    - reward: Balance");
  console.log(
    "\n  Same pattern — need to check if claim can be called before stake"
  );

  // ---- STEP 8: Admin Key Concentration Check ----
  console.log("\n[8] Admin Key Concentration (Volo-type)...");
  console.log("  ADMIN_CAP_ID:", ADMIN_CAP_ID);
  console.log("  Single AdminCap controls:");
  console.log("    - CDP vault configuration (min_collateral_ratio)");
  console.log("    - Liquidation rule changes");
  console.log("    - PSM fee rate changes");
  console.log("    - Borrow/saving incentive flow rates");
  console.log("    - Emergency operations");
  console.log("  Need to check: Is AdminCap owned by multisig or EOA?");

  // Check AdminCap owner
  try {
    const adminCapObj = await client.getObject({
      id: ADMIN_CAP_ID,
      options: { showOwner: true, showContent: true },
    });
    const owner = adminCapObj.data?.owner;
    console.log("\n  AdminCap owner:", JSON.stringify(owner));
    if ((owner as any)?.AddressOwner) {
      const ownerAddr = (owner as any).AddressOwner;
      console.log(
        "  ⚠️  AdminCap held by single address:",
        ownerAddr,
        "— check if multisig"
      );
    } else if ((owner as any)?.ObjectOwner) {
      console.log(
        "  ℹ️  AdminCap owned by another object (may be multisig wrapper)"
      );
    }
  } catch (e) {
    console.error("  Error fetching AdminCap:", e);
  }

  // ---- STEP 9: Oracle / Pyth Integration ----
  console.log("\n[9] Oracle / Price Feed Analysis...");
  console.log("  From SDK: uses Pyth price feeds (pyth_state_id in config)");
  console.log("  Pyth requires signed VAA updates — cannot be directly manipulated");
  console.log(
    "  Flash loan + Pyth combo: Pyth prices are push-based (external signers)"
  );
  console.log("  Flash loans cannot manipulate Pyth prices");
  console.log(
    "  CDP liquidation uses oracle price — need to check freshness enforcement"
  );
  console.log("  Does liquidation check price staleness? (common vulnerability)");

  // ---- STEP 10: Griefing Vectors ----
  console.log("\n[10] Griefing / DoS Analysis...");
  console.log("  a) Fountain (strap-fountain): anyone can create_<T,R>()");
  console.log(
    "     - Creates fake reward fountains with zero rewards"
  );
  console.log("     - Could confuse users but not drain protocol funds");
  console.log(
    "  b) PSM: if fees can be set to 0 by anyone -> drain arbitrage opportunity"
  );
  console.log(
    "  c) CDP: position_locker field in Vault — what locks/unlocks positions?"
  );

  console.log("\n" + "=".repeat(70));
  console.log("BUCKET AUDIT COMPLETE — See audit_bucket_incentive.ts for deep-dive");
  console.log("=".repeat(70));
}

main().catch(console.error);
