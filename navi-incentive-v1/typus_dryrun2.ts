import { SuiClient } from "@mysten/sui/client";
import { Transaction } from "@mysten/sui/transactions";

const client = new SuiClient({ url: "https://fullnode.mainnet.sui.io:443" });

const TYPUS_HEDGE_PKG = "0x15f0d9c093179f38ec90b20ac336750f82921730c25fed63e951d37a1a542bf0";
const TYPUS_AUCTION_PKG = "0x601a9f900ee01f6458809a881bef6115cc65762e2bd1fa022ea6bb6111862268";

// Correct Version and vault objects
const VERSION_HEDGE = "0x536284c92af3fc5fba496164b42925132b9b9e4ed14f63109d19adc337daa3df";
const HEDGE_REGISTRY = "0x085a8f24fe508bf060cce14f7b3b9a534c7528cd50d903a4717d6d07233bd9d5";
const VERSION_AUCTION = "0xb4cbf40fbe91337ba7e3b6e5117af11751bc22cfa87704be3387e9afedb03e7a";
const AUCTION_OBJ = "0xd2487400b3b280a6902f74110d27fc6b00fe622b22acc199af28dc0ff43968cf";

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
    if (result.error) console.log(`Error: ${result.error.slice(0, 300)}`);
    if (result.events.length > 0) {
      console.log(`Events:`);
      for (const e of result.events) {
        console.log(`  ${e.type.split("::").pop()}: ${JSON.stringify(e.parsedJson).slice(0, 150)}`);
      }
    }
  } catch(e: any) {
    const msg = e.message ?? String(e);
    const abortMatch = msg.match(/MoveAbort.*?}, (\d+)\)/);
    const abortCode = abortMatch ? `abort_code=${abortMatch[1]}` : "no_abort";
    console.log(`Threw [${abortCode}]: ${msg.slice(0, 300)}`);
  }
}

async function main() {
  console.log("=== Typus Protocol dry-runs (attacker: non-authorized) ===\n");

  // Check Version authority contents
  for (const [label, vObj] of [["Hedge Version", VERSION_HEDGE], ["Auction Version", VERSION_AUCTION]]) {
    const obj = await client.getObject({ id: vObj, options: { showContent: true } });
    const fields = (obj.data?.content as any)?.fields ?? {};
    const auth = fields.authority?.fields?.contents ?? fields.authority ?? "?";
    console.log(`[${label}] authority: ${JSON.stringify(auth).slice(0, 200)}`);
  }

  // Test 1: typus_hedge::update_vault_config  
  await testCall("typus_hedge::update_vault_config (non-auth sender)", (tx) => {
    tx.moveCall({
      package: TYPUS_HEDGE_PKG,
      module: "typus_hedge",
      function: "update_vault_config",
      arguments: [
        tx.object(VERSION_HEDGE),
        tx.object(HEDGE_REGISTRY),
        tx.pure.u64(9999),
        tx.pure.string("malicious"),
        tx.pure.u64(9999),
      ]
    });
  });

  // Test 2: typus_hedge::update_hedge_ratio
  // Need to check exact params first
  const hedgeFns = await client.getNormalizedMoveModule({ 
    package: TYPUS_HEDGE_PKG, module: "typus_hedge" 
  });
  for (const [fn, finfo] of Object.entries(hedgeFns.exposedFunctions)) {
    if ((finfo as any).isEntry) {
      console.log(`\n  entry fn: ${fn}(${(finfo as any).parameters.length} params)`);
    }
  }

  // Test 3: auction::update_auction_config
  await testCall("auction::update_auction_config (non-auth sender)", (tx) => {
    tx.moveCall({
      package: TYPUS_AUCTION_PKG,
      module: "auction",
      function: "update_auction_config",
      arguments: [
        tx.object(VERSION_AUCTION),
        tx.object(AUCTION_OBJ),
        tx.pure.u64(0),   // min_bid
        tx.pure.u64(0),   // max_bid
        tx.pure.u64(0),   // min_size
        tx.pure.u64(0),   // increment
        tx.pure.u64(0),   // decay_speed
        tx.pure.u64(0),   // initial_price
        tx.pure.u64(0),   // final_price
        tx.pure.u64(0),   // fee_bp
        tx.pure.u64(0),   // start_ts
        tx.pure.u64(0),   // end_ts
        tx.pure.u64(0),   // max_deposit
        tx.pure.u64(0),   // min_deposit
      ]
    });
  });
}

main().catch(console.error);
