import { SuiClient } from "@mysten/sui/client";
import { Transaction } from "@mysten/sui/transactions";

const client = new SuiClient({ url: "https://fullnode.mainnet.sui.io:443" });
const DUMMY = "0x0000000000000000000000000000000000000000000000000000000000001337";

const SCALLOP_LATEST = "0xde5c09ad171544aa3724dc67216668c80e754860f419136a68d78504eb2e2805";
const SCALLOP_ORIG   = "0xefe8b36d5b2e43728cc323298626b83177803521d195cfb11e15b910e892fddf";

const VERSION_OBJ    = "0x07871c4b3c847a0f674510d4978d5cf6f960452795e8ff6f189fd2088a3f6ac7";
const MARKET_OBJ     = "0xa757975255146dc9686aa823b7838b507f315d704f428cbadad2f4ea061939d9";
const CDR            = "0x200abe9bf19751cc566ae35aa58e2b7e4ff688fc1130f8d8909ea09bc137d668";
const X_ORACLE       = "0x1478a432123e4b3d61878b629f2c692969fdb375644f1251cd278a4b1e7d7cd6";
const CLOCK          = "0x0000000000000000000000000000000000000000000000000000000000000006";
const SUI_TYPE       = "0x2::sui::SUI";

// Existing shared obligation that anyone can use
const EXISTING_OBLIGATION = "0x96b95bdbff34f1e8fa9bbb29c06466c3640d60375a09fc0d16de7805b79834af";

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
  console.log(`[${label}] ${status} → ${error ? (error.includes("MoveAbort") ? parseAbort(error) : error.slice(0, 120)) : "ok"}`);
  return { status, error };
}

async function main() {
  console.log("=== Scallop borrow with existing obligation ===\n");
  
  // Check what ObligationKey type looks like  
  const keyParam = (await client.getNormalizedMoveFunction({
    package: SCALLOP_LATEST, module: "borrow", function: "borrow_entry"
  })).parameters[2];
  const keyType = JSON.stringify(keyParam);
  const keyPkg = keyType.match(/"address":"(0x[0-9a-f]+)"/)?.[1] ?? SCALLOP_ORIG;
  const keyModule = keyType.match(/"module":"(\w+)"/)?.[1] ?? "obligation";
  const keyName = keyType.match(/"name":"(\w+)"/)?.[1] ?? "ObligationKey";
  console.log(`ObligationKey type: ${keyPkg.slice(0,16)}...::${keyModule}::${keyName}`);
  
  // We can't pass a fake ObligationKey — it's a Move object
  // But we CAN pass an existing obligation as a shared object
  // The borrow function will check if the key matches the obligation
  // If zero check comes BEFORE key check, we'll see "zero amount" abort
  // If key check comes BEFORE zero check, we'll see "key mismatch" abort
  
  // Strategy: use the existing obligation + create a new ObligationKey by re-using open_obligation
  // In Scallop, ObligationKey has an ID that links to the Obligation
  // We need to create a MATCHING key, or use the existing obligation's key
  
  // Let's just try with a freshly created obligation in the same TX
  // but pass it as an object reference (not a result)
  // Actually, in Sui PTB, results from shared object creation can be used
  
  // The InvariantViolation before was probably because we tried to use 
  // the obligation both as a result AND there was a type mismatch somewhere
  
  // Let me check: what EXACTLY is returned from open_obligation?
  const openOblFn = await client.getNormalizedMoveFunction({
    package: SCALLOP_LATEST, module: "open_obligation", function: "open_obligation"
  });
  console.log("\nopen_obligation returns:");
  openOblFn.return?.forEach((r, i) => {
    const s = JSON.stringify(r);
    const name = s.match(/"name":"(\w+)"/)?.[1] ?? s.slice(0, 60);
    const pkg = s.match(/"address":"(0x[0-9a-f]+)"/)?.[1] ?? "";
    console.log(`  [${i}]: ${name} (pkg: ${pkg.slice(0,16)}...)`);
  });
  
  // Also check return_obligation signature
  const returnOblFn = await client.getNormalizedMoveFunction({
    package: SCALLOP_LATEST, module: "open_obligation", function: "return_obligation"
  });
  console.log("\nreturn_obligation params:");
  returnOblFn.parameters.forEach((p, i) => {
    const s = JSON.stringify(p);
    const isMut = s.includes("MutableReference");
    const name = s.match(/"name":"(\w+)"/)?.[1] ?? s.slice(0, 60);
    const pkg = s.match(/"address":"(0x[0-9a-f]+)"/)?.[1] ?? "";
    console.log(`  [${i}]: ${isMut ? "&mut " : ""}${name} (pkg: ${pkg.slice(0,16)}...)`);
  });
  
  // Now try the sequence with deposit_collateral instead to understand 
  // the relationship: does deposit work on existing obligation?
  console.log("\n--- deposit_collateral on EXISTING obligation (no hot potato) ---");
  {
    const tx = new Transaction();
    tx.setSender(DUMMY);
    const zeroCoin = tx.splitCoins(tx.gas, [0]);
    tx.moveCall({
      target: `${SCALLOP_LATEST}::deposit_collateral::deposit_collateral`,
      typeArguments: [SUI_TYPE],
      arguments: [
        tx.object(VERSION_OBJ),
        tx.object(EXISTING_OBLIGATION),  // Use existing shared obligation
        tx.object(MARKET_OBJ),
        zeroCoin,
      ],
    });
    await di(tx, "deposit_collateral(existing_obl, amount=0)");
  }
  
  {
    const tx = new Transaction();
    tx.setSender(DUMMY);
    const dustCoin = tx.splitCoins(tx.gas, [1]);
    tx.moveCall({
      target: `${SCALLOP_LATEST}::deposit_collateral::deposit_collateral`,
      typeArguments: [SUI_TYPE],
      arguments: [
        tx.object(VERSION_OBJ),
        tx.object(EXISTING_OBLIGATION),
        tx.object(MARKET_OBJ),
        dustCoin,
      ],
    });
    await di(tx, "deposit_collateral(existing_obl, amount=1 MIST)");
  }
}

main().catch(console.error);
