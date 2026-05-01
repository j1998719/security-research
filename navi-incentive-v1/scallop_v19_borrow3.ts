import { SuiClient } from "@mysten/sui/client";
import { Transaction } from "@mysten/sui/transactions";

const client = new SuiClient({ url: "https://fullnode.mainnet.sui.io:443" });
const DUMMY = "0x0000000000000000000000000000000000000000000000000000000000001337";

// borrow_entry in LATEST pkg expects Obligation from ORIG pkg (0xefe8...)
// But open_obligation in LATEST pkg returns Obligation — what type is it?
// The Obligation type is from ORIG pkg, but the LATEST pkg function returns the same type
// because it hasn't changed the Obligation struct

// InvariantViolation happens in Move VM when there's a bytecode verification error
// Let me try using ORIG pkg for open_obligation and LATEST for borrow

const SCALLOP_LATEST = "0xde5c09ad171544aa3724dc67216668c80e754860f419136a68d78504eb2e2805";
const SCALLOP_ORIG   = "0xefe8b36d5b2e43728cc323298626b83177803521d195cfb11e15b910e892fddf";
const CDR_PKG        = "0xca5a5a62f01c79a104bf4d31669e29daa387f325c241de4edbe30986a9bc8b0d";

const VERSION_OBJ = "0x07871c4b3c847a0f674510d4978d5cf6f960452795e8ff6f189fd2088a3f6ac7";
const MARKET_OBJ  = "0xa757975255146dc9686aa823b7838b507f315d704f428cbadad2f4ea061939d9";
const CDR         = "0x200abe9bf19751cc566ae35aa58e2b7e4ff688fc1130f8d8909ea09bc137d668";
const X_ORACLE    = "0x1478a432123e4b3d61878b629f2c692969fdb375644f1251cd278a4b1e7d7cd6";
const CLOCK       = "0x0000000000000000000000000000000000000000000000000000000000000006";
const SUI_TYPE    = "0x2::sui::SUI";

