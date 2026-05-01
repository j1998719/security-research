import { SuiClient } from "@mysten/sui/client";
import { Transaction } from "@mysten/sui/transactions";

const client = new SuiClient({ url: "https://fullnode.mainnet.sui.io:443" });

const NAVI_V15    = "0x1e4a13a0494d5facdbe8473e74127b838c2d446ecec0ce262e2eddafa77259cb";
const DUMMY       = "0x0000000000000000000000000000000000000000000000000000000000001337";

const CLOCK       = "0x0000000000000000000000000000000000000000000000000000000000000006";
const ORACLE_OBJ  = "0x1568865ed9a0b5ec414220e8f79b3d04c77acc82358f6e5ae4635687392ffbef";
const STORAGE     = "0xbb4e2f4b6205c2e2a2db47aeb4f830796ec7c005f88537ee775986639bc442fe";
const SUI_POOL    = "0x96df0fce3c471489f4debaaa762cf960b3d97820bd1f3f025ff8190730e958c5";
const INCENTIVE_V3 = "0x62982dad27fb10bb314b3384d5de8d2ac2d72ab2dbeae5d801dbdb9efa816c80";
const INCENTIVE_V2 = "0xf87a8acb8b81d14307894d12595541a73f19933f88e1326d5be349c7a6f7559c";
const SUI_SYSTEM   = "0x0000000000000000000000000000000000000000000000000000000000000005";
const SUI_TYPE     = "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI";

// v15 signatures (confirmed above):
// entry_deposit(clock, &mut storage, &mut pool, u8, coin, u64, &mut incentive_v2, &mut incentive_v3, &mut ctx)
// entry_borrow_v2(clock, oracle, &mut storage, &mut pool, u8, u64, &mut incentive_v2, &mut incentive_v3, &mut suisystem, &mut ctx)

async function devInspect(tx: Transaction, label: string) {
  const r = await client.devInspectTransactionBlock({ transactionBlock: tx, sender: DUMMY });
  const status = r.effects?.status?.status;
  const error = r.effects?.status?.error ?? "";
  
  let abortInfo = "";
  if (error) {
    const match = error.match(/abort_code: (\d+)/);
    const modMatch = error.match(/location: (.+?)[,}]/);
    if (match) abortInfo = ` | abort code ${match[1]}${modMatch ? " @ " + modMatch[1] : ""}`;
  }
  
  console.log(`[${label}] ${status}${abortInfo}`);
  if (status !== "success" && !abortInfo) {
    console.log(`  Error: ${error.slice(0, 200)}`);
  }
  return { status, error };
}

