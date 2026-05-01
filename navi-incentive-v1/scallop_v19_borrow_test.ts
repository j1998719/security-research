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
  console.log(`[${label}] ${status} → ${error ? parseAbort(error) : "ok"}`);
  if (error && !error.includes("MoveAbort")) console.log("  raw:", error.slice(0, 150));
  return { status, error };
}

async function main() {
  console.log("=== Scallop v19 Borrow Zero-Amount Tests (with correct CDR) ===\n");
  
  // Verify CDR exists
  const cdr = await client.getObject({ id: CDR, options: { showContent: false, showOwner: true } });
  console.log("CDR owner:", JSON.stringify(cdr.data?.owner).slice(0, 50));
  
  // Also check Version object value
  const vObj = await client.getObject({ id: VERSION_OBJ, options: { showContent: true } });
  const vFields = (vObj.data?.content as any)?.fields ?? {};
  console.log("Version object value:", vFields.value);
  
  // Check what version SCALLOP_LATEST expects
  {
    const tx = new Transaction();
    tx.setSender(DUMMY);
    tx.moveCall({ 
      target: `${SCALLOP_LATEST}::version::value`, 
      typeArguments: [], 
      arguments: [tx.object(VERSION_OBJ)] 
    });
    const r = await client.devInspectTransactionBlock({ transactionBlock: tx, sender: DUMMY });
    const vBytes = r.results?.[0]?.returnValues?.[0];
    if (vBytes) {
      const v = Buffer.from(vBytes[0]).readBigUInt64LE(0);
      console.log("version::value() from latest pkg =", v.toString());
    }
  }
  
  console.log("\n--- borrow_entry(amount=0) ---");
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
  
  // amount=1
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
