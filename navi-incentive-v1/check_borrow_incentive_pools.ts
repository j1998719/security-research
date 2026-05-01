import { SuiClient } from "@mysten/sui/client";
const client = new SuiClient({ url: "https://fullnode.mainnet.sui.io:443" });

const OLD_PKG = "0xc63072e7f5f4983a2efaf5bdba1480d5e7d74d57948e1c7cc436f8e22cbeb410";

async function main() {
  // Find IncentivePool objects via events
  console.log("=== Finding IncentivePool objects ===");
  const createEvents = await client.queryEvents({
    query: { MoveEventModule: { package: OLD_PKG, module: "admin" } },
    limit: 20,
    order: "descending",
  });
  
  const poolIds = new Set<string>();
  const rewardPoolIds = new Set<string>();
  
  for (const e of createEvents.data) {
    const pj = e.parsedJson as any ?? {};
    if (pj.incentive_pool_id) poolIds.add(pj.incentive_pool_id);
    if (pj.reward_pool_id) rewardPoolIds.add(pj.reward_pool_id);
  }
  
  // Also check user events for pool IDs
  const userEvents = await client.queryEvents({
    query: { MoveEventModule: { package: OLD_PKG, module: "user" } },
    limit: 30,
    order: "descending",
  });
  for (const e of userEvents.data) {
    const pj = e.parsedJson as any ?? {};
    if (pj.incentive_pool_id) poolIds.add(pj.incentive_pool_id);
    if (pj.reward_pool_id) rewardPoolIds.add(pj.reward_pool_id);
    if (pj.incentive_account_id) {} // user account IDs
  }
  
  console.log(`Unique incentive pool IDs: ${poolIds.size}`);
  console.log(`Unique reward pool IDs: ${rewardPoolIds.size}`);
  
  // Check each incentive pool
  console.log("\n=== IncentivePool states ===");
  for (const pid of poolIds) {
    const obj = await client.getObject({ id: pid, options: { showContent: true, showType: true } });
    if (obj.error) { console.log(`  ${pid.slice(0,22)}: DELETED/ERROR`); continue; }
    const f = (obj.data?.content as any)?.fields ?? {};
    const t = obj.data?.type?.split("::").pop() ?? "?";
    console.log(`  ${pid.slice(0,22)} [${t}]:`);
    console.log(`    index=${f.index} stakes=${f.stakes} dist_point=${f.distributed_point} max_dist=${f.max_distributed_point}`);
  }
  
  // Check each reward pool  
  console.log("\n=== RewardPool balances ===");
  for (const rpid of rewardPoolIds) {
    const obj = await client.getObject({ id: rpid, options: { showContent: true, showType: true } });
    if (obj.error) { console.log(`  ${rpid.slice(0,22)}: DELETED/ERROR`); continue; }
    const f = (obj.data?.content as any)?.fields ?? {};
    const t = obj.data?.type?.split("::").pop() ?? "?";
    const bal = f.rewards?.fields?.value ?? f.balance ?? f.claimable_rewards?.fields?.value ?? JSON.stringify(f).slice(0,80);
    console.log(`  ${rpid.slice(0,22)} [${t}]: balance=${bal}`);
  }
  
  // Check user module entry function signatures
  console.log("\n=== user::stake signature ===");
  try {
    const fn = await client.getNormalizedMoveFunction({ package: OLD_PKG, module: "user", function: "stake" });
    console.log("isEntry:", fn.isEntry);
    for (let i = 0; i < fn.parameters.length; i++) {
      const p = JSON.stringify(fn.parameters[i]);
      const name = p.match(/"name":"(\w+)"/)?.[1] ?? p.slice(0, 80);
      const isMut = p.includes("MutableReference");
      console.log(`  [${i}] ${isMut?"&mut":"&"} ${name}`);
    }
  } catch (e: any) { console.log("Error:", e.message?.slice(0,60)); }
  
  console.log("\n=== user::update_points signature ===");
  try {
    const fn = await client.getNormalizedMoveFunction({ package: OLD_PKG, module: "user", function: "update_points" });
    console.log("isEntry:", fn.isEntry);
    for (let i = 0; i < fn.parameters.length; i++) {
      const p = JSON.stringify(fn.parameters[i]);
      const name = p.match(/"name":"(\w+)"/)?.[1] ?? p.slice(0, 80);
      console.log(`  [${i}] ${name}`);
    }
  } catch (e: any) { console.log("Error:", e.message?.slice(0,60)); }
}
main().catch(console.error);
