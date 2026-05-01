import { SuiClient } from "@mysten/sui/client";
import { Transaction } from "@mysten/sui/transactions";

const client = new SuiClient({ url: "https://fullnode.mainnet.sui.io:443" });

const PKG = "0xa0eba10b173538c8fecca1dff298e488402cc9ff374f8a12ca7758eebe830b66";
const CONFIGS = "0x100412c65d766597eea5760016d729cbb7961d2b770b16a93d318dcc74e418bb";
const ATTACKER = "0x0000000000000000000000000000000000000000000000000000000000001337";

async function main() {
  console.log("=== Kriya set_pause_config dry-run (non-admin caller) ===\n");
  
  // Test 1: set_pause_config - try to pause all operations as non-admin
  try {
    const tx1 = new Transaction();
    tx1.moveCall({
      package: PKG,
      module: "spot_dex",
      function: "set_pause_config",
      arguments: [
        tx1.object(CONFIGS),
        tx1.pure.bool(false),  // disable swap
        tx1.pure.bool(false),  // disable deposit
        tx1.pure.bool(false),  // disable withdraw
      ]
    });
    
    const result1 = await client.devInspectTransactionBlock({
      sender: ATTACKER,
      transactionBlock: tx1,
    });
    
    console.log("set_pause_config status:", result1.effects.status);
    if (result1.error) console.log("Error:", result1.error);
    if (result1.events.length > 0) {
      console.log("Events:", result1.events.map(e => e.type.split("::").pop() + ": " + JSON.stringify(e.parsedJson).slice(0,100)));
    }
  } catch(e: any) {
    console.log("set_pause_config threw:", e.message?.slice(0, 200));
  }
  
  // Test 2: set_stable_fee_config - try to set fees to 0 as non-admin
  try {
    const tx2 = new Transaction();
    tx2.moveCall({
      package: PKG,
      module: "spot_dex",
      function: "set_stable_fee_config",
      arguments: [
        tx2.object(CONFIGS),
        tx2.pure.u64(0),   // protocol_fee = 0
        tx2.pure.u64(0),   // lp_fee = 0
      ]
    });
    
    const result2 = await client.devInspectTransactionBlock({
      sender: ATTACKER,
      transactionBlock: tx2,
    });
    
    console.log("\nset_stable_fee_config status:", result2.effects.status);
    if (result2.error) console.log("Error:", result2.error);
  } catch(e: any) {
    console.log("set_stable_fee_config threw:", e.message?.slice(0, 200));
  }

  // Test 3: set_uc_fee_config
  try {
    const tx3 = new Transaction();
    tx3.moveCall({
      package: PKG,
      module: "spot_dex",
      function: "set_uc_fee_config",
      arguments: [
        tx3.object(CONFIGS),
        tx3.pure.u64(10000),  // max fee
        tx3.pure.u64(10000),  // max fee
      ]
    });
    
    const result3 = await client.devInspectTransactionBlock({
      sender: ATTACKER,
      transactionBlock: tx3,
    });
    
    console.log("\nset_uc_fee_config status:", result3.effects.status);
    if (result3.error) console.log("Error:", result3.error);
  } catch(e: any) {
    console.log("set_uc_fee_config threw:", e.message?.slice(0, 200));
  }

  // Test 4: remove_whitelisted_address_config - try with admin addr
  try {
    const tx4 = new Transaction();
    tx4.moveCall({
      package: PKG,
      module: "spot_dex",
      function: "remove_whitelisted_address_config",
      arguments: [
        tx4.object(CONFIGS),
        tx4.pure.address("0x2b089053b2fa5c5f836902473c78f6b485583770698ace3433de96cdb41206f4"),  // try removing admin
      ]
    });
    
    const result4 = await client.devInspectTransactionBlock({
      sender: ATTACKER,
      transactionBlock: tx4,
    });
    
    console.log("\nremove_whitelisted_address_config status:", result4.effects.status);
    if (result4.error) console.log("Error:", result4.error);
  } catch(e: any) {
    console.log("remove_whitelisted_address_config threw:", e.message?.slice(0, 200));
  }
}

main().catch(console.error);
