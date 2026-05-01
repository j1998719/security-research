import { SuiClient } from "@mysten/sui/client";
import { Transaction } from "@mysten/sui/transactions";
const client = new SuiClient({ url: "https://fullnode.mainnet.sui.io:443" });

const INCENTIVE_V3 = "0x62982dad27fb10bb314b3384d5de8d2ac2d72ab2dbeae5d801dbdb9efa816c80";
const DUMMY = "0x0000000000000000000000000000000000000000000000000000000000001337";

async function main() {
  // Get the INCENTIVE_V3 object and find its latest version/modification
  const iv3 = await client.getObject({
    id: INCENTIVE_V3,
    options: { showContent: true, showPreviousTransaction: true }
  });
  console.log("Previous tx digest:", iv3.data?.previousTransaction);
  console.log("Object version:", iv3.data?.version);

  // The previous tx that last modified INCENTIVE_V3 might give us the latest package
  const prevDigest = iv3.data?.previousTransaction;
  if (prevDigest) {
    const prevTx = await client.getTransactionBlock({
      digest: prevDigest,
      options: { showInput: true },
    });
    const calls = (prevTx.transaction?.data?.transaction as any)?.transactions ?? [];
    console.log("\nCalls in previous tx:");
    for (const c of calls) {
      if (c.MoveCall) {
        console.log(`  ${c.MoveCall.package}::${c.MoveCall.module}::${c.MoveCall.function}`);
      }
    }
  }

  // Try to get object history to find what packages are calling INCENTIVE_V3
  // Use RPC directly
  console.log("\n=== Querying recent transactions on INCENTIVE_V3 via RPC ===");
  try {
    const resp = await (client as any).transport.request({
      method: "suix_queryTransactionBlocks",
      params: [
        { filter: { ChangedObject: INCENTIVE_V3 }, options: { showInput: true } },
        null,
        5,
        true,
      ],
    });
    const txs = resp.data ?? [];
    console.log(`Found ${txs.length} txs that changed INCENTIVE_V3`);
    for (const tx of txs.slice(0, 5)) {
      const calls = tx.transaction?.data?.transaction?.transactions ?? [];
      for (const c of calls) {
        if (c.MoveCall) {
          console.log(`  pkg=${c.MoveCall.package.slice(0,20)} fn=${c.MoveCall.module}::${c.MoveCall.function}`);
        }
      }
    }
  } catch (e: any) {
    console.log("RPC error:", e.message?.slice(0, 100));
  }

  // Another approach: look at what module exposed the version_migrate function
  // and query any recent version_migrate calls
  // Alternatively: find NAVI's current package from their frontend config
  // by checking the INCENTIVE_V3 object's package ownership

  // The INCENTIVE_V3 object type is from MID_PKG (0x81c408448d...)
  // But the ACTUAL CURRENT package is what we need to call
  // MID_PKG's version module might define CURRENT_VERSION != 15
  // Let's test calling MID_PKG's claim_reward_entry - it failed with 1400
  // And PROTO_PKG's also fails with 1400
  // This means BOTH are OUTDATED packages

  // The latest package must be EVEN NEWER than PROTO_PKG
  // Let's find it by looking at recent NAVI transactions (entry_deposit etc.)
  console.log("\n=== Finding latest NAVI package via recent deposit txs ===");
  try {
    const depositTxs = await (client as any).transport.request({
      method: "suix_queryTransactionBlocks",
      params: [
        { filter: { ChangedObject: "0xbb4e2f4b6205c2e2a2db47aeb4f830796ec7c005f88537ee775986639bc442fe" } }, // STORAGE
        null, 3, true,
      ],
    });
    for (const tx of (depositTxs.data ?? []).slice(0, 3)) {
      const calls = tx.transaction?.data?.transaction?.transactions ?? [];
      for (const c of calls) {
        if (c.MoveCall && (c.MoveCall.function.includes("deposit") || c.MoveCall.function.includes("withdraw"))) {
          console.log(`  pkg=${c.MoveCall.package} fn=${c.MoveCall.function}`);
        }
      }
    }
  } catch (e: any) {
    console.log("Error:", e.message?.slice(0, 100));
  }
}
main().catch(console.error);
