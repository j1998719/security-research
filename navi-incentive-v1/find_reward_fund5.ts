import { SuiClient } from "@mysten/sui/client";
const client = new SuiClient({ url: "https://fullnode.mainnet.sui.io:443" });

const V1_PKG = "0xd899cf7d2b5db716bd2cf55599fb0d5ee38a3061e7b6bb6eebf73fa5bc4c81ca";
const INCENTIVE_V3 = "0x62982dad27fb10bb314b3384d5de8d2ac2d72ab2dbeae5d801dbdb9efa816c80";

async function main() {
  // The Rule struct has `id: UID` so Rules have their own IDs
  // But the BLUE_RULE_ID came from rule?.fields?.id?.id which could be the UID of an EMBEDDED object
  // In Move/Sui, objects embedded inside other objects (not shared/owned) have UIDs but aren't
  // accessible as standalone objects via getObject
  // Check if getObject works for the BLUE rule id
  const BLUE_RULE_ID = "0x48a9d53c9bac92d21754af7ead5cce6c528b11a329bc9b6d24198984c99614c9";
  const ruleObj = await client.getObject({ id: BLUE_RULE_ID, options: { showContent: true, showType: true } });
  console.log("BLUE Rule getObject result:", JSON.stringify(ruleObj).slice(0, 200));

  // If Rules are embedded, claim_reward_entry must access them through the parent Incentive object
  // The String parameter would be the Rule's address (key in the VecMap)
  // The claim_reward_entry: (Clock, Incentive, Storage, RewardFund, Vector<String>, Vector<Address>)
  //   Vector<String> = rule_ids (rule addresses as strings)
  //   Vector<Address> = users to claim for
  //   RewardFund = the fund to pay out from (SEPARATE object)

  // So RewardFund MUST be a standalone object. Let me check NAVI's recent transactions
  // to find transactions that called claim_reward_entry or create_reward_fund

  // Look for event-based approach: what events does claim_reward_entry emit?
  const eventType = `${V1_PKG}::incentive_v3::ClaimRewardEvent`;
  console.log("\n=== Querying ClaimRewardEvent events ===");
  try {
    const events = await client.queryEvents({
      query: { MoveEventType: eventType },
      limit: 3,
    });
    console.log(`Events found: ${events.data.length}`);
    for (const e of events.data) {
      console.log(`  tx=${e.id.txDigest.slice(0,20)} fields=${JSON.stringify(e.parsedJson ?? e.bcs ?? {}).slice(0, 200)}`);
    }
  } catch (e: any) {
    console.log("Event query error:", e.message?.slice(0, 80));
  }

  // Try different event types
  for (const evtName of ["RewardClaimed", "ClaimReward", "Claimed", "AddReward"]) {
    const evtType = `${V1_PKG}::incentive_v3::${evtName}`;
    try {
      const events = await client.queryEvents({ query: { MoveEventType: evtType }, limit: 2 });
      if (events.data.length > 0) {
        console.log(`\nFound events for ${evtName} (${events.data.length}):`);
        const e = events.data[0];
        console.log(`  tx=${e.id.txDigest.slice(0,20)}`);
        console.log(`  json=${JSON.stringify(e.parsedJson ?? {}).slice(0, 300)}`);
      }
    } catch {}
  }

  // Also check from PROTO_PKG
  for (const evtName of ["RewardClaimed", "ClaimReward", "Claimed", "AddReward"]) {
    const PROTO_PKG = "0xee0041239b89564ce870a7dec5ddc5d114367ab94a1137e90aa0633cb76518e0";
    const evtType = `${PROTO_PKG}::incentive_v3::${evtName}`;
    try {
      const events = await client.queryEvents({ query: { MoveEventType: evtType }, limit: 2 });
      if (events.data.length > 0) {
        console.log(`\nPROTO_PKG events for ${evtName} (${events.data.length}):`);
        const e = events.data[0];
        console.log(`  tx=${e.id.txDigest.slice(0,20)}`);
        console.log(`  json=${JSON.stringify(e.parsedJson ?? {}).slice(0, 300)}`);
      }
    } catch {}
  }
}
main().catch(console.error);
