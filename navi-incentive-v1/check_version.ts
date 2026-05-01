import { SuiClient } from "@mysten/sui/client";
import { Transaction } from "@mysten/sui/transactions";

const client = new SuiClient({ url: "https://fullnode.mainnet.sui.io:443" });
const NAVI_MAIN_PKG = "0xee0041239b89564ce870a7dec5ddc5d114367ab94a1137e90aa0633cb76518e0";
const DUMMY = "0x0000000000000000000000000000000000000000000000000000000000001337";

async function main() {
  const tx = new Transaction();
  tx.setSender(DUMMY);
  
  const [ver] = tx.moveCall({
    target: `${NAVI_MAIN_PKG}::version::this_version`,
    typeArguments: [],
    arguments: [],
  });
  tx.transferObjects([ver], DUMMY);
  
  const r = await client.devInspectTransactionBlock({ transactionBlock: tx, sender: DUMMY });
  console.log("Status:", r.effects?.status?.status);
  console.log("Error:", r.effects?.status?.error ?? "none");
  
  // Check return values
  if (r.results?.[0]) {
    const ret = r.results[0].returnValues?.[0];
    if (ret) {
      const bytes = Buffer.from(ret[0]);
      const version = bytes.readBigUInt64LE(0);
      console.log("this_version() =", version.toString());
    }
  }
  
  // Also try next_version
  const tx2 = new Transaction();
  tx2.setSender(DUMMY);
  const INCENTIVE_V3 = "0x62982dad27fb10bb314b3384d5de8d2ac2d72ab2dbeae5d801dbdb9efa816c80";
  const [nv] = tx2.moveCall({
    target: `${NAVI_MAIN_PKG}::version::next_version`,
    typeArguments: [],
    arguments: [tx2.object(INCENTIVE_V3)],
  });
  tx2.transferObjects([nv], DUMMY);
  const r2 = await client.devInspectTransactionBlock({ transactionBlock: tx2, sender: DUMMY });
  console.log("\nnext_version status:", r2.effects?.status?.status);
  console.log("error:", r2.effects?.status?.error ?? "none");
}

main().catch(console.error);
