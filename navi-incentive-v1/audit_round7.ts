/**
 * ROUND 7 SECURITY AUDIT
 * Direction 1: Bluefin Pro (new perps architecture)
 * Direction 2: Wormhole cross-chain bridge
 * Direction 3: Oracle manipulation scan
 * Direction 4: KriyaDEX farming, Scallop market, NAVI lending core
 */
import { SuiClient, getFullnodeUrl } from "@mysten/sui/client";
const client = new SuiClient({ url: getFullnodeUrl("mainnet") });

// === PACKAGES ===
const BLUEFIN_PRO = "0x039146aa464eb40568353e0d8e4c38455ef5781d964ffc9fef4eb5ae023cac58";
const BLUEFIN_PRO_DATA_STORE = "0xe74481697f432ddee8dd6f9bd13b9d0297a5b63d55f3db25c4d3b5d34dad85b7";
const BLUEFIN_SPOT_ORIG = "0x3492c874c1e3b3e2984e8c41b589e642d4d0a5d6459e5a9cfc2d52fd7c89c267";
const BLUEFIN_SPOT_CURR = "0x6c796c3ab3421a68158e0df18e4657b2827b1f8fed5ed4b82dba9c935988711b";
const WORMHOLE = "0x5306f64e312b581766351c07af79c72fcb1cd25147157fdc2f8ad76de9a3fb6a";
const NAVI_LATEST = "0x1e4a13a0494d5facdbe8473e74127b838c2d446ecec0ce262e2eddafa77259cb";
const NAVI_V1 = "0xd899cf7d2b5db716bd2cf55599fb0d5ee38a3061e7b6bb6eebf73fa5bc4c81ca";
const NAVI_ORACLE = "0xca441b44943c16be0e6e23c5a955bb971537ea3289ae8016fbf33fffe1fd210f";
const SUILEND = "0xf95b06141ed4a174f239417323bde3f209b972f5930d8521ea38a52aff3a6ddf";
const KRIYA_AMM = "0xa0eba10b173538c8fecca1dff298e488402cc9ff374f8a12ca7758eebe830b66";
const SCALLOP_SPOOL_V3 = "0x472fc7d4c3534a8ec8c2f5d7a557a43050eab057aaab853e8910968ddc84fc9f";

async function sep(title: string) {
  console.log("\n" + "=".repeat(70));
  console.log(title);
  console.log("=".repeat(70));
}

