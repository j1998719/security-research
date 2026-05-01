import { SuiClient } from "@mysten/sui/client";
const client = new SuiClient({ url: "https://fullnode.mainnet.sui.io:443" });

const PKG = "0xc63072e7f5f4983a2efaf5bdba1480d5e7d74d57948e1c7cc436f8e22cbeb410";

async function main() {
  console.log("=== Scallop BorrowIncentive - Reward Pool Status ===\n");

  // 1. reward_pool module structs
  console.log("--- reward_pool structs ---");
  try {
    const mod = await client.getNormalizedMoveModule({ package: PKG, module: "reward_pool" });
    for (const [name, st] of Object.entries(mod.structs)) {
      console.log(`struct ${name}:`);
      for (const f of st.fields) {
        console.log(`  ${f.name}: ${JSON.stringify(f.type).slice(0,70)}`);
      }
    }
    console.log("\nreward_pool functions:");
    for (const [fnName, fn] of Object.entries(mod.exposedFunctions)) {
      const params = fn.parameters.map(p => JSON.stringify(p).match(/"name":"(\w+)"/)?.[1] ?? "?");
      console.log(`  ${fn.visibility} ${fn.isEntry ? "entry " : ""}${fnName}(${params.join(",")})`);
    }
  } catch (e: any) { console.log("Error:", e.message?.slice(0,80)); }

  // 2. incentive_pool module - IncentivePools struct (plural = container)
  console.log("\n--- incentive_pool: IncentivePools struct ---");
  try {
    const mod = await client.getNormalizedMoveModule({ package: PKG, module: "incentive_pool" });
    for (const [name, st] of Object.entries(mod.structs)) {
      if (name === "IncentivePools" || name === "IncentivePool") {
        console.log(`struct ${name} abilities:[${st.abilities.abilities.join(",")}]`);
        for (const f of st.fields) {
          console.log(`  ${f.name}: ${JSON.stringify(f.type).slice(0,80)}`);
        }
      }
    }
  } catch (e: any) { console.log("Error:", e.message?.slice(0,60)); }

  // 3. IncentivePool index value - what's the current global index?
  // Find objects
  console.log("\n--- Looking for IncentivePools/IncentiveAccounts objects ---");
  // They might be accessible via recent stake txs
  try {
    const txs = await client.queryTransactionBlocks({
      filter: { MoveFunction: { package: PKG, module: "user", function: "stake" } },
      limit: 1, order: "descending",
      options: { showInput: true },
    });
    if (txs.data.length > 0) {
      const txData = txs.data[0].transaction?.data?.transaction as any;
      const inputs = txData?.inputs ?? [];
      console.log(`Stake tx has ${inputs.length} inputs`);
      for (const inp of inputs.slice(0, 15)) {
        if (inp.objectId) {
          console.log(`  objId=${inp.objectId?.slice(0,24)} type=${inp.objectType?.slice(0,60) ?? "unknown"}`);
        }
      }
    }
  } catch (e: any) { console.log("Error:", e.message?.slice(0,60)); }

  // 4. Direct object fetch for known incentive-related object
  // From the 0x41c0788f... type reference, let me find actual objects
  console.log("\n--- Events from oldest (initialization) ---");
  try {
    const evts = await client.queryEvents({
      query: { MoveEventModule: { package: PKG, module: "admin" } },
      limit: 5, order: "ascending",
    });
    console.log(`admin events (oldest): ${evts.data.length}`);
    for (const e of evts.data) {
      const pj = e.parsedJson as any ?? {};
      console.log(`  ${e.type?.split("::").pop()}: ${JSON.stringify(pj).slice(0,150)}`);
    }
  } catch (e: any) { console.log("Error:", e.message?.slice(0,60)); }

  // 5. Count recent redeem transactions - is this actively used?
  console.log("\n--- Activity check ---");
  try {
    const stakeT = await client.queryTransactionBlocks({
      filter: { MoveFunction: { package: PKG, module: "user", function: "stake" } },
      limit: 5, order: "descending",
    });
    const updateT = await client.queryTransactionBlocks({
      filter: { MoveFunction: { package: PKG, module: "user", function: "update_points" } },
      limit: 5, order: "descending",
    });
    console.log(`Recent stake txs: ${stakeT.data.length}`);
    console.log(`Recent update_points txs: ${updateT.data.length}`);
    if (updateT.data.length > 0) {
      console.log(`Latest update_points: checkpoint ${updateT.data[0].checkpoint}`);
    }
  } catch (e: any) { console.log("Error:", e.message?.slice(0,60)); }

  // 6. Is this deprecated/inactive based on events?
  console.log("\n--- Protocol status assessment ---");
  try {
    const evts = await client.queryEvents({
      query: { MoveEventModule: { package: PKG, module: "user" } },
      limit: 10, order: "descending",
    });
    console.log(`Recent user events: ${evts.data.length}`);
    let zeroRewards = 0;
    let nonZeroRewards = 0;
    for (const e of evts.data) {
      const pj = e.parsedJson as any ?? {};
      if (pj.rewards === "0") zeroRewards++;
      else if (pj.rewards) nonZeroRewards++;
    }
    console.log(`Events with rewards=0: ${zeroRewards}, rewards>0: ${nonZeroRewards}`);
    if (zeroRewards > 0 && nonZeroRewards === 0) {
      console.log("⚠️  ALL recent reward events show rewards=0 → Pool likely empty/inactive");
    }
  } catch (e: any) { console.log("Error:", e.message?.slice(0,60)); }
}
main().catch(console.error);
