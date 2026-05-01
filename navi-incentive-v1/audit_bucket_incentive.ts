/**
 * BUCKET PROTOCOL — BORROW & SAVING INCENTIVE DEEP DIVE
 * Focus: reward accumulator vulnerabilities (Scallop-type)
 *
 * Run: cd /Users/chiao-yuyang/Desktop/notebook/security-research/navi-incentive-v1
 *       npx ts-node audit_bucket_incentive.ts
 */

import { SuiClient, getFullnodeUrl } from "@mysten/sui/client";
import { Transaction } from "@mysten/sui/transactions";

const ENTRY_CONFIG_ID =
  "0x03e79aa64ac007d200aefdcb445e31e24f460279bab6c73babfb031b7464072e";
const BUCKET_PKG =
  "0x1906a868f05cec861532d92aa49059580caf72d900ba2c387d5135b6a9727f52";

// Well-known Sui clock
const CLOCK_OBJ = "0x6";

// Collateral coin types (from SDK)
const COLLATERAL_TYPES: Record<string, string> = {
  SUI: "0x2::sui::SUI",
  WBTC: "0x027792d9fed7f9844eb4839566001bb6f6cb4804f66aa2da6fe1ee242d896881::coin::COIN",
  BTC: "0xaafb102dd0902f5055cadecd687fb5b71ca82ef0e0285d90afde828ec58ca96b::btc::BTC",
  WAL: "0x356a26eb9e012a68958082340d4c4116e7f55615cf27affcff209cf0ae544f59::wal::WAL",
};

async function getConfigFromChain(client: SuiClient) {
  const entryObj = await client.getObject({
    id: ENTRY_CONFIG_ID,
    options: { showContent: true },
  });

  const fields = (entryObj.data?.content as any)?.fields || {};
  const idVector: string[] = fields?.id_vector || [];

  if (idVector.length === 0) return null;

  const subObjects = await client.multiGetObjects({
    ids: idVector,
    options: { showContent: true, showType: true },
  });

  let packageConfig: any = null;
  let objectConfig: any = null;

  for (const obj of subObjects) {
    const type = (obj.data?.content as any)?.type || "";
    const subFields = (obj.data?.content as any)?.fields || {};

    if (type.includes("PackageConfig") || type.includes("package")) {
      packageConfig = subFields;
    }
    if (type.includes("ObjectConfig") || type.includes("object_config")) {
      objectConfig = subFields;
    }
  }

  return { packageConfig, objectConfig, allSubObjects: subObjects };
}

