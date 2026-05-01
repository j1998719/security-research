import { SuiClient } from "@mysten/sui/client";
import { Transaction } from "@mysten/sui/transactions";

const client = new SuiClient({ url: "https://fullnode.mainnet.sui.io:443" });
const DUMMY = "0x0000000000000000000000000000000000000000000000000000000000001337";
const SCALLOP_LATEST = "0xde5c09ad171544aa3724dc67216668c80e754860f419136a68d78504eb2e2805";

// 1284 as abort code: this is the oracle price stale/invalid check
// Scallop's borrow_internal must call get_price which checks oracle freshness
// In devInspect, oracle won't be updated so BOTH amount=0 and amount=1 fail at oracle check

// To find where zero check is, look at Scallop source (public GitHub):
// https://github.com/scallop-io/sui-lending-protocol/blob/main/contracts/protocol/sources/user/borrow.move

// From source (line ~30-40):
// public fun borrow<T>(
//   version: &Version,
//   obligation: &mut Obligation,
//   obligation_key: &ObligationKey,
//   market: &mut Market,
//   coin_decimals_registry: &CoinDecimalsRegistry,
//   borrow_amount: u64,
//   x_oracle: &XOracle,
//   clock: &Clock,
//   ctx: &mut TxContext,
// ): Coin<T> {
//   version::assert_current_version(version);
//   obligation::assert_key_match(obligation, obligation_key);
//   assert!(borrow_amount > 0, error::borrow_zero_amount_error());  // <-- ZERO CHECK
//   // ... then oracle check
// }

// The order in source: version_check → key_match → ZERO CHECK → oracle check
// So abort 1284 (oracle) comes AFTER the zero check
// But we see BOTH amount=0 and amount=1 hitting 1284...

// UNLESS: abort 770 (from existing obligation test) = "coin type not registered in market"
// and abort 1284 = oracle freshness check

// Let's check the source carefully:
// The first check after assert zero: 
// 1. assert_key_match - checks obligation_key.ownership.obligation_id == obligation.id
// 2. When creating a new obligation and using it in same PTB, key DOES match
// 3. assert!(borrow_amount > 0) - the zero check
// 4. oracle freshness check

// So if both hit 1284, the zero check was PASSED (amount=0 didn't trigger abort)
// OR they both fail at key_match before reaching zero check

// Actually: if PTB creates obligation and uses obligationKey in borrow,
// the key should match because they're from the same open_obligation call

// Conclusion: abort 1284 is AFTER the zero-amount check
// This means: Scallop borrow(amount=0) DOES NOT have a zero-amount check? 
// OR: the zero check aborts with a different code

// Let's check the exact error codes by looking at Scallop's error module
async function main() {
  console.log("=== Scallop error code analysis ===\n");
  
  // Check if there's an error module
  for (const modName of ["error", "errors", "error_code", "borrow_error"]) {
    try {
      const m = await client.getNormalizedMoveModule({ package: SCALLOP_LATEST, module: modName });
      const fns = Object.keys(m.exposedFunctions).slice(0, 10);
      console.log(`${modName} module: ${fns.join(", ")}`);
    } catch(e: any) {}
  }
  
  // Check the Scallop ORIG package for error module
  const SCALLOP_ORIG = "0xefe8b36d5b2e43728cc323298626b83177803521d195cfb11e15b910e892fddf";
  for (const modName of ["error", "errors", "error_code"]) {
    try {
      const m = await client.getNormalizedMoveModule({ package: SCALLOP_ORIG, module: modName });
      const fns = Object.keys(m.exposedFunctions).slice(0, 20);
      console.log(`ORIG ${modName} module: ${fns.join(", ")}`);
    } catch(e: any) {}
  }
  
  // Analysis summary
  console.log("\n=== Interpretation ===");
  console.log("abort 770 (borrow_internal, no collateral in obl) = likely: COLLATERAL_NOT_SUFFICIENT or DEBT_TYPE_NOT_SUPPORTED");
  console.log("abort 1284 (borrow_internal, with collateral in same PTB) = likely: ORACLE_PRICE_STALE");
  console.log("If both amount=0 and amount=1 hit 1284, the zero check comes BEFORE 1284 but AFTER 770");
  console.log("If zero check fires FIRST, amount=0 would abort with a DIFFERENT code than amount=1");
  console.log("\n=== CRITICAL QUESTION ===");
  console.log("Do amount=0 and amount=1 hit 1284 at the SAME instruction?");
  console.log("If yes → zero check either doesn't exist OR comes after 1284 gate");
  console.log("If no (different instructions) → zero check is somewhere in there");
}

main().catch(console.error);
