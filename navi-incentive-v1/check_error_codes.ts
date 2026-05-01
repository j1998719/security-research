import { SuiClient } from "@mysten/sui/client";
import { Transaction } from "@mysten/sui/transactions";

const client = new SuiClient({ url: "https://fullnode.mainnet.sui.io:443" });
const DUMMY = "0x0000000000000000000000000000000000000000000000000000000000001337";
const NAVI_V15 = "0x1e4a13a0494d5facdbe8473e74127b838c2d446ecec0ce262e2eddafa77259cb";

async function main() {
  console.log("=== NAVI v15 Error Code Analysis ===\n");
  
  // Check utils module struct
  console.log("--- utils module ---");
  try {
    const mod = await client.getNormalizedMoveModule({ package: NAVI_V15, module: "utils" });
    // List all functions with their parameters
    for (const [name, fn] of Object.entries(mod.exposedFunctions)) {
      const params = fn.parameters.map(p => {
        const s = JSON.stringify(p);
        return s.match(/"name":"(\w+)"/)?.[1] ?? s.slice(0,30);
      });
      console.log(`  ${name}(${params.join(", ")}) -> ${JSON.stringify(fn.return).slice(0,50)}`);
    }
  } catch(e: any) { console.log("error:", (e as any).message?.slice(0,60)); }
  
  // Check validation module
  console.log("\n--- validation module functions ---");
  try {
    const mod = await client.getNormalizedMoveModule({ package: NAVI_V15, module: "validation" });
    for (const [name, fn] of Object.entries(mod.exposedFunctions)) {
      const params = fn.parameters.map(p => {
        const s = JSON.stringify(p);
        return s.match(/"name":"(\w+)"/)?.[1] ?? s.slice(0,30);
      });
      console.log(`  ${name}(${params.join(", ")})`);
    }
  } catch(e: any) { console.log("error:", (e as any).message?.slice(0,60)); }
  
  // Decode error codes from NAVI error constants
  // abort 46000 = potential "EINVALID_AMOUNT" or "EZERO_AMOUNT"
  // abort 1503 = 1500 + 3 = validation module error 3 typically
  // Let's query the error code table from V1 package
  const LOGIC_PKG = "0xd899cf7d2b5db716bd2cf55599fb0d5ee38a3061e7b6bb6eebf73fa5bc4c81ca";
  
  console.log("\n--- V1 error codes module ---");
  try {
    const mod = await client.getNormalizedMoveModule({ package: LOGIC_PKG, module: "error_codes" });
    console.log("error_codes functions:", Object.keys(mod.exposedFunctions).slice(0,10).join(", "));
  } catch(e: any) {
    console.log("No error_codes module in V1");
  }
  
  // Try to read error code constants from v15
  console.log("\n--- v15 modules ---");
  try {
    const pkg = await client.getNormalizedMoveModules({ package: NAVI_V15 });
    console.log("v15 modules:", Object.keys(pkg).join(", "));
  } catch(e: any) { console.log("error:", (e as any).message?.slice(0,60)); }
  
  // Can we call validate_deposit directly to check its zero check?
  // validate_deposit(storage, asset_id, amount) - U256 amount
  // If we call it with amount=0, do we get a specific error?
  console.log("\n--- Direct validate_deposit(amount=0) call ---");
  try {
    const tx = new Transaction();
    tx.setSender(DUMMY);
    const STORAGE = "0xbb4e2f4b6205c2e2a2db47aeb4f830796ec7c005f88537ee775986639bc442fe";
    
    // validate_deposit expects U256 for amount in V1, but V15 might differ
    // V1 signature: validate_deposit(&mut Storage, U8, U256)
    tx.moveCall({
      target: `${LOGIC_PKG}::validation::validate_deposit`,
      typeArguments: [],
      arguments: [
        tx.object(STORAGE),
        tx.pure.u8(0),
        tx.pure.u256(0n),  // amount = 0
      ],
    });
    const r = await client.devInspectTransactionBlock({ transactionBlock: tx, sender: DUMMY });
    const status = r.effects?.status?.status;
    const error = r.effects?.status?.error ?? "";
    const abortMatch = error.match(/MoveAbort\(.+?, (\d+)\)/);
    const fnMatch = error.match(/function_name: Some\("([^"]+)"\)/);
    console.log(`validate_deposit(0): ${status} → abort ${abortMatch?.[1] ?? "?"} in ${fnMatch?.[1] ?? "?"}`);
  } catch(e: any) { console.log("error:", (e as any).message?.slice(0,80)); }
  
  console.log("\n--- Direct validate_borrow(amount=0) call ---");
  try {
    const tx = new Transaction();
    tx.setSender(DUMMY);
    const STORAGE = "0xbb4e2f4b6205c2e2a2db47aeb4f830796ec7c005f88537ee775986639bc442fe";
    const ORACLE = "0x1568865ed9a0b5ec414220e8f79b3d04c77acc82358f6e5ae4635687392ffbef";
    const CLOCK  = "0x0000000000000000000000000000000000000000000000000000000000000006";
    
    const validBorrowFn = await client.getNormalizedMoveFunction({
      package: LOGIC_PKG, module: "validation", function: "validate_borrow"
    });
    console.log("validate_borrow params:", validBorrowFn.parameters.map((p,i) => {
      const s = JSON.stringify(p);
      return `[${i}]${s.match(/"name":"(\w+)"/)?.[1] ?? s.slice(0,30)}`;
    }).join(", "));
  } catch(e: any) { console.log("error:", (e as any).message?.slice(0,80)); }
}

main().catch(console.error);
