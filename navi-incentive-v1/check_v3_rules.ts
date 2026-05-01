import { SuiClient } from "@mysten/sui/client";
import { Transaction } from "@mysten/sui/transactions";

const client = new SuiClient({ url: "https://fullnode.mainnet.sui.io:443" });
const PROTO_PKG    = "0xee0041239b89564ce870a7dec5ddc5d114367ab94a1137e90aa0633cb76518e0";
const INCENTIVE_V3 = "0x62982dad27fb10bb314b3384d5de8d2ac2d72ab2dbeae5d801dbdb9efa816c80";
const STORAGE      = "0xbb4e2f4b6205c2e2a2db47aeb4f830796ec7c005f88537ee775986639bc442fe";
const CLOCK        = "0x0000000000000000000000000000000000000000000000000000000000000006";
const DUMMY        = "0x0000000000000000000000000000000000000000000000000000000000001337";
const SUI_TYPE     = "0x2::sui::SUI";

// ─── Check v3 Rule struct (reward tracking) ──────────────────────────────────

async function checkV3Rules() {
  console.log("=== v3 Rule struct analysis ===\n");

  // Get AssetPool for SUI (first pool)
  const obj = await client.getObject({ id: INCENTIVE_V3, options: { showContent: true } });
  const pools = (obj.data?.content as any)?.fields?.pools?.fields?.contents ?? [];
  
  // Find SUI pool
  let suiPool: any = null;
  for (const p of pools) {
    const key = String(p?.fields?.key ?? "");
    if (key.includes("sui::SUI") || key.includes("0002::sui")) {
      suiPool = p;
      break;
    }
  }
  if (!suiPool && pools.length > 0) suiPool = pools[0];
  
  const poolId = suiPool?.fields?.value?.fields?.id?.id ?? suiPool?.fields?.value;
  console.log("Sample pool ID:", poolId);
  
  if (poolId && typeof poolId === "string") {
    // Get rules from pool
    const poolObj = await client.getObject({ id: poolId, options: { showContent: true } });
    const pf = (poolObj.data?.content as any)?.fields ?? {};
    const rulesId = pf.rules?.fields?.id?.id ?? pf.rules?.id?.id;
    console.log("Rules table ID:", rulesId);
    
    if (rulesId) {
      const ruleDFs = await client.getDynamicFields({ parentId: rulesId });
      console.log(`Rule count: ${ruleDFs.data.length}`);
      
      if (ruleDFs.data.length > 0) {
        const ruleObj = await client.getObject({ 
          id: ruleDFs.data[0].objectId, 
          options: { showContent: true, showType: true }
        });
        const rf = (ruleObj.data?.content as any)?.fields?.value?.fields ?? 
                   (ruleObj.data?.content as any)?.fields ?? {};
        console.log("\nRule struct fields:", Object.keys(rf));
        
        // Check for per-user index storage
        for (const [k, v] of Object.entries(rf)) {
          const vStr = JSON.stringify(v).slice(0, 80);
          if (vStr.includes("table") || vStr.includes("Table")) {
            console.log(`\n  TABLE field: ${k}`);
            const tid = (v as any)?.fields?.id?.id;
            if (tid) {
              const entries = await client.getDynamicFields({ parentId: tid });
              console.log(`  Entries count: ${entries.data.length}`);
              if (entries.data.length > 0) {
                const e = await client.getObject({ id: entries.data[0].objectId, options: { showContent: true } });
                console.log("  Sample entry:", JSON.stringify((e.data?.content as any)?.fields).slice(0, 150));
              }
            }
          } else {
            console.log(`  ${k}: ${vStr}`);
          }
        }
      }
    }
  }
}

// ─── Check v3 getNormalizedMoveModule for Rule struct ─────────────────────────

