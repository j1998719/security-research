import { SuiClient } from "@mysten/sui/client";
import { Transaction } from "@mysten/sui/transactions";

const client = new SuiClient({ url: "https://fullnode.mainnet.sui.io:443" });
const DUMMY = "0x0000000000000000000000000000000000000000000000000000000000001337";

// Scallop latest package (v19 per UpgradeCap)
const SCALLOP_LATEST = "0xde5c09ad171544aa3724dc67216668c80e754860f419136a68d78504eb2e2805";
const SCALLOP_ORIG   = "0xefe8b36d5b2e43728cc323298626b83177803521d195cfb11e15b910e892fddf";
const VERSION_OBJ    = "0x07871c4b3c847a0f674510d4978d5cf6f960452795e8ff6f189fd2088a3f6ac7";
const MARKET_OBJ     = "0xa757975255146dc9686aa823b7838b507f315d704f428cbadad2f4ea061939d9";
const CLOCK          = "0x0000000000000000000000000000000000000000000000000000000000000006";
const X_ORACLE       = "0x1478a432123e4b3d61878b629f2c692969fdb375644f1251cd278a4b1e7d7cd6";
const CDR            = "0xcf78430b3c3942f90e16aafc422c4c40398a02bda2045492a66d183752a494b2";
const SUI_TYPE       = "0x2::sui::SUI";

function parseAbort(error: string) {
  const codeMatch = error.match(/MoveAbort\(.+?, (\d+)\)/);
  const modMatches = [...error.matchAll(/name: Identifier\("([^"]+)"\)/g)].map(m => m[1]);
  const fnMatch = error.match(/function_name: Some\("([^"]+)"\)/);
  const cmdMatch = error.match(/in command (\d+)/);
  const code = codeMatch?.[1] ?? "none";
  const mods = modMatches.join("::");
  const fn = fnMatch?.[1] ?? "?";
  const cmd = cmdMatch?.[1] ?? "?";
  return `abort ${code} @ ${mods}::${fn} (cmd ${cmd})`;
}

async function di(tx: Transaction, label: string) {
  const r = await client.devInspectTransactionBlock({ transactionBlock: tx, sender: DUMMY });
  const status = r.effects?.status?.status;
  const error = r.effects?.status?.error ?? "";
  console.log(`[${label}] ${status} → ${error ? parseAbort(error) : "ok"}`);
  if (error && !error.includes("MoveAbort") && !error.includes("VMVerification")) {
    console.log("  raw:", error.slice(0, 150));
  }
  return { status, error };
}

async function main() {
  console.log("=== Scallop v19 Zero-Amount Tests ===\n");
  
  // First check if latest has the right modules
  console.log("Checking modules in latest pkg...");
  for (const mod of ["open_obligation", "deposit_collateral", "borrow", "version_methods"]) {
    try {
      const m = await client.getNormalizedMoveModule({ package: SCALLOP_LATEST, module: mod });
      const fns = Object.keys(m.exposedFunctions);
      console.log(`  ${mod}: [${fns.join(", ")}]`);
    } catch(e: any) {
      console.log(`  ${mod}: NOT FOUND`);
    }
  }
  
  // Check if version_methods::current_version exists
  try {
    const m = await client.getNormalizedMoveModule({ package: SCALLOP_LATEST, module: "version" });
    console.log("  version module fns:", Object.keys(m.exposedFunctions).join(", "));
  } catch(e: any) {
    console.log("  version: NOT FOUND");
  }
  
  // Check Version object value for latest
  const versionObj = await client.getObject({ id: VERSION_OBJ, options: { showContent: true } });
  const vFields = (versionObj.data?.content as any)?.fields ?? {};
  console.log("\nVersion object value:", vFields.value);
  
  // The correct package to call is SCALLOP_LATEST for function calls
  // But the Version object type is from SCALLOP_ORIG
  // In Sui, when a package is upgraded, the functions in the new package 
  // still accept objects from the original package types
  
  console.log("\n=== TEST: deposit_collateral(amount=0) with LATEST pkg ===");
  {
    const tx = new Transaction();
    tx.setSender(DUMMY);
    
    // open_obligation
    const [obligation, obligationKey, hotPotato] = tx.moveCall({
      target: `${SCALLOP_LATEST}::open_obligation::open_obligation`,
      typeArguments: [],
      arguments: [tx.object(VERSION_OBJ)],
    });
    
    // zero coin
    const zeroCoin = tx.splitCoins(tx.gas, [0]);
    
    // deposit 0
    tx.moveCall({
      target: `${SCALLOP_LATEST}::deposit_collateral::deposit_collateral`,
      typeArguments: [SUI_TYPE],
      arguments: [
        tx.object(VERSION_OBJ),
        obligation,
        tx.object(MARKET_OBJ),
        zeroCoin,
      ],
    });
    
    // return obligation
    tx.moveCall({
      target: `${SCALLOP_LATEST}::open_obligation::return_obligation`,
      typeArguments: [],
      arguments: [tx.object(VERSION_OBJ), obligation, hotPotato],
    });
    
    tx.transferObjects([obligationKey], DUMMY);
    await di(tx, "deposit_collateral(amount=0)");
  }
  
  // TEST: deposit_collateral(amount=1)
  {
    const tx = new Transaction();
    tx.setSender(DUMMY);
    const [obligation, obligationKey, hotPotato] = tx.moveCall({
      target: `${SCALLOP_LATEST}::open_obligation::open_obligation`,
      typeArguments: [],
      arguments: [tx.object(VERSION_OBJ)],
    });
    const dustCoin = tx.splitCoins(tx.gas, [1]);
    tx.moveCall({
      target: `${SCALLOP_LATEST}::deposit_collateral::deposit_collateral`,
      typeArguments: [SUI_TYPE],
      arguments: [tx.object(VERSION_OBJ), obligation, tx.object(MARKET_OBJ), dustCoin],
    });
    tx.moveCall({
      target: `${SCALLOP_LATEST}::open_obligation::return_obligation`,
      typeArguments: [],
      arguments: [tx.object(VERSION_OBJ), obligation, hotPotato],
    });
    tx.transferObjects([obligationKey], DUMMY);
    await di(tx, "deposit_collateral(amount=1 MIST)");
  }
  
  // TEST: borrow_entry(amount=0)
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
    await di(tx, "borrow_entry(amount=0)");
  }
  
  // TEST: borrow_entry(amount=1)
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
        tx.pure.u64(1),
        tx.object(X_ORACLE), tx.object(CLOCK),
      ],
    });
    tx.moveCall({
      target: `${SCALLOP_LATEST}::open_obligation::return_obligation`,
      typeArguments: [],
      arguments: [tx.object(VERSION_OBJ), obligation, hotPotato],
    });
    tx.transferObjects([obligationKey], DUMMY);
    await di(tx, "borrow_entry(amount=1 MIST)");
  }
}

main().catch(console.error);
