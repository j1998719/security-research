import { SuiClient } from "@mysten/sui/client";
import { Transaction } from "@mysten/sui/transactions";

const client = new SuiClient({ url: "https://fullnode.mainnet.sui.io:443" });

const NAVI_V15  = "0x1e4a13a0494d5facdbe8473e74127b838c2d446ecec0ce262e2eddafa77259cb";
const DUMMY     = "0x0000000000000000000000000000000000000000000000000000000000001337";

const CLOCK       = "0x0000000000000000000000000000000000000000000000000000000000000006";
const ORACLE_OBJ  = "0x1568865ed9a0b5ec414220e8f79b3d04c77acc82358f6e5ae4635687392ffbef";
const STORAGE     = "0xbb4e2f4b6205c2e2a2db47aeb4f830796ec7c005f88537ee775986639bc442fe";
const SUI_POOL    = "0x96df0fce3c471489f4debaaa762cf960b3d97820bd1f3f025ff8190730e958c5";
const INCENTIVE_V3 = "0x62982dad27fb10bb314b3384d5de8d2ac2d72ab2dbeae5d801dbdb9efa816c80";
const INCENTIVE_V2 = "0xf87a8acb8b81d14307894d12595541a73f19933f88e1326d5be349c7a6f7559c";
const SUI_SYSTEM  = "0x0000000000000000000000000000000000000000000000000000000000000005";
const SUI_TYPE    = "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI";

async function devInspect(tx: Transaction, label: string) {
  const r = await client.devInspectTransactionBlock({ transactionBlock: tx, sender: DUMMY });
  const status = r.effects?.status?.status;
  const error = r.effects?.status?.error ?? "";
  
  // Extract abort code if present
  let abortInfo = "";
  if (error) {
    const match = error.match(/abort_code: (\d+)/);
    const modMatch = error.match(/location: (.+?),/);
    if (match) abortInfo = ` | abort code ${match[1]}${modMatch ? " @ " + modMatch[1] : ""}`;
  }
  
  console.log(`[${label}] ${status}${abortInfo}`);
  if (status !== "success" && !abortInfo) {
    console.log(`  Error: ${error.slice(0, 150)}`);
  }
  return { status, error };
}

async function checkEntryDepositSig() {
  // First verify the function signature in v15
  try {
    const fn = await client.getNormalizedMoveFunction({ 
      package: NAVI_V15, module: "incentive_v3", function: "entry_deposit" 
    });
    console.log("entry_deposit params count:", fn.parameters.length);
    fn.parameters.forEach((p, i) => {
      const s = JSON.stringify(p);
      const isMut = s.includes("MutableReference");
      const name = s.match(/"name":"(\w+)"/)?.[1] ?? s.slice(0, 60);
      console.log(`  param[${i}]: ${isMut ? "&mut " : ""}${name}`);
    });
    return fn.parameters.length;
  } catch(e: any) {
    console.log("Could not get function sig:", e.message?.slice(0,80));
    return 8;
  }
}

async function checkEntryBorrowSig() {
  const fns = ["entry_borrow_v2", "entry_borrow", "borrow_entry"];
  for (const fname of fns) {
    try {
      const fn = await client.getNormalizedMoveFunction({ 
        package: NAVI_V15, module: "incentive_v3", function: fname 
      });
      console.log(`\n${fname} params count: ${fn.parameters.length}`);
      fn.parameters.forEach((p, i) => {
        const s = JSON.stringify(p);
        const isMut = s.includes("MutableReference");
        const name = s.match(/"name":"(\w+)"/)?.[1] ?? s.slice(0, 60);
        console.log(`  param[${i}]: ${isMut ? "&mut " : ""}${name}`);
      });
      return fname;
    } catch(e: any) {
      // try next
    }
  }
  return null;
}

