import { SuiClient } from "@mysten/sui/client";
const client = new SuiClient({ url: "https://fullnode.mainnet.sui.io:443" });

const NAVI_V1 = "0xd899cf7d2b5db716bd2cf55599fb0d5ee38a3061e7b6bb6eebf73fa5bc4c81ca";

async function main() {
  // Get ALL add_pool transactions
  let allTxs: any[] = [];
  let cursor: string | null | undefined = null;
  
  do {
    const resp = await client.queryTransactionBlocks({
      filter: { MoveFunction: { package: NAVI_V1, module: "incentive", function: "add_pool" } },
      options: { showObjectChanges: true },
      limit: 50,
      order: "ascending",
      cursor: cursor ?? undefined,
    });
    allTxs = allTxs.concat(resp.data);
    cursor = resp.nextCursor;
  } while (cursor);
  
  console.log(`Total add_pool txs: ${allTxs.length}`);
  
  // Collect all IncentiveBal IDs
  const balIds: string[] = [];
  for (const tx of allTxs) {
    for (const c of tx.objectChanges ?? []) {
      const ct = (c as any).objectType ?? "";
      if (ct.includes("IncentiveBal") || ct.match(/::incentive::Incent.*SUI/)) {
        const id = (c as any).objectId;
        if (id && (c as any).type === "created") {
          balIds.push(id);
        }
      }
    }
  }
  
  console.log(`\nIncentiveBal IDs found: ${balIds.length}`);
  
  // Check balances of each
  let totalSUI = 0n;
  const balsWithFunds: Array<{ id: string; balance: bigint; total: bigint }> = [];
  
  for (const id of balIds) {
    const obj = await client.getObject({ id, options: { showContent: true, showType: true } });
    if (obj.error) continue;
    const f = (obj.data?.content as any)?.fields ?? {};
    // Try various field names
    const bal = BigInt(f.balance ?? f.remaining ?? f.undistributed ?? "0");
    const tot = BigInt(f.total_supply ?? f.distributed_amount ?? f.total ?? "0");
    if (bal > 0n) {
      balsWithFunds.push({ id, balance: bal, total: tot });
      totalSUI += bal;
    }
    console.log(`  ${id.slice(0,26)} balance=${bal} total=${tot}`);
  }
  
  console.log(`\n=== SUMMARY ===`);
  console.log(`Total IncentiveBal objects: ${balIds.length}`);
  console.log(`Objects with balance > 0: ${balsWithFunds.length}`);
  console.log(`Total remaining SUI: ${totalSUI} MIST = ${Number(totalSUI)/1e9} SUI`);
}
main().catch(console.error);
