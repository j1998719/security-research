import { SuiClient } from "@mysten/sui/client";
import { Transaction } from "@mysten/sui/transactions";

const client = new SuiClient({ url: "https://fullnode.mainnet.sui.io:443" });

const NAVI_V15    = "0x1e4a13a0494d5facdbe8473e74127b838c2d446ecec0ce262e2eddafa77259cb";
const DUMMY       = "0x0000000000000000000000000000000000000000000000000000000000001337";

const CLOCK        = "0x0000000000000000000000000000000000000000000000000000000000000006";
const ORACLE_OBJ   = "0x1568865ed9a0b5ec414220e8f79b3d04c77acc82358f6e5ae4635687392ffbef";
const STORAGE      = "0xbb4e2f4b6205c2e2a2db47aeb4f830796ec7c005f88537ee775986639bc442fe";
const SUI_POOL     = "0x96df0fce3c471489f4debaaa762cf960b3d97820bd1f3f025ff8190730e958c5";
const INCENTIVE_V3 = "0x62982dad27fb10bb314b3384d5de8d2ac2d72ab2dbeae5d801dbdb9efa816c80";
const INCENTIVE_V2 = "0xf87a8acb8b81d14307894d12595541a73f19933f88e1326d5be349c7a6f7559c";
const SUI_SYSTEM   = "0x0000000000000000000000000000000000000000000000000000000000000005";
const SUI_TYPE     = "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI";

function parseAbortCode(error: string): string {
  // Extract full abort info from MoveAbort error string
  const abortMatch = error.match(/MoveAbort\(.+?, (\d+)\)/);
  const locMatch = error.match(/name: Identifier\("([^"]+)"\)/);
  const fnMatch = error.match(/function_name: Some\("([^"]+)"\)/);
  if (abortMatch) {
    const code = parseInt(abortMatch[1]);
    const mod = locMatch?.[1] ?? "?";
    const fn = fnMatch?.[1] ?? "?";
    return `abort ${code} in ${mod}::${fn}`;
  }
  return error.slice(0, 100);
}

async function devInspect(tx: Transaction, label: string) {
  const r = await client.devInspectTransactionBlock({ transactionBlock: tx, sender: DUMMY });
  const status = r.effects?.status?.status;
  const error = r.effects?.status?.error ?? "";
  const info = error ? parseAbortCode(error) : "";
  console.log(`[${label}] ${status}${info ? " → " + info : ""}`);
  return { status, error };
}

async function main() {
  console.log("=== NAVI v15 Zero-Amount Boundary Tests ===\n");
  
  // TEST 1: entry_deposit(amount=0) — fully correct sig
  {
    const tx = new Transaction();
    tx.setSender(DUMMY);
    const c = tx.splitCoins(tx.gas, [0]);
    tx.moveCall({
      target: `${NAVI_V15}::incentive_v3::entry_deposit`,
      typeArguments: [SUI_TYPE],
      arguments: [
        tx.object(CLOCK), tx.object(STORAGE), tx.object(SUI_POOL),
        tx.pure.u8(0), c, tx.pure.u64(0),
        tx.object(INCENTIVE_V2), tx.object(INCENTIVE_V3),
      ],
    });
    await devInspect(tx, "entry_deposit(coin=0, amount=0)");
  }
  
  // TEST 2: entry_deposit(coin=1, amount=0) — coin has value but amount=0
  {
    const tx = new Transaction();
    tx.setSender(DUMMY);
    const c = tx.splitCoins(tx.gas, [1]);
    tx.moveCall({
      target: `${NAVI_V15}::incentive_v3::entry_deposit`,
      typeArguments: [SUI_TYPE],
      arguments: [
        tx.object(CLOCK), tx.object(STORAGE), tx.object(SUI_POOL),
        tx.pure.u8(0), c, tx.pure.u64(0),
        tx.object(INCENTIVE_V2), tx.object(INCENTIVE_V3),
      ],
    });
    await devInspect(tx, "entry_deposit(coin=1, amount=0)");
  }
  
  // TEST 3: entry_borrow_v2(amount=0) — should hit validation::validate_borrow
  {
    const tx = new Transaction();
    tx.setSender(DUMMY);
    tx.moveCall({
      target: `${NAVI_V15}::incentive_v3::entry_borrow_v2`,
      typeArguments: [SUI_TYPE],
      arguments: [
        tx.object(CLOCK), tx.object(ORACLE_OBJ), tx.object(STORAGE), tx.object(SUI_POOL),
        tx.pure.u8(0), tx.pure.u64(0),
        tx.object(INCENTIVE_V2), tx.object(INCENTIVE_V3), tx.object(SUI_SYSTEM),
      ],
    });
    await devInspect(tx, "entry_borrow_v2(amount=0)");
  }
  
  // TEST 4: entry_borrow_v2(amount=1) — should fail at insufficient collateral
  {
    const tx = new Transaction();
    tx.setSender(DUMMY);
    tx.moveCall({
      target: `${NAVI_V15}::incentive_v3::entry_borrow_v2`,
      typeArguments: [SUI_TYPE],
      arguments: [
        tx.object(CLOCK), tx.object(ORACLE_OBJ), tx.object(STORAGE), tx.object(SUI_POOL),
        tx.pure.u8(0), tx.pure.u64(1),
        tx.object(INCENTIVE_V2), tx.object(INCENTIVE_V3), tx.object(SUI_SYSTEM),
      ],
    });
    await devInspect(tx, "entry_borrow_v2(amount=1 MIST)");
  }
  
  console.log("\n=== What do the abort codes mean? ===");
  // Check utils module functions to understand abort codes
  try {
    const utilsMod = await client.getNormalizedMoveModule({ package: NAVI_V15, module: "utils" });
    const fns = Object.keys(utilsMod.exposedFunctions);
    console.log("utils functions:", fns.join(", "));
  } catch(e: any) { console.log("utils:", (e as any).message?.slice(0,60)); }
  
  try {
    const validMod = await client.getNormalizedMoveModule({ package: NAVI_V15, module: "validation" });
    const fns = Object.keys(validMod.exposedFunctions);
    console.log("validation functions:", fns.join(", "));
  } catch(e: any) { console.log("validation:", (e as any).message?.slice(0,60)); }
  
  // Check error codes in V1 package (validation module)
  const LOGIC_PKG = "0xd899cf7d2b5db716bd2cf55599fb0d5ee38a3061e7b6bb6eebf73fa5bc4c81ca";
  try {
    const mod = await client.getNormalizedMoveModule({ package: LOGIC_PKG, module: "validation" });
    console.log("\nV1 validation functions:", Object.keys(mod.exposedFunctions).join(", "));
  } catch(e: any) { console.log("V1 validation:", (e as any).message?.slice(0,60)); }
}

main().catch(console.error);
