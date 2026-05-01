/**
 * Scallop V2 post-exploit analysis:
 * - Check remaining reward pool balances
 * - Verify other attacker TXs
 * - Confirm V2 is still callable
 */
import { SuiClient } from "@mysten/sui/client";
import { Transaction } from "@mysten/sui/transactions";
const client = new SuiClient({ url: "https://fullnode.mainnet.sui.io:443" });

const SPOOL_V2 = "0xec1ac7f4d01c5bf178ff4e62e523e7df7721453d81d4904a42a0ffc2686c843d";
const SPOOL_V1 = "0xe87f1b2d498106a2c61421cec75b7b5c5e348512b0dc263949a0e7a3c256571a";
const DUMMY = "0x0000000000000000000000000000000000000000000000000000000000001337";
const CLOCK = "0x0000000000000000000000000000000000000000000000000000000000000006";

async function main() {
  // 1. Find all V2 spool objects with remaining rewards
  console.log("=== Finding V2 spool reward pool objects ===\n");

  // Find RewardsPool objects from V2 via events
  const redeemEvents = await client.queryEvents({
    query: { MoveEventModule: { package: SPOOL_V2, module: "user" } },
    limit: 50,
    order: "descending",
  });

  const rewardsPoolIds = new Set<string>();
  const spoolIds = new Set<string>();
  for (const e of redeemEvents.data) {
    const pj = e.parsedJson as any ?? {};
    if (pj.rewards_pool_id) rewardsPoolIds.add(pj.rewards_pool_id);
    if (pj.spool_id) spoolIds.add(pj.spool_id);
  }
  console.log(`Unique rewards_pool_ids found: ${rewardsPoolIds.size}`);
  console.log(`Unique spool_ids found: ${spoolIds.size}`);

  // Check each rewards pool balance
  console.log("\nRewards pool balances:");
  for (const poolId of rewardsPoolIds) {
    const obj = await client.getObject({ id: poolId, options: { showContent: true, showType: true } });
    if (obj.error) {
      console.log(`  ${poolId.slice(0,20)}... → DELETED`);
      continue;
    }
    const f = (obj.data?.content as any)?.fields ?? {};
    const bal = f.rewards?.fields?.value ?? f.balance ?? JSON.stringify(f.rewards).slice(0, 50);
    const t = obj.data?.type?.split("::").pop() ?? "?";
    console.log(`  ${poolId.slice(0,20)}... [${t}] balance=${bal}`);
  }

  // 2. Check the "other attacker" transactions
  console.log("\n=== Other transactions using V2 ===");
  const otherTxs = ["6zXFkPpM8aum9JoTA8C6", "8eARvXTwovAtG1smwxQJ", "7Sw5c9aRSbX7h5vRc6he", "AwSV3BMjFGq3WcZJBgq2"];
  for (const digest of otherTxs) {
    try {
      const tx = await client.getTransactionBlock({
        digest,
        options: { showInput: true, showEvents: true },
      });
      const calls = (tx.transaction?.data?.transaction as any)?.transactions ?? [];
      const v2calls = calls.filter((c: any) => c.MoveCall?.package?.includes("ec1ac7f4")).map((c: any) => c.MoveCall.function);
      const events = tx.events ?? [];
      const redeemEvt = events.find(e => e.type?.includes("RedeemRewards"));
      const rewards = redeemEvt ? (redeemEvt.parsedJson as any)?.rewards : "no_redeem_event";
      console.log(`  ${digest.slice(0,20)}: V2 calls=[${v2calls.join(",")}] rewards=${rewards}`);
    } catch (e: any) {
      console.log(`  ${digest.slice(0,20)}: ${e.message?.slice(0,40)}`);
    }
  }

  // 3. Try dry-run of V2 stake + update_points to see if still callable
  console.log("\n=== V2 callability test (devInspect) ===");

  // Find a V2 spool object to use in the call
  // From events, spool_id was in SpoolAccountStakeEvent
  const stakeEvents = await client.queryEvents({
    query: { MoveEventType: `${SPOOL_V2}::spool::SpoolCreatedEvent` },
    limit: 3,
  });
  console.log(`Spool created events: ${stakeEvents.data.length}`);
  for (const e of stakeEvents.data) {
    const pj = e.parsedJson as any ?? {};
    console.log(`  spool_id=${pj.spool_id?.slice(0, 30)}`);
  }

  // Get all V2 Spool objects from V1 events (Spool type is from V1 pkg)
  // Spool type: 0xe87f1b2d...::spool::Spool
  console.log("\nLooking for V2 Spool objects...");
  try {
    const resp = await (client as any).transport.request({
      method: "suix_queryObjects",
      params: [{ filter: { StructType: `${SPOOL_V1}::spool::Spool` } }, null, 5, false],
    });
    const objs = resp.data ?? [];
    console.log(`Found ${objs.length} Spool objects (V1 type)`);
    for (const o of objs.slice(0, 3)) {
      const f = o.data?.content?.fields ?? {};
      const version = f.version ?? "no_version";
      const currIndex = f.current_spool_index ?? "?";
      const totalStakes = f.total_stakes ?? "?";
      console.log(`  id=${o.data?.objectId?.slice(0,20)} version=${version} index=${currIndex} stakes=${totalStakes}`);
    }
  } catch (e: any) {
    console.log("Query error:", e.message?.slice(0, 80));
  }

  // 4. Check V3 version guard
  console.log("\n=== V3 spool struct (version field?) ===");
  try {
    const st = await client.getNormalizedMoveStruct({ package: SPOOL_V2, module: "spool", struct: "Spool" });
    console.log("Spool fields:");
    for (const f of st.fields) {
      console.log(`  ${f.name}: ${JSON.stringify(f.type).slice(0, 60)}`);
    }
  } catch (e: any) {
    console.log("Error:", e.message?.slice(0, 60));
  }
}
main().catch(console.error);
