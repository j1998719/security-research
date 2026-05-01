import { SuiClient } from "@mysten/sui/client";
const client = new SuiClient({ url: "https://fullnode.mainnet.sui.io:443" });

const PROTO_PKG = "0xee0041239b89564ce870a7dec5ddc5d114367ab94a1137e90aa0633cb76518e0";
const MID_PKG = "0x81c408448d0d57b3e371ea94de1d40bf852784d3e225de1e74acab3e8395c18f";
const V1_PKG = "0xd899cf7d2b5db716bd2cf55599fb0d5ee38a3061e7b6bb6eebf73fa5bc4c81ca";
const INCENTIVE_V3 = "0x62982dad27fb10bb314b3384d5de8d2ac2d72ab2dbeae5d801dbdb9efa816c80";

async function main() {
  // List all functions in incentive_v3 that deal with RewardFund
  const mod = await client.getNormalizedMoveModulesByPackage({ package: PROTO_PKG });
  const v3 = mod["incentive_v3"];
  console.log("=== incentive_v3 all functions ===");
  for (const [name, func] of Object.entries(v3.exposedFunctions)) {
    const params = (func as any).parameters?.map((p: any) => {
      const s = JSON.stringify(p);
      return s.match(/"name":"(\w+)"/)?.[1] ?? s.slice(0, 30);
    }).join(", ");
    console.log(`  ${(func as any).isEntry ? "[entry]" : "      "} ${name}(${params})`);
  }

  // Check if Rule struct has reward_balance (not a separate RewardFund)
  try {
    const ruleStruct = await client.getNormalizedMoveStruct({ package: MID_PKG, module: "incentive_v3", struct: "Rule" });
    console.log("\n=== Rule struct fields ===");
    for (const f of ruleStruct.fields) {
      console.log(`  ${f.name}: ${JSON.stringify(f.type).slice(0, 120)}`);
    }
  } catch (e: any) {
    console.log("Rule (MID_PKG) error:", e.message?.slice(0,60));
  }

  // Check AssetPool struct
  try {
    const apStruct = await client.getNormalizedMoveStruct({ package: MID_PKG, module: "incentive_v3", struct: "AssetPool" });
    console.log("\n=== AssetPool struct fields ===");
    for (const f of apStruct.fields) {
      console.log(`  ${f.name}: ${JSON.stringify(f.type).slice(0, 120)}`);
    }
  } catch (e: any) {
    console.log("AssetPool (MID_PKG) error:", e.message?.slice(0,60));
  }

  // Look at actual Rule content from a pool that has rules
  // BLUE pool first rule: 0x48a9d53c...
  const BLUE_RULE_ADDR = "0x48a9d53c9bac92d21754af7ead5cce6c528b11a329bc9b6d24198984c99614c9";
  // Need to find the pool ID for BLUE
  const iv3Obj = await client.getObject({ id: INCENTIVE_V3, options: { showContent: true } });
  const pools = (iv3Obj.data?.content as any)?.fields?.pools?.fields?.contents ?? [];
  let bluePoolId = "";
  for (const p of pools) {
    const key = String(p?.fields?.key ?? "");
    if (key.includes("e1b45a0e641b9955a20aa0ad1c1f4ad86aad8afb07296d4085")) {
      const valId = p?.fields?.value?.fields?.id?.id ?? p?.fields?.value?.fields?.id;
      console.log("\nBLUE pool value:", JSON.stringify(p?.fields?.value).slice(0, 200));
      bluePoolId = String(p?.fields?.value?.fields?.id?.id ?? "");
      break;
    }
  }

  // Get the BLUE pool directly (it's inside the VecMap, not a separate object)
  // The AssetPool is embedded in the VecMap, not a standalone object
  // So Rule is also embedded inside AssetPool.rules VecMap
  // → Rule struct fields must include reward_balance inline

  // Let's get the full rule content from the BLUE pool
  const bluePool = pools.find((p: any) => String(p?.fields?.key ?? "").includes("e1b45a0e"));
  if (bluePool) {
    const rules = bluePool?.fields?.value?.fields?.rules?.fields?.contents ?? [];
    if (rules.length > 0) {
      const rule = rules[0]?.fields?.value?.fields ?? {};
      console.log("\n=== BLUE pool Rule[0] full fields ===");
      for (const [k, v] of Object.entries(rule)) {
        const vs = JSON.stringify(v).slice(0, 150);
        console.log(`  ${k}: ${vs}`);
      }
    }
  }
}
main().catch(console.error);