// ============================================================
// DIRECTION 1: BLUEFIN PRO PERPS FULL AUDIT
// ============================================================
async function auditBluefinPro() {
  await sep("DIRECTION 1: BLUEFIN PRO PERPS");

  // 1a. Check data_store module - what is InternalDataStore
  console.log("\n[1a] Bluefin Pro data_store structs...");
  try {
    const mod = await client.getNormalizedMoveModule({ package: BLUEFIN_PRO_DATA_STORE, module: "data_store" });
    for (const [sn, sd] of Object.entries(mod.structs)) {
      const fields = (sd as any).fields?.map((f: any) => f.name) ?? [];
      const abilities = (sd as any).abilities?.abilities ?? [];
      console.log(`  Struct ${sn}: abilities=${JSON.stringify(abilities)}, fields=${JSON.stringify(fields.slice(0, 12))}`);
    }
  } catch (e: any) { console.log("  ERROR:", e.message?.slice(0, 100)); }

  // 1b. Check exchange module for position size tracking atomicity
  console.log("\n[1b] Bluefin Pro exchange module - position logic...");
  try {
    const mod = await client.getNormalizedMoveModule({ package: BLUEFIN_PRO, module: "exchange" });
    const fns = mod.exposedFunctions;
    
    // Focus on trade, open/close position
    const positionFns = ["trade", "close_position", "open_position", "liquidate", "deleverage", "set_funding_rate", "apply_funding_rate"];
    for (const fn of positionFns) {
      if (fns[fn]) {
        const params = JSON.stringify(fns[fn].parameters ?? []);
        const typeParams = fns[fn].typeParameters ?? [];
        console.log(`  [ENTRY: ${fns[fn].isEntry}] ${fn}:`);
        console.log(`    typeParams: ${typeParams.length}, params(short): ${params.slice(0, 200)}`);
      }
    }
  } catch (e: any) { console.log("  ERROR:", e.message?.slice(0, 100)); }

  // 1c. Check perpetual module 
  console.log("\n[1c] Bluefin Pro perpetual module structs (position state)...");
  try {
    const mod = await client.getNormalizedMoveModule({ package: BLUEFIN_PRO, module: "perpetual" });
    for (const [sn, sd] of Object.entries(mod.structs)) {
      const fields = (sd as any).fields?.map((f: any) => `${f.name}:${JSON.stringify(f.type).slice(0,50)}`) ?? [];
      console.log(`  Struct ${sn}: fields=${JSON.stringify(fields.slice(0, 10))}`);
    }
    // Entry fns
    for (const [fn, fdata] of Object.entries(mod.exposedFunctions)) {
      if ((fdata as any).isEntry) {
        console.log(`  [ENTRY] ${fn}: ${JSON.stringify((fdata as any).parameters ?? []).slice(0,200)}`);
      }
    }
  } catch (e: any) { console.log("  ERROR:", e.message?.slice(0, 100)); }

  // 1d. Check margining_engine
  console.log("\n[1d] Bluefin Pro margining_engine...");
  try {
    const mod = await client.getNormalizedMoveModule({ package: BLUEFIN_PRO, module: "margining_engine" });
    for (const [fn, fdata] of Object.entries(mod.exposedFunctions)) {
      const is_entry = (fdata as any).isEntry;
      const vis = (fdata as any).visibility;
      const params_str = JSON.stringify((fdata as any).parameters ?? []).slice(0, 300);
      console.log(`  [${is_entry ? "ENTRY" : vis}] ${fn}: ${params_str}`);
    }
  } catch (e: any) { console.log("  ERROR:", e.message?.slice(0, 100)); }

  // 1e. Deprecated package check - is orig package still callable?
  console.log("\n[1e] Bluefin Spot — deprecated package reward functions...");
  try {
    const mod = await client.getNormalizedMoveModule({ package: BLUEFIN_SPOT_ORIG, module: "gateway" });
    const entries = Object.entries(mod.exposedFunctions).filter(([,f]) => (f as any).isEntry);
    for (const [fn, fdata] of entries) {
      const params = (fdata as any).parameters ?? [];
      const hasVersion = params.some((p: any) => JSON.stringify(p).includes("version") || JSON.stringify(p).includes("GlobalConfig"));
      // check if fn needs admin cap
      const hasAdmin = params.some((p: any) => JSON.stringify(p).toLowerCase().includes("admincap") || JSON.stringify(p).toLowerCase().includes("admin_cap"));
      const rewardRelated = fn.toLowerCase().includes("reward") || fn.toLowerCase().includes("collect") || fn.toLowerCase().includes("fee");
      if (rewardRelated) {
        console.log(`  ${fn}: admin_required=${hasAdmin}, version_param=${hasVersion} ${!hasAdmin && !hasVersion ? "🔴 POTENTIAL VULN" : "✅"}`);
      }
    }
  } catch (e: any) { console.log("  ERROR:", e.message?.slice(0, 100)); }

  // 1f. Bluefin spot orig - check collect_reward params in detail
  console.log("\n[1f] Bluefin Spot orig gateway::collect_reward signature...");
  try {
    const fn = await client.getNormalizedMoveFunction({ package: BLUEFIN_SPOT_ORIG, module: "gateway", function: "collect_reward" });
    console.log("  collect_reward parameters:");
    for (const [i, p] of (fn.parameters ?? []).entries()) {
      console.log(`    param[${i}]: ${JSON.stringify(p)}`);
    }
    console.log("  isEntry:", fn.isEntry);
    console.log("  typeParameters:", JSON.stringify(fn.typeParameters));
  } catch (e: any) { console.log("  ERROR:", e.message?.slice(0, 100)); }

  // 1g. Check admin module for version guard on the spot upgrade
  console.log("\n[1g] Bluefin Spot current vs orig — version guard comparison...");
  try {
    const origGlobal = await client.getNormalizedMoveModule({ package: BLUEFIN_SPOT_ORIG, module: "config" });
    const currGlobal = await client.getNormalizedMoveModule({ package: BLUEFIN_SPOT_CURR, module: "config" });
    const origHasVersion = Object.keys(origGlobal.structs).some(s => s.toLowerCase().includes("version"));
    const currHasVersion = Object.keys(currGlobal.structs).some(s => s.toLowerCase().includes("version"));
    console.log(`  Original config has version struct: ${origHasVersion}`);
    console.log(`  Current config has version struct: ${currHasVersion}`);
    // check if GlobalConfig struct has version field
    for (const [sn, sd] of Object.entries(origGlobal.structs)) {
      const fields = (sd as any).fields?.map((f: any) => f.name) ?? [];
      if (sn.toLowerCase().includes("config") || sn.toLowerCase().includes("global")) {
        console.log(`  Orig ${sn} fields: ${fields.join(", ")}`);
      }
    }
  } catch (e: any) { console.log("  ERROR:", e.message?.slice(0, 100)); }
}

