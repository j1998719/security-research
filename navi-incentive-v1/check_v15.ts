import { SuiClient } from "@mysten/sui/client";
import { Transaction } from "@mysten/sui/transactions";

const client = new SuiClient({ url: "https://fullnode.mainnet.sui.io:443" });

const MID_PKG = "0x81c408448d0d57b3e371ea94de1d40bf852784d3e225de1e74acab3e8395c18f";
const PROTO_PKG = "0xee0041239b89564ce870a7dec5ddc5d114367ab94a1137e90aa0633cb76518e0";
const DUMMY = "0x0000000000000000000000000000000000000000000000000000000000001337";

const INCENTIVE_V3 = "0x62982dad27fb10bb314b3384d5de8d2ac2d72ab2dbeae5d801dbdb9efa816c80";
const INCENTIVE_V2 = "0xf87a8acb8b81d14307894d12595541a73f19933f88e1326d5be349c7a6f7559c";
const STORAGE    = "0xbb4e2f4b6205c2e2a2db47aeb4f830796ec7c005f88537ee775986639bc442fe";
const ORACLE_OBJ = "0x1568865ed9a0b5ec414220e8f79b3d04c77acc82358f6e5ae4635687392ffbef";
const CLOCK      = "0x0000000000000000000000000000000000000000000000000000000000000006";
const SUI_POOL   = "0x96df0fce3c471489f4debaaa762cf960b3d97820bd1f3f025ff8190730e958c5";

async function main() {
  console.log("=== Check MID_PKG version ===");
  
  // 1. Check constants::version in MID_PKG
  const tx1 = new Transaction();
  tx1.setSender(DUMMY);
  tx1.moveCall({ target: `${MID_PKG}::constants::version`, typeArguments: [], arguments: [] });
  const r1 = await client.devInspectTransactionBlock({ transactionBlock: tx1, sender: DUMMY });
  const vBytes = r1.results?.[0]?.returnValues?.[0];
  if (vBytes) {
    const v = Buffer.from(vBytes[0]).readBigUInt64LE(0);
    console.log("MID_PKG constants::version() =", v.toString());
  } else {
    console.log("Could not read MID_PKG version:", r1.effects?.status);
  }
  
  // 2. Check PROTO_PKG version (should be 14)
  const tx2 = new Transaction();
  tx2.setSender(DUMMY);
  tx2.moveCall({ target: `${PROTO_PKG}::constants::version`, typeArguments: [], arguments: [] });
  const r2 = await client.devInspectTransactionBlock({ transactionBlock: tx2, sender: DUMMY });
  const vBytes2 = r2.results?.[0]?.returnValues?.[0];
  if (vBytes2) {
    const v2 = Buffer.from(vBytes2[0]).readBigUInt64LE(0);
    console.log("PROTO_PKG constants::version() =", v2.toString());
  }
  
  // 3. Try entry_deposit(amount=0) with MID_PKG
  console.log("\n=== Zero deposit test with MID_PKG ===");
  const SUI_TYPE = "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI";
  
  const tx3 = new Transaction();
  tx3.setSender(DUMMY);
  const zeroCoin = tx3.splitCoins(tx3.gas, [0]);
  tx3.moveCall({
    target: `${MID_PKG}::incentive_v3::entry_deposit`,
    typeArguments: [SUI_TYPE],
    arguments: [
      tx3.object(CLOCK),
      tx3.object(ORACLE_OBJ),
      tx3.object(STORAGE),
      tx3.object(SUI_POOL),
      tx3.pure.u8(0),  // asset_id for SUI
      zeroCoin,
      tx3.pure.u64(0), // amount
      tx3.object(INCENTIVE_V3),
    ],
  });
  const r3 = await client.devInspectTransactionBlock({ transactionBlock: tx3, sender: DUMMY });
  console.log("entry_deposit(0) status:", r3.effects?.status?.status);
  if (r3.effects?.status?.error) {
    console.log("Error:", r3.effects.status.error);
  }
  
  // 4. Try entry_deposit(1 MIST) with MID_PKG  
  console.log("\n=== Dust deposit test with MID_PKG ===");
  const tx4 = new Transaction();
  tx4.setSender(DUMMY);
  const dustCoin = tx4.splitCoins(tx4.gas, [1]);
  tx4.moveCall({
    target: `${MID_PKG}::incentive_v3::entry_deposit`,
    typeArguments: [SUI_TYPE],
    arguments: [
      tx4.object(CLOCK),
      tx4.object(ORACLE_OBJ),
      tx4.object(STORAGE),
      tx4.object(SUI_POOL),
      tx4.pure.u8(0),
      dustCoin,
      tx4.pure.u64(1),
      tx4.object(INCENTIVE_V3),
    ],
  });
  const r4 = await client.devInspectTransactionBlock({ transactionBlock: tx4, sender: DUMMY });
  console.log("entry_deposit(1) status:", r4.effects?.status?.status);
  if (r4.effects?.status?.error) {
    console.log("Error:", r4.effects.status.error);
  }
}

main().catch(console.error);