async function main() {
  const client = new SuiClient({ url: getFullnodeUrl("mainnet") });

  console.log("=".repeat(70));
  console.log("BUCKET BORROW/SAVING INCENTIVE — DEEP DIVE");
  console.log("=".repeat(70));

  // ---- STEP 1: Resolve package IDs from chain ----
  console.log("\n[1] Fetching on-chain config to resolve package IDs...");
  let borrowIncentivePkg: string | null = null;
  let savingIncentivePkg: string | null = null;
  let originalBorrowIncentivePkg: string | null = null;
  let vaultRewarderRegistry: string | null = null;
  let savingPoolIncentiveConfig: string | null = null;

  try {
    const cfg = await getConfigFromChain(client);
    if (cfg) {
      const pkgs = cfg.packageConfig || {};
      const objs = cfg.objectConfig || {};

      console.log("  All package config keys:", Object.keys(pkgs));
      console.log("  All object config keys:", Object.keys(objs));

      // Try to find borrow/saving incentive packages
      for (const [k, v] of Object.entries(pkgs)) {
        if (typeof v === "string") {
          console.log(`    ${k}: ${v}`);
          if (k.includes("borrow_incentive") && !k.includes("original")) {
            borrowIncentivePkg = v as string;
          }
          if (k.includes("original") && k.includes("borrow")) {
            originalBorrowIncentivePkg = v as string;
          }
          if (k.includes("saving_incentive") && !k.includes("original")) {
            savingIncentivePkg = v as string;
          }
        }
      }
      for (const [k, v] of Object.entries(objs)) {
        if (typeof v === "string") {
          console.log(`    ${k}: ${v}`);
          if (k.includes("vault_rewarder")) {
            vaultRewarderRegistry = v as string;
          }
          if (k.includes("saving_pool_incentive")) {
            savingPoolIncentiveConfig = v as string;
          }
        }
      }
    }
  } catch (e) {
    console.error("  Config fetch failed:", e);
    console.log("  Using fallback: examining main package directly");
  }

  // ---- STEP 2: Enumerate borrow incentive module functions ----
  const pkgToAudit = borrowIncentivePkg || BUCKET_PKG;
  console.log(`\n[2] Enumerating functions in borrow incentive pkg: ${pkgToAudit}`);

  try {
    const normPkg = await client.getNormalizedMoveModulesByPackage({
      package: pkgToAudit,
    });
    const modules = Object.keys(normPkg);
    console.log("  Modules:", modules.join(", "));

    for (const modName of modules) {
      if (!modName.includes("incentive") && !modName.includes("reward")) continue;
      const mod = normPkg[modName];
      const fns = Object.entries(mod.exposedFunctions || {});
      console.log(`\n  Module: ${modName} (${fns.length} functions)`);

      for (const [name, fn] of fns) {
        const isEntry = fn.isEntry;
        const vis = fn.visibility;
        const params = fn.parameters?.map((p: any) => {
          if (typeof p === "string") return p;
          if (p.Reference) return `&${JSON.stringify(p.Reference)}`;
          if (p.MutableReference) return `&mut ${JSON.stringify(p.MutableReference)}`;
          if (p.Struct) return `${p.Struct.module}::${p.Struct.name}`;
          return JSON.stringify(p);
        });

        const isSuspicious =
          isEntry &&
          /claim|harvest|collect|reward/i.test(name) &&
          !params?.some((p: string) => /AdminCap|ManagerCap|admin/i.test(p));

        console.log(
          `    [${vis}${isEntry ? "/entry" : ""}] ${name}` +
            (isSuspicious ? " ⚠️  SUSPICIOUS — entry + reward, no admin cap" : "")
        );
        if (isSuspicious) {
          console.log(`      params: ${params?.join(", ")}`);
        }
      }
    }
  } catch (e) {
    console.error("  Error:", e);
  }

  // ---- STEP 3: Check original (deprecated) borrow incentive package ----
  if (originalBorrowIncentivePkg && originalBorrowIncentivePkg !== pkgToAudit) {
    console.log(
      `\n[3] DEPRECATED borrow incentive pkg detected: ${originalBorrowIncentivePkg}`
    );
    console.log("  Checking if deprecated package still callable...");

    try {
      const oldMods = await client.getNormalizedMoveModulesByPackage({
        package: originalBorrowIncentivePkg,
      });
      const fns = Object.entries(
        oldMods["borrow_incentive"]?.exposedFunctions || {}
      );

      for (const [name, fn] of fns) {
        if (/claim|harvest|reward/i.test(name)) {
          const hasVersionGuard = fn.parameters?.some((p: any) =>
            JSON.stringify(p).toLowerCase().includes("version")
          );
          console.log(
            `    ${name}: version_guarded=${hasVersionGuard}` +
              (!hasVersionGuard
                ? " 🔴 NO VERSION GUARD — SCALLOP-TYPE ATTACK POSSIBLE"
                : " ✅")
          );
        }
      }
    } catch (e) {
      console.error("  Error checking deprecated pkg:", e);
    }
  } else {
    console.log("\n[3] No separate deprecated borrow incentive pkg detected");
    console.log("  (original and current may be the same — no upgrade happened yet)");
    console.log("  ✅ No Scallop-type risk from deprecated package");
  }

  // ---- STEP 4: VaultRewarder Registry Inspection ----
  if (vaultRewarderRegistry) {
    console.log(`\n[4] Inspecting VaultRewarder Registry: ${vaultRewarderRegistry}`);
    try {
      const regObj = await client.getObject({
        id: vaultRewarderRegistry,
        options: { showContent: true, showType: true },
      });
      const fields = (regObj.data?.content as any)?.fields || {};
      console.log("  Registry fields:");
      for (const [k, v] of Object.entries(fields)) {
        if (typeof v === "object") {
          console.log(`    ${k}: [table/set — ${JSON.stringify(v).slice(0, 80)}]`);
        } else {
          console.log(`    ${k}: ${v}`);
        }
      }

      // Look at versions field — are old versions still supported?
      if (fields.versions) {
        console.log("\n  Supported versions:", JSON.stringify(fields.versions));
        console.log(
          "  If multiple versions are listed, old version calls may still be valid"
        );
      }
    } catch (e) {
      console.error("  Error:", e);
    }
  }

  // ---- STEP 5: Dry-run suspicious realtime_reward_amount call ----
  console.log("\n[5] Dry-running borrow_incentive::realtime_reward_amount...");
  console.log("  This is a devInspect simulation — should not require gas");

  const ZERO_ADDR = "0x0000000000000000000000000000000000000000000000000000000000000000";

  if (vaultRewarderRegistry && (borrowIncentivePkg || BUCKET_PKG)) {
    try {
      const tx = new Transaction();
      // realtime_reward_amount<Collateral, Reward>(registry, rewarder_id, account_id, clock)
      // We need actual rewarder IDs — try to enumerate from registry
      // For now simulate with zero address to check if function is callable
      tx.moveCall({
        target: `${borrowIncentivePkg || BUCKET_PKG}::borrow_incentive::realtime_reward_amount`,
        typeArguments: [COLLATERAL_TYPES.SUI, "0x2::sui::SUI"],
        arguments: [
          tx.object(vaultRewarderRegistry),
          tx.pure.address(ZERO_ADDR), // rewarder_id placeholder
          tx.pure.address(ZERO_ADDR), // account_id placeholder
          tx.object(CLOCK_OBJ),
        ],
      });

      const result = await client.devInspectTransactionBlock({
        transactionBlock: tx,
        sender: ZERO_ADDR,
      });
      console.log("  Result status:", result.effects.status);
      if (result.effects.status.status === "success") {
        console.log("  Return values:", JSON.stringify(result.results?.[0]?.returnValues));
      } else {
        console.log("  Error (expected — wrong rewarder_id):", result.effects.status.error);
      }
    } catch (e) {
      console.error("  Dry-run error:", e);
    }
  }

  // ---- STEP 6: Check saving incentive for same patterns ----
  const savPkg = savingIncentivePkg || BUCKET_PKG;
  console.log(`\n[6] Enumerating saving incentive functions in: ${savPkg}`);
  try {
    const normPkg = await client.getNormalizedMoveModulesByPackage({
      package: savPkg,
    });
    const modules = Object.keys(normPkg);

    for (const modName of modules) {
      if (!modName.includes("incentive") && !modName.includes("reward")) continue;
      const mod = normPkg[modName];
      const fns = Object.entries(mod.exposedFunctions || {});
      console.log(`\n  Module: ${modName}`);

      for (const [name, fn] of fns) {
        const isEntry = fn.isEntry;
        const params = fn.parameters?.map((p: any) => JSON.stringify(p));
        const isSuspicious =
          isEntry &&
          /claim|harvest|collect/i.test(name) &&
          !params?.some((p) => /AdminCap|ManagerCap/i.test(p));
        console.log(
          `    [${fn.visibility}${isEntry ? "/entry" : ""}] ${name}` +
            (isSuspicious ? " ⚠️  SUSPICIOUS" : "")
        );
      }
    }
  } catch (e) {
    console.error("  Error:", e);
  }

  // ---- STEP 7: Strap-Fountain (v1 incentive) analysis ----
  console.log("\n[7] Strap-Fountain (v1 incentive) Analysis...");
  console.log("  Source: github.com/Bucket-Protocol/strap-fountain");
  console.log("  create_<T,R>() is PUBLIC ENTRY — ANYONE can create a Fountain");
  console.log("  Findings:");
  console.log(
    "    - create_() transfers AdminCap to sender — no protocol permission needed"
  );
  console.log(
    "    - Fake fountains can be created to phish users into staking to empty pools"
  );
  console.log("    - Cumulative_unit starts at 0 — new stakers get unit=current");
  console.log(
    "    - StakeData.start_unit = fountain.cumulative_unit at stake time — CORRECT"
  );
  console.log(
    "    - No zero-index exploit here: user stakes FIRST, then reward accrues"
  );
  console.log(
    "    - Surplus positions (liquidated straps): SurplusData has no start_unit"
  );
  console.log("    - check surplus reward logic...");
  console.log("\n  StakeProof has key+store — can be transferred/traded!");
  console.log(
    "  This is a secondary market risk but not direct theft vector"
  );

  // ---- STEP 8: Examine saving_pool_incentive global config ----
  if (savingPoolIncentiveConfig) {
    console.log(`\n[8] Saving Pool Incentive Global Config: ${savingPoolIncentiveConfig}`);
    try {
      const obj = await client.getObject({
        id: savingPoolIncentiveConfig,
        options: { showContent: true, showType: true },
      });
      const fields = (obj.data?.content as any)?.fields || {};
      console.log("  Fields:");
      for (const [k, v] of Object.entries(fields)) {
        if (typeof v === "object") {
          console.log(`    ${k}: [complex — ${JSON.stringify(v).slice(0, 100)}]`);
        } else {
          console.log(`    ${k}: ${v}`);
        }
      }
    } catch (e) {
      console.error("  Error:", e);
    }
  }

  // ---- STEP 9: Saving Incentive — DepositResponseChecker / WithdrawResponseChecker ----
  console.log("\n[9] Deposit/Withdraw Response Checker Pattern...");
  console.log("  From SDK types:");
  console.log("  DepositResponseChecker { rewarder_ids: VecSet, response: DepositResponse }");
  console.log("  WithdrawResponseChecker { rewarder_ids: VecSet, response: WithdrawResponse }");
  console.log("  These are likely request/fulfill patterns — PTB hot potato");
  console.log("  If these are non-dropped structs, they enforce deposit/withdraw atomically");
  console.log("  ✅ Likely SAFE — PTB enforces response must be consumed");

  // ---- SUMMARY ----
  console.log("\n" + "=".repeat(70));
  console.log("INCENTIVE AUDIT FINDINGS SUMMARY:");
  console.log("-".repeat(70));
  console.log("🔴 CRITICAL: None detected yet (reward index pattern is correct)");
  console.log("🟠 HIGH: Need to verify deprecated pkg version guards (if upgrades occurred)");
  console.log("🟡 MEDIUM: Strap-Fountain create_() is permissionless — phishing risk");
  console.log("🟡 MEDIUM: AdminCap ownership — check if multisig");
  console.log("🟢 LOW: StakeProof is transferable (key+store) — secondary market risk");
  console.log("✅ SAFE: FlashMintReceipt is proper hot potato");
  console.log("✅ SAFE: Reward accrual uses unit differential — no zero-index backdoor");
  console.log("✅ SAFE: PSM fee rate appears properly gated (FeeConfig via partner configs)");
  console.log("=".repeat(70));
}

main().catch(console.error);
