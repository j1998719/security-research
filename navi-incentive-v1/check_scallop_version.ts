import { SuiClient } from "@mysten/sui/client";
import { Transaction } from "@mysten/sui/transactions";

const client = new SuiClient({ url: "https://fullnode.mainnet.sui.io:443" });
const SCALLOP = "0xefe8b36d5b2e43728cc323298626b83177803521d195cfb11e15b910e892fddf";
const DUMMY = "0x0000000000000000000000000000000000000000000000000000000000001337";
const VERSION_OBJ = "0x07871c4b3c847a0f674510d4978d5cf6f960452795e8ff6f189fd2088a3f6ac7";

async function main() {
  const tx = new Transaction();
  tx.setSender(DUMMY);
  
  // Call current_version::current_version() to get the expected version
  tx.moveCall({
    target: `${SCALLOP}::current_version::current_version`,
    typeArguments: [],
    arguments: [],
  });
  
  const r = await client.devInspectTransactionBlock({ transactionBlock: tx, sender: DUMMY });
  console.log("Status:", r.effects?.status?.status);
  if (r.results?.[0]?.returnValues?.[0]) {
    const bytes = Buffer.from(r.results[0].returnValues[0][0]);
    const ver = bytes.readBigUInt64LE(0);
    console.log("expected version:", ver.toString());
  }
  
  // Check Version object actual value
  const vObj = await client.getObject({ id: VERSION_OBJ, options: { showContent: true } });
  const f = (vObj.data?.content as any)?.fields ?? {};
  console.log("Version object value:", f.value);
}

main().catch(console.error);
