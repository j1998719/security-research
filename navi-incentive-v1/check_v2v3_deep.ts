import { SuiClient } from "@mysten/sui/client";
import { Transaction } from "@mysten/sui/transactions";

const client = new SuiClient({ url: "https://fullnode.mainnet.sui.io:443" });
const STORAGE      = "0xbb4e2f4b6205c2e2a2db47aeb4f830796ec7c005f88537ee775986639bc442fe";
const CLOCK        = "0x0000000000000000000000000000000000000000000000000000000000000006";
const INCENTIVE_V2 = "0xf87a8acb8b81d14307894d12595541a73f19933f88e1326d5be349c7a6f7559c";
const INCENTIVE_V3 = "0x62982dad27fb10bb314b3384d5de8d2ac2d72ab2dbeae5d801dbdb9efa816c80";
const NAVI_WHALE   = "0x7861f12c652dbcf96589413cf5cbc5ebcccd85c2c9f09c25fee76f2a218195c9";
const DUMMY        = "0x0000000000000000000000000000000000000000000000000000000000001337";
const SUI_TYPE     = "0x2::sui::SUI";

// ─── V2 Analysis ──────────────────────────────────────────────────────────────
async function analyzeV2() {
  console.log("=== NAVI IncentiveV2 Analysis ===\n");
  
  // Get the IncentiveV2 object and find its package
  const obj = await client.getObject({ id: INCENTIVE_V2, options: { showType: true, showContent: true } });
  const objType = obj.data?.type ?? "";
  const v2Pkg = objType.split("::")[0];
  console.log("v2 package:", v2Pkg);
  console.log("v2 version field:", (obj.data?.content as any)?.fields?.version);
  
  // Get v2 incentive_v2 module functions
  const mod = await client.getNormalizedMoveModule({ package: v2Pkg, module: "incentive_v2" });
  const fns = mod.exposedFunctions;
  const entryFns = Object.entries(fns).filter(([, v]) => v.isEntry);
  console.log(`\nv2 entry functions (${entryFns.length}):`);
  for (const [k] of entryFns) console.log(`  ${k}`);
  
  // Find v2 IncentiveBal objects
  const v2BalType = `${v2Pkg}::incentive_v2::IncentiveFundsPool`;
  console.log("\nSearching for v2 IncentiveFundsPool objects...");
  // Check dynamic fields of IncentiveV2
  const df = await client.getDynamicFields({ parentId: INCENTIVE_V2 });
  console.log(`  IncentiveV2 dynamic fields: ${df.data.length}`);
  
  // Test if v2 claim_reward is callable
  const claimFnName = entryFns.find(([k]) => k.includes("claim"))?.[0];
  if (claimFnName) {
    console.log(`\nTesting v2 ${claimFnName} (version guard check)...`);
    const tx = new Transaction();
    tx.setSender(DUMMY);
    // Use a fake IncentiveFundsPool - error type reveals if version guard fires first
    tx.moveCall({
      target: `${v2Pkg}::incentive_v2::${claimFnName}`,
      typeArguments: [SUI_TYPE],
      arguments: [
        tx.object(INCENTIVE_V2),
        tx.object("0x0000000000000000000000000000000000000000000000000000000000000001"),
        tx.object(CLOCK),
        tx.object(STORAGE),
        tx.pure.address(NAVI_WHALE),
      ],
    });
    const r = await client.devInspectTransactionBlock({ transactionBlock: tx, sender: DUMMY });
    const err = r.effects?.status?.error ?? "";
    console.log(`  Status: ${r.effects?.status?.status}`);
    if (err.includes("EIncorrectVersion") || err.includes("version")) {
      console.log("  → VERSION GUARD FIRES ✓ — v2 blocked by version check");
    } else if (err.includes("not found") || err.includes("object")) {
      console.log("  → Passed version check! Object error next — v2 callable if valid IncentiveFundsPool exists");
      console.log("  ERROR:", err.slice(0, 120));
    } else {
      console.log("  ERROR:", err.slice(0, 120));
    }
  }
}

// ─── V3 Analysis ──────────────────────────────────────────────────────────────
async function analyzeV3() {
  console.log("\n=== NAVI IncentiveV3 Analysis ===\n");
  
  const obj = await client.getObject({ id: INCENTIVE_V3, options: { showType: true, showContent: true } });
  const v3Pkg = (obj.data?.type ?? "").split("::")[0];
  console.log("v3 package:", v3Pkg.slice(0, 22) + "...");
  
  const f = (obj.data?.content as any)?.fields ?? {};
  console.log("Fields:", Object.keys(f));
  
  // Check pools (VecMap)
  const poolsRaw = f.pools;
  if (poolsRaw?.type?.includes("VecMap")) {
    const contents = poolsRaw?.fields?.contents ?? [];
    console.log(`\nv3 pool count (VecMap): ${contents.length}`);
    if (contents.length > 0) {
      const sample = contents[0];
      console.log("Sample pool key:", sample?.fields?.key?.slice(0, 60));
      const pf = sample?.fields?.value?.fields ?? {};
      console.log("Sample pool fields:", Object.keys(pf));
      // Look for index/reward tracking
      const indexKeys = Object.keys(pf).filter(k => k.includes("index") || k.includes("reward") || k.includes("accrued"));
      console.log("Index/reward related:", indexKeys);
      for (const k of indexKeys) console.log(`  ${k}: ${String(pf[k]).slice(0,40)}`);
    }
  }
  
  // Check v3 reward claim function
  const protoPkg = "0xee0041239b89564ce870a7dec5ddc5d114367ab94a1137e90aa0633cb76518e0";
  const mod = await client.getNormalizedMoveModule({ package: protoPkg, module: "incentive_v3" }).catch(() => null);
  if (mod) {
    const rewardFns = Object.entries(mod.exposedFunctions).filter(([k]) => 
      k.includes("reward") || k.includes("claim") || k.includes("harvest")
    );
    console.log(`\nv3 reward functions (${rewardFns.length}):`);
    for (const [k, v] of rewardFns) {
      console.log(`  ${k}  entry=${v.isEntry}`);
    }
  } else {
    console.log("(Could not fetch incentive_v3 module from protoPkg)");
  }
  
  // Does v3 have per-user index in a Table (potentially uninitialized)?
  // Check the PoolState struct
  console.log("\nChecking PoolState struct for user index tracking...");
  const nMod = await client.getNormalizedMoveModulesByPackage({ package: protoPkg }).catch(() => null);
  if (nMod) {
    const iv3Mod = nMod["incentive_v3"];
    if (iv3Mod) {
      const structs = iv3Mod.structs;
      for (const [name, s] of Object.entries(structs)) {
        if (name.includes("Pool") || name.includes("User") || name.includes("Reward")) {
          console.log(`  Struct ${name}:`);
          for (const field of s.fields) {
            const ty = JSON.stringify(field.type);
            if (ty.includes("table") || ty.includes("Table") || ty.includes("index") || ty.includes("Index")) {
              console.log(`    ${field.name}: ${ty.slice(0, 60)} ← potential uninitialized index`);
            } else {
              console.log(`    ${field.name}: ${ty.slice(0, 50)}`);
            }
          }
        }
      }
    }
  }
}

async function main() {
  await analyzeV2();
  await analyzeV3();
}

main().catch(console.error);
