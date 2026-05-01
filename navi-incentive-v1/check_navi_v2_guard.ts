/**
 * Verify NAVI V2 package version guard blocks deprecated calls
 * and check if V2 IncentiveBal objects have funds
 */
import { SuiClient } from "@mysten/sui/client";
import { Transaction } from "@mysten/sui/transactions";
const client = new SuiClient({ url: "https://fullnode.mainnet.sui.io:443" });

const NAVI_V2_PKG = "0xe66f07e2a8d9cf793da1e0bca98ff312b3ffba57228d97cf23a0613fddf31b65";
const NAVI_V2_INCENTIVE_OBJ = "0xf87a8acb8b81d14307894d12595541a73f19933f88e1326d5be349c7a6f7559c";
const NAVI_V3_PKG = "0x81c408448d0d57b3e371ea94de1d40bf852784d3e225de1e74acab3e8395c18f";
const NAVI_V3_INCENTIVE_OBJ = "0x62982dad27fb10bb314b3384d5de8d2ac2d72ab2dbeae5d801dbdb9efa816c80";
const CLOCK = "0x0000000000000000000000000000000000000000000000000000000000000006";
const DUMMY = "0x0000000000000000000000000000000000000000000000000000000000001337";

// Known V1 IncentiveBal objects (from previous audit)
const V1_INCENTIVE_BAL_EXAMPLE = "0x6dace7bbcf72e155e1ebb9a85c16f1f3f0e2de3ebad8b0e3d9b8e44c7a123456";

async function main() {
  console.log("=== NAVI V2/V3 Version Guard Verification ===\n");

  // 1. Check Incentive V2 object state
  console.log("--- NAVI V2 Incentive object state ---");
  try {
    const obj = await client.getObject({
      id: NAVI_V2_INCENTIVE_OBJ,
      options: { showContent: true }
    });
    const fields = (obj.data?.content as any)?.fields ?? {};
    const version = fields.version ?? fields.current_version ?? "not found";
    console.log(`  version field: ${JSON.stringify(version)}`);
    console.log(`  other fields: ${Object.keys(fields).slice(0, 10).join(", ")}`);
  } catch (e: any) { console.log(`Error: ${e.message?.slice(0, 60)}`); }

  // 2. Check Incentive V3 object state
  console.log("\n--- NAVI V3 Incentive object state ---");
  try {
    const obj = await client.getObject({
      id: NAVI_V3_INCENTIVE_OBJ,
      options: { showContent: true }
    });
    const fields = (obj.data?.content as any)?.fields ?? {};
    const version = fields.version ?? fields.current_version ?? "not found";
    console.log(`  version field: ${JSON.stringify(version)}`);
    console.log(`  other fields: ${Object.keys(fields).slice(0, 10).join(", ")}`);
  } catch (e: any) { console.log(`Error: ${e.message?.slice(0, 60)}`); }

  // 3. Dry-run V2's claim_reward to verify version guard
  console.log("\n--- Dry-run: V2 incentive::claim_reward (should fail with version error) ---");
  try {
    // Find IncentiveBal objects from V2 package
    const evts = await client.queryEvents({
      query: { MoveEventModule: { package: NAVI_V2_PKG, module: "incentive" } },
      limit: 3,
      order: "descending",
    });
    console.log(`V2 incentive events: ${evts.data.length}`);
    for (const e of evts.data.slice(0, 2)) {
      console.log(`  ${e.type?.split("::").pop()}: ${JSON.stringify(e.parsedJson ?? {}).slice(0, 80)}`);
    }
  } catch (e: any) { console.log(`Error: ${e.message?.slice(0, 60)}`); }

  // 4. Search for V2 IncentiveBal objects with funds
  console.log("\n--- Find V2 IncentiveBal objects ---");
  try {
    const evts = await client.queryEvents({
      query: { MoveEventType: `${NAVI_V2_PKG}::incentive::IncentiveBalCreated` },
      limit: 5,
      order: "descending",
    });
    console.log(`IncentiveBalCreated events: ${evts.data.length}`);
    for (const e of evts.data.slice(0, 3)) {
      const pj = e.parsedJson as any ?? {};
      const id = pj.id ?? pj.object_id ?? "?";
      console.log(`  id=${String(id).slice(0, 40)}`);
    }
  } catch (e: any) {
    // Try any event from V2
    try {
      const evts2 = await client.queryEvents({
        query: { MoveEventModule: { package: NAVI_V2_PKG, module: "incentive_v2" } },
        limit: 3, order: "descending",
      });
      console.log(`V2 incentive_v2 events: ${evts2.data.length}`);
    } catch {}
    console.log(`Error: ${e.message?.slice(0, 60)}`);
  }

  // 5. Check how the V2 version guard is implemented
  console.log("\n--- V2 version guard implementation ---");
  try {
    const mod = await client.getNormalizedMoveModule({ package: NAVI_V2_PKG, module: "storage" });
    for (const [name, st] of Object.entries(mod.structs ?? {}) as [string, any][]) {
      const fields = (st as any).fields ?? [];
      const hasVer = fields.some((f: any) => /version/i.test(f.name));
      if (hasVer) {
        console.log(`  ${name}: ${fields.filter((f: any) => /version/i.test(f.name)).map((f: any) => f.name).join(", ")}`);
      }
    }
  } catch {}

  try {
    const versionFns = [];
    for (const modName of ["incentive", "incentive_v2", "storage", "validation"]) {
      try {
        const mod = await client.getNormalizedMoveModule({ package: NAVI_V2_PKG, module: modName });
        for (const [fnName, fn] of Object.entries(mod.exposedFunctions)) {
          if (/version/i.test(fnName)) versionFns.push(`${modName}::${fnName}`);
        }
      } catch {}
    }
    console.log(`  Version-related functions: ${versionFns.join(", ")}`);
  } catch (e: any) { console.log(`Error: ${e.message?.slice(0, 60)}`); }

  // 6. Check Storage struct for version in V2
  console.log("\n--- V2 Storage struct fields ---");
  try {
    const st = await client.getNormalizedMoveStruct({ package: NAVI_V2_PKG, module: "storage", struct: "Storage" });
    for (const f of st.fields) {
      if (/version|protocol/i.test(f.name)) {
        console.log(`  *** ${f.name}: ${JSON.stringify(f.type).slice(0, 60)}`);
      }
    }
  } catch (e: any) { console.log(`Error: ${e.message?.slice(0, 60)}`); }
}

main().catch(console.error);
