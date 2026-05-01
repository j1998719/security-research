import { SuiClient } from "@mysten/sui/client";
const client = new SuiClient({ url: "https://fullnode.mainnet.sui.io:443" });

const POOLS_TABLE = "0x0ebae351150474aa81540f08261bfd46ba0fc5fd598777711bb0b4a2b9ce3e21";

const POC_TARGETS = [
  { id: "0xc34b4cb0ce7efda72e6b218c540b05f5001c447310eb1fb800077b1798eadaa7", asset: 0, idx: 20 },
  { id: "0xd7c7adae7be521521ee7f4e01bb2af85cb02f2be7c7846cb41168789b1d76676", asset: 0, idx: 19 },
  { id: "0xae3be8be657d3084e67070ffb60840bdbba6618373044b2f8506b41dc5c3057c", asset: 1, idx: 20 },
];

async function main() {
  // Check PoC targets directly
  console.log("=== PoC IncentiveBal targets ===");
  for (const t of POC_TARGETS) {
    const obj = await client.getObject({ id: t.id, options: { showContent: true, showType: true } });
    if (obj.error) { console.log(`  ${t.id.slice(0,22)}: ERROR ${JSON.stringify(obj.error).slice(0,40)}`); continue; }
    const f = (obj.data?.content as any)?.fields ?? {};
    const bal = BigInt(f.balance ?? 0);
    const dist = BigInt(f.distributed_amount ?? 0);
    console.log(`  asset=${t.asset} idx=${t.idx}: balance=${Number(bal)/1e9} SUI distributed=${Number(dist)/1e9} SUI`);
  }

  // Check POOLS_TABLE dynamic fields to find ALL IncentiveBal IDs
  console.log("\n=== POOLS_TABLE content (asset 0) ===");
  try {
    const df = await client.getDynamicFieldObject({
      parentId: POOLS_TABLE,
      name: { type: "u8", value: "0" },
    });
    const f = (df.data?.content as any)?.fields ?? {};
    const poolValue = f.value?.fields ?? f;
    console.log("PoolInfo fields:", Object.keys(poolValue).join(", "));
    console.log("index_rewards count:", (poolValue.index_rewards ?? []).length);
    console.log("end_times count:", (poolValue.end_times ?? []).length);
    
    // Check if IncentiveBal IDs are stored here
    const incBals = poolValue.incentive_bals ?? poolValue.bals ?? poolValue.bal_ids ?? [];
    if (incBals.length > 0) {
      console.log("IncentiveBal IDs:", incBals.slice(0,5));
    }
    
    // Print first few index_rewards values
    const idxRewards = poolValue.index_rewards ?? [];
    console.log("First 5 index_rewards:", idxRewards.slice(0, 5));
    
    // Check if there's a 'bals' or similar field
    const allFields = JSON.stringify(poolValue);
    if (allFields.includes("c34b4c")) console.log("Found c34b4c reference in pool data!");
    console.log("Pool data (first 500 chars):", allFields.slice(0, 500));
  } catch (e: any) {
    console.log("Error:", e.message?.slice(0, 80));
  }

  // Also check the Incentive object's dynamic fields
  console.log("\n=== Incentive object dynamic fields ===");
  const INCENTIVE = "0xaaf735bf83ff564e1b219a0d644de894ef5bdc4b2250b126b2a46dd002331821";
  const incFields = await client.getDynamicFields({ parentId: INCENTIVE });
  console.log(`Dynamic fields: ${incFields.data.length}`);
  for (const f of incFields.data.slice(0, 5)) {
    console.log(`  type=${f.name.type} val=${JSON.stringify(f.name.value)} objType=${f.objectType?.slice(-30)} id=${f.objectId?.slice(0,22)}`);
  }
}
main().catch(console.error);
