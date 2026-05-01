import { SuiClient } from "@mysten/sui/client";
import { Transaction } from "@mysten/sui/transactions";
const client = new SuiClient({ url: "https://fullnode.mainnet.sui.io:443" });

const PKG = "0xc63072e7f5f4983a2efaf5bdba1480d5e7d74d57948e1c7cc436f8e22cbeb410";
const DUMMY = "0x0000000000000000000000000000000000000000000000000000000000001337";
const CLOCK = "0x0000000000000000000000000000000000000000000000000000000000000006";

async function main() {
  console.log("=== Scallop BorrowIncentive Deep Check ===\n");

  // 1. ALL functions in user module
  console.log("--- user module: ALL functions ---");
  try {
    const mod = await client.getNormalizedMoveModule({ package: PKG, module: "user" });
    for (const [fnName, fn] of Object.entries(mod.exposedFunctions)) {
      const params = fn.parameters.map(p => {
        const s = JSON.stringify(p);
        return (s.match(/"name":"(\w+)"/)?.[1] ?? s.slice(0,25)) + (s.includes("MutableReference") ? "*" : "");
      });
      console.log(`  ${fn.isEntry ? "entry" : fn.visibility} ${fnName}(${params.join(", ")})`);
    }
  } catch (e: any) { console.log("Error:", e.message?.slice(0,60)); }

  // 2. IncentiveState struct
  console.log("\n--- IncentiveState struct ---");
  try {
    const st = await client.getNormalizedMoveStruct({ package: PKG, module: "incentive_account", struct: "IncentiveState" });
    for (const f of st.fields) {
      console.log(`  ${f.name}: ${JSON.stringify(f.type).slice(0,60)}`);
    }
    console.log(`(abilities: [${st.abilities.abilities.join(",")}])`);
  } catch (e: any) { console.log("Error:", e.message?.slice(0,60)); }

  // 3. IncentivePool struct  
  console.log("\n--- IncentivePool struct ---");
  try {
    const st = await client.getNormalizedMoveStruct({ package: PKG, module: "incentive_pool", struct: "IncentivePool" });
    for (const f of st.fields) {
      console.log(`  ${f.name}: ${JSON.stringify(f.type).slice(0,70)}`);
    }
  } catch (e: any) { console.log("Error:", e.message?.slice(0,60)); }

  // 4. admin::add_rewards - does it really have NO admin cap?
  console.log("\n--- admin::add_rewards full signature ---");
  try {
    const fn = await client.getNormalizedMoveFunction({ package: PKG, module: "admin", function: "add_rewards" });
    console.log(`isEntry: ${fn.isEntry}, visibility: ${fn.visibility}`);
    for (let i = 0; i < fn.parameters.length; i++) {
      const p = JSON.stringify(fn.parameters[i]);
      const name = p.match(/"name":"(\w+)"/)?.[1] ?? p.slice(0,40);
      const addr = p.match(/"address":"([^"]+)"/)?.[1];
      const isMut = p.includes("MutableReference");
      console.log(`  [${i}]: ${isMut ? "&mut " : ""}${name} (${addr?.slice(0,16)})`);
    }
    console.log(`returns: ${JSON.stringify(fn.return).slice(0,60)}`);
  } catch (e: any) { console.log("Error:", e.message?.slice(0,60)); }

  // 5. incentive_account module - any create/new function?
  console.log("\n--- incentive_account: create/new functions ---");
  try {
    const mod = await client.getNormalizedMoveModule({ package: PKG, module: "incentive_account" });
    for (const [fnName, fn] of Object.entries(mod.exposedFunctions)) {
      if (/new|create|init|register/i.test(fnName)) {
        const params = fn.parameters.map(p => JSON.stringify(p).match(/"name":"(\w+)"/)?.[1] ?? "?");
        console.log(`  ${fn.visibility} ${fn.isEntry ? "entry " : ""}${fnName}(${params.join(",")})`);
      }
    }
  } catch (e: any) { console.log("Error:", e.message?.slice(0,60)); }

  // 6. Find IncentiveAccounts shared object
  console.log("\n--- IncentiveAccounts/IncentivePools objects ---");
  for (const [mod, struct] of [["incentive_account", "IncentiveAccounts"], ["incentive_pool", "IncentivePools"]]) {
    try {
      const resp = await (client as any).transport.request({
        method: "suix_queryObjects",
        params: [{ filter: { StructType: `${PKG}::${mod}::${struct}` } }, null, 2, true],
      });
      const objs = resp.data ?? [];
      console.log(`${struct}: ${objs.length} objects`);
      for (const o of objs.slice(0, 1)) {
        const f = o.data?.content?.fields ?? {};
        console.log(`  id=${o.data?.objectId?.slice(0,24)}`);
        console.log(`  fields: ${Object.keys(f).slice(0,6).join(",")}`);
      }
    } catch (e: any) { console.log(`${struct}: error ${e.message?.slice(0,40)}`); }
  }

  // 7. Recent transactions using this package
  console.log("\n--- Recent txs ---");
  try {
    const txs = await client.queryTransactionBlocks({
      filter: { MoveFunction: { package: PKG, module: "user" } },
      limit: 3, order: "descending",
    });
    console.log(`Recent user module txs: ${txs.data.length}`);
    for (const tx of txs.data) {
      console.log(`  ${tx.digest.slice(0,24)} @ cp ${tx.checkpoint}`);
    }
  } catch (e: any) { console.log("Error:", e.message?.slice(0,60)); }
}
main().catch(console.error);
