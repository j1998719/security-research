import { SuiClient } from "@mysten/sui/client";
import { Transaction } from "@mysten/sui/transactions";
const client = new SuiClient({ url: "https://fullnode.mainnet.sui.io:443" });

const PROTO_PKG = "0xee0041239b89564ce870a7dec5ddc5d114367ab94a1137e90aa0633cb76518e0";
const MID_PKG = "0x81c408448d0d57b3e371ea94de1d40bf852784d3e225de1e74acab3e8395c18f";
const DUMMY = "0x0000000000000000000000000000000000000000000000000000000000001337";
const NAVI_WHALE = "0x7861f12c652dbcf96589413cf5cbc5ebcccd85c2c9f09c25fee76f2a218195c9";

async function main() {
  // Get the FULL transaction to understand EXACTLY what was called
  const digest = "GjXbovKAKt1kvvrVuKW2SDXo4vuSXb2VRwigN986rMxp";
  const tx = await client.getTransactionBlock({
    digest,
    options: { showInput: true, showObjectChanges: true, showRawInput: true },
  });

  const data = tx.transaction?.data?.transaction as any;
  console.log("=== Transaction structure ===");
  console.log("# of Move calls:", data?.transactions?.length);
  for (const call of data?.transactions ?? []) {
    console.log("\nCall:", JSON.stringify(call).slice(0, 300));
  }

  console.log("\n=== Inputs ===");
  for (let i = 0; i < data?.inputs?.length; i++) {
    console.log(`[${i}]`, JSON.stringify(data.inputs[i]).slice(0, 150));
  }

  // Also get the FULL normalized signature for MID_PKG to see param names
  const fn = await client.getNormalizedMoveFunction({
    package: MID_PKG,
    module: "incentive_v3",
    function: "claim_reward_entry",
  });
  console.log("\n=== claim_reward_entry FULL params ===");
  console.log("typeParams:", fn.typeParameters?.length);
  for (let i = 0; i < fn.parameters.length; i++) {
    console.log(`[${i}]`, JSON.stringify(fn.parameters[i]));
  }
  console.log("return:", JSON.stringify(fn.return));

  // Now try a devInspect cloning the ACTUAL call structure
  const origInputs = data?.inputs ?? [];
  // The actual call args reference inputs by index
  const callData = data?.transactions?.[0];
  console.log("\n=== Cloning the exact call with DUMMY address ===");

  // Clone the call: change the sender/user to DUMMY but keep everything else
  // [4] = vector<string> of coin types (or rule id strings?)
  // [5] = vector<address> of rule IDs (or users?)
  // [6] = address (who to claim for or sender)
  const inp4 = origInputs[4];
  const inp5 = origInputs[5];
  const inp6 = origInputs[6];
  console.log("inp4 (vec<string>):", JSON.stringify(inp4).slice(0, 200));
  console.log("inp5 (vec<address>):", JSON.stringify(inp5).slice(0, 200));
  console.log("inp6 (address):", JSON.stringify(inp6).slice(0, 150));

  // Try the actual MID_PKG call (which was used in the real tx)
  const tx2 = new Transaction();
  tx2.setSender(DUMMY);

  // CERT type
  const CERT_TYPE = "0x549e8b69270defbfafd4f94e17ec44cdbdd99820b33bda2278dea3b9a32d3f55::cert::CERT";
  const REWARD_FUND = "0x7093cf7549d5e5b35bfde2177223d1050f71655c7f676a5e610ee70eb4d93b5c";
  const INCENTIVE_V3 = "0x62982dad27fb10bb314b3384d5de8d2ac2d72ab2dbeae5d801dbdb9efa816c80";
  const STORAGE = "0xbb4e2f4b6205c2e2a2db47aeb4f830796ec7c005f88537ee775986639bc442fe";
  const CLOCK = "0x0000000000000000000000000000000000000000000000000000000000000006";

  // Use MID_PKG (same as original tx)
  tx2.moveCall({
    target: `${MID_PKG}::incentive_v3::claim_reward_entry`,
    typeArguments: [CERT_TYPE],
    arguments: [
      tx2.object(CLOCK),
      tx2.object(INCENTIVE_V3),
      tx2.object(STORAGE),
      tx2.object(REWARD_FUND),
      tx2.pure(inp4.value, inp4.valueType),
      tx2.pure(inp5.value, inp5.valueType),
      tx2.pure.address(DUMMY),  // claim for DUMMY address
    ],
  });
  const r = await client.devInspectTransactionBlock({ transactionBlock: tx2, sender: DUMMY });
  const status = r.effects?.status?.status;
  const error = r.effects?.status?.error ?? "";
  console.log("\n=== devInspect result (DUMMY sender, claim for DUMMY) ===");
  console.log("Status:", status);
  if (status === "success") {
    console.log("✅ CALLABLE — checking return values:");
    const returns = r.results?.[0]?.returnValues ?? [];
    console.log("Returns:", returns.length);
    const events = r.events?.filter((e: any) => e.type.includes("RewardClaimed")) ?? [];
    if (events.length > 0) console.log("Events:", JSON.stringify(events[0].parsedJson).slice(0, 300));
  } else {
    console.log("Error:", error.slice(0, 200));
    const fnName = error.match(/function_name: Some\("([^"]+)"\)/)?.[1];
    const code = error.match(/}, (\d+)\)/)?.[1];
    if (fnName) console.log(`  Aborted in: ${fnName}() code=${code}`);
  }
}
main().catch(console.error);
