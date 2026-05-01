/**
 * Scallop Zero-Amount Boundary Tests
 * Direction 2: Test deposit with amount=0 and borrow with amount=0
 */
import { SuiClient } from "@mysten/sui/client";
import { Transaction } from "@mysten/sui/transactions";

const client = new SuiClient({ url: "https://fullnode.mainnet.sui.io:443" });

const SCALLOP = "0xefe8b36d5b2e43728cc323298626b83177803521d195cfb11e15b910e892fddf";
const VERSION = "0x07871c4b3c847a0f674510d4978d5cf6f960452795e8ff6f189fd2088a3f6ac7";
const MARKET  = "0xa757975255146dc9686aa823b7838b507f315d704f428cbadad2f4ea061939d9";
const COIN_DECIMALS_REGISTRY = "0xcf78430b3c3942f90e16aafc422c4c40398a02bda2045492a66d183752a494b2";
const CLOCK   = "0x0000000000000000000000000000000000000000000000000000000000000006";
const DUMMY   = "0x0000000000000000000000000000000000000000000000000000000000001337";
const SUI_TYPE = "0x2::sui::SUI";

// We need X Oracle for borrow
// Get x_oracle from borrow transactions
async function getXOracle(): Promise<string> {
  // From previous audits, x_oracle is at:
  return "0x1478a432123e4b3d61878b629f2c692969fdb375644f1251cd278a4b1e7d7cd6";
}

async function testDepositCollateralZero() {
  console.log("[TEST 1] deposit_collateral with amount=0");
  // deposit_collateral(version, &mut obligation, &mut market, Coin<T>, &mut ctx)
  
  const tx = new Transaction();
  tx.setSender(DUMMY);
  
  // First create an Obligation
  const [obligation, obligationKey, hotPotato] = tx.moveCall({
    target: `${SCALLOP}::open_obligation::open_obligation`,
    typeArguments: [],
    arguments: [tx.object(VERSION)],
  });
  
  // Create zero SUI coin
  const [zeroCoin] = tx.splitCoins(tx.gas, [tx.pure.u64(0)]);
  
  // Deposit 0
  tx.moveCall({
    target: `${SCALLOP}::deposit_collateral::deposit_collateral`,
    typeArguments: [SUI_TYPE],
    arguments: [
      tx.object(VERSION),
      obligation,
      tx.object(MARKET),
      zeroCoin,
    ],
  });
  
  // Must return obligation hot potato
  tx.moveCall({
    target: `${SCALLOP}::open_obligation::return_obligation`,
    typeArguments: [],
    arguments: [tx.object(VERSION), obligation, hotPotato],
  });
  
  // Transfer key to self
  tx.transferObjects([obligationKey], DUMMY);
  
  const r = await client.devInspectTransactionBlock({ transactionBlock: tx, sender: DUMMY });
  const status = r.effects?.status?.status;
  const error  = r.effects?.status?.error ?? "";
  console.log("  Result:", status);
  console.log("  Error:", error.slice(0, 300));
  
  if (status === "success") {
    console.log("  🚨 ZERO COLLATERAL DEPOSIT ACCEPTED! State mutation with 0 value!");
    const events = r.events ?? [];
    console.log("  Events:", events.map(e => e.type).join(", "));
  } else {
    const code = error.match(/MoveAbort.+?, (\d+)\)/)?.[1];
    if (code) console.log("  Abort code:", code);
    if (error.includes("command 0")) console.log("  → Failed at open_obligation");
    else if (error.includes("command 1")) console.log("  → Failed at zero coin split");
    else if (error.includes("command 2")) console.log("  → Failed at deposit_collateral (ZERO CHECK!)");
  }
  return { status, error };
}

async function testBorrowZero() {
  console.log("\n[TEST 2] borrow with amount=0");
  
  // First find an existing obligation to try borrowing from
  const EXISTING_OBLIGATION = "0x96b95bdbff34f1e8fa9bbb29c06466c3640d60375a09fc0d16de7805b79834af";
  const EXISTING_OBLIGATION_KEY = "0xcaf1603e92145c04afaf02334054f92bbbc012632b20932cad24841d93e4cd14";
  // Note: we don't own the key, but this will tell us which error fires first
  
  const x_oracle = await getXOracle();
  
  // Attempt with our own newly created obligation
  const tx = new Transaction();
  tx.setSender(DUMMY);
  
  const [obligation, obligationKey, hotPotato] = tx.moveCall({
    target: `${SCALLOP}::open_obligation::open_obligation`,
    typeArguments: [],
    arguments: [tx.object(VERSION)],
  });
  
  // Try to borrow 0 SUI with no collateral (health factor will fail)
  tx.moveCall({
    target: `${SCALLOP}::borrow::borrow_entry`,
    typeArguments: [SUI_TYPE],
    arguments: [
      tx.object(VERSION),
      obligation,
      obligationKey,
      tx.object(MARKET),
      tx.object(COIN_DECIMALS_REGISTRY),
      tx.pure.u64(0),  // amount = 0
      tx.object(x_oracle),
      tx.object(CLOCK),
    ],
  });
  
  tx.moveCall({
    target: `${SCALLOP}::open_obligation::return_obligation`,
    typeArguments: [],
    arguments: [tx.object(VERSION), obligation, hotPotato],
  });
  
  tx.transferObjects([obligationKey], DUMMY);
  
  const r = await client.devInspectTransactionBlock({ transactionBlock: tx, sender: DUMMY });
  const status = r.effects?.status?.status;
  const error  = r.effects?.status?.error ?? "";
  console.log("  Result:", status);
  console.log("  Error:", error.slice(0, 300));
  
  if (status === "success") {
    console.log("  🚨 ZERO BORROW ACCEPTED! Can create empty debt position!");
  } else {
    const code = error.match(/MoveAbort.+?, (\d+)\)/)?.[1];
    if (code) console.log("  Abort code:", code);
    // Check which command failed
    const cmd = error.match(/in command (\d+)/)?.[1];
    console.log("  Failed at command:", cmd);
    if (cmd === "1") console.log("  → borrow_entry failed (amount=0 check or health factor)");
  }
  return { status, error };
}

async function main() {
  console.log("=".repeat(60));
  console.log("  Scallop Zero-Amount Boundary Tests — devInspect ONLY");
  console.log("=".repeat(60));
  
  await testDepositCollateralZero();
  await testBorrowZero();
}

main().catch(console.error);
