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
const REAL_CLAIMER = "0x374e0ef6e83118c22735dbb34d6c762b7bf26197757b6918086bedb65310fab3";

function hexToBytes(hex: string): number[] {
  const bytes: number[] = [];
  for (let i = 0; i < hex.length; i += 2) bytes.push(parseInt(hex.slice(i, i + 2), 16));
  return bytes;
}

async function main() {
  // Check LATEST_PKG claim_reward_entry signature
  const fn = await client.getNormalizedMoveFunction({ package: LATEST_PKG, module: "incentive_v3", function: "claim_reward_entry" });
  console.log("=== LATEST_PKG claim_reward_entry ===");
  for (let i = 0; i < fn.parameters.length; i++) {
    const p = JSON.stringify(fn.parameters[i]);
    const name = p.match(/"name":"(\w+)"/)?.[1] ?? "?";
    const isMut = p.includes("MutableReference");
    const isvec = p.includes('"Vector"');
    const innerName = p.match(/"name":"(\w+)"/g)?.[1]?.replace('"name":"','').replace('"','') ?? name;
    console.log(`  [${i}] ${isMut ? "&mut" : "&"} ${name}${isvec ? " (Vector)" : ""} → ${p.slice(0,100)}`);
  }

  // Find recent real transactions that used LATEST_PKG::claim_reward_entry
  console.log("\n=== Recent claim_reward_entry txs with LATEST_PKG ===");
  const txs = await client.queryTransactionBlocks({
    filter: { MoveFunction: { package: LATEST_PKG, module: "incentive_v3", function: "claim_reward_entry" } },
    options: { showInput: true },
    limit: 3,
    order: "descending",
  });
  console.log(`Found: ${txs.data.length}`);
  if (txs.data.length > 0) {
    const tx = txs.data[0];
    const inputs = (tx.transaction?.data?.transaction as any)?.inputs ?? [];
    console.log(`Latest tx: ${tx.digest}`);
    for (let i = 0; i < inputs.length; i++) {
      console.log(`  [${i}]`, JSON.stringify(inputs[i]).slice(0, 150));
    }
  }

  // Try different arg encodings for claim_reward_entry
  // Attempt A: vector<String> = just the coin type strings with normalized format
  const certTypeNorm = "549e8b69270defbfafd4f94e17ec44cdbdd99820b33bda2278dea3b9a32d3f55::cert::CERT";
  const usdcTypeNorm = "dba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC";
  // cert::CERT without 0x prefix (as TypeName uses)
  console.log("\n=== Attempt A: normalized coin types (no 0x) ===");
  const tx = new Transaction();
  tx.setSender(REAL_CLAIMER);
  const coinTypesBcs = bcs.vector(bcs.string()).serialize([certTypeNorm, usdcTypeNorm]).toBytes();
  const ruleIdsBcs = bcs.vector(bcs.fixedArray(32, bcs.u8())).serialize([
    hexToBytes(CERT_RULE_1.slice(2).padStart(64, "0")),
    hexToBytes(CERT_RULE_2.slice(2).padStart(64, "0")),
  ]).toBytes();
  tx.moveCall({
    target: `${LATEST_PKG}::incentive_v3::claim_reward_entry`,
    typeArguments: [CERT_TYPE],
    arguments: [
      tx.object(CLOCK), tx.object(INCENTIVE_V3), tx.object(STORAGE), tx.object(REWARD_FUND_CERT),
      tx.pure(coinTypesBcs), tx.pure(ruleIdsBcs),
    ],
  });
  const r = await client.devInspectTransactionBlock({ transactionBlock: tx, sender: REAL_CLAIMER });
  const status = r.effects?.status?.status;
  const error = r.effects?.status?.error ?? "";
  console.log("Status:", status, error ? `error: ${error.slice(0, 150)}` : "");
  const fn2 = error.match(/function_name: Some\("([^"]+)"\)/)?.[1];
  const code = error.match(/}, (\d+)\)/)?.[1];
  if (fn2) console.log(`  aborted in ${fn2}() code=${code}`);
}
main().catch(console.error);
