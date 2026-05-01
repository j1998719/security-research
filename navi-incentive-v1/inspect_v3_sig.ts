import { SuiClient } from "@mysten/sui/client";
const client = new SuiClient({ url: "https://fullnode.mainnet.sui.io:443" });
const PROTO_PKG = "0xee0041239b89564ce870a7dec5ddc5d114367ab94a1137e90aa0633cb76518e0";
const INCENTIVE_V3 = "0x62982dad27fb10bb314b3384d5de8d2ac2d72ab2dbeae5d801dbdb9efa816c80";

async function main() {
  const fn = await client.getNormalizedMoveFunction({ package: PROTO_PKG, module: "incentive_v3", function: "claim_reward_entry" });
  console.log("=== claim_reward_entry ===");
  console.log("isEntry:", fn.isEntry, "typeParams:", fn.typeParameters?.length);
  for (let i = 0; i < fn.parameters.length; i++) {
    console.log(`  [${i}]`, JSON.stringify(fn.parameters[i]).slice(0, 200));
  }
  console.log("return:", JSON.stringify(fn.return).slice(0, 100));

  // Also get all entry functions in incentive_v3 module
  const mod = await client.getNormalizedMoveModulesByPackage({ package: PROTO_PKG });
  const v3mod = mod["incentive_v3"];
  if (v3mod) {
    console.log("\n=== All entry functions in incentive_v3 ===");
    for (const [name, func] of Object.entries(v3mod.exposedFunctions)) {
      if ((func as any).isEntry) {
        console.log(`  ${name}: ${(func as any).parameters?.length} params`);
      }
    }
  }

  const dfs = await client.getDynamicFields({ parentId: INCENTIVE_V3 });
  console.log("\n=== INCENTIVE_V3 dynamic fields ===");
  for (const df of dfs.data) {
    const obj = await client.getObject({ id: df.objectId, options: { showContent: true } });
    const t = (obj.data?.content as any)?.type ?? "";
    const f = JSON.stringify((obj.data?.content as any)?.fields ?? {}).slice(0, 200);
    console.log(`  type=...${t.slice(-60)}`);
    console.log(`  id=${df.objectId}`);
    console.log(`  fields=${f}\n`);
  }
}
main().catch(console.error);