// ============================================================
// DIRECTION 2: WORMHOLE BRIDGE ANALYSIS
// ============================================================
async function auditWormhole() {
  await sep("DIRECTION 2: WORMHOLE BRIDGE");

  // 2a. Check all modules for any entry functions (CrossCurve style)
  console.log("\n[2a] Wormhole — scanning ALL modules for entry functions...");
  try {
    const norm = await client.getNormalizedMoveModulesByPackage({ package: WORMHOLE });
    let totalEntries = 0;
    for (const [mod, info] of Object.entries(norm)) {
      const entries = Object.entries((info as any).exposedFunctions ?? {}).filter(([,f]) => (f as any).isEntry);
      if (entries.length > 0) {
        totalEntries += entries.length;
        for (const [fn, fdata] of entries) {
          console.log(`  [ENTRY] ${mod}::${fn}`);
          const params = (fdata as any).parameters ?? [];
          for (const [i, p] of params.entries()) {
            const ps = JSON.stringify(p);
            const hasSenderCheck = ps.includes("TxContext");
            console.log(`    param[${i}]: ${ps.slice(0, 150)} ${hasSenderCheck ? "← sender context" : ""}`);
          }
        }
      }
    }
    if (totalEntries === 0) {
      console.log("  ✅ NO ENTRY FUNCTIONS — Wormhole core has no callable entry points.");
      console.log("  Architecture: VAA struct is hot-potato (no abilities), must pass through parse_and_verify.");
      console.log("  Consumer contracts (token bridge, etc.) are separate packages — need separate scan.");
    }
  } catch (e: any) { console.log("  ERROR:", e.message?.slice(0, 100)); }

  // 2b. Find Wormhole Token Bridge package
  console.log("\n[2b] Searching for Wormhole Token Bridge on Sui...");
  const TOKEN_BRIDGE_CANDIDATES = [
    "0xf47329f4344f3bf0f8e436e2f7b485466cff300f12a166563995d3888c80bcaf",
    "0x26efee2b51c911237888e5dc6702868abca3c7ac12c53f76ef8eba0697695e3d",
  ];
  for (const pkg of TOKEN_BRIDGE_CANDIDATES) {
    try {
      const norm = await client.getNormalizedMoveModulesByPackage({ package: pkg });
      const mods = Object.keys(norm);
      console.log(`  PKG ${pkg.slice(0,28)}... modules: ${mods.join(", ")}`);
      // Check for complete_transfer or execute_message
      for (const [mod, info] of Object.entries(norm)) {
        for (const [fn, fdata] of Object.entries((info as any).exposedFunctions ?? {})) {
          if (fn.includes("complete") || fn.includes("execute") || fn.includes("transfer")) {
            const is_entry = (fdata as any).isEntry;
            const params = (fdata as any).parameters ?? [];
            const hasTrustedRelayer = params.some((p: any) => JSON.stringify(p).toLowerCase().includes("relayer") || JSON.stringify(p).toLowerCase().includes("guardian"));
            console.log(`  [${is_entry ? "ENTRY" : "pub"}] ${mod}::${fn}: trusted_relayer_check=${hasTrustedRelayer} ${is_entry && !hasTrustedRelayer ? "⚠️" : ""}`);
          }
        }
      }
    } catch (e: any) {
      console.log(`  ${pkg.slice(0, 28)}: ${e.message?.slice(0, 60)}`);
    }
  }

  // 2c. Check consumed_vaas for replay protection
  console.log("\n[2c] Wormhole VAA replay protection...");
  try {
    const mod = await client.getNormalizedMoveModule({ package: WORMHOLE, module: "consumed_vaas" });
    for (const [sn, sd] of Object.entries(mod.structs)) {
      const fields = (sd as any).fields?.map((f: any) => f.name) ?? [];
      const abilities = (sd as any).abilities?.abilities ?? [];
      console.log(`  ConsumedVAAs struct ${sn}: abilities=${JSON.stringify(abilities)}, fields=${JSON.stringify(fields)}`);
    }
    for (const [fn, fdata] of Object.entries(mod.exposedFunctions)) {
      console.log(`  fn ${fn}: visibility=${fdata.visibility}`);
    }
  } catch (e: any) { console.log("  ERROR:", e.message?.slice(0, 100)); }
}

