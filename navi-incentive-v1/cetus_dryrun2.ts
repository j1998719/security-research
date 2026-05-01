import { SuiClient } from "@mysten/sui/client";
import { Transaction } from "@mysten/sui/transactions";

const client = new SuiClient({ url: "https://fullnode.mainnet.sui.io:443" });
const CETUS_INTEGRATE = "0x996c4d9480708fb8b92aa7acf819fb0497b5ec8e65ba06601cae2fb6db3312c3";
const CETUS_CLMM = "0x1eabed72c53feb3805120a081dc15963c204dc8d091542592abaf7a35689b2fb";
const ATTACKER = "0x0000000000000000000000000000000000000000000000000000000000001337";

async function main() {
  // Find GlobalConfig from actual transactions
  const txs = await client.queryTransactionBlocks({
    filter: { MoveFunction: { package: CETUS_INTEGRATE, module: "config_script", function: "update_protocol_fee_rate" } },
    options: { showInput: true },
    limit: 3,
    order: "descending"
  });

  console.log(`update_protocol_fee_rate txs: ${txs.data.length}`);
  
  let globalConfigId = "";
  for (const tx of txs.data.slice(0, 1)) {
    const inp = (tx.transaction?.data?.transaction as any)?.inputs ?? [];
    for (let i = 0; i < inp.length; i++) {
      if (inp[i].type === "object") {
        const obj = await client.getObject({ id: inp[i].objectId, options: { showType: true } });
        const t = obj.data?.type ?? "";
        console.log(`  input[${i}] ${inp[i].objectId.slice(0, 24)} => ${t.slice(0, 80)}`);
        if (t.includes("GlobalConfig")) globalConfigId = inp[i].objectId;
      }
    }
  }

  // If not found from that function, try add_fee_tier
  if (!globalConfigId) {
    const txs2 = await client.queryTransactionBlocks({
      filter: { MoveFunction: { package: CETUS_INTEGRATE, module: "config_script", function: "add_fee_tier" } },
      options: { showInput: true },
      limit: 3,
      order: "descending"
    });
    console.log(`\nadd_fee_tier txs: ${txs2.data.length}`);
    for (const tx of txs2.data.slice(0, 1)) {
      const inp = (tx.transaction?.data?.transaction as any)?.inputs ?? [];
      for (let i = 0; i < inp.length; i++) {
        if (inp[i].type === "object") {
          const obj = await client.getObject({ id: inp[i].objectId, options: { showType: true } });
          const t = obj.data?.type ?? "";
          console.log(`  input[${i}] ${inp[i].objectId.slice(0, 24)} => ${t.slice(0, 80)}`);
          if (t.includes("GlobalConfig")) globalConfigId = inp[i].objectId;
        }
      }
    }
  }

  // Try querying general config_script txs
  if (!globalConfigId) {
    const txs3 = await client.queryTransactionBlocks({
      filter: { MoveFunction: { package: CETUS_INTEGRATE, module: "config_script" } },
      options: { showInput: true },
      limit: 5,
      order: "descending"
    });
    console.log(`\nconfig_script general txs: ${txs3.data.length}`);
    for (const tx of txs3.data.slice(0, 2)) {
      const inp = (tx.transaction?.data?.transaction as any)?.inputs ?? [];
      const txns = (tx.transaction?.data?.transaction as any)?.transactions ?? [];
      for (const t of txns.slice(0, 2)) {
        if (t.MoveCall) console.log(`  call: ${t.MoveCall.module}::${t.MoveCall.function}`);
      }
      for (let i = 0; i < inp.length; i++) {
        if (inp[i].type === "object") {
          const obj = await client.getObject({ id: inp[i].objectId, options: { showType: true } });
          const t = obj.data?.type ?? "";
          if (t.includes("GlobalConfig")) {
            console.log(`  FOUND GlobalConfig: ${inp[i].objectId}`);
            globalConfigId = inp[i].objectId;
          }
        }
      }
    }
  }

  console.log(`\nGlobalConfig: ${globalConfigId || "NOT FOUND"}`);
  if (!globalConfigId) return;

  // Check GlobalConfig structure
  const configObj = await client.getObject({ id: globalConfigId, options: { showContent: true } });
  const fields = (configObj.data?.content as any)?.fields ?? {};
  console.log(`\nGlobalConfig fields:`);
  for (const [k, v] of Object.entries(fields)) {
    if (typeof v === "object") {
      console.log(`  ${k}: ${JSON.stringify(v).slice(0, 100)}`);
    } else {
      console.log(`  ${k}: ${v}`);
    }
  }

  // Test update_protocol_fee_rate
  console.log("\n=== cetus::update_protocol_fee_rate (non-auth) ===");
  try {
    const tx = new Transaction();
    tx.moveCall({
      package: CETUS_INTEGRATE,
      module: "config_script",
      function: "update_protocol_fee_rate",
      arguments: [
        tx.object(globalConfigId),
        tx.pure.u64(10000),  // max fee rate
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
        console.log(`  Event: ${e.type.split("::").pop()}: ${JSON.stringify(e.parsedJson).slice(0, 200)}`);
      }
    }
  } catch(e: any) {
    const msg = e.message ?? String(e);
    const abortMatch = msg.match(/MoveAbort.*?}, (\d+)\)/);
    const abortCode = abortMatch ? `abort_code=${abortMatch[1]}` : "no_abort";
    console.log(`Threw [${abortCode}]: ${msg.slice(0, 400)}`);
  }

  // Test add_fee_tier
  console.log("\n=== cetus::add_fee_tier (non-auth) ===");
  try {
    const tx2 = new Transaction();
    tx2.moveCall({
      package: CETUS_INTEGRATE,
      module: "config_script",
      function: "add_fee_tier",
      arguments: [
        tx2.object(globalConfigId),
        tx2.pure.u32(100),  // tick_spacing
        tx2.pure.u64(500),  // fee_rate
      ]
    });
    
    const result2 = await client.devInspectTransactionBlock({
      sender: ATTACKER,
      transactionBlock: tx2,
    });
    
    console.log(`Status: ${JSON.stringify(result2.effects.status)}`);
    if (result2.error) console.log(`Error: ${result2.error.slice(0, 400)}`);
  } catch(e: any) {
    const msg = e.message ?? String(e);
    const abortMatch = msg.match(/MoveAbort.*?}, (\d+)\)/);
    console.log(`Threw [abort=${abortMatch?.[1] ?? "none"}]: ${msg.slice(0, 400)}`);
  }
}

main().catch(console.error);
