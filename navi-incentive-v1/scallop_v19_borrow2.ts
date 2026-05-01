import { SuiClient } from "@mysten/sui/client";
import { Transaction } from "@mysten/sui/transactions";

const client = new SuiClient({ url: "https://fullnode.mainnet.sui.io:443" });
const DUMMY = "0x0000000000000000000000000000000000000000000000000000000000001337";

// Try different approach: use original package for the calls
const SCALLOP_LATEST = "0xde5c09ad171544aa3724dc67216668c80e754860f419136a68d78504eb2e2805";
const SCALLOP_ORIG   = "0xefe8b36d5b2e43728cc323298626b83177803521d195cfb11e15b910e892fddf";
const VERSION_OBJ    = "0x07871c4b3c847a0f674510d4978d5cf6f960452795e8ff6f189fd2088a3f6ac7";
const MARKET_OBJ     = "0xa757975255146dc9686aa823b7838b507f315d704f428cbadad2f4ea061939d9";
const CDR            = "0x200abe9bf19751cc566ae35aa58e2b7e4ff688fc1130f8d8909ea09bc137d668";
const X_ORACLE       = "0x1478a432123e4b3d61878b629f2c692969fdb375644f1251cd278a4b1e7d7cd6";
const CLOCK          = "0x0000000000000000000000000000000000000000000000000000000000000006";
const SUI_TYPE       = "0x2::sui::SUI";

// The Scallop upgrade architecture: 
// When a package is upgraded, the NEW package receives objects created by the ORIGINAL package
// But the function call target must use the LATEST package address
// The InvariantViolation suggests that the version check is blocking us

// borrow_entry calls assert_current_version(version)
// The Version object has value=9 but the latest pkg might expect exactly 9 or uses assert_current_version
// InvariantViolation is different from MoveAbort — it means there's a structural error

// Let's check: does SCALLOP_LATEST borrow_entry have a different signature?

async function main() {
  console.log("=== Scallop borrow_entry signature analysis ===\n");
  
  // Check borrow_entry in latest pkg
  const fn = await client.getNormalizedMoveFunction({
    package: SCALLOP_LATEST, module: "borrow", function: "borrow_entry"
  });
  console.log("Latest borrow_entry params:");
  fn.parameters.forEach((p, i) => {
    const s = JSON.stringify(p);
    const isMut = s.includes("MutableReference");
    const isRef = s.includes("Reference");
    const pkg = s.match(/"address":"(0x[0-9a-f]+)"/)?.[1] ?? "";
    const name = s.match(/"name":"(\w+)"/)?.[1] ?? s.slice(0, 60);
    console.log(`  [${i}]: ${isMut ? "&mut " : isRef ? "& " : ""}${name} [pkg: ${pkg.slice(0,16)}...]`);
  });
  
  // Check open_obligation in latest pkg
  const fn2 = await client.getNormalizedMoveFunction({
    package: SCALLOP_LATEST, module: "open_obligation", function: "open_obligation"
  });
  console.log("\nLatest open_obligation return types:");
  fn2.return?.forEach((r, i) => {
    const s = JSON.stringify(r);
    const name = s.match(/"name":"(\w+)"/)?.[1] ?? s.slice(0, 60);
    console.log(`  [${i}]: ${name}`);
  });
  
  // The problem with InvariantViolation: maybe we're calling borrow_entry with 
  // obligation from SCALLOP_LATEST::open_obligation but borrow_entry expects
  // the obligation type from a different package address
  
  // Check: does borrow_entry reference the ORIGINAL obligation type?
  console.log("\nObligation param in borrow_entry:");
  const obligParam = fn.parameters[1];
  console.log("  param[1]:", JSON.stringify(obligParam).slice(0, 150));
  
  // Check if the Obligation and ObligationKey types are from different packages
  const obligKeyParam = fn.parameters[2];
  console.log("  param[2]:", JSON.stringify(obligKeyParam).slice(0, 150));
}

main().catch(console.error);