// ============================================================
// DIRECTION 3: ORACLE MANIPULATION SCAN
// ============================================================
async function auditOracles() {
  await sep("DIRECTION 3: ORACLE MANIPULATION SCAN");

  // 3a. NAVI oracle — price update mechanism
  console.log("\n[3a] NAVI Oracle — price update mechanism...");
  try {
    const fn = await client.getNormalizedMoveFunction({ package: NAVI_ORACLE, module: "oracle", function: "update_token_price" });
    console.log("  update_token_price:");
    for (const [i, p] of (fn.parameters ?? []).entries()) {
      const ps = JSON.stringify(p);
      const isFeeder = ps.includes("OracleFeederCap");
      const isAdmin = ps.includes("OracleAdminCap");
      console.log(`    param[${i}]: ${ps.slice(0, 200)} ${isFeeder ? "← FEEDER CAP REQUIRED ✅" : ""} ${isAdmin ? "← ADMIN CAP ✅" : ""}`);
    }
    console.log("  typeParameters:", JSON.stringify(fn.typeParameters));
    // No CoinType generic = NOT susceptible to Rhea-type oracle attack with arbitrary coin
  } catch (e: any) { console.log("  ERROR:", e.message?.slice(0, 100)); }

  // 3b. NAVI oracle — get_token_price — is it CoinType parameterized?
  console.log("\n[3b] NAVI Oracle — get_token_price signature...");
  try {
    const fn = await client.getNormalizedMoveFunction({ package: NAVI_ORACLE, module: "oracle", function: "get_token_price" });
    console.log("  get_token_price:");
    for (const [i, p] of (fn.parameters ?? []).entries()) {
      console.log(`    param[${i}]: ${JSON.stringify(p).slice(0, 200)}`);
    }
    console.log("  typeParameters:", JSON.stringify(fn.typeParameters));
    // Uses U8 asset_id, not generic CoinType — check if mapping is controlled
    const norm = await client.getNormalizedMoveModule({ package: NAVI_ORACLE, module: "oracle" });
    const oracle_struct = norm.structs["PriceOracle"];
    console.log("  PriceOracle.price_oracles field type (storage mapping):");
    const po_field = (oracle_struct as any).fields?.find((f: any) => f.name === "price_oracles");
    console.log("   ", JSON.stringify(po_field?.type ?? "not found").slice(0, 300));
  } catch (e: any) { console.log("  ERROR:", e.message?.slice(0, 100)); }

  // 3c. Scallop oracle check — find Scallop main market package
  console.log("\n[3c] Scallop — finding main market package...");
  const SCALLOP_CANDIDATES = [
    "0xba79d07a3c2c7870e3e5a9f58cf52e17c99f9b16b78cae9b20c40b03a31a0d1",
    "0x4c32d2d4c266b8e54e5655d7dfe06fe2de3a0a56fe07ec98e1aa84b36cd90e85",
    "0x82ea898f85df29d6b1b50219cd86e2238f27ca8e03f6f37a4b6faa55b5571af8",
  ];
  for (const pkg of SCALLOP_CANDIDATES) {
    try {
      const norm = await client.getNormalizedMoveModulesByPackage({ package: pkg });
      const mods = Object.keys(norm);
      const hasMarket = mods.some(m => ["market", "lending_market", "borrow", "supply"].includes(m.toLowerCase()));
      if (hasMarket || mods.length > 5) {
        console.log(`  FOUND Scallop market? ${pkg.slice(0,28)}... modules: ${mods.join(", ")}`);
      }
    } catch {}
  }

  // 3d. Suilend oracle check
  console.log("\n[3d] Suilend — oracle/collateral CoinType whitelist...");
  try {
    const norm = await client.getNormalizedMoveModulesByPackage({ package: SUILEND });
    const mods = Object.keys(norm);
    console.log(`  Suilend modules: ${mods.join(", ")}`);
    // Find oracle or price-related modules
    const oracleMods = mods.filter(m => m.toLowerCase().includes("oracle") || m.toLowerCase().includes("price"));
    for (const mod of oracleMods) {
      const modData = await client.getNormalizedMoveModule({ package: SUILEND, module: mod });
      console.log(`  [${mod}] structs: ${Object.keys(modData.structs).join(", ")}`);
      for (const [fn, fdata] of Object.entries(modData.exposedFunctions)) {
        const typeParams = (fdata as any).typeParameters ?? [];
        if (typeParams.length > 0) {
          console.log(`  [${mod}]::${fn}: has ${typeParams.length} type params (generic CoinType?) ⚠️`);
        }
      }
    }
    // Also check reserve or collateral module
    const reserveMods = mods.filter(m => m.toLowerCase().includes("reserve") || m.toLowerCase().includes("collateral") || m.toLowerCase().includes("lending"));
    for (const mod of reserveMods.slice(0, 3)) {
      const modData = await client.getNormalizedMoveModule({ package: SUILEND, module: mod });
      // Look for oracle-calling functions
      for (const [fn, fdata] of Object.entries(modData.exposedFunctions)) {
        const params = JSON.stringify((fdata as any).parameters ?? []);
        const typeParams = (fdata as any).typeParameters ?? [];
        if (params.includes("price") || params.includes("oracle") || params.includes("Price")) {
          console.log(`  [${mod}]::${fn}: oracle usage, typeParams=${typeParams.length}`);
        }
      }
    }
  } catch (e: any) { console.log("  ERROR:", e.message?.slice(0, 100)); }
}

