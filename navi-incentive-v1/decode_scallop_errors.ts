import { SuiClient } from "@mysten/sui/client";
import { Transaction } from "@mysten/sui/transactions";

const client = new SuiClient({ url: "https://fullnode.mainnet.sui.io:443" });
const DUMMY = "0x0000000000000000000000000000000000000000000000000000000000001337";

const SCALLOP_LATEST = "0xde5c09ad171544aa3724dc67216668c80e754860f419136a68d78504eb2e2805";
const SCALLOP_ORIG   = "0xefe8b36d5b2e43728cc323298626b83177803521d195cfb11e15b910e892fddf";

async function getErrorCode(pkg: string, modName: string, fnName: string): Promise<number | null> {
  const tx = new Transaction();
  tx.setSender(DUMMY);
  tx.moveCall({ target: `${pkg}::${modName}::${fnName}`, typeArguments: [], arguments: [] });
  const r = await client.devInspectTransactionBlock({ transactionBlock: tx, sender: DUMMY });
  const ret = r.results?.[0]?.returnValues?.[0];
  if (ret) {
    const bytes = Buffer.from(ret[0]);
    // Error codes are U64
    return Number(bytes.readBigUInt64LE(0));
  }
  return null;
}

async function main() {
  console.log("=== Scallop Error Code Decoder ===\n");
  
  // Get all error codes from both latest and orig
  const errorFns = [
    "borrow_too_small_error",
    "oracle_stale_price_error", 
    "oracle_price_not_found_error",
    "borrow_too_much_error",
    "borrow_limit_reached_error",
    "collateral_not_enough",
  ];
  
  for (const fnName of errorFns) {
    for (const [label, pkg] of [["ORIG", SCALLOP_ORIG], ["LATEST", SCALLOP_LATEST]]) {
      try {
        const code = await getErrorCode(pkg, "error", fnName);
        if (code !== null) {
          console.log(`${label} error::${fnName} = ${code} (0x${code.toString(16)})`);
        }
      } catch(e: any) {}
    }
  }
  
  // The key: abort 1284 in borrow_internal
  // If 1284 = borrow_too_small_error, then it's the zero check!
  // If 1284 = oracle_stale_price_error, then zero check either doesn't exist or comes after
  
  console.log("\n=== Target abort codes ===");
  console.log("abort 770  (no collateral)  = 0x302 → ?");
  console.log("abort 1284 (with collateral) = 0x504 → ?");
  console.log("abort 1797 (deposit 0)       = 0x705 → ZERO_AMOUNT in deposit_collateral");
}

main().catch(console.error);
