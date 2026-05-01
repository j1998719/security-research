import { SuiClient } from "@mysten/sui/client";
const client = new SuiClient({ url: "https://fullnode.mainnet.sui.io:443" });

const OLD_PKG = "0xc63072e7f5f4983a2efaf5bdba1480d5e7d74d57948e1c7cc436f8e22cbeb410";

async function main() {
  // Get full details of the IncentivePool object
  const POOL_ID = "0x64972b713ccec45ec3964809e477cea6f97350c9012a2c6de05e19a6f35ccf14";
  const pool = await client.getObject({ id: POOL_ID, options: { showContent: true, showType: true } });
  console.log("Pool type:", pool.data?.type);
  console.log("Pool content:", JSON.stringify((pool.data?.content as any)?.fields ?? {}, null, 2).slice(0, 500));

  // Find IncentivePools and IncentiveAccounts shared objects from events
  const adminEvts = await client.queryEvents({
    query: { MoveEventModule: { package: OLD_PKG, module: "admin" } },
    limit: 10,
    order: "descending",
  });
  
  for (const e of adminEvts.data) {
    const pj = e.parsedJson as any ?? {};
    console.log(`\nEvent: ${e.type?.split("::").pop()}`);
    console.log(JSON.stringify(pj).slice(0, 300));
  }

  // Check full user::update_points parameter types
  console.log("\n=== user::update_points full params ===");
  const fn = await client.getNormalizedMoveFunction({ package: OLD_PKG, module: "user", function: "update_points" });
  for (let i = 0; i < fn.parameters.length; i++) {
    const p = JSON.stringify(fn.parameters[i]);
    console.log(`  [${i}] ${p.slice(0, 150)}`);
  }
  
  // Check user::stake full params
  console.log("\n=== user::stake full params ===");
  const fn2 = await client.getNormalizedMoveFunction({ package: OLD_PKG, module: "user", function: "stake" });
  for (let i = 0; i < fn2.parameters.length; i++) {
    const p = JSON.stringify(fn2.parameters[i]);
    console.log(`  [${i}] ${p.slice(0, 150)}`);
  }

  // Check if there's a new version of BorrowIncentive (current)
  console.log("\n=== Looking for current BorrowIncentive package ===");
  // Search for recent borrow incentive events
  const userEvts = await client.queryEvents({
    query: { MoveEventModule: { package: OLD_PKG, module: "user" } },
    limit: 5,
    order: "descending",
  });
  for (const e of userEvts.data) {
    const pj = e.parsedJson as any ?? {};
    console.log(`\n${e.type?.split("::").pop()} tx=${e.id.txDigest.slice(0,22)}`);
    console.log(JSON.stringify(pj).slice(0, 200));
  }
  
  // Check for current borrow incentive using query by tx
  if (userEvts.data.length > 0) {
    const digest = userEvts.data[0].id.txDigest;
    const tx = await client.getTransactionBlock({ digest, options: { showInput: true } });
    const calls = (tx.transaction?.data?.transaction as any)?.transactions ?? [];
    console.log(`\nCalls in recent tx ${digest.slice(0,20)}:`);
    for (const c of calls) {
      if (c.MoveCall) console.log(`  ${c.MoveCall.package.slice(0,22)}::${c.MoveCall.module}::${c.MoveCall.function}`);
    }
  }
}
main().catch(console.error);