async function main() {
  console.log("=== NAVI v15 Zero-Amount Boundary Tests ===\n");
  console.log("Package:", NAVI_V15);
  
  // Verify version
  const txV = new Transaction();
  txV.setSender(DUMMY);
  txV.moveCall({ target: `${NAVI_V15}::constants::version`, typeArguments: [], arguments: [] });
  const rV = await client.devInspectTransactionBlock({ transactionBlock: txV, sender: DUMMY });
  const vB = rV.results?.[0]?.returnValues?.[0];
  if (vB) console.log("Confirmed version:", Buffer.from(vB[0]).readBigUInt64LE(0).toString(), "\n");
  
  // Get function signatures
  console.log("=== Function Signatures ===");
  const depositParamCount = await checkEntryDepositSig();
  const borrowFnName = await checkEntryBorrowSig();
  
  console.log("\n=== Zero-Amount Tests ===\n");
  
  // TEST 1: entry_deposit(amount=0)
  {
    const tx = new Transaction();
    tx.setSender(DUMMY);
    const zeroCoin = tx.splitCoins(tx.gas, [0]);
    
    if (depositParamCount === 8) {
      // 8-param version: clock, oracle, storage, pool, asset_id, coin, amount, incentive_v3
      tx.moveCall({
        target: `${NAVI_V15}::incentive_v3::entry_deposit`,
        typeArguments: [SUI_TYPE],
        arguments: [
          tx.object(CLOCK), tx.object(ORACLE_OBJ), tx.object(STORAGE), tx.object(SUI_POOL),
          tx.pure.u8(0), zeroCoin, tx.pure.u64(0), tx.object(INCENTIVE_V3),
        ],
      });
    } else {
      // Try 7-param without oracle
      tx.moveCall({
        target: `${NAVI_V15}::incentive_v3::entry_deposit`,
        typeArguments: [SUI_TYPE],
        arguments: [
          tx.object(CLOCK), tx.object(STORAGE), tx.object(SUI_POOL),
          tx.pure.u8(0), zeroCoin, tx.pure.u64(0), tx.object(INCENTIVE_V3),
        ],
      });
    }
    await devInspect(tx, "entry_deposit(amount=0)");
  }
  
  // TEST 2: entry_deposit(amount=1 MIST)
  {
    const tx = new Transaction();
    tx.setSender(DUMMY);
    const dustCoin = tx.splitCoins(tx.gas, [1]);
    tx.moveCall({
      target: `${NAVI_V15}::incentive_v3::entry_deposit`,
      typeArguments: [SUI_TYPE],
      arguments: [
        tx.object(CLOCK), tx.object(ORACLE_OBJ), tx.object(STORAGE), tx.object(SUI_POOL),
        tx.pure.u8(0), dustCoin, tx.pure.u64(1), tx.object(INCENTIVE_V3),
      ],
    });
    await devInspect(tx, "entry_deposit(amount=1 MIST)");
  }
  
  // TEST 3: entry_borrow_v2(amount=0)
  if (borrowFnName) {
    const tx = new Transaction();
    tx.setSender(DUMMY);
    
    if (borrowFnName === "entry_borrow_v2") {
      // Typical sig: clock, oracle, storage, pool, asset_id, amount, incentive_v2, incentive_v3, ctx
      tx.moveCall({
        target: `${NAVI_V15}::incentive_v3::entry_borrow_v2`,
        typeArguments: [SUI_TYPE],
        arguments: [
          tx.object(CLOCK), tx.object(ORACLE_OBJ), tx.object(STORAGE), tx.object(SUI_POOL),
          tx.pure.u8(0), tx.pure.u64(0), tx.object(INCENTIVE_V2), tx.object(INCENTIVE_V3),
        ],
      });
    } else {
      tx.moveCall({
        target: `${NAVI_V15}::incentive_v3::${borrowFnName}`,
        typeArguments: [SUI_TYPE],
        arguments: [
          tx.object(CLOCK), tx.object(ORACLE_OBJ), tx.object(STORAGE), tx.object(SUI_POOL),
          tx.pure.u8(0), tx.pure.u64(0), tx.object(INCENTIVE_V2), tx.object(INCENTIVE_V3),
        ],
      });
    }
    await devInspect(tx, `${borrowFnName}(amount=0)`);
  }
  
  // TEST 4: entry_borrow_v2(amount=1 MIST)
  if (borrowFnName) {
    const tx = new Transaction();
    tx.setSender(DUMMY);
    tx.moveCall({
      target: `${NAVI_V15}::incentive_v3::${borrowFnName}`,
      typeArguments: [SUI_TYPE],
      arguments: [
        tx.object(CLOCK), tx.object(ORACLE_OBJ), tx.object(STORAGE), tx.object(SUI_POOL),
        tx.pure.u8(0), tx.pure.u64(1), tx.object(INCENTIVE_V2), tx.object(INCENTIVE_V3),
      ],
    });
    await devInspect(tx, `${borrowFnName}(amount=1 MIST)`);
  }
}

main().catch(console.error);