function parseAbort(error: string) {
  const codeMatch = error.match(/MoveAbort\(.+?, (\d+)\)/);
  const modMatches = [...error.matchAll(/name: Identifier\("([^"]+)"\)/g)].map(m => m[1]);
  const fnMatch = error.match(/function_name: Some\("([^"]+)"\)/);
  const cmdMatch = error.match(/in command (\d+)/);
  const code = codeMatch?.[1] ?? "none";
  return `abort ${code} @ ${modMatches.join("::")}::${fnMatch?.[1] ?? "?"} (cmd ${cmdMatch?.[1] ?? "?"})`;
}

async function di(tx: Transaction, label: string) {
  const r = await client.devInspectTransactionBlock({ transactionBlock: tx, sender: DUMMY });
  const status = r.effects?.status?.status;
  const error = r.effects?.status?.error ?? "";
  console.log(`[${label}] ${status} → ${error ? (error.includes("MoveAbort") ? parseAbort(error) : error.slice(0,100)) : "ok"}`);
  return { status, error };
}

// Check version check in borrow_entry
async function checkVersionCheck() {
  // Version object has value=9, latest pkg has version=19 in UpgradeCap
  // But version::value() returns 9, which is the protocol version
  // Scallop's current_version() constant in latest pkg should match 9
  
  // Check current_version in latest
  try {
    const isCurrentFn = await client.getNormalizedMoveFunction({
      package: SCALLOP_LATEST, module: "version", function: "is_current_version"
    });
    console.log("is_current_version params:");
    isCurrentFn.parameters.forEach((p, i) => {
      const s = JSON.stringify(p);
      console.log(`  [${i}]: ${s.slice(0, 80)}`);
    });
  } catch(e: any) {}
  
  // Try calling is_current_version on the Version object
  const tx = new Transaction();
  tx.setSender(DUMMY);
  const [result] = tx.moveCall({
    target: `${SCALLOP_LATEST}::version::is_current_version`,
    typeArguments: [],
    arguments: [tx.object(VERSION_OBJ)],
  });
  const r = await client.devInspectTransactionBlock({ transactionBlock: tx, sender: DUMMY });
  const vBytes = r.results?.[0]?.returnValues?.[0];
  if (vBytes) {
    const v = Buffer.from(vBytes[0])[0];
    console.log("\nis_current_version(VERSION_OBJ) =", v ? "true" : "false");
  } else {
    console.log("\nis_current_version check:", r.effects?.status);
  }
}

async function main() {
  console.log("=== Scallop borrow zero-amount tests ===\n");
  
  await checkVersionCheck();
  
  console.log("\n--- Test with ORIG open_obligation + LATEST borrow ---");
  {
    const tx = new Transaction();
    tx.setSender(DUMMY);
    
    // Try using ORIG for open_obligation
    const [obligation, obligationKey, hotPotato] = tx.moveCall({
      target: `${SCALLOP_ORIG}::open_obligation::open_obligation`,
      typeArguments: [],
      arguments: [tx.object(VERSION_OBJ)],
    });
    
    tx.moveCall({
      target: `${SCALLOP_LATEST}::borrow::borrow_entry`,
      typeArguments: [SUI_TYPE],
      arguments: [
        tx.object(VERSION_OBJ), obligation, obligationKey,
        tx.object(MARKET_OBJ), tx.object(CDR),
        tx.pure.u64(0),
        tx.object(X_ORACLE), tx.object(CLOCK),
      ],
    });
    
    tx.moveCall({
      target: `${SCALLOP_ORIG}::open_obligation::return_obligation`,
      typeArguments: [],
      arguments: [tx.object(VERSION_OBJ), obligation, hotPotato],
    });
    tx.transferObjects([obligationKey], DUMMY);
    await di(tx, "ORIG open + LATEST borrow_entry(0)");
  }
  
  // Try LATEST for everything
  console.log("\n--- Test with LATEST open_obligation + LATEST borrow ---");
  {
    const tx = new Transaction();
    tx.setSender(DUMMY);
    
    const [obligation, obligationKey, hotPotato] = tx.moveCall({
      target: `${SCALLOP_LATEST}::open_obligation::open_obligation`,
      typeArguments: [],
      arguments: [tx.object(VERSION_OBJ)],
    });
    
    tx.moveCall({
      target: `${SCALLOP_LATEST}::borrow::borrow_entry`,
      typeArguments: [SUI_TYPE],
      arguments: [
        tx.object(VERSION_OBJ), obligation, obligationKey,
        tx.object(MARKET_OBJ), tx.object(CDR),
        tx.pure.u64(0),
        tx.object(X_ORACLE), tx.object(CLOCK),
      ],
    });
    
    tx.moveCall({
      target: `${SCALLOP_LATEST}::open_obligation::return_obligation`,
      typeArguments: [],
      arguments: [tx.object(VERSION_OBJ), obligation, hotPotato],
    });
    tx.transferObjects([obligationKey], DUMMY);
    await di(tx, "LATEST open + LATEST borrow_entry(0)");
  }
  
  // What about: try deposit_collateral in orig pkg
  console.log("\n--- Test deposit_collateral (ORIG pkg) ---");
  {
    const tx = new Transaction();
    tx.setSender(DUMMY);
    const [obligation, obligationKey, hotPotato] = tx.moveCall({
      target: `${SCALLOP_ORIG}::open_obligation::open_obligation`,
      typeArguments: [],
      arguments: [tx.object(VERSION_OBJ)],
    });
    const zeroCoin = tx.splitCoins(tx.gas, [0]);
    tx.moveCall({
      target: `${SCALLOP_ORIG}::deposit_collateral::deposit_collateral`,
      typeArguments: [SUI_TYPE],
      arguments: [tx.object(VERSION_OBJ), obligation, tx.object(MARKET_OBJ), zeroCoin],
    });
    tx.moveCall({
      target: `${SCALLOP_ORIG}::open_obligation::return_obligation`,
      typeArguments: [],
      arguments: [tx.object(VERSION_OBJ), obligation, hotPotato],
    });
    tx.transferObjects([obligationKey], DUMMY);
    await di(tx, "ORIG deposit_collateral(0)");
  }
}

main().catch(console.error);
