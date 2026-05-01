import { SuiClient } from "@mysten/sui/client";
import { Transaction } from "@mysten/sui/transactions";

const client = new SuiClient({ url: "https://fullnode.mainnet.sui.io:443" });
const DUMMY = "0x0000000000000000000000000000000000000000000000000000000000001337";
const NAVI_V15    = "0x1e4a13a0494d5facdbe8473e74127b838c2d446ecec0ce262e2eddafa77259cb";
const LOGIC_PKG   = "0xd899cf7d2b5db716bd2cf55599fb0d5ee38a3061e7b6bb6eebf73fa5bc4c81ca";
const STORAGE     = "0xbb4e2f4b6205c2e2a2db47aeb4f830796ec7c005f88537ee775986639bc442fe";
const ORACLE      = "0x1568865ed9a0b5ec414220e8f79b3d04c77acc82358f6e5ae4635687392ffbef";
const CLOCK       = "0x0000000000000000000000000000000000000000000000000000000000000006";

function parseAbort(error: string) {
  const codeMatch = error.match(/MoveAbort\(.+?, (\d+)\)/);
  const modMatch = error.match(/name: Identifier\("([^"]+)"\)/g);
  const fnMatch = error.match(/function_name: Some\("([^"]+)"\)/);
  const code = codeMatch?.[1] ?? "?";
  const mod = modMatch?.[0]?.match(/Identifier\("([^"]+)"\)/)?.[1] ?? "?";
  const fn = fnMatch?.[1] ?? "?";
  return `abort ${code} @ ${mod}::${fn}`;
}

async function di(tx: Transaction, label: string) {
  const r = await client.devInspectTransactionBlock({ transactionBlock: tx, sender: DUMMY });
  const status = r.effects?.status?.status;
  const error = r.effects?.status?.error ?? "";
  const info = error ? parseAbort(error) : "";
  console.log(`[${label}] ${status} → ${info || "ok"}`);
  return { status, error };
}

async function main() {
  console.log("=== Detailed Error Analysis for Zero-Amount ===\n");
  
  // 1. Direct validate_deposit(0) from V1 package
  {
    const tx = new Transaction();
    tx.setSender(DUMMY);
    tx.moveCall({
      target: `${LOGIC_PKG}::validation::validate_deposit`,
      typeArguments: [],
      arguments: [tx.object(STORAGE), tx.pure.u8(0), tx.pure.u256(0n)],
    });
    const r = await di(tx, "V1 validate_deposit(storage, 0, 0)");
    if (r.error) console.log("  raw:", r.error.slice(0, 250));
  }
  
  // 2. Direct validate_deposit(1) from V1 package
  {
    const tx = new Transaction();
    tx.setSender(DUMMY);
    tx.moveCall({
      target: `${LOGIC_PKG}::validation::validate_deposit`,
      typeArguments: [],
      arguments: [tx.object(STORAGE), tx.pure.u8(0), tx.pure.u256(1n)],
    });
    await di(tx, "V1 validate_deposit(storage, 0, 1)");
  }
  
  // 3. Direct validate_borrow(0) from V1 package
  {
    const tx = new Transaction();
    tx.setSender(DUMMY);
    tx.moveCall({
      target: `${LOGIC_PKG}::validation::validate_borrow`,
      typeArguments: [],
      arguments: [tx.object(STORAGE), tx.pure.u8(0), tx.pure.u256(0n)],
    });
    const r = await di(tx, "V1 validate_borrow(storage, 0, 0)");
    if (r.error) console.log("  raw:", r.error.slice(0, 250));
  }
  
  // 4. Direct validate_borrow(1) from V1 package
  {
    const tx = new Transaction();
    tx.setSender(DUMMY);
    tx.moveCall({
      target: `${LOGIC_PKG}::validation::validate_borrow`,
      typeArguments: [],
      arguments: [tx.object(STORAGE), tx.pure.u8(0), tx.pure.u256(1n)],
    });
    await di(tx, "V1 validate_borrow(storage, 0, 1)");
  }
  
  // 5. Check utils::split_coin with amount=0 — abort 46000
  // utils::split_coin is in v15, not v1
  // abort 46000 = let's decode it
  // NAVI typically uses constants like: AMOUNT_IS_ZERO = 46000
  console.log("\n=== Abort code semantics ===");
  console.log("abort 46000 @ utils::split_coin → likely AMOUNT_IS_ZERO or EINVALID_AMOUNT");
  console.log("abort 1503 @ validation::validate_borrow → 1500 + 3 = validate_borrow error #3");
  console.log("abort 1603 @ logic::execute_borrow → 1600 + 3 = execute_borrow error #3 (likely: insufficient_liquidity or no_collateral)");
  
  // 6. Now check v15 validate_deposit directly
  {
    const tx = new Transaction();
    tx.setSender(DUMMY);
    tx.moveCall({
      target: `${NAVI_V15}::validation::validate_deposit`,
      typeArguments: [],
      arguments: [tx.object(STORAGE), tx.pure.u8(0), tx.pure.u256(0n)],
    });
    const r = await di(tx, "v15 validate_deposit(storage, 0, 0)");
    if (r.error) console.log("  raw:", r.error.slice(0, 250));
  }
  
  // 7. v15 validate_deposit with amount=1
  {
    const tx = new Transaction();
    tx.setSender(DUMMY);
    tx.moveCall({
      target: `${NAVI_V15}::validation::validate_deposit`,
      typeArguments: [],
      arguments: [tx.object(STORAGE), tx.pure.u8(0), tx.pure.u256(1n)],
    });
    await di(tx, "v15 validate_deposit(storage, 0, 1)");
  }
  
  // 8. v15 validate_borrow with amount=0
  {
    const tx = new Transaction();
    tx.setSender(DUMMY);
    tx.moveCall({
      target: `${NAVI_V15}::validation::validate_borrow`,
      typeArguments: [],
      arguments: [tx.object(STORAGE), tx.pure.u8(0), tx.pure.u256(0n)],
    });
    const r = await di(tx, "v15 validate_borrow(storage, 0, 0)");
    if (r.error) console.log("  raw:", r.error.slice(0, 250));
  }
}

main().catch(console.error);
