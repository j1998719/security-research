/**
 * Deep check Scallop V1 (0xe87f1b2d...):
 * - Find Spool objects with current index
 * - Find RewardsPool objects with remaining rewards
 * - Check if new_spool_account initializes index=0 or current
 * - Examine recent V1 txs
 */
import { SuiClient } from "@mysten/sui/client";
import { Transaction } from "@mysten/sui/transactions";
const client = new SuiClient({ url: "https://fullnode.mainnet.sui.io:443" });

const V1_PKG = "0xe87f1b2d498106a2c61421cec75b7b5c5e348512b0dc263949a0e7a3c256571a";
const CLOCK = "0x0000000000000000000000000000000000000000000000000000000000000006";

async function main() {
  // 1. Find V1 Spool objects via CreateSpoolAccountEvent (spool_id field)
  console.log("=== Finding V1 Spool objects ===");
  const spoolIds = new Set<string>();
  const rewardsPoolIds = new Set<string>();

  // Query all user events to find spool IDs
  let cursor: any = null;
  let totalEvts = 0;
  for (let page = 0; page < 5; page++) {
    const evts = await client.queryEvents({
      query: { MoveEventModule: { package: V1_PKG, module: "user" } },
      limit: 50,
      order: "ascending",
      cursor,
    });
    totalEvts += evts.data.length;
    for (const e of evts.data) {
      const pj = e.parsedJson as any ?? {};
      if (pj.spool_id) spoolIds.add(pj.spool_id);
      if (pj.rewards_pool_id) rewardsPoolIds.add(pj.rewards_pool_id);
    }
    if (!evts.hasNextPage) break;
    cursor = evts.nextCursor;
  }
  
  // Also check admin events
  for (let page = 0; page < 3; page++) {
    const evts = await client.queryEvents({
      query: { MoveEventModule: { package: V1_PKG, module: "admin" } },
      limit: 50,
      order: "ascending",
      cursor: page === 0 ? null : undefined,
    });
    for (const e of evts.data) {
      const pj = e.parsedJson as any ?? {};
      if (pj.spool_id) spoolIds.add(pj.spool_id);
      if (pj.rewards_pool_id) rewardsPoolIds.add(pj.rewards_pool_id);
    }
    if (!evts.hasNextPage) break;
  }

  console.log(`Total user events scanned: ${totalEvts}`);
  console.log(`Unique spool IDs: ${spoolIds.size}`);
  console.log(`Unique rewards_pool IDs: ${rewardsPoolIds.size}`);

  // 2. Check each Spool's current index
  console.log("\n=== Spool current indices ===");
  for (const spoolId of spoolIds) {
    try {
      const obj = await client.getObject({ id: spoolId, options: { showContent: true } });
      const f = (obj.data?.content as any)?.fields ?? {};
      const idx = f.index ?? "?";
      const stakes = f.stakes ?? "?";
      const maxPt = f.max_distributed_point ?? "?";
      console.log(`  ${spoolId.slice(0,20)} index=${idx} stakes=${stakes} maxPt=${maxPt}`);
    } catch (e: any) {
      console.log(`  ${spoolId.slice(0,20)} ERROR: ${e.message?.slice(0,40)}`);
    }
  }

  // 3. Check each RewardsPool balance
  console.log("\n=== RewardsPool balances ===");
  for (const rpId of rewardsPoolIds) {
    try {
      const obj = await client.getObject({ id: rpId, options: { showContent: true, showType: true } });
      const f = (obj.data?.content as any)?.fields ?? {};
      const rewards = f.rewards?.fields?.value ?? JSON.stringify(f.rewards)?.slice(0, 50);
      const claimed = f.claimed_rewards ?? "?";
      console.log(`  ${rpId.slice(0,20)} rewards=${rewards} claimed=${claimed}`);
    } catch (e: any) {
      console.log(`  ${rpId.slice(0,20)} ERROR: ${e.message?.slice(0,40)}`);
    }
  }

  // 4. Examine recent V1 transactions
  console.log("\n=== Recent V1 TXs ===");
  const recentTxDigests = ["6HkXEkqoqex31MjG42tH", "AgSuZoLoKfDkVL1dwveb", "TktWC2F7LS1frtipHwwu"];
  for (const digest of recentTxDigests) {
    try {
      const tx = await client.getTransactionBlock({
        digest,
        options: { showInput: true, showEvents: true, showEffects: true },
      });
      const calls = (tx.transaction?.data?.transaction as any)?.transactions ?? [];
      const v1calls = calls.filter((c: any) => c.MoveCall?.package?.startsWith("0xe87f1b2d")).map((c: any) => `${c.MoveCall.module}::${c.MoveCall.function}`);
      const evts = (tx.events ?? []).map(e => e.type?.split("::").pop());
      const status = (tx.effects as any)?.status?.status;
      console.log(`  ${digest.slice(0,20)}: ${status} calls=[${v1calls.join(",")}] events=[${evts.join(",")}]`);
    } catch (e: any) {
      console.log(`  ${digest.slice(0,20)}: ERROR ${e.message?.slice(0,50)}`);
    }
  }

  // 5. Try dry-run: can we call new_spool_account + update_points in PTB?
  // First find a V1 Spool ID to use
  const firstSpoolId = Array.from(spoolIds)[0];
  if (firstSpoolId) {
    console.log(`\n=== Dry-run: new_spool_account on ${firstSpoolId.slice(0,20)} ===`);
    try {
      const tx = new Transaction();
      const acct = tx.moveCall({
        target: `${V1_PKG}::user::new_spool_account`,
        arguments: [
          tx.object(firstSpoolId),
          tx.object(CLOCK),
        ],
      });
      // Transfer the SpoolAccount to dummy address
      tx.transferObjects([acct], "0x0000000000000000000000000000000000000000000000000000000000001337");
      const result = await client.devInspectTransactionBlock({
        transactionBlock: tx,
        sender: "0x0000000000000000000000000000000000000000000000000000000000001337",
      });
      console.log(`new_spool_account status: ${result.effects.status.status}`);
      if (result.effects.status.error) {
        console.log(`error: ${result.effects.status.error?.slice(0, 100)}`);
      }
      // Check if SpoolAccount was created, and what its initial index is
      if (result.effects.status.status === "success") {
        console.log("✅ new_spool_account CALLABLE from PTB!");
        console.log("Created objects:", result.effects.created?.map(o => o.reference?.objectId?.slice(0,20)).join(", "));
      }
    } catch (e: any) {
      console.log(`dry-run error: ${e.message?.slice(0, 100)}`);
    }
  }
}
main().catch(console.error);
