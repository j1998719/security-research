import { SuiClient } from "@mysten/sui/client";
import { Transaction } from "@mysten/sui/transactions";
const client = new SuiClient({ url: "https://fullnode.mainnet.sui.io:443" });

const PROTO_PKG = "0xee0041239b89564ce870a7dec5ddc5d114367ab94a1137e90aa0633cb76518e0";
const MID_PKG = "0x81c408448d0d57b3e371ea94de1d40bf852784d3e225de1e74acab3e8395c18f";
const INCENTIVE_V3 = "0x62982dad27fb10bb314b3384d5de8d2ac2d72ab2dbeae5d801dbdb9efa816c80";
const STORAGE = "0xbb4e2f4b6205c2e2a2db47aeb4f830796ec7c005f88537ee775986639bc442fe";
const CLOCK = "0x0000000000000000000000000000000000000000000000000000000000000006";
const REWARD_FUND_CERT = "0x7093cf7549d5e5b35bfde2177223d1050f71655c7f676a5e610ee70eb4d93b5c";
const DUMMY = "0x0000000000000000000000000000000000000000000000000000000000001337";
const NAVI_WHALE = "0x7861f12c652dbcf96589413cf5cbc5ebcccd85c2c9f09c25fee76f2a218195c9";

// Cert token type from the event
const CERT_TYPE = "0x549e8b69270defbfafd4f94e17ec44cdbdd99820b33bda2278dea3b9a32d3f55::cert::CERT";

async function main() {
  // Check RewardFund<CERT> object
  const rf = await client.getObject({
    id: REWARD_FUND_CERT,
    options: { showContent: true, showType: true, showOwner: true },
  });
  console.log("=== RewardFund<CERT> object ===");
  console.log("type:", rf.data?.type);
  console.log("owner:", JSON.stringify(rf.data?.owner).slice(0, 150));
  const rff = (rf.data?.content as any)?.fields ?? {};
  console.log("balance:", rff.balance);
  console.log("coin_type:", rff.coin_type);

  // Check if it's shared or owned
  const owner = rf.data?.owner;
  const isShared = owner && typeof owner === "object" && "Shared" in owner;
  const ownerAddr = typeof owner === "string" ? owner : (owner as any)?.AddressOwner;
  console.log("\nIs shared object?", isShared);
  console.log("Owner address:", ownerAddr);

  // The rule IDs passed were vector<address> as the FIFTH argument
  // From the tx: [5] = vector<address> (users), [4] = vector<string> (rule IDs)
  // Wait — the event shows rule_ids in the event json
  // Let's check the tx more carefully
  const tx = await client.getTransactionBlock({
    digest: "GjXbovKAKt1kvvrVuKW2SDXo4vuSXb2VRwigN986rMxp",
    options: { showInput: true, showEvents: true },
  });

  const inputs = (tx.transaction?.data?.transaction as any)?.inputs ?? [];
  console.log("\nAll tx inputs:");
  for (let i = 0; i < inputs.length; i++) {
    const inp = inputs[i];
    console.log(`  [${i}]`, JSON.stringify(inp).slice(0, 150));
  }

  // The key security question: if RewardFund is OWNED (not shared),
  // then only its owner can call claim_reward_entry with it.
  // This means the uninitialized user_index vulnerability is ONLY exploitable
  // if the attacker somehow gets a RewardFund, or if the NAVI team uses it.
  // The risk is: when NAVI admin calls claim_reward_entry with a funded RewardFund,
  // do they process users whose user_index = 0 (giving them full historical rewards)?

  // Let's check if version_verification exists and what it does
  // by testing a devInspect call with the RewardFund
  console.log("\n=== devInspect: claim_reward_entry with RewardFund ===");
  // Test: can a random address (DUMMY) call claim_reward_entry if they don't own RewardFund?
  // CERT pool rules: da416fe656205ece... and ae82946d6cae4d5e...
  const tx2 = new Transaction();
  tx2.setSender(DUMMY);
  tx2.moveCall({
    target: `${PROTO_PKG}::incentive_v3::claim_reward_entry`,
    typeArguments: [CERT_TYPE],
    arguments: [
      tx2.object(CLOCK),
      tx2.object(INCENTIVE_V3),
      tx2.object(STORAGE),
      tx2.object(REWARD_FUND_CERT),
      tx2.pure.vector("address", ["0xda416fe656205ece152240771fe58b301d0c9a0ae43817b7f0cc0faa2742a60e"]),
      tx2.pure.vector("address", [DUMMY]),
    ],
  });
  const r = await client.devInspectTransactionBlock({ transactionBlock: tx2, sender: DUMMY });
  const status = r.effects?.status?.status;
  const error = r.effects?.status?.error ?? "";
  console.log("Status:", status);
  if (error) {
    console.log("Error:", error.slice(0, 200));
    if (error.includes("version")) console.log("→ VERSION GUARD fires");
    if (error.includes("InvalidInputObject")) console.log("→ Cannot use owned object (confirms ownership restriction)");
  }
}
main().catch(console.error);