// ============================================================
// DIRECTION 4: KRIYA FARMING + SCALLOP MARKET + NAVI LENDING CORE
// ============================================================
async function auditDirection4() {
  await sep("DIRECTION 4: KRIYA FARMING / SCALLOP MARKET / NAVI LENDING");

  // 4a. KriyaDEX — find farming/staking module (not AMM)
  console.log("\n[4a] KriyaDEX — enumerating all modules in AMM package...");
  try {
    const norm = await client.getNormalizedMoveModulesByPackage({ package: KRIYA_AMM });
    const mods = Object.keys(norm);
    console.log(`  Modules: ${mods.join(", ")}`);
    const farmingMods = mods.filter(m => 
      m.toLowerCase().includes("farm") || 
      m.toLowerCase().includes("stake") || 
      m.toLowerCase().includes("reward") || 
      m.toLowerCase().includes("incentive") ||
      m.toLowerCase().includes("emission")
    );
    console.log(`  Farming-related modules: ${farmingMods.length > 0 ? farmingMods.join(", ") : "NONE"}`);
    
    // Check all modules for reward-type patterns
    for (const [mod, info] of Object.entries(norm)) {
      const entries = Object.entries((info as any).exposedFunctions ?? {}).filter(([,f]) => (f as any).isEntry);
      const rewardEntries = entries.filter(([fn]) => 
        fn.toLowerCase().includes("reward") || 
        fn.toLowerCase().includes("claim") || 
        fn.toLowerCase().includes("harvest") ||
        fn.toLowerCase().includes("emission")
      );
      if (rewardEntries.length > 0) {
        for (const [fn, fdata] of rewardEntries) {
          const params = (fdata as any).parameters ?? [];
          const hasVersionParam = params.some((p: any) => JSON.stringify(p).toLowerCase().includes("version"));
          const hasAdminCap = params.some((p: any) => JSON.stringify(p).toLowerCase().includes("admincap") || JSON.stringify(p).toLowerCase().includes("cap"));
          console.log(`  [${mod}]::${fn}: version_param=${hasVersionParam}, admin_cap=${hasAdminCap} ${!hasVersionParam && !hasAdminCap ? "⚠️ CHECK" : ""}`);
        }
      }
    }
  } catch (e: any) { console.log("  ERROR:", e.message?.slice(0, 100)); }

  // 4b. KriyaDEX farming — find separate package
  console.log("\n[4b] KriyaDEX farming — searching for separate package...");
  const KRIYA_FARM_CANDIDATES = [
    "0x424a4a3ef9cb9d32fa3ea83cfa01b2f4b2feefa3eb0e17da7e57fccc1c2a1c17",
    "0x2a24ce23a59e8a9a46b29b47e9c90fef09e5e91a19e2d3a1b6b1d6b6d6a6c6e",
    "0x1ea7580a6fb7c9e42aabf3db96d0c1b61e77bdb47e8e50e93f8f84c0b8c8f30",
  ];
  for (const pkg of KRIYA_FARM_CANDIDATES) {
    try {
      const norm = await client.getNormalizedMoveModulesByPackage({ package: pkg });
      const mods = Object.keys(norm);
      console.log(`  PKG ${pkg.slice(0,28)}... modules: ${mods.join(", ")}`);
    } catch {}
  }

  // 4c. NAVI lending core — flash_loan atomicity check
  console.log("\n[4c] NAVI lending core — flash_loan hot potato verification...");
  try {
    // Receipt struct must have no abilities (cannot be dropped, copied, or stored)
    const receipt = await client.getNormalizedMoveStruct({ package: NAVI_V1, module: "flash_loan", struct: "Receipt" });
    const abilities = (receipt as any).abilities?.abilities ?? [];
    console.log(`  Receipt abilities: ${JSON.stringify(abilities)}`);
    if (abilities.length === 0) {
      console.log("  ✅ Hot potato pattern — Receipt has NO abilities (must repay in same PTB)");
    } else {
      console.log("  🔴 VULNERABILITY — Receipt has abilities, can escape PTB without repayment!");
    }
    
    // Check loan function visibility - should be Public, not entry
    const loanFn = await client.getNormalizedMoveFunction({ package: NAVI_V1, module: "flash_loan", function: "loan" });
    console.log(`  flash_loan::loan visibility: ${loanFn.visibility}, isEntry: ${loanFn.isEntry}`);
    
    // Check if loan is actually called through lending module
    const lendingLoanFn = await client.getNormalizedMoveFunction({ package: NAVI_LATEST, module: "lending", function: "flash_loan_with_ctx" }).catch(() => null);
    if (lendingLoanFn) {
      console.log(`  lending::flash_loan_with_ctx: isEntry=${lendingLoanFn.isEntry}`);
    }
  } catch (e: any) { console.log("  ERROR:", e.message?.slice(0, 100)); }

  // 4d. NAVI liquidation access control
  console.log("\n[4d] NAVI liquidation_call — access control check...");
  try {
    const fn = await client.getNormalizedMoveFunction({ package: NAVI_LATEST, module: "lending", function: "liquidation_call" });
    console.log("  liquidation_call parameters:");
    for (const [i, p] of (fn.parameters ?? []).entries()) {
      const ps = JSON.stringify(p);
      const isAdminOrOperator = ps.toLowerCase().includes("cap") || ps.toLowerCase().includes("admin") || ps.toLowerCase().includes("operator");
      console.log(`    param[${i}]: ${ps.slice(0, 200)} ${isAdminOrOperator ? "← ACCESS CONTROL" : ""}`);
    }
    console.log(`  isEntry: ${fn.isEntry}`);
    // Anyone can liquidate = expected behavior in lending protocols
  } catch (e: any) { console.log("  ERROR:", e.message?.slice(0, 100)); }

  // 4e. NAVI borrow — check for validation module calls
  console.log("\n[4e] NAVI validation module...");
  try {
    const mod = await client.getNormalizedMoveModule({ package: NAVI_LATEST, module: "validation" });
    for (const [fn, fdata] of Object.entries(mod.exposedFunctions)) {
      const params = JSON.stringify((fdata as any).parameters ?? []).slice(0, 200);
      console.log(`  ${fn}: ${params}`);
    }
  } catch (e: any) { console.log("  ERROR:", e.message?.slice(0, 100)); }

  // 4f. Scallop spool v3 - check module structure
  console.log("\n[4f] Scallop spool v3 module scan...");
  try {
    const norm = await client.getNormalizedMoveModulesByPackage({ package: SCALLOP_SPOOL_V3 });
    const mods = Object.keys(norm);
    console.log(`  Scallop spool v3 modules: ${mods.join(", ")}`);
    // Check for version guard
    for (const [mod, info] of Object.entries(norm)) {
      const entries = Object.entries((info as any).exposedFunctions ?? {}).filter(([,f]) => (f as any).isEntry);
      for (const [fn, fdata] of entries) {
        const params = (fdata as any).parameters ?? [];
        const hasVersion = params.some((p: any) => {
          const s = JSON.stringify(p);
          return s.includes("version") || s.includes("Version") || s.includes("Versioned");
        });
        const isReward = fn.toLowerCase().includes("reward") || fn.toLowerCase().includes("claim") || fn.toLowerCase().includes("stake") || fn.toLowerCase().includes("unstake");
        if (isReward) {
          console.log(`  [ENTRY] ${mod}::${fn}: has_version_param=${hasVersion} ${!hasVersion ? "⚠️" : "✅"}`);
        }
      }
    }
  } catch (e: any) { console.log("  ERROR:", e.message?.slice(0, 100)); }
}

// ============================================================
// MAIN
// ============================================================
async function main() {
  console.log("ROUND 7 SECURITY AUDIT — Sui DeFi");
  console.log(`Timestamp: ${new Date().toISOString()}`);
  
  await auditBluefinPro();
  await auditWormhole();
  await auditOracles();
  await auditDirection4();
  
  console.log("\n" + "=".repeat(70));
  console.log("AUDIT COMPLETE");
  console.log("=".repeat(70));
}

main().catch(console.error);
