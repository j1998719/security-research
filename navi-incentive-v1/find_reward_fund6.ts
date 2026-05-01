import { SuiClient } from "@mysten/sui/client";
const client = new SuiClient({ url: "https://fullnode.mainnet.sui.io:443" });

const PROTO_PKG = "0xee0041239b89564ce870a7dec5ddc5d114367ab94a1137e90aa0633cb76518e0";
const V1_PKG = "0xd899cf7d2b5db716bd2cf55599fb0d5ee38a3061e7b6bb6eebf73fa5bc4c81ca";
const MID_PKG = "0x81c408448d0d57b3e371ea94de1d40bf852784d3e225de1e74acab3e8395c18f";
const INCENTIVE_V3 = "0x62982dad27fb10bb314b3384d5de8d2ac2d72ab2dbeae5d801dbdb9efa816c80";

async function main() {
  // Find transactions that called claim_reward or claim_reward_entry
  // by searching Move calls in transactions touching INCENTIVE_V3

  // Query recent transactions on INCENTIVE_V3 object
  console.log("=== Recent txs on INCENTIVE_V3 ===");
  try {
    const txs = await client.queryTransactionBlocks({
      filter: {
        InputObject: INCENTIVE_V3,
      },
      options: { showInput: true, showObjectChanges: true },
      limit: 5,
      order: "descending",
    });
    console.log(`Found ${txs.data.length} recent txs`);
    for (const tx of txs.data) {
      const digest = tx.digest;
      const calls = (tx.transaction?.data?.transaction as any)?.transactions ?? [];
      for (const call of calls) {
        const tgt = call.MoveCall?.target ?? "";
        if (tgt.includes("claim_reward") || tgt.includes("reward")) {
          console.log(`  tx=${digest.slice(0,20)} call=${tgt}`);
          // Get full tx to see all inputs
          const fullTx = await client.getTransactionBlock({
            digest,
            options: { showInput: true, showObjectChanges: true },
          });
          const inputs = (fullTx.transaction?.data?.transaction as any)?.inputs ?? [];
          const objInputs = inputs.filter((i: any) => i.objectId || i.Object);
          console.log(`  Object inputs: ${objInputs.map((i: any) => (i.objectId ?? i.Object?.ImmOrOwnedObject?.objectId ?? i.Object?.SharedObject?.objectId ?? "?").slice(0,20)).join(", ")}`);

          // Check object changes for new objects (RewardFund creation)
          const created = (fullTx.objectChanges ?? []).filter((c: any) => c.type === "created");
          for (const c of created) {
            console.log(`  Created: ${c.objectId?.slice(0,24)} type=${String((c as any).objectType).slice(-50)}`);
          }
        }
      }
    }
  } catch (e: any) {
    console.log("Error:", e.message?.slice(0, 100));
  }

  // Also try to find RewardFund by looking at what objects the known rules' AssetPools reference
  // The BLUE pool rule has global_index > 0, so rewards WERE computed
  // Let's look for transaction that called update_reward_state_by_asset or similar

  // Try to find all v3 claim-related txs via event types from all packages
  for (const pkg of [V1_PKG, MID_PKG, PROTO_PKG]) {
    for (const evt of ["RewardClaim", "ClaimReward", "RewardClaimed", "Reward", "UpdateReward"]) {
      try {
        const events = await client.queryEvents({
          query: { MoveEventModule: { package: pkg, module: "incentive_v3" } },
          limit: 3,
        });
        if (events.data.length > 0) {
          console.log(`\nEvents from ${pkg.slice(0,16)}::incentive_v3:`);
          for (const e of events.data.slice(0, 2)) {
            console.log(`  type=${e.type?.split("::").pop()} tx=${e.id.txDigest.slice(0,20)}`);
            console.log(`  json=${JSON.stringify(e.parsedJson ?? {}).slice(0, 200)}`);
          }
          break;
        }
      } catch {}
    }
  }

  // Try direct event module query
  for (const pkg of [V1_PKG, MID_PKG, PROTO_PKG]) {
    try {
      const events = await client.queryEvents({
        query: { MoveEventModule: { package: pkg, module: "incentive_v3" } },
        limit: 2,
        order: "descending",
      });
      if (events.data.length > 0) {
        console.log(`\nFound events from ${pkg.slice(0,20)}::incentive_v3 (${events.data.length}):`);
        for (const e of events.data) {
          console.log(`  type=${e.type}`);
          console.log(`  tx=${e.id.txDigest.slice(0,24)}`);
          const pj = e.parsedJson ?? {};
          console.log(`  json=${JSON.stringify(pj).slice(0, 300)}`);
        }
        break;
      }
    } catch (err: any) {
      console.log(`Error querying ${pkg.slice(0,16)}:`, err.message?.slice(0,60));
    }
  }
}
main().catch(console.error);
