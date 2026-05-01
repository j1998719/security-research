import { SuiClient } from "@mysten/sui/client";
const client = new SuiClient({ url: "https://fullnode.mainnet.sui.io:443" });
const MID_PKG = "0x81c408448d0d57b3e371ea94de1d40bf852784d3e225de1e74acab3e8395c18f";

async function main() {
  const events = await client.queryEvents({
    query: { MoveEventModule: { package: MID_PKG, module: "incentive_v3" } },
    limit: 5,
    order: "descending",
  });
  for (const e of events.data) {
    console.log("digest:", e.id.txDigest);
    console.log("type:", e.type.split("::").pop());
    console.log();
  }

  // Get full transaction for first RewardClaimed
  const claimed = events.data.find(e => e.type.includes("RewardClaimed"));
  if (claimed) {
    console.log("Getting tx:", claimed.id.txDigest);
    const tx = await client.getTransactionBlock({
      digest: claimed.id.txDigest,
      options: { showInput: true, showObjectChanges: true },
    });
    const inputs = (tx.transaction?.data?.transaction as any)?.inputs ?? [];
    console.log(`Inputs (${inputs.length}):`);
    for (let i = 0; i < inputs.length; i++) {
      const inp = inputs[i];
      if (inp.type === "object") {
        const objId = inp.objectId ?? inp.Object?.SharedObject?.objectId ?? inp.Object?.ImmOrOwnedObject?.objectId;
        const isShared = inp.Object?.SharedObject != null;
        console.log(`  [${i}] ${isShared ? "SHARED" : "owned "} ${objId}`);
      } else {
        console.log(`  [${i}] pure: ${JSON.stringify(inp).slice(0, 80)}`);
      }
    }

    const calls = (tx.transaction?.data?.transaction as any)?.transactions ?? [];
    for (const call of calls) {
      if (call.MoveCall?.target?.includes("claim_reward")) {
        console.log("\nclaim_reward call:", call.MoveCall.target);
        console.log("args:", JSON.stringify(call.MoveCall.arguments));
      }
    }
  }
}
main().catch(console.error);
