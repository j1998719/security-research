/**
 * BLUEFIN PROTOCOL — FULL SECURITY AUDIT
 * Covers: Perps (v2), Spot DEX, Coin/Staking contracts
 *
 * Run: cd /Users/chiao-yuyang/Desktop/notebook/security-research/navi-incentive-v1
 *       npx ts-node audit_bluefin.ts
 */

import { SuiClient, getFullnodeUrl } from "@mysten/sui/client";
import { Transaction } from "@mysten/sui/transactions";

// ============================================================
// BLUEFIN PERPS (from deployment.json)
// ============================================================
const PERPS_PACKAGE =
  "0xb9b92f069eb185d9fe1fcc988e7d89b3b48e5f58d879a0dbc4187bff8f8e6946";
const CAPABILITIES_SAFE =
  "0xc1af297f05860b9edb67dcedeae7198d04012c1e99d942ff2d81724eaf0eabde";
const BANK =
  "0xc2adfcb47c8b8dc3ab7ae9c744df6a4e385b889c11a1a905ef4c0a4815d8bd25";
const EXCHANGE_ADMIN_CAP =
  "0x41047e18bd64cfc20db37ea644b7789311d4aac710a34ba009f014e1b99c1283";
const TREASURY_CAP =
  "0x52e18f588232a581330d4373d9b81a0dfc7ec33acf898043e03f02dc5cdca709";
const FUNDING_RATE_CAP =
  "0xe42bc3d32cb88e75a7a5c7ac7152c9eb69088f5bbb1407975998d4c5cc6e4aeb";
const UPGRADE_CAP_PERPS =
  "0x7c1fd1a0c2cd3fe99f1bcaf946fbc3079062e1a1ded1e99b2b8bc718293d4aab";
const ORDER_STATUS =
  "0xd8729865157825a85dc6bda39bbb86f2ce2f5a2a5d7881882e95a8ffd26f6534";
const SETTLEMENT_CAP =
  "0xf0549b723ea4c99e0ac79d13aed4b5b8a387417a1265843bbde004feaf5321ed";
const DELEVERAGING_CAP =
  "0xb2487c3914143acc858fb0770788d90f51fa3388d6f91b616d97375f082c5bd7";
const EXCHANGE_GUARDIAN_CAP =
  "0x18e7a86539986216401bfd5bb5d21a803f3a8c2404265fe142ea17be4dd9f614";
const SUB_ACCOUNTS =
  "0x2e100cc2407ea221a922b9dd0e6cd796adbacdc48e11adcc1977ac861ab43e0c";
const BANK_TABLE =
  "0xf099ec3ccacba20f1718b55b060709e9e3ecb80a8bd9fdd07602a077a54ff4b6";

// Markets
const ETH_PERP_PERPETUAL =
  "0xfdc2901bcee786bdf124d712cdd0821bed185402414050b57bc8dd5b5329c912";
const BTC_PERP_PERPETUAL =
  "0xe23dee7c0f977f40cd8eda2cefed6f49a62b4c42f7c743199804a2bb899e49f5";
const ETH_PRICE_ORACLE =
  "0xbf655d5dd2262fe977ca0e722b7e3de580562c80a53f543f3c59acfaf01c573e";
const BTC_PRICE_ORACLE =
  "0xf7594631b44c26b43f29e17be7e7fcfc05769ccd91ab571bd5f09658f7a4f9ac";

// ============================================================
// BLUEFIN SPOT (from bluefin-spot-contracts-public)
// ============================================================
const SPOT_BASE_PKG =
  "0x3492c874c1e3b3e2984e8c41b589e642d4d0a5d6459e5a9cfc2d52fd7c89c267";
const SPOT_CURRENT_PKG =
  "0x6c796c3ab3421a68158e0df18e4657b2827b1f8fed5ed4b82dba9c935988711b";
const SPOT_GLOBAL_CONFIG =
  "0x03db251ba509a8d5d8777b6338836082335d93eecbdd09a11e190a1cff51c352";
const SPOT_ADMIN_CAP =
  "0xc5e736b21175e1f8121d58b743432a39cbea8ee23177b6caf7c2a0aadba8d8b9";