async function main() {
  console.log("=== NAVI v15 Zero-Amount Boundary Tests (Fixed Signatures) ===\n");
  
  // TEST 1: entry_deposit(amount=0) — NO oracle param in v15
  {
    const tx = new Transaction();
    tx.setSender(DUMMY);
    const zeroCoin = tx.splitCoins(tx.gas, [0]);
    tx.moveCall({
      target: `${NAVI_V15}::incentive_v3::entry_deposit`,
      typeArguments: [SUI_TYPE],
      arguments: [
        tx.object(CLOCK),       // param[0]: Clock
        tx.object(STORAGE),     // param[1]: &mut Storage
        tx.object(SUI_POOL),    // param[2]: &mut Pool<T>
        tx.pure.u8(0),          // param[3]: U8 (asset_id)
        zeroCoin,               // param[4]: Coin<T>
        tx.pure.u64(0),         // param[5]: U64 (amount)
        tx.object(INCENTIVE_V2),// param[6]: &mut Incentive
        tx.object(INCENTIVE_V3),// param[7]: &mut Incentive
        // param[8]: &mut TxContext — injected automatically
      ],
    });
    const r = await devInspect(tx, "entry_deposit(amount=0)");
    if (r.error.includes("abort_code")) {
      console.log("  Full error:", r.error.slice(0, 300));
    }
  }
  
  // TEST 2: entry_deposit(amount=1 MIST, coin=0 value) — coin has 0 value but amount=1
  // This tests whether amount param vs coin value mismatch is checked
  {
    const tx = new Transaction();
    tx.setSender(DUMMY);
    const zeroCoin = tx.splitCoins(tx.gas, [0]);
    tx.moveCall({
      target: `${NAVI_V15}::incentive_v3::entry_deposit`,
      typeArguments: [SUI_TYPE],
      arguments: [
        tx.object(CLOCK), tx.object(STORAGE), tx.object(SUI_POOL),
        tx.pure.u8(0), zeroCoin, tx.pure.u64(1),
        tx.object(INCENTIVE_V2), tx.object(INCENTIVE_V3),
      ],
    });
    const r = await devInspect(tx, "entry_deposit(coin=0, amount=1)");
    if (r.error.includes("abort_code")) console.log("  Full error:", r.error.slice(0, 300));
  }
  
  // TEST 3: entry_borrow_v2(amount=0) — uses oracle
  {
    const tx = new Transaction();
    tx.setSender(DUMMY);
    tx.moveCall({
      target: `${NAVI_V15}::incentive_v3::entry_borrow_v2`,
      typeArguments: [SUI_TYPE],
      arguments: [
        tx.object(CLOCK),        // param[0]: Clock
        tx.object(ORACLE_OBJ),   // param[1]: PriceOracle
        tx.object(STORAGE),      // param[2]: &mut Storage
        tx.object(SUI_POOL),     // param[3]: &mut Pool<T>
        tx.pure.u8(0),           // param[4]: U8 (asset_id)
        tx.pure.u64(0),          // param[5]: U64 (amount=0)
        tx.object(INCENTIVE_V2), // param[6]: &mut Incentive
        tx.object(INCENTIVE_V3), // param[7]: &mut Incentive
        tx.object(SUI_SYSTEM),   // param[8]: &mut SuiSystemState
        // param[9]: &mut TxContext
      ],
    });
    const r = await devInspect(tx, "entry_borrow_v2(amount=0)");
    if (r.error.includes("abort_code")) console.log("  Full error:", r.error.slice(0, 300));
  }
  
  // TEST 4: entry_borrow_v2(amount=1 MIST) — should fail on collateral but past zero check
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
    const r = await devInspect(tx, "entry_borrow_v2(amount=1 MIST)");
    if (r.error.includes("abort_code")) console.log("  Full error:", r.error.slice(0, 300));
  }
  
  // TEST 5: Look for validate_deposit function in v15 to confirm zero-check
  console.log("\n=== Checking validate_deposit for zero-check ===");
  try {
    const LOGIC_PKG = "0xd899cf7d2b5db716bd2cf55599fb0d5ee38a3061e7b6bb6eebf73fa5bc4c81ca";
    const validateFn = await client.getNormalizedMoveFunction({
      package: LOGIC_PKG, module: "validation", function: "validate_deposit"
    });
    console.log("validate_deposit params:", validateFn.parameters.length);
    validateFn.parameters.forEach((p, i) => {
      const s = JSON.stringify(p);
      console.log(`  param[${i}]: ${s.slice(0, 80)}`);
    });
  } catch(e: any) {
    // Try other module names
    try {
      const LOGIC_PKG = "0xd899cf7d2b5db716bd2cf55599fb0d5ee38a3061e7b6bb6eebf73fa5bc4c81ca";
      const mod = await client.getNormalizedMoveModule({ package: LOGIC_PKG, module: "logic" });
      const fns = Object.keys(mod.exposedFunctions).filter(f => f.includes("validate") || f.includes("deposit") || f.includes("borrow"));
      console.log("logic module relevant functions:", fns.join(", "));
    } catch(e2: any) {
      console.log("Could not find validate function:", (e2 as any).message?.slice(0, 60));
    }
  }
}

main().catch(console.error);