async function checkV3Structs() {
  console.log("\n=== v3 Rule struct (normalized) ===\n");
  const mod = await client.getNormalizedMoveModulesByPackage({ package: PROTO_PKG });
  const iv3 = mod?.incentive_v3;
  if (!iv3) { console.log("incentive_v3 not found"); return; }
  
  const rule = iv3.structs?.Rule ?? iv3.structs?.RewardRule ?? iv3.structs?.PoolRule;
  if (rule) {
    console.log("Rule fields:");
    for (const f of rule.fields) {
      const ty = JSON.stringify(f.type);
      const isTable = ty.includes("table") || ty.includes("Table");
      console.log(`  ${f.name}: ${ty.slice(0, 70)} ${isTable ? "← TABLE (per-user state?)" : ""}`);
    }
  }
  
  // Also check claim function
  const fns = iv3.exposedFunctions;
  const claimFns = Object.entries(fns).filter(([k]) => 
    k.includes("claim") || k.includes("reward")
  );
  console.log("\nClaim/reward functions:");
  for (const [k, v] of claimFns) {
    console.log(`  ${k}  entry=${v.isEntry}`);
  }
}

// ─── Check v2 old deployment IncentiveFundsPool balances ─────────────────────

async function checkV2OldFunds() {
  console.log("\n=== v2 old deployment IncentiveFundsPool balances ===\n");
  // From article: IncentiveFundsPool objects
  const OLD_V2_INCENTIVE = "0x952b6726bbcc08eb14f38a3632a3f98b823f301468d7de36f1d05faaef1bdd2a";
  const OLD_V2_PKG = "0xa49c5d1c8f0a9eaa4e1c0c461c2b5dfb6e88213876739e56db1afb3649a8af26";
  
  // Get pool_objs from old Incentive
  const iObj = await client.getObject({ id: OLD_V2_INCENTIVE, options: { showContent: true } });
  const f = (iObj.data?.content as any)?.fields ?? {};
  console.log("Old v2 Incentive version:", f.version);
  
  const fundsId = f.funds?.fields?.id?.id;
  const poolObjsId = f.pool_objs?.fields?.id?.id;
  console.log("funds table ID:", fundsId);
  console.log("pool_objs table ID:", poolObjsId);
  
  if (fundsId) {
    const dfs = await client.getDynamicFields({ parentId: fundsId });
    console.log(`\nFunds table entries: ${dfs.data.length}`);
    for (const df of dfs.data.slice(0, 5)) {
      const entry = await client.getObject({ id: df.objectId, options: { showContent: true } });
      const ef = (entry.data?.content as any)?.fields ?? {};
      const bal = ef.balance ?? ef.amount ?? ef.value;
      const coinType = df.name?.type ?? df.objectType ?? "";
      console.log(`  Entry: ${JSON.stringify(ef).slice(0, 100)}`);
    }
  }
  
  if (poolObjsId) {
    const dfs2 = await client.getDynamicFields({ parentId: poolObjsId });
    console.log(`\npool_objs entries: ${dfs2.data.length}`);
  }
  
  // Test if old v2 claim_reward is callable (check version guard with old incentive)
  console.log("\nTesting old v2 claim_reward version guard...");
  const tx = new Transaction();
  tx.setSender(DUMMY);
  tx.moveCall({
    target: `${OLD_V2_PKG}::incentive_v2::claim_reward`,
    typeArguments: [SUI_TYPE],
    arguments: [
      tx.object(CLOCK),
      tx.object(OLD_V2_INCENTIVE),
      tx.object("0x0000000000000000000000000000000000000000000000000000000000000002"),
      tx.object(STORAGE),
      tx.pure.u8(0),
      tx.pure.u8(0),
    ],
  });
  const r = await client.devInspectTransactionBlock({ transactionBlock: tx, sender: DUMMY }).catch((e: any) => ({ error: e.message }));
  const err = (r as any).effects?.status?.error ?? (r as any).error ?? "";
  console.log("Status:", (r as any).effects?.status?.status ?? "n/a");
  console.log("Error:", String(err).slice(0, 150));
}

async function main() {
  await checkV3Rules();
  await checkV3Structs();
  await checkV2OldFunds();
}
main().catch(console.error);
