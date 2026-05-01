import { SuiClient } from "@mysten/sui/client";
import { Transaction } from "@mysten/sui/transactions";

const client = new SuiClient({ url: "https://fullnode.mainnet.sui.io:443" });
const DUMMY = "0x0000000000000000000000000000000000000000000000000000000000001337";

const SCALLOP_LATEST = "0xde5c09ad171544aa3724dc67216668c80e754860f419136a68d78504eb2e2805";
const VERSION_OBJ    = "0x07871c4b3c847a0f674510d4978d5cf6f960452795e8ff6f189fd2088a3f6ac7";
const MARKET_OBJ     = "0xa757975255146dc9686aa823b7838b507f315d704f428cbadad2f4ea061939d9";
const CDR            = "0x200abe9bf19751cc566ae35aa58e2b7e4ff688fc1130f8d8909ea09bc137d668";
const X_ORACLE       = "0x1478a432123e4b3d61878b629f2c692969fdb375644f1251cd278a4b1e7d7cd6";
const CLOCK          = "0x0000000000000000000000000000000000000000000000000000000000000006";
const SUI_TYPE       = "0x2::sui::SUI";

// Try: use an existing obligation (shared) + we don't own the key
// The borrow_entry expects &ObligationKey (immutable ref) so maybe we can borrow someone's obligation
// without owning the key? Let's test with a real obligation and a dummy address as key

// Actually, we need the ObligationKey to be a RESULT from the same PTB
// Let's create an obligation in a prior "block" and use it in borrow

// Another approach: look at Scallop GitHub source for borrow.move
// to find zero-amount check without needing to test it

async function main() {
  // From Scallop GitHub: https://github.com/scallop-io/sui-lending-protocol
  // contracts/protocol/sources/user/borrow.move
  // public entry fun borrow_entry<T>(..., amount: u64, ...) {
  //   let borrowed_coin = borrow<T>(..., amount, ...);
  //   ...
  // }
  // public fun borrow<T>(..., amount: u64, ...) {
  //   assert!(amount > 0, ERROR_BORROW_ZERO);
  // }
  
  // Let's check if there's a separate borrow module (non-entry) we can call
  const borrowMod = await client.getNormalizedMoveModule({ 
    package: SCALLOP_LATEST, module: "borrow" 
  });
  console.log("borrow module functions:");
  for (const [name, fn] of Object.entries(borrowMod.exposedFunctions)) {
    console.log(`  ${fn.visibility}${fn.isEntry ? " entry" : ""} ${name} [${fn.parameters.length} params]`);
  }
  
  // Also check borrow_fees or borrow_calc or borrow_validator modules
  for (const modName of ["borrow_fees", "borrow_calc", "interest_fee", "fee", "borrow_referral"]) {
    try {
      const m = await client.getNormalizedMoveModule({ package: SCALLOP_LATEST, module: modName });
      console.log(`${modName}: ${Object.keys(m.exposedFunctions).join(", ")}`);
    } catch(e: any) {}
  }
  
  // Look at what check happens at abort code 81926 for deposit(1 MIST)
  // 81926 = what module defines this?
  console.log("\n--- deposit_collateral abort 81926 analysis ---");
  // 81926 decimal = 0x14006
  // Scallop error codes typically: module_id * 1000 + error_id
  // 81926 / 1000 = 81.926 → not cleanly divisible
  // 81926 = 0x14006 hex
  // Some protocols use 0x prefix: 0x14 = 20 (category), 0x006 = 6 (error code within category)
  // OR: 81926 raw error code in deposit_collateral module
  console.log("abort 81926 = 0x" + (81926).toString(16) + " — likely coin type not registered or market state issue");
  
  // abort 1797 from deposit(0): 
  // 1797 = 0x705 → possible ERROR_ZERO_AMOUNT_DEPOSIT
  console.log("abort 1797 = 0x" + (1797).toString(16) + " — likely ZERO_AMOUNT or similar");
  
  // Now let's try to call borrow with an already-existing obligation
  // Use an existing shared obligation object by ID
  const EXISTING_OBLIGATION = "0x96b95bdbff34f1e8fa9bbb29c06466c3640d60375a09fc0d16de7805b79834af";
  
  // Verify it's shared
  const obj = await client.getObject({ id: EXISTING_OBLIGATION, options: { showContent: true, showOwner: true } });
  console.log("\nExisting obligation owner:", JSON.stringify(obj.data?.owner).slice(0, 60));
  const oblType = (obj.data?.content as any)?.type ?? "";
  console.log("Existing obligation type:", oblType.slice(0, 80));
}

main().catch(console.error);
