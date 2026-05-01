import { SuiClient } from "@mysten/sui/client";
import { Transaction } from "@mysten/sui/transactions";
import { bcs } from "@mysten/sui/bcs";

const client = new SuiClient({ url: "https://fullnode.mainnet.sui.io:443" });
const DUMMY    = "0x0000000000000000000000000000000000000000000000000000000000001337";
const NAVI_V15 = "0x1e4a13a0494d5facdbe8473e74127b838c2d446ecec0ce262e2eddafa77259cb";
const STORAGE  = "0xbb4e2f4b6205c2e2a2db47aeb4f830796ec7c005f88537ee775986639bc442fe";

function parseAbort(error: string) {
  const codeMatch = error.match(/MoveAbort\(.+?, (\d+)\)/);
  const modMatches = [...error.matchAll(/name: Identifier\("([^"]+)"\)/g)];
  const fnMatch = error.match(/function_name: Some\("([^"]+)"\)/);
  const code = codeMatch?.[1] ?? "?";
  const mods = modMatches.map(m => m[1]).join("::");
  const fn = fnMatch?.[1] ?? "?";
  return `abort ${code} @ ${mods}::${fn}`;
}

async function di(tx: Transaction, label: string) {
  const r = await client.devInspectTransactionBlock({ transactionBlock: tx, sender: DUMMY });
  const status = r.effects?.status?.status;
  const error = r.effects?.status?.error ?? "";
  const info = error ? parseAbort(error) : "ok";
  console.log(`[${label}] ${status} → ${info}`);
  if (error && !error.includes("MoveAbort")) console.log("  raw:", error.slice(0, 200));
  return { status, error };
}

async function main() {
  console.log("=== validate_deposit / validate_borrow zero checks ===\n");
  
  // The issue with U256: pure.u256(0n) might not work properly
  // Let's use bcs encoding for U256
  
  // validate_deposit(amount=0)
  {
    const tx = new Transaction();
    tx.setSender(DUMMY);
    // Pass U256 as raw bytes (little-endian 32 bytes, value=0)
    const zeroU256 = new Uint8Array(32); // all zeros = U256(0)
    tx.moveCall({
      target: `${NAVI_V15}::validation::validate_deposit`,
      typeArguments: [],
      arguments: [
        tx.object(STORAGE),
        tx.pure.u8(0),
        tx.pure(bcs.u256().serialize(0n).toBytes()),
      ],
    });
    await di(tx, "validate_deposit(storage, 0, amount=0)");
  }
  
  // validate_deposit(amount=1)
  {
    const tx = new Transaction();
    tx.setSender(DUMMY);
    tx.moveCall({
      target: `${NAVI_V15}::validation::validate_deposit`,
      typeArguments: [],
      arguments: [
        tx.object(STORAGE),
        tx.pure.u8(0),
        tx.pure(bcs.u256().serialize(1n).toBytes()),
      ],
    });
    await di(tx, "validate_deposit(storage, 0, amount=1)");
  }
  
  // validate_borrow(amount=0)
  {
    const tx = new Transaction();
    tx.setSender(DUMMY);
    tx.moveCall({
      target: `${NAVI_V15}::validation::validate_borrow`,
      typeArguments: [],
      arguments: [
        tx.object(STORAGE),
        tx.pure.u8(0),
        tx.pure(bcs.u256().serialize(0n).toBytes()),
      ],
    });
    await di(tx, "validate_borrow(storage, 0, amount=0)");
  }
  
  // validate_borrow(amount=1)
  {
    const tx = new Transaction();
    tx.setSender(DUMMY);
    tx.moveCall({
      target: `${NAVI_V15}::validation::validate_borrow`,
      typeArguments: [],
      arguments: [
        tx.object(STORAGE),
        tx.pure.u8(0),
        tx.pure(bcs.u256().serialize(1n).toBytes()),
      ],
    });
    await di(tx, "validate_borrow(storage, 0, amount=1)");
  }
}

main().catch(console.error);
