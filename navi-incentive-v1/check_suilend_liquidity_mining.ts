import { SuiClient } from "@mysten/sui/client";
import { Transaction } from "@mysten/sui/transactions";
const client = new SuiClient({ url: "https://fullnode.mainnet.sui.io:443" });

const PKG = "0xf95b06141ed4a174f239417323bde3f209b972f5930d8521ea38a52aff3a6ddf";
const DUMMY = "0x0000000000000000000000000000000000000000000000000000000000001337";
const CLOCK = "0x0000000000000000000000000000000000000000000000000000000000000006";

async function main() {
  console.log("=== Suilend liquidity_mining module ===\n");

  // 1. All structs in liquidity_mining
  console.log("--- liquidity_mining structs ---");
  try {
    const mod = await client.getNormalizedMoveModule({ package: PKG, module: "liquidity_mining" });
    for (const [name, st] of Object.entries(mod.structs)) {
      console.log(`\nstruct ${name} abilities:[${st.abilities.abilities.join(",")}]`);
      for (const f of st.fields) {
        console.log(`  ${f.name}: ${JSON.stringify(f.type).slice(0,70)}`);
      }
    }
  } catch (e: any) { console.log("Error:", e.message?.slice(0,60)); }

  // 2. new_user_reward_manager - what does it require?
  console.log("\n--- new_user_reward_manager ---");
  try {
    const fn = await client.getNormalizedMoveFunction({ package: PKG, module: "liquidity_mining", function: "new_user_reward_manager" });
    console.log(`visibility: ${fn.visibility}, isEntry: ${fn.isEntry}`);
    for (let i = 0; i < fn.parameters.length; i++) {
      const p = JSON.stringify(fn.parameters[i]);
      const name = p.match(/"name":"(\w+)"/)?.[1] ?? p.slice(0,40);
      const isMut = p.includes("MutableReference");
      console.log(`  param[${i}]: ${isMut ? "&mut " : ""}${name}`);
    }
    console.log(`returns: ${JSON.stringify(fn.return).slice(0,100)}`);
  } catch (e: any) { console.log("Error:", e.message?.slice(0,60)); }

  // 3. claim_rewards - what does it require?
  console.log("\n--- liquidity_mining::claim_rewards ---");
  try {
    const fn = await client.getNormalizedMoveFunction({ package: PKG, module: "liquidity_mining", function: "claim_rewards" });
    console.log(`visibility: ${fn.visibility}, isEntry: ${fn.isEntry}`);
    for (let i = 0; i < fn.parameters.length; i++) {
      const p = JSON.stringify(fn.parameters[i]);
      const name = p.match(/"name":"(\w+)"/)?.[1] ?? p.slice(0,60);
      const isMut = p.includes("MutableReference");
      console.log(`  param[${i}]: ${isMut ? "&mut " : ""}${name}`);
    }
    console.log(`returns: ${JSON.stringify(fn.return).slice(0,100)}`);
  } catch (e: any) { console.log("Error:", e.message?.slice(0,60)); }

  // 4. change_user_reward_manager_share
  console.log("\n--- change_user_reward_manager_share ---");
  try {
    const fn = await client.getNormalizedMoveFunction({ package: PKG, module: "liquidity_mining", function: "change_user_reward_manager_share" });
    console.log(`visibility: ${fn.visibility}, isEntry: ${fn.isEntry}`);
    for (let i = 0; i < fn.parameters.length; i++) {
      const p = JSON.stringify(fn.parameters[i]);
      const name = p.match(/"name":"(\w+)"/)?.[1] ?? p.slice(0,60);
      console.log(`  param[${i}]: ${name}`);
    }
  } catch (e: any) { console.log("Error:", e.message?.slice(0,60)); }

  // 5. Find PoolRewardManager objects to check current accumulated rewards
  console.log("\n--- PoolRewardManager objects ---");
  try {
    const resp = await (client as any).transport.request({
      method: "suix_queryObjects",
      params: [{ filter: { StructType: `${PKG}::liquidity_mining::PoolRewardManager` } }, null, 3, true],
    });
    const objs = resp.data ?? [];
    console.log(`PoolRewardManager objects: ${objs.length}`);
    for (const o of objs.slice(0, 2)) {
      const f = o.data?.content?.fields ?? {};
      const cumulative = f.cumulative_rewards_per_share ?? f.acc_per_share ?? "?";
      console.log(`  id=${o.data?.objectId?.slice(0,24)} cumulative=${JSON.stringify(cumulative).slice(0,60)}`);
    }
  } catch (e: any) { console.log("Error:", e.message?.slice(0,60)); }

  // 6. Dry-run: new_user_reward_manager then claim_rewards
  // This is the potential exploit path: create new UserRewardManager (index=0), then claim all historical
  console.log("\n--- Dry-run: new_user_reward_manager ---");
  try {
    // Find a PoolRewardManager to use
    const resp = await (client as any).transport.request({
      method: "suix_queryObjects",
      params: [{ filter: { StructType: `${PKG}::liquidity_mining::PoolRewardManager` } }, null, 1, true],
    });
    const objs = resp.data ?? [];
    if (objs.length === 0) {
      console.log("No PoolRewardManager found for dry-run");
      return;
    }
    
    const poolRewardManagerId = objs[0].data?.objectId;
    console.log(`Using PoolRewardManager: ${poolRewardManagerId?.slice(0,24)}`);
    
    const tx = new Transaction();
    const userRewardMgr = tx.moveCall({
      target: `${PKG}::liquidity_mining::new_user_reward_manager`,
      arguments: [tx.object(poolRewardManagerId!)],
    });
    
    const result = await client.devInspectTransactionBlock({
      transactionBlock: tx,
      sender: DUMMY,
    });
    console.log(`Status: ${result.effects.status.status}`);
    if (result.effects.status.error) {
      console.log(`Error: ${result.effects.status.error?.slice(0,200)}`);
    } else {
      console.log(`✅ new_user_reward_manager callable!`);
      const retVals = result.results?.[0]?.returnValues;
      console.log(`Returns: ${JSON.stringify(retVals?.map((r: any) => r[1])).slice(0,100)}`);
      
      // What are the initial values of the UserRewardManager?
      const mutated = result.effects.mutatedObjects ?? [];
      console.log(`mutatedObjects: ${mutated.length}`);
    }
  } catch (e: any) { console.log("Error:", e.message?.slice(0,80)); }
}
main().catch(console.error);
