import { SuiClient } from "@mysten/sui/client";
const client = new SuiClient({ url: "https://fullnode.mainnet.sui.io:443" });

const NAVI_V1 = "0xd899cf7d2b5db716bd2cf55599fb0d5ee38a3061e7b6bb6eebf73fa5bc4c81ca";

async function main() {
  // Get all add_pool txs to find IncentiveBal IDs
  const txs = await client.queryTransactionBlocks({
    filter: { MoveFunction: { package: NAVI_V1, module: "incentive", function: "add_pool" } },
    options: { showObjectChanges: true },
    limit: 50,
    order: "ascending",
  });
  
  console.log(`add_pool txs: ${txs.data.length}`);
  
  const balIds: string[] = [];
  for (const tx of txs.data) {
    for (const c of (tx.objectChanges ?? []) as any[]) {
      if (c.type === "created" && (c.objectType ?? "").includes("IncentiveBal")) {
        balIds.push(c.objectId);
      }
    }
  }
  console.log(`IncentiveBal IDs: ${balIds.length}`);
  for (const id of balIds.slice(0,3)) console.log(`  ${id}`);
  
  // Check balances
  let totalMIST = 0n;
  for (const id of balIds.slice(0, 10)) {
    const obj = await client.getObject({ id, options: { showContent: true } });
    const f = (obj.data?.content as any)?.fields ?? {};
    console.log(`${id.slice(0,20)}... fields: ${JSON.stringify(f).slice(0,150)}`);
    const bal = BigInt(f.balance ?? 0);
    totalMIST += bal;
  }
  console.log(`\nTotal (first 10): ${Number(totalMIST)/1e9} SUI`);
}
main().catch(console.error);
