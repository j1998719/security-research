import { SuiClient } from "@mysten/sui/client";
import { Transaction } from "@mysten/sui/transactions";

const client = new SuiClient({ url: "https://fullnode.mainnet.sui.io:443" });
const MID_PKG = "0x81c408448d0d57b3e371ea94de1d40bf852784d3e225de1e74acab3e8395c18f";
const DUMMY = "0x0000000000000000000000000000000000000000000000000000000000001337";

const STORAGE = "0xbb4e2f4b6205c2e2a2db47aeb4f830796ec7c005f88537ee775986639bc442fe";
const SUI_POOL = "0x96df0fce3c471489f4debaaa762cf960b3d97820bd1f3f025ff8190730e958c5";
const INCENTIVE_V2 = "0xf87a8acb8b81d14307894d12595541a73f19933f88e1326d5be349c7a6f7559c";
const INCENTIVE_V3 = "0x62982dad27fb10bb314b3384d5de8d2ac2d72ab2dbeae5d801dbdb9efa816c80";
const CLOCK = "0x0000000000000000000000000000000000000000000000000000000000000006";
const SUI_TYPE = "0x2::sui::SUI";

async function main() {
  // Check MID_PKG version
  const tx = new Transaction();
  tx.setSender(DUMMY);
  
  try {
    tx.moveCall({
      target: `${MID_PKG}::constants::version`,
      typeArguments: [],
      arguments: [],
    });
    
    const r = await client.devInspectTransactionBlock({ transactionBlock: tx, sender: DUMMY });
    if (r.results?.[0]?.returnValues?.[0]) {
      const bytes = Buffer.from(r.results[0].returnValues[0][0]);
      const version = bytes.readBigUInt64LE(0);
      console.log("MID_PKG constants::version() =", version.toString());
    }
  } catch (e: any) {
    console.log("constants::version failed:", e.message?.slice(0, 100));
  }
  
  // Also test entry_deposit with MID_PKG
  console.log("\n[Testing entry_deposit with MID_PKG]");
  const tx2 = new Transaction();
  tx2.setSender(DUMMY);
  
  const [zeroCoin] = tx2.splitCoins(tx2.gas, [tx2.pure.u64(0)]);
  
  tx2.moveCall({
    target: `${MID_PKG}::incentive_v3::entry_deposit`,
    typeArguments: [SUI_TYPE],
    arguments: [
      tx2.object(CLOCK),
      tx2.object(STORAGE),
      tx2.object(SUI_POOL),
      tx2.pure.u8(0),
      zeroCoin,
      tx2.pure.u64(0),
      tx2.object(INCENTIVE_V2),
      tx2.object(INCENTIVE_V3),
    ],
  });
  
  const r2 = await client.devInspectTransactionBlock({ transactionBlock: tx2, sender: DUMMY });
  const status2 = r2.effects?.status?.status;
  const error2 = r2.effects?.status?.error ?? "";
  console.log("  Result:", status2);
  console.log("  Error:", error2.slice(0, 300));
  
  if (status2 === "success") {
    console.log("  ← PASSES VERSION CHECK! (deposit 0 succeeded with MID_PKG)");
  } else {
    const code = error2.match(/MoveAbort.+?, (\d+)\)/)?.[1];
    if (code) console.log(`  Abort code: ${code} (0=amount check, 1400=version)`);
  }
}

main().catch(console.error);
