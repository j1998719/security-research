import { SuiClient } from "@mysten/sui/client";
import { Transaction } from "@mysten/sui/transactions";

const client = new SuiClient({ url: "https://fullnode.mainnet.sui.io:443" });
const NAVI_MAIN_PKG = "0xee0041239b89564ce870a7dec5ddc5d114367ab94a1137e90aa0633cb76518e0";
const DUMMY = "0x0000000000000000000000000000000000000000000000000000000000001337";

async function main() {
  const tx = new Transaction();
  tx.setSender(DUMMY);
  
  const [v] = tx.moveCall({
    target: `${NAVI_MAIN_PKG}::constants::version`,
    typeArguments: [],
    arguments: [],
  });
  
  const r = await client.devInspectTransactionBlock({ transactionBlock: tx, sender: DUMMY });
  console.log("Status:", r.effects?.status?.status);
  
  if (r.results?.[0]) {
    const ret = r.results[0].returnValues?.[0];
    if (ret) {
      const bytes = Buffer.from(ret[0]);
      const version = bytes.readBigUInt64LE(0);
      console.log("constants::version() =", version.toString());
    }
  }
  
  // Also check the Incentive V3 object version field
  const INCENTIVE_V3 = "0x62982dad27fb10bb314b3384d5de8d2ac2d72ab2dbeae5d801dbdb9efa816c80";
  const iv3 = await client.getObject({ id: INCENTIVE_V3, options: { showContent: true } });
  const f = (iv3.data?.content as any)?.fields ?? {};
  console.log("\nIncentive V3 object version:", f.version);
  console.log("Incentive V2 object version check...");
  
  const INCENTIVE_V2 = "0xf87a8acb8b81d14307894d12595541a73f19933f88e1326d5be349c7a6f7559c";
  const iv2 = await client.getObject({ id: INCENTIVE_V2, options: { showContent: true } });
  const f2 = (iv2.data?.content as any)?.fields ?? {};
  console.log("Incentive V2 version:", f2.version);
}

main().catch(console.error);
