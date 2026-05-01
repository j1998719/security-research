import { SuiClient } from "@mysten/sui/client";
import { Transaction } from "@mysten/sui/transactions";

const client = new SuiClient({ url: "https://fullnode.mainnet.sui.io:443" });
const DUMMY = "0x0000000000000000000000000000000000000000000000000000000000001337";

const SCALLOP_LATEST = "0xde5c09ad171544aa3724dc67216668c80e754860f419136a68d78504eb2e2805";
const SCALLOP_ORIG   = "0xefe8b36d5b2e43728cc323298626b83177803521d195cfb11e15b910e892fddf";

const VERSION_OBJ = "0x07871c4b3c847a0f674510d4978d5cf6f960452795e8ff6f189fd2088a3f6ac7";
const MARKET_OBJ  = "0xa757975255146dc9686aa823b7838b507f315d704f428cbadad2f4ea061939d9";
const CDR         = "0x200abe9bf19751cc566ae35aa58e2b7e4ff688fc1130f8d8909ea09bc137d668";
const X_ORACLE    = "0x1478a432123e4b3d61878b629f2c692969fdb375644f1251cd278a4b1e7d7cd6";
const CLOCK       = "0x0000000000000000000000000000000000000000000000000000000000000006";
const SUI_TYPE    = "0x2::sui::SUI";

// Existing shared obligation + key (key is address-owned by someone else)
const EXISTING_OBLIGATION = "0x96b95bdbff34f1e8fa9bbb29c06466c3640d60375a09fc0d16de7805b79834af";
const EXISTING_OBL_KEY    = "0xcaf1603e92145c04afaf02334054f92bbbc012632b20932cad24841d93e4cd14";

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
  console.log("=== Scallop borrow_entry zero-amount final test ===\n");
  
  // devInspect bypasses ownership checks, so we can pass someone else's ObligationKey
  
  // Test 1: borrow_entry with existing obl + existing key, amount=0
  {
    const tx = new Transaction();
    tx.setSender(DUMMY);
    tx.moveCall({
      target: `${SCALLOP_LATEST}::borrow::borrow_entry`,
      typeArguments: [SUI_TYPE],
      arguments: [
        tx.object(VERSION_OBJ),
        tx.object(EXISTING_OBLIGATION),
        tx.object(EXISTING_OBL_KEY),
        tx.object(MARKET_OBJ),
        tx.object(CDR),
        tx.pure.u64(0),
        tx.object(X_ORACLE),
        tx.object(CLOCK),
      ],
    });
    await di(tx, "borrow_entry(existing_obl, existing_key, amount=0)");
  }
  
  // Test 2: borrow_entry with existing obl + existing key, amount=1
  {
    const tx = new Transaction();
    tx.setSender(DUMMY);
    tx.moveCall({
      target: `${SCALLOP_LATEST}::borrow::borrow_entry`,
      typeArguments: [SUI_TYPE],
      arguments: [
        tx.object(VERSION_OBJ),
        tx.object(EXISTING_OBLIGATION),
        tx.object(EXISTING_OBL_KEY),
        tx.object(MARKET_OBJ),
        tx.object(CDR),
        tx.pure.u64(1),
        tx.object(X_ORACLE),
        tx.object(CLOCK),
      ],
    });
    await di(tx, "borrow_entry(existing_obl, existing_key, amount=1 MIST)");
  }
  
  // Test 3: borrow (not entry) with amount=0 
  {
    const tx = new Transaction();
    tx.setSender(DUMMY);
    const [borrowedCoin] = tx.moveCall({
      target: `${SCALLOP_LATEST}::borrow::borrow`,
      typeArguments: [SUI_TYPE],
      arguments: [
        tx.object(VERSION_OBJ),
        tx.object(EXISTING_OBLIGATION),
        tx.object(EXISTING_OBL_KEY),
        tx.object(MARKET_OBJ),
        tx.object(CDR),
        tx.pure.u64(0),
        tx.object(X_ORACLE),
        tx.object(CLOCK),
      ],
    });
    tx.transferObjects([borrowedCoin], DUMMY);
    await di(tx, "borrow(existing_obl, amount=0)");
  }
}

main().catch(console.error);
