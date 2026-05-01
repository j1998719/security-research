/**
 * Check Scallop V2 spool remaining state post-exploit
 */
import { SuiClient } from "@mysten/sui/client";
import { Transaction } from "@mysten/sui/transactions";
const client = new SuiClient({ url: "https://fullnode.mainnet.sui.io:443" });

const SPOOL_V2 = "0xec1ac7f4d01c5bf178ff4e62e523e7df7721453d81d4904a42a0ffc2686c843d";
const SPOOL_V3 = "0x472fc7d4c3534a8ec8c2f5d7a557a43050eab057aaab853e8910968ddc84fc9f";
const DUMMY = "0x0000000000000000000000000000000000000000000000000000000000001337";

// From exploit TX events
const REWARDS_POOL_ID = "0x162250ef72b64ef15a69d65ebade04a15ddf3d78abbb9e91e1c97f22f3ac5965";
const SPOOL_ID = "0x4f0ba970d3c11db05c8f40c60f5c21d2cb3f5f2e0a32a65d7d0e89c93b5f3b8";

async function main() {
  // Check rewards pool remaining balance
  console.log("=== Scallop V2 Spool State (post-exploit) ===\n");

  const rp = await client.getObject({ id: REWARDS_POOL_ID, options: { showContent: true, showType: true } });
  if (rp.error) {
    console.log("rewards_pool_id error:", rp.error);
  } else {
    const t = rp.data?.type ?? "";
    const f = (rp.data?.content as any)?.fields ?? {};
    console.log("RewardsPool type:", t.slice(-60));
    console.log("RewardsPool fields:", JSON.stringify(f).slice(0, 300));
  }

  // Find all V2 spool/rewards objects by querying recent events
  console.log("\n=== V2 spool events (all time, newest first) ===");
  for (const modName of ["user", "spool_account", "rewards_pool", "spool"]) {
    try {
      const events = await client.queryEvents({
        query: { MoveEventModule: { package: SPOOL_V2, module: modName } },
        limit: 5,
        order: "descending",
      });
      if (events.data.length > 0) {
        console.log(`\n${modName} events (${events.data.length}):`);
        for (const e of events.data.slice(0, 3)) {
          console.log(`  ${e.type?.split("::").pop()} tx=${e.id.txDigest.slice(0,24)}`);
          const pj = JSON.stringify(e.parsedJson ?? {});
          if (pj.includes("reward") || pj.includes("pool") || pj.includes("amount")) {
            console.log(`  json=${pj.slice(0, 200)}`);
          }
        }
      }
    } catch {}
  }

  // Check if V2 spool module has version guard by looking at stake/update_points signature
  console.log("\n=== V2 user::stake signature ===");
  try {
    const fn = await client.getNormalizedMoveFunction({ package: SPOOL_V2, module: "user", function: "stake" });
    console.log("isEntry:", fn.isEntry);
    for (let i = 0; i < fn.parameters.length; i++) {
      const p = JSON.stringify(fn.parameters[i]);
      const name = p.match(/"name":"(\w+)"/)?.[1] ?? "?";
      const isMut = p.includes("MutableReference");
      console.log(`  [${i}] ${isMut?"&mut":"&"} ${name}`);
    }
  } catch (e: any) {
    console.log("Error:", e.message?.slice(0, 60));
  }

  // Check V2 update_points signature (this is where last_index = 0 vulnerability is)
  console.log("\n=== V2 user::update_points signature ===");
  try {
    const fn = await client.getNormalizedMoveFunction({ package: SPOOL_V2, module: "user", function: "update_points" });
    for (let i = 0; i < fn.parameters.length; i++) {
      const p = JSON.stringify(fn.parameters[i]);
      const name = p.match(/"name":"(\w+)"/)?.[1] ?? "?";
      const isMut = p.includes("MutableReference");
      console.log(`  [${i}] ${isMut?"&mut":"&"} ${name}: ${p.slice(0,80)}`);
    }
  } catch (e: any) {
    console.log("Error:", e.message?.slice(0, 60));
  }

  // Query recent txs to find all V2 spool-related objects
  console.log("\n=== Recent V2 activity txs ===");
  const recentTxs = await client.queryTransactionBlocks({
    filter: { MoveFunction: { package: SPOOL_V2, module: "user" } },
    options: { showInput: true },
    limit: 5,
    order: "descending",
  });
  console.log(`Recent V2 user module txs: ${recentTxs.data.length}`);
  if (recentTxs.data.length > 0) {
    for (const tx of recentTxs.data) {
      const calls = (tx.transaction?.data?.transaction as any)?.transactions ?? [];
      for (const c of calls) {
        if (c.MoveCall?.package?.includes("ec1ac7f4")) {
          console.log(`  ${tx.digest.slice(0,20)}: ${c.MoveCall.module}::${c.MoveCall.function}`);
        }
      }
    }
  } else {
    console.log("  No recent V2 activity found → V2 may be patched or abandoned");
  }

  // Also check version guard existence in V2
  console.log("\n=== V2 spool_account struct (check for version field) ===");
  try {
    const st = await client.getNormalizedMoveStruct({ package: SPOOL_V2, module: "spool_account", struct: "SpoolAccount" });
    console.log("SpoolAccount fields:");
    for (const f of st.fields) {
      console.log(`  ${f.name}: ${JSON.stringify(f.type).slice(0, 80)}`);
    }
  } catch (e: any) {
    console.log("Error:", e.message?.slice(0, 60));
  }
}
main().catch(console.error);
