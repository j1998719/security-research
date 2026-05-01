import { SuiClient } from "@mysten/sui/client";
import { Transaction } from "@mysten/sui/transactions";

const client = new SuiClient({ url: "https://fullnode.mainnet.sui.io:443" });
const DUMMY    = "0x0000000000000000000000000000000000000000000000000000000000001337";
const NAVI_V15 = "0x1e4a13a0494d5facdbe8473e74127b838c2d446ecec0ce262e2eddafa77259cb";
const STORAGE  = "0xbb4e2f4b6205c2e2a2db47aeb4f830796ec7c005f88537ee775986639bc442fe";

// VMVerificationOrDeserializationError likely because validate_deposit 
// expects &mut Storage from 0xd899... but the function is in v15 package
// The Storage TYPE must match - it IS from 0xd899 package
// The issue may be: public function that requires FRIEND visibility?

async function main() {
  // Check visibility of validate_deposit
  const vd = await client.getNormalizedMoveFunction({
    package: NAVI_V15, module: "validation", function: "validate_deposit"
  });
  console.log("validate_deposit visibility:", vd.visibility, "isEntry:", vd.isEntry);
  
  const vb = await client.getNormalizedMoveFunction({
    package: NAVI_V15, module: "validation", function: "validate_borrow"
  });
  console.log("validate_borrow visibility:", vb.visibility, "isEntry:", vb.isEntry);
  
  // If visibility is "Friend", we can't call it directly from PTB
  // That would explain VMVerificationOrDeserializationError
  
  // Let's also check utils::split_coin visibility
  const sc = await client.getNormalizedMoveFunction({
    package: NAVI_V15, module: "utils", function: "split_coin"
  });
  console.log("utils::split_coin visibility:", sc.visibility, "isEntry:", sc.isEntry);
  
  // The abort 46000 from utils::split_coin when deposit amount=0 is key
  // It means the zero check happens at coin split time, not in validate_deposit
  // Let's verify: what does utils::split_coin do with amount=0?
  // Error occurs even before validate_deposit is reached
  
  // The entry_borrow_v2(amount=0) aborts in validation::validate_borrow at code 1503
  // This is a borrow-specific abort code
  // 1503 is likely: BORROW_AMOUNT_CANNOT_BE_ZERO or similar
  
  // Let's look at what entry_deposit and entry_borrow call internally
  // by checking the v15 utils::split_coin function
  const splitParams = sc.parameters.map((p, i) => {
    const s = JSON.stringify(p);
    return `[${i}]:${s.slice(0, 60)}`;
  });
  console.log("\nutils::split_coin params:", splitParams.join(", "));
  console.log("utils::split_coin return:", JSON.stringify(sc.return).slice(0, 80));
  
  // Try calling split_coin directly
  console.log("\n=== Test utils::split_coin(coin, 0) ===");
  {
    const tx = new Transaction();
    tx.setSender(DUMMY);
    const c = tx.splitCoins(tx.gas, [10]); // coin with 10 MIST
    const [part] = tx.moveCall({
      target: `${NAVI_V15}::utils::split_coin`,
      typeArguments: ["0x2::sui::SUI"],
      arguments: [c, tx.pure.u64(0)],
    });
    // need to transfer back
    tx.transferObjects([part], tx.pure.address(DUMMY));
    const r = await client.devInspectTransactionBlock({ transactionBlock: tx, sender: DUMMY });
    const err = r.effects?.status?.error ?? "";
    const abortMatch = err.match(/MoveAbort\(.+?, (\d+)\)/);
    const modMatches = [...err.matchAll(/name: Identifier\("([^"]+)"\)/g)].map(m => m[1]);
    const fnMatch = err.match(/function_name: Some\("([^"]+)"\)/);
    console.log(`split_coin(10, 0): ${r.effects?.status?.status} → abort ${abortMatch?.[1]} @ ${modMatches.join("::")}::${fnMatch?.[1]}`);
  }
  
  // Test split_coin with amount=1
  {
    const tx = new Transaction();
    tx.setSender(DUMMY);
    const c = tx.splitCoins(tx.gas, [10]);
    const [part] = tx.moveCall({
      target: `${NAVI_V15}::utils::split_coin`,
      typeArguments: ["0x2::sui::SUI"],
      arguments: [c, tx.pure.u64(1)],
    });
    tx.transferObjects([part], tx.pure.address(DUMMY));
    const r = await client.devInspectTransactionBlock({ transactionBlock: tx, sender: DUMMY });
    const err = r.effects?.status?.error ?? "";
    const abortMatch = err.match(/MoveAbort\(.+?, (\d+)\)/);
    console.log(`split_coin(10, 1): ${r.effects?.status?.status} ${abortMatch ? "→ abort " + abortMatch[1] : "(no abort)"}`);
  }
}

main().catch(console.error);
