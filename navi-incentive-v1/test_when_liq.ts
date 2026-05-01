import { SuiClient } from "@mysten/sui/client";
import { Transaction } from "@mysten/sui/transactions";

const client = new SuiClient({ url: "https://fullnode.mainnet.sui.io:443" });

const NAVI_V15_PKG  = "0x1e4a13a0494d5facdbe8473e74127b838c2d446ecec0ce262e2eddafa77259cb";
const STORAGE       = "0xbb4e2f4b6205c2e2a2db47aeb4f830796ec7c005f88537ee775986639bc442fe";
const DUMMY         = "0x0000000000000000000000000000000000000000000000000000000000001337";

async function testWhenLiquidatable() {
  console.log("=== Test: when_liquidatable(storage, borrower=DUMMY, liquidator=DUMMY) ===");
  console.log("when_liquidatable aborts if condition not met");
  
  const tx = new Transaction();
  tx.setSender(DUMMY);
  
  tx.moveCall({
    target: `${NAVI_V15_PKG}::storage::when_liquidatable`,
    typeArguments: [],
    arguments: [
      tx.object(STORAGE),
      tx.pure.address(DUMMY), // borrower
      tx.pure.address(DUMMY), // liquidator = borrower (SELF)
    ],
  });
  
  const result = await client.devInspectTransactionBlock({
    transactionBlock: tx,
    sender: DUMMY,
  });
  
  const status = result.effects?.status?.status;
  const error  = result.effects?.status?.error ?? "";
  console.log("Result:", status);
  console.log("Error:", error.slice(0, 600));
  
  if (status === "success") {
    console.log(">>> when_liquidatable PASSED for self-reference! No self-check in when_liquidatable.");
  } else {
    const abortMatch = error.match(/abort_code: (\d+)|MoveAbort.*?, (\d+)\)|, (\d+)\)/);
    const code = abortMatch ? (abortMatch[1] || abortMatch[2] || abortMatch[3]) : null;
    console.log("Abort code:", code);
    if (error.includes("1038") || error.includes("SELF_LIQUIDATION")) {
      console.log(">>> EXPLICIT SELF-LIQUIDATION GUARD CONFIRMED");
    } else if (code === "1001" || error.includes("not_liquidatable") || error.includes("health")) {
      console.log(">>> Failed at health factor check - DUMMY not undercollateralized");
      console.log(">>> Self-liquidation guard unclear from this test alone");
    }
  }
}

// Also test with a REAL borrower address (known NAVI user)
async function testRealBorrowerSelfLiq() {
  // Use one of the known protected users: 0x57b87865...
  // If they are in protected list, only designated liquidators can liquidate them
  // But let's use a different known NAVI borrower
  const REAL_BORROWER = "0x3f40bc9aca5e62681904762ef2c04161d9fd142fe4dc2e5348f71cf2cf5207fa"; // from real liq tx
  
  console.log("\n=== Test: when_liquidatable(storage, borrower=REAL, liquidator=REAL) ===");
  console.log("borrower = liquidator = known NAVI borrower (self-liquidation)");
  
  const tx = new Transaction();
  tx.setSender(REAL_BORROWER);
  
  tx.moveCall({
    target: `${NAVI_V15_PKG}::storage::when_liquidatable`,
    typeArguments: [],
    arguments: [
      tx.object(STORAGE),
      tx.pure.address(REAL_BORROWER), // borrower = real NAVI user
      tx.pure.address(REAL_BORROWER), // liquidator = SAME (self)
    ],
  });
  
  const result = await client.devInspectTransactionBlock({
    transactionBlock: tx,
    sender: REAL_BORROWER,
  });
  
  const status = result.effects?.status?.status;
  const error  = result.effects?.status?.error ?? "";
  console.log("Result:", status);
  console.log("Error:", error.slice(0, 600));
  
  if (status === "success") {
    console.log(">>> SELF-LIQUIDATION ALLOWED by when_liquidatable! No borrower != liquidator check.");
    console.log(">>> The self-liquidation vulnerability is CONFIRMED at the storage level.");
  } else {
    const codeMatch = error.match(/MoveAbort.*?(\d+)\)/);
    const code = codeMatch ? codeMatch[1] : 'unknown';
    console.log("Abort code:", code);
    if (code === "1038") {
      console.log(">>> PATCHED: self-liquidation guard (1038 = typical self-liq error code)");
    } else {
      console.log(">>> Aborted for other reason - need to analyze");
    }
  }
}

async function main() {
  await testWhenLiquidatable();
  await testRealBorrowerSelfLiq();
}

main().catch(console.error);
