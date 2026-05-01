import { SuiClient } from "@mysten/sui/client";
import { Transaction } from "@mysten/sui/transactions";

const client = new SuiClient({ url: "https://fullnode.mainnet.sui.io:443" });
const CETUS_INTEGRATE = "0x996c4d9480708fb8b92aa7acf819fb0497b5ec8e65ba06601cae2fb6db3312c3";
const CETUS_CLMM = "0x1eabed72c53feb3805120a081dc15963c204dc8d091542592abaf7a35689b2fb";
const ATTACKER = "0x0000000000000000000000000000000000000000000000000000000000001337";

// GlobalConfig from on-chain transaction
const GLOBAL_CONFIG = "0x89c1a321291d15ddae5a086c9abc533dff697fde3d89e0ca836c41af73e36a75";

async function testCall(label: string, buildTx: (tx: Transaction) => void) {
  console.log(`\n=== ${label} ===`);
  try {
    const tx = new Transaction();
    buildTx(tx);
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
}

async function main() {
  // Check GlobalConfig
  const configObj = await client.getObject({ id: GLOBAL_CONFIG, options: { showContent: true } });
  const fields = (configObj.data?.content as any)?.fields ?? {};
  console.log(`GlobalConfig fields:`);
  console.log(`  protocol_fee_rate: ${fields.protocol_fee_rate}`);
  console.log(`  package_version: ${fields.package_version}`);
  const acl = fields.acl?.fields?.permissions ?? "?";
  console.log(`  acl.permissions: ${JSON.stringify(acl).slice(0, 200)}`);

  // Test 1: config_script::update_protocol_fee_rate
  await testCall("cetus::config_script::update_protocol_fee_rate (non-auth)", (tx) => {
    tx.moveCall({
      package: CETUS_INTEGRATE,
      module: "config_script",
      function: "update_protocol_fee_rate",
      arguments: [
        tx.object(GLOBAL_CONFIG),
        tx.pure.u64(10000),
      ]
    });
  });

  // Test 2: config_script::add_fee_tier
  await testCall("cetus::config_script::add_fee_tier (non-auth)", (tx) => {
    tx.moveCall({
      package: CETUS_INTEGRATE,
      module: "config_script",
      function: "add_fee_tier",
      arguments: [
        tx.object(GLOBAL_CONFIG),
        tx.pure.u32(100),
        tx.pure.u64(500),
      ]
    });
  });

  // Test 3: config_script::update_fee_tier
  await testCall("cetus::config_script::update_fee_tier (non-auth)", (tx) => {
    tx.moveCall({
      package: CETUS_INTEGRATE,
      module: "config_script",
      function: "update_fee_tier",
      arguments: [
        tx.object(GLOBAL_CONFIG),
        tx.pure.u32(100),
        tx.pure.u64(9999),
      ]
    });
  });

  // Test 4: pool_script::update_fee_rate (on a specific pool)
  // Find a pool
  const poolEvts = await client.queryTransactionBlocks({
    filter: { MoveFunction: { package: CETUS_INTEGRATE, module: "pool_script", function: "update_fee_rate" } },
    options: { showInput: true },
    limit: 3,
    order: "descending"
  });
  console.log(`\nupdate_fee_rate txs: ${poolEvts.data.length}`);
  
  let poolId = "";
  for (const tx of poolEvts.data.slice(0, 1)) {
    const inp = (tx.transaction?.data?.transaction as any)?.inputs ?? [];
    for (let i = 0; i < inp.length; i++) {
      if (inp[i].type === "object") {
        const obj = await client.getObject({ id: inp[i].objectId, options: { showType: true } });
        const t = obj.data?.type ?? "";
        if (t.includes("::pool::Pool<")) {
          poolId = inp[i].objectId;
          console.log(`  Found Pool: ${poolId.slice(0, 24)}`);
        }
      }
    }
  }
  
  if (poolId) {
    const poolData = await client.getObject({ id: poolId, options: { showType: true } });
    const poolType = poolData.data?.type ?? "";
    const typeMatch = poolType.match(/Pool<(.+)>$/);
    if (typeMatch) {
      const typeArgs = typeMatch[1].split(", ").slice(0, 2);
      await testCall("cetus::pool_script::update_fee_rate (non-auth)", (tx) => {
        tx.moveCall({
          package: CETUS_INTEGRATE,
          module: "pool_script",
          function: "update_fee_rate",
          typeArguments: typeArgs,
          arguments: [
            tx.object(GLOBAL_CONFIG),
            tx.object(poolId),
            tx.pure.u64(10000),  // max fee
          ]
        });
      });
    }
  }
}

main().catch(console.error);