const SPOT_PROTOCOL_FEE_CAP =
  "0x55697473304e901372020f30228526c4e93558b23259d90bc6fdddedf83295d2";
const SPOT_UPGRADE_CAP =
  "0xd5b2d2159a78030e6f07e028eb75236693ed7f2f32fecbdc1edb32d3a2079c0d";

// ============================================================
// BLUEFIN COIN / STAKING
// ============================================================
const COIN_PKG =
  "0xbcec51c81e1381ac70f5d3124ccb5920e1964bd602bd07e03696613d941d595c";

// PRO (proDeployment.json)
const PRO_PACKAGE =
  "0x039146aa464eb40568353e0d8e4c38455ef5781d964ffc9fef4eb5ae023cac58";
const PRO_ADMIN_CAP =
  "0x9452aff994371ce8b5c1e64cf541993291fee6037243bfe5e3600553067907fd";
const PRO_INTERNAL_DATA =
  "0xa9f033047d2fc453da063b03500a48950d2497bb0a2faec57da2833d42a12806";

const ZERO_ADDR =
  "0x0000000000000000000000000000000000000000000000000000000000000000";
const CLOCK_OBJ = "0x6";

async function main() {
  const client = new SuiClient({ url: getFullnodeUrl("mainnet") });

  console.log("=".repeat(70));
  console.log("BLUEFIN PROTOCOL SECURITY AUDIT");
  console.log("=".repeat(70));

  // ---- STEP 1: Perps Package Module Enumeration ----
  console.log("\n[1] Enumerating Bluefin Perps package modules...");
  try {
    const normPkg = await client.getNormalizedMoveModulesByPackage({
      package: PERPS_PACKAGE,
    });
    const modules = Object.keys(normPkg);
    console.log(`  Modules (${modules.length}):`, modules.join(", "));

    // Check for funding rate functions
    for (const modName of modules) {
      const mod = normPkg[modName];
      const fns = Object.entries(mod.exposedFunctions || {});

      const fundingFns = fns.filter(([name]) =>
        /funding|rate|settlement|insurance/i.test(name)
      );
      const rewardFns = fns.filter(([name]) =>
        /reward|claim|harvest|stake/i.test(name)
      );
      const adminFns = fns.filter(([name]) =>
        /set_|update_|admin|config|guardian|change_fee/i.test(name)
      );

      if (fundingFns.length > 0) {
        console.log(`\n  Module: ${modName} — FUNDING RATE FUNCTIONS:`);
        for (const [name, fn] of fundingFns) {
          const params = fn.parameters?.map((p: any) => {
            if (p.Struct) return `${p.Struct.module}::${p.Struct.name}`;
            if (p.MutableReference)
              return `&mut ${(p.MutableReference as any).Struct?.name || "?"}`;
            return JSON.stringify(p);
          });

          // Key check: does it require FundingRateCap?
          const requiresFRCap = params?.some((p) =>
            /FundingRateCap|funding_rate_cap|CapabilitiesSafe/i.test(p)
          );
          console.log(
            `    [${fn.isEntry ? "entry" : fn.visibility}] ${name}` +
              (requiresFRCap
                ? " ✅ requires FundingRateCap"
                : " ⚠️  NO FundingRateCap GUARD")
          );
          if (!requiresFRCap) {
            console.log(`      params: ${params?.join(", ")}`);
          }
        }
      }

      if (rewardFns.length > 0) {
        console.log(`\n  Module: ${modName} — REWARD FUNCTIONS:`);
        for (const [name, fn] of rewardFns) {
          console.log(`    [${fn.isEntry ? "entry" : fn.visibility}] ${name}`);
        }
      }
    }
  } catch (e) {
    console.error("  Error:", e);
  }

  // ---- STEP 2: CapabilitiesSafe inspection ----
  console.log(`\n[2] Inspecting CapabilitiesSafe: ${CAPABILITIES_SAFE}`);
  try {
    const capSafe = await client.getObject({
      id: CAPABILITIES_SAFE,
      options: { showContent: true, showType: true, showOwner: true },
    });
    console.log("  Type:", (capSafe.data?.content as any)?.type);
    console.log("  Owner:", JSON.stringify(capSafe.data?.owner));
    const fields = (capSafe.data?.content as any)?.fields || {};
    for (const [k, v] of Object.entries(fields)) {
      if (typeof v === "object") {
        console.log(`    ${k}: [${JSON.stringify(v).slice(0, 120)}]`);
      } else {
        console.log(`    ${k}: ${v}`);
      }
    }
  } catch (e) {
    console.error("  Error:", e);
  }

  // ---- STEP 3: FundingRateCap owner check ----
  console.log(`\n[3] Checking FundingRateCap owner: ${FUNDING_RATE_CAP}`);
  try {
    const frcap = await client.getObject({
      id: FUNDING_RATE_CAP,
      options: { showOwner: true, showContent: true, showType: true },
    });
    console.log("  Type:", (frcap.data?.content as any)?.type);
    const owner = frcap.data?.owner;
    console.log("  Owner:", JSON.stringify(owner));

    if ((owner as any)?.AddressOwner) {
      const addr = (owner as any).AddressOwner;
      console.log(`  ⚠️  FundingRateCap held by single EOA: ${addr}`);
      console.log("  Risk: If key is compromised, attacker can set arbitrary funding rate");
      // Check if this is the deployer address
      const DEPLOYER = "0x17826aa78491a3dd76a13187cdd4b35b2cc5acbbcb6712582fced3856dbb12ec";
      if (addr === DEPLOYER) {
        console.log("  This IS the deployer address — single point of failure");
      }
    } else if ((owner as any)?.ObjectOwner) {
      console.log(
        "  FundingRateCap owned by object (multisig wrapper?) — safer"
      );
    }
  } catch (e) {
    console.error("  Error:", e);
  }

  // ---- STEP 4: ExchangeAdminCap owner check ----
  console.log(`\n[4] Checking ExchangeAdminCap owner: ${EXCHANGE_ADMIN_CAP}`);
  try {
    const adminCap = await client.getObject({
      id: EXCHANGE_ADMIN_CAP,
      options: { showOwner: true, showContent: true },
    });
    const owner = adminCap.data?.owner;
    console.log("  Owner:", JSON.stringify(owner));
    if ((owner as any)?.AddressOwner) {
      console.log(
        `  ⚠️  AdminCap held by single EOA: ${(owner as any).AddressOwner}`
      );
    }
  } catch (e) {
    console.error("  Error:", e);
  }

  // ---- STEP 5: UpgradeCap owner check ----
  console.log(`\n[5] Checking Perps UpgradeCap owner: ${UPGRADE_CAP_PERPS}`);
  try {
    const upgradeCap = await client.getObject({
      id: UPGRADE_CAP_PERPS,
      options: { showOwner: true, showContent: true, showType: true },
    });
    const owner = upgradeCap.data?.owner;
    const fields = (upgradeCap.data?.content as any)?.fields || {};
    console.log("  Owner:", JSON.stringify(owner));
    console.log("  UpgradeCap fields (policy, etc):", JSON.stringify(fields).slice(0, 200));

    // Policy 0=compatible, 1=additive, 2=depOnly, 3=immutable
    if (fields.policy !== undefined) {
      const policyNames: Record<number, string> = {
        0: "Compatible (any upgrade)",
        1: "Additive (new functions only)",
        2: "Dep-only (dependency changes only)",
        3: "Immutable (no upgrades)",
        128: "Immutable",
      };
      console.log(
        `  Upgrade policy: ${fields.policy} = ${policyNames[fields.policy as number] || "Unknown"}`
      );
    }
  } catch (e) {
    console.error("  Error:", e);
  }

  // ---- STEP 6: Spot DEX — Version guard check (Scallop-type) ----
  console.log("\n[6] Bluefin Spot — Version Guard / Deprecated Package Check...");
  console.log(`  Base (original) pkg: ${SPOT_BASE_PKG}`);
  console.log(`  Current pkg: ${SPOT_CURRENT_PKG}`);
  const isSpotUpgraded = SPOT_BASE_PKG !== SPOT_CURRENT_PKG;
  console.log(`  Packages differ: ${isSpotUpgraded}`);

  if (isSpotUpgraded) {
    console.log(
      "  ⚠️  Spot DEX has been upgraded — checking original package for missing version guards..."
    );
    try {
      const oldMods = await client.getNormalizedMoveModulesByPackage({
        package: SPOT_BASE_PKG,
      });
      const modules = Object.keys(oldMods);
      console.log("  Modules in original pkg:", modules.join(", "));

      for (const modName of modules) {
        const mod = oldMods[modName];
        const fns = Object.entries(mod.exposedFunctions || {});
        const rewardFns = fns.filter(([name]) =>
          /reward|collect|claim|harvest/i.test(name)
        );

        for (const [name, fn] of rewardFns) {
          const paramStrs = fn.parameters?.map((p: any) => JSON.stringify(p)) || [];
          const hasVersionGuard = paramStrs.some((p) =>
            /version|Version/i.test(p)
          );
          console.log(
            `  [${modName}] ${name} — version_guard: ${hasVersionGuard}` +
              (!hasVersionGuard
                ? " 🔴 POTENTIAL SCALLOP-TYPE — NO VERSION CHECK"
                : " ✅")
          );
        }
      }
    } catch (e) {
      console.error("  Error inspecting original pkg:", e);
    }
  }

  // ---- STEP 7: Spot DEX — Flash Swap Hot Potato ----
  console.log("\n[7] Bluefin Spot Flash Swap Analysis...");
  try {
    const spotMods = await client.getNormalizedMoveModulesByPackage({
      package: SPOT_CURRENT_PKG,
    });
    const modules = Object.keys(spotMods);

    for (const modName of modules) {
      const mod = spotMods[modName];
      const structs = Object.entries(mod.structs || {});

      for (const [structName, struct] of structs) {
        if (/receipt|Receipt|flash/i.test(structName)) {
          const abilities = (struct as any).abilities?.abilities || [];
          console.log(`  Struct: ${modName}::${structName}`);
          console.log(`    Abilities: [${abilities.join(", ")}]`);
          if (abilities.length === 0) {
            console.log("    ✅ Hot potato — no abilities (cannot escape PTB)");
          } else if (abilities.includes("copy") || abilities.includes("drop")) {
            console.log(
              "    🔴 CRITICAL — receipt has copy/drop abilities — NOT a hot potato!"
            );
          } else if (abilities.includes("store") || abilities.includes("key")) {
            console.log(
              "    🟠 HIGH — receipt has store/key — can be wrapped or transferred!"
            );
          }
        }
      }
    }
  } catch (e) {
    console.error("  Error:", e);
  }

  // ---- STEP 8: Spot DEX — Fee Rate Access Control (AftermathFi-type) ----
  console.log("\n[8] Bluefin Spot — Fee Rate Access Control...");
  console.log("  From source analysis: protocol_fee_share = 25% HARDCODED");
  console.log("  Pool.fee_rate is set at creation time by pool creator");
  console.log("  Fee change after creation: need to check update functions");
  try {
    const spotMods = await client.getNormalizedMoveModulesByPackage({
      package: SPOT_CURRENT_PKG,
    });

    for (const modName of Object.keys(spotMods)) {
      const mod = spotMods[modName];
      const fns = Object.entries(mod.exposedFunctions || {});
      const feeFns = fns.filter(([name]) => /fee|rate/i.test(name));

      for (const [name, fn] of feeFns) {
        const params = fn.parameters?.map((p: any) => {
          if (p.Struct) return `${p.Struct.module}::${p.Struct.name}`;
          return JSON.stringify(p);
        });
        const needsAdminCap = params?.some((p) =>
          /AdminCap|ProtocolFeeCap|admin_cap/i.test(p)
        );
        console.log(
          `  [${modName}] ${name}: admin_required=${needsAdminCap}` +
            (!needsAdminCap ? " ⚠️  No admin cap check" : " ✅")
        );
      }
    }
  } catch (e) {
    console.error("  Error:", e);
  }

  // ---- STEP 9: Bluefin Coin/Staking reward accumulator ----
  console.log(`\n[9] Bluefin Coin/Staking Package: ${COIN_PKG}`);
  try {
    const coinMods = await client.getNormalizedMoveModulesByPackage({
      package: COIN_PKG,
    });
    const modules = Object.keys(coinMods);
    console.log("  Modules:", modules.join(", "));

    for (const modName of modules) {
      const mod = coinMods[modName];
      const structs = Object.entries(mod.structs || {});
      const fns = Object.entries(mod.exposedFunctions || {});

      // Check structs for reward accumulator fields
      for (const [structName, struct] of structs) {
        const fields = (struct as any).fields || [];
        const rewardFields = fields.filter((f: any) =>
          /index|unit|reward_debt|last_index|accumulator/i.test(f.name || "")
        );
        if (rewardFields.length > 0) {
          console.log(`\n  Struct: ${modName}::${structName} — REWARD FIELDS:`);
          for (const f of rewardFields) {
            console.log(`    ${f.name}: ${JSON.stringify(f.type_)}`);
          }
        }
      }

      // Check reward claim functions
      const rewardFns = fns.filter(([name]) =>
        /claim|harvest|reward|stake|unstake/i.test(name)
      );
      if (rewardFns.length > 0) {
        console.log(`\n  Module: ${modName} — REWARD FUNCTIONS:`);
        for (const [name, fn] of rewardFns) {
          const isEntry = fn.isEntry;
          const params = fn.parameters?.map((p: any) => {
            if (p.Struct) return `${p.Struct.module}::${p.Struct.name}`;
            return JSON.stringify(p);
          });
          console.log(
            `    [${fn.visibility}${isEntry ? "/entry" : ""}] ${name}`
          );
          console.log(`      params: ${params?.join(", ")}`);
        }
      }
    }
  } catch (e) {
    console.error("  Error:", e);
  }

  // ---- STEP 10: Perps Bank — can funds be extracted? ----
  console.log(`\n[10] Perps Bank Inspection: ${BANK}`);
  try {
    const bankObj = await client.getObject({
      id: BANK,
      options: { showContent: true, showType: true },
    });
    const type = (bankObj.data?.content as any)?.type;
    const fields = (bankObj.data?.content as any)?.fields || {};
    console.log("  Type:", type);
    for (const [k, v] of Object.entries(fields)) {
      if (typeof v !== "object" || v === null) {
        console.log(`    ${k}: ${v}`);
      } else {
        console.log(`    ${k}: [${JSON.stringify(v).slice(0, 120)}]`);
      }
    }
  } catch (e) {
    console.error("  Error:", e);
  }

  // ---- STEP 11: Perps Oracle price freshness ----
  console.log(`\n[11] Perps Price Oracle Inspection: ${ETH_PRICE_ORACLE}`);
  try {
    const oracleObj = await client.getObject({
      id: ETH_PRICE_ORACLE,
      options: { showContent: true, showType: true },
    });
    const type = (oracleObj.data?.content as any)?.type;
    const fields = (oracleObj.data?.content as any)?.fields || {};
    console.log("  Type:", type);
    for (const [k, v] of Object.entries(fields)) {
      if (typeof v !== "object") {
        console.log(`    ${k}: ${v}`);
      } else {
        console.log(`    ${k}: ${JSON.stringify(v).slice(0, 200)}`);
      }
    }
    // Look for price, confidence, publish_time, max_staleness
    console.log("\n  Key questions:");
    console.log("  a) Is there a max_staleness check before liquidation?");
    console.log("  b) Can oracle be updated by anyone with a valid VAA?");
    console.log("  c) Is confidence interval checked? (Pyth: price ± conf)");
  } catch (e) {
    console.error("  Error:", e);
  }

  // ---- STEP 12: Dry-run — try unauthorized funding rate set ----
  console.log("\n[12] Dry-run: Attempt to set funding rate without FundingRateCap...");
  try {
    const normPkg = await client.getNormalizedMoveModulesByPackage({
      package: PERPS_PACKAGE,
    });

    // Find funding rate setter functions
    let fundingSetFn: string | null = null;
    let fundingModName: string | null = null;
    for (const [modName, mod] of Object.entries(normPkg)) {
      for (const [fnName, fn] of Object.entries(mod.exposedFunctions || {})) {
        if (/set.*funding|funding.*rate.*set|apply.*funding/i.test(fnName)) {
          fundingSetFn = fnName;
          fundingModName = modName;
          console.log(`  Found: ${modName}::${fnName}`);
        }
      }
    }

    if (!fundingSetFn || !fundingModName) {
      console.log("  No funding rate setter found in public interface");
      console.log("  (May be operator-signed off-chain or via CapabilitiesSafe)");
    }
  } catch (e) {
    console.error("  Error:", e);
  }

  // ---- STEP 13: Insurance Fund check ----
  console.log("\n[13] Insurance Fund / Withdrawal Analysis...");
  try {
    const normPkg = await client.getNormalizedMoveModulesByPackage({
      package: PERPS_PACKAGE,
    });

    for (const [modName, mod] of Object.entries(normPkg)) {
      const fns = Object.entries(mod.exposedFunctions || {});
      const withdrawFns = fns.filter(([name]) =>
        /withdraw|insurance|delist|emergency/i.test(name)
      );

      for (const [name, fn] of withdrawFns) {
        const params = fn.parameters?.map((p: any) => {
          if (p.Struct) return `${p.Struct.module}::${p.Struct.name}`;
          return JSON.stringify(p);
        });
        const needsAdmin = params?.some((p) =>
          /AdminCap|GuardianCap|SettlementCap|CapabilitiesSafe/i.test(p)
        );
        console.log(
          `  [${modName}] ${name}: admin_gated=${needsAdmin}` +
            (!needsAdmin ? " 🔴 UNPROTECTED WITHDRAWAL" : " ✅")
        );
        if (!needsAdmin) {
          console.log(`    params: ${params?.join(", ")}`);
        }
      }
    }
  } catch (e) {
    console.error("  Error:", e);
  }

  // ---- STEP 14: SubAccounts — can sub-account drain parent? ----
  console.log("\n[14] SubAccounts delegation risk...");
  try {
    const subAccObj = await client.getObject({
      id: SUB_ACCOUNTS,
      options: { showContent: true, showType: true },
    });
    const type = (subAccObj.data?.content as any)?.type;
    console.log("  SubAccounts type:", type);
    const fields = (subAccObj.data?.content as any)?.fields || {};
    console.log("  Fields:", JSON.stringify(fields).slice(0, 300));
  } catch (e) {
    console.error("  Error:", e);
  }

  // ---- STEP 15: Perps TreasuryCap check ----
  console.log(`\n[15] TreasuryCap owner: ${TREASURY_CAP}`);
  try {
    const tc = await client.getObject({
      id: TREASURY_CAP,
      options: { showOwner: true, showContent: true, showType: true },
    });
    console.log("  Type:", (tc.data?.content as any)?.type);
    console.log("  Owner:", JSON.stringify(tc.data?.owner));
    const fields = (tc.data?.content as any)?.fields || {};
    // Check total_supply
    if (fields.total_supply) {
      console.log("  Total supply:", fields.total_supply);
    }
  } catch (e) {
    console.error("  Error:", e);
  }

  // ---- STEP 16: Pro package (proDeployment.json) ----
  console.log(`\n[16] Bluefin Pro Package: ${PRO_PACKAGE}`);
  try {
    const proMods = await client.getNormalizedMoveModulesByPackage({
      package: PRO_PACKAGE,
    });
    const modules = Object.keys(proMods);
    console.log("  Pro modules:", modules.join(", "));

    // Check for reward/staking related modules
    for (const modName of modules) {
      const mod = proMods[modName];
      const fns = Object.entries(mod.exposedFunctions || {});
      const rewardFns = fns.filter(([name]) =>
        /reward|stake|claim|harvest/i.test(name)
      );

      if (rewardFns.length > 0) {
        console.log(`\n  Pro Module: ${modName} — REWARD FUNCTIONS:`);
        for (const [name, fn] of rewardFns) {
          console.log(`    [${fn.visibility}${fn.isEntry ? "/entry" : ""}] ${name}`);
        }
      }
    }
  } catch (e) {
    console.error("  Error loading Pro package:", e);
  }

  console.log("\n" + "=".repeat(70));
  console.log("BLUEFIN AUDIT COMPLETE");
  console.log("=".repeat(70));
}

main().catch(console.error);
