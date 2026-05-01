import { SuiClient } from "@mysten/sui/client";
import { Transaction } from "@mysten/sui/transactions";

const client = new SuiClient({ url: "https://fullnode.mainnet.sui.io:443" });
const CETUS_INTEGRATE = "0x996c4d9480708fb8b92aa7acf819fb0497b5ec8e65ba06601cae2fb6db3312c3";
const ATTACKER = "0x0000000000000000000000000000000000000000000000000000000000001337";
const GLOBAL_CONFIG = "0xdaa46292632c3c4d8f31f23ea0f9b36a28ff3677e9684980e4438403a67a3d8f";

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
  // Check GlobalConfig ACL
  const configObj = await client.getObject({ id: GLOBAL_CONFIG, options: { showContent: true } });
  const fields = (configObj.data?.content as any)?.fields ?? {};
  console.log(`GlobalConfig protocol_fee_rate: ${fields.protocol_fee_rate}`);
  console.log(`GlobalConfig package_version: ${fields.package_version}`);
  const acl = fields.acl;
  console.log(`ACL type: ${acl?.type ?? "?"}`);
  const aclFields = acl?.fields ?? acl;
  console.log(`ACL fields: ${JSON.stringify(aclFields).slice(0, 300)}`);

  // Test config_script::update_protocol_fee_rate
  await testCall("cetus::update_protocol_fee_rate (non-auth)", (tx) => {
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

  // Test config_script::add_fee_tier
  await testCall("cetus::add_fee_tier (non-auth)", (tx) => {
    tx.moveCall({
      package: CETUS_INTEGRATE,
      module: "config_script",
      function: "add_fee_tier",
      arguments: [
        tx.object(GLOBAL_CONFIG),
        tx.pure.u32(200),
        tx.pure.u64(200),
      ]
    });
  });

  // Test config_script::delete_fee_tier
  await testCall("cetus::delete_fee_tier (non-auth)", (tx) => {
    tx.moveCall({
      package: CETUS_INTEGRATE,
      module: "config_script",
      function: "delete_fee_tier",
      arguments: [
        tx.object(GLOBAL_CONFIG),
        tx.pure.u32(100),
      ]
    });
  });
}

main().catch(console.error);
