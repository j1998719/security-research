import { SuiClient } from "@mysten/sui/client";
const client = new SuiClient({ url: "https://fullnode.mainnet.sui.io:443" });

const NAVI_V1 = "0xd899cf7d2b5db716bd2cf55599fb0d5ee38a3061e7b6bb6eebf73fa5bc4c81ca";
const INCENTIVE_V3 = "0x62982dad27fb10bb314b3384d5de8d2ac2d72ab2dbeae5d801dbdb9efa816c80";
const NEW_BORROW_INCENTIVE = "0x74922703605ba0548a5522b4da4cdb1600c46ae1ed476e07e428f23484a4a4d";

async function main() {
  // 1. Check NAVI V1 incentive pools remaining balance
  console.log("=== NAVI V1 IncentiveV3 pools ===");
  const iv3 = await client.getObject({ id: INCENTIVE_V3, options: { showContent: true } });
  const pools = (iv3.data?.content as any)?.fields?.pools?.fields?.contents ?? [];
  console.log(`Total pools: ${pools.length}`);
  
  for (const pool of pools) {
    const key = String(pool?.fields?.key ?? "");
    const rules = pool?.fields?.value?.fields?.rules?.fields?.contents ?? [];
    for (const r of rules) {
      const ruleId = r?.fields?.key;
      const rf = r?.fields?.value?.fields ?? {};
      const rewardFundId = rf.reward_fund_id?.fields?.id ?? "no_id";
      const enable = rf.enable;
      const globalIdx = rf.global_index;
      const supplyAmt = rf.supply_amount;
      console.log(`Pool ${key.slice(0,30)} Rule ${ruleId?.slice(0,20)}: fund=${rewardFundId?.slice?.(0,20)} enabled=${enable} global_index=${globalIdx}`);
    }
  }

  // 2. Check new Scallop BorrowIncentive package
  console.log("\n=== NEW Scallop BorrowIncentive ===");
  try {
    const mods = await client.getNormalizedMoveModulesByPackage({ package: NEW_BORROW_INCENTIVE });
    console.log("Modules:", Object.keys(mods).join(", "));
    
    let hasVersionGuard = false;
    const rewardEntries: string[] = [];
    for (const [modName, modData] of Object.entries(mods)) {
      const structs = (modData as any).structs ?? {};
      for (const [_, sd] of Object.entries(structs)) {
        if (((sd as any).fields ?? []).some((f: any) => f.name === "version")) hasVersionGuard = true;
      }
      const fns = (modData as any).exposedFunctions ?? {};
      for (const [fnName, fnData] of Object.entries(fns)) {
        const isReward = ["claim", "reward", "harvest", "redeem", "stake", "update_points"].some(kw => fnName.toLowerCase().includes(kw));
        if (isReward && (fnData as any).isEntry) rewardEntries.push(`${modName}::${fnName}`);
      }
    }
    console.log(`Version guard: ${hasVersionGuard ? "YES" : "⚠️NO"}`);
    if (rewardEntries.length > 0) {
      console.log("Reward entry fns:", rewardEntries.join(", "));
    }
  } catch (e: any) { console.log("Error:", e.message?.slice(0, 80)); }
  
  // 3. Check base IncentivePools package
  const BASE_PKG = "0x41c0788f4ab64cf36dc882174f467634c033bf68c3c1b5ef9819507825eb510b";
  console.log("\n=== Base IncentivePools package ===");
  try {
    const mods = await client.getNormalizedMoveModulesByPackage({ package: BASE_PKG });
    console.log("Modules:", Object.keys(mods).join(", "));
    for (const [modName, modData] of Object.entries(mods)) {
      const fns = (modData as any).exposedFunctions ?? {};
      const entries = Object.entries(fns).filter(([_, f]) => (f as any).isEntry);
      if (entries.length > 0) console.log(`  ${modName} entries: ${entries.map(([n]) => n).join(", ")}`);
    }
  } catch (e: any) { console.log("Error:", e.message?.slice(0, 80)); }
}
main().catch(console.error);
