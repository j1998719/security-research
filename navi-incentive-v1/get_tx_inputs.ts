import { SuiClient } from "@mysten/sui/client";
const client = new SuiClient({ url: "https://fullnode.mainnet.sui.io:443" });

const V1_PKG = "0xd899cf7d2b5db716bd2cf55599fb0d5ee38a3061e7b6bb6eebf73fa5bc4c81ca";
const MID_PKG = "0x81c408448d0d57b3e371ea94de1d40bf852784d3e225de1e74acab3e8395c18f";

async function main() {
  const txDigests = ["GjXbovKAKt1kvvrVuKW2SDXo", "FE7S8h1SHBEki6M6JeZYtekD"];

  for (const digest of txDigests) {
    console.log(`\n=== TX ${digest} ===`);
    const tx = await client.getTransactionBlock({
      digest,
      options: { showInput: true, showObjectChanges: true, showEvents: true },
    });

    // Show all inputs
    const inputs = (tx.transaction?.data?.transaction as any)?.inputs ?? [];
    console.log(`Inputs (${inputs.length}):`);
    for (let i = 0; i < inputs.length; i++) {
      const inp = inputs[i];
      if (inp.type === "object") {
        const objId = inp.objectId ?? inp.Object?.SharedObject?.objectId ?? inp.Object?.ImmOrOwnedObject?.objectId;
        const owner = inp.Object?.SharedObject ? "shared" : "owned/imm";
        console.log(`  [${i}] ${owner} ${objId}`);
      } else {
        console.log(`  [${i}] pure: ${JSON.stringify(inp).slice(0, 60)}`);
      }
    }

    // Show Move calls
    const calls = (tx.transaction?.data?.transaction as any)?.transactions ?? [];
    console.log(`Move calls:`);
    for (const call of calls) {
      if (call.MoveCall) {
        console.log(`  target: ${call.MoveCall.target}`);
        console.log(`  args: ${JSON.stringify(call.MoveCall.arguments).slice(0, 200)}`);
      }
    }

    // Show object changes — find RewardFund
    const changes = tx.objectChanges ?? [];
    console.log(`Object changes:`);
    for (const c of changes) {
      const t = (c as any).objectType ?? "";
      if (t.includes("RewardFund") || t.includes("reward")) {
        console.log(`  ⭐ REWARD: ${c.type} ${(c as any).objectId} type=${t.slice(-50)}`);
      }
    }

    // Show events
    const events = tx.events ?? [];
    console.log(`Events:`);
    for (const e of events) {
      console.log(`  ${e.type?.split("::").pop()}: ${JSON.stringify(e.parsedJson ?? {}).slice(0, 200)}`);
    }
  }

  // Also get more RewardClaimed events to find patterns
  console.log("\n=== More RewardClaimed events (older) ===");
  const events = await client.queryEvents({
    query: { MoveEventModule: { package: MID_PKG, module: "incentive_v3" } },
    limit: 10,
    order: "descending",
  });
  const claimed = events.data.filter(e => e.type.includes("RewardClaimed"));
  console.log(`Found ${claimed.length} RewardClaimed events`);
  for (const e of claimed) {
    const pj = e.parsedJson as any ?? {};
    console.log(`  tx=${e.id.txDigest.slice(0,24)}`);
    console.log(`  coin=${String(pj.coin_type ?? "").split("::").pop()}`);
    console.log(`  user=${String(pj.user ?? "").slice(0,24)}`);
    console.log(`  claimed=${pj.total_claimed}`);
    console.log(`  rule_indices=${JSON.stringify(pj.rule_indices ?? []).slice(0, 80)}`);
    console.log();
  }
}
main().catch(console.error);
