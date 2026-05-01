import { SuiClient } from "@mysten/sui/client";
import { Transaction } from "@mysten/sui/transactions";

const client = new SuiClient({ url: "https://fullnode.mainnet.sui.io:443" });
const DUMMY = "0x0000000000000000000000000000000000000000000000000000000000001337";
const SCALLOP_LATEST = "0xde5c09ad171544aa3724dc67216668c80e754860f419136a68d78504eb2e2805";
const SCALLOP_ORIG   = "0xefe8b36d5b2e43728cc323298626b83177803521d195cfb11e15b910e892fddf";

async function getErrorCode(pkg: string, fnName: string): Promise<number | null> {
  const tx = new Transaction();
  tx.setSender(DUMMY);
  tx.moveCall({ target: `${pkg}::error::${fnName}`, typeArguments: [], arguments: [] });
  const r = await client.devInspectTransactionBlock({ transactionBlock: tx, sender: DUMMY });
  const ret = r.results?.[0]?.returnValues?.[0];
  if (ret) return Number(Buffer.from(ret[0]).readBigUInt64LE(0));
  return null;
}

async function main() {
  console.log("=== All Scallop error codes ===\n");
  
  // Get ALL functions from error module
  const errMod = await client.getNormalizedMoveModule({ package: SCALLOP_LATEST, module: "error" });
  const allFns = Object.keys(errMod.exposedFunctions);
  console.log(`Total error functions: ${allFns.length}`);
  
  const codeMap: Record<number, string> = {};
  
  for (const fnName of allFns) {
    const code = await getErrorCode(SCALLOP_LATEST, fnName);
    if (code !== null) {
      codeMap[code] = fnName;
      if ([770, 1284, 1797].includes(code)) {
        console.log(`*** MATCH: ${fnName} = ${code} (0x${code.toString(16)})`);
      }
    }
  }
  
  // Print all codes sorted
  console.log("\nAll error codes:");
  for (const [code, name] of Object.entries(codeMap).sort((a, b) => parseInt(a[0]) - parseInt(b[0]))) {
    const isTarget = [770, 1284, 1797].includes(parseInt(code));
    console.log(`  ${isTarget ? ">>> " : "    "}${code}: ${name}`);
  }
}

main().catch(console.error);
