import { SuiClient } from "@mysten/sui/client";
import { Transaction } from "@mysten/sui/transactions";
const client = new SuiClient({ url: "https://fullnode.mainnet.sui.io:443" });

const INCENTIVE_V3 = "0x62982dad27fb10bb314b3384d5de8d2ac2d72ab2dbeae5d801dbdb9efa816c80";
const PROTO_PKG = "0xee0041239b89564ce870a7dec5ddc5d114367ab94a1137e90aa0633cb76518e0";
const MID_PKG = "0x81c408448d0d57b3e371ea94de1d40bf852784d3e225de1e74acab3e8395c18f";
const CLOCK = "0x0000000000000000000000000000000000000000000000000000000000000006";
const STORAGE = "0xbb4e2f4b6205c2e2a2db47aeb4f830796ec7c005f88537ee775986639bc442fe";
const REWARD_FUND_CERT = "0x7093cf7549d5e5b35bfde2177223d1050f71655c7f676a5e610ee70eb4d93b5c";
const DUMMY = "0x0000000000000000000000000000000000000000000000000000000000001337";
const CERT_TYPE = "0x549e8b69270defbfafd4f94e17ec44cdbdd99820b33bda2278dea3b9a32d3f55::cert::CERT";

async function main() {
  // Check INCENTIVE_V3 current version
  const iv3 = await client.getObject({ id: INCENTIVE_V3, options: { showContent: true } });
  const version = (iv3.data?.content as any)?.fields?.version;
  console.log("INCENTIVE_V3.version:", version);

  // Call version() view function via devInspect to get the actual version
  const tx = new Transaction();
  tx.setSender(DUMMY);
  const [ver] = tx.moveCall({
    target: `${PROTO_PKG}::incentive_v3::version`,
    arguments: [tx.object(INCENTIVE_V3)],
  });
  tx.transferObjects([ver], tx.pure.address(DUMMY));

  const r = await client.devInspectTransactionBlock({ transactionBlock: tx, sender: DUMMY });
  console.log("version() call status:", r.effects?.status?.status);
  if (r.results?.[0]?.returnValues?.length) {
    console.log("version() return:", r.results[0].returnValues);
  }
  if (r.effects?.status?.error) {
    console.log("version() error:", r.effects.status.error.slice(0, 200));
  }

  // Try to find the NEWEST package by looking at recently published packages
  // that could be the true current version
  // Check if there are newer published txs from NAVI protocol
  const txs = await client.queryTransactionBlocks({
    filter: { MoveFunction: { package: PROTO_PKG, module: "incentive_v3", function: "version_migrate" } },
    limit: 3,
    order: "descending",
  });
  console.log("\nversion_migrate txs from PROTO_PKG:", txs.data.length);

  // Also check for version_migrate across all package versions
  for (const pkg of [MID_PKG, PROTO_PKG]) {
    const vmTxs = await client.queryTransactionBlocks({
      filter: { MoveFunction: { package: pkg, module: "incentive_v3", function: "version_migrate" } },
      limit: 2,
      order: "descending",
    });
    if (vmTxs.data.length > 0) {
      console.log(`\nversion_migrate from ${pkg.slice(0,16)}: ${vmTxs.data.length} txs`);
      const vtx = await client.getTransactionBlock({
        digest: vmTxs.data[0].digest,
        options: { showInput: true },
      });
      const inputs = (vtx.transaction?.data?.transaction as any)?.inputs ?? [];
      for (const i of inputs) {
        if (i.type === "pure") console.log("  pure input:", JSON.stringify(i).slice(0, 100));
      }
    }
  }

  // Find the actual latest NAVI package by querying recent transactions on INCENTIVE_V3
  // Check most recent transaction on INCENTIVE_V3 to see what package was used
  const recentTxs = await client.queryTransactionBlocks({
    filter: { InputObject: INCENTIVE_V3 },
    options: { showInput: true },
    limit: 3,
    order: "descending",
  });
  console.log("\nRecent txs using INCENTIVE_V3:", recentTxs.data.length);
  for (const rtx of recentTxs.data) {
    const calls = (rtx.transaction?.data?.transaction as any)?.transactions ?? [];
    for (const c of calls) {
      if (c.MoveCall) {
        console.log(`  ${c.MoveCall.package.slice(0,20)}::${c.MoveCall.module}::${c.MoveCall.function}`);
      }
    }
  }
}
main().catch(console.error);
