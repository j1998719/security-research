import { SuiClient } from "@mysten/sui/client";
import { Transaction } from "@mysten/sui/transactions";

const client = new SuiClient({ url: "https://fullnode.mainnet.sui.io:443" });
const DUMMY = "0x0000000000000000000000000000000000000000000000000000000000001337";
const NAVI_V15 = "0x1e4a13a0494d5facdbe8473e74127b838c2d446ecec0ce262e2eddafa77259cb";
const STORAGE  = "0xbb4e2f4b6205c2e2a2db47aeb4f830796ec7c005f88537ee775986639bc442fe";

// VMVerificationOrDeserializationError means type mismatch on args
// validate_deposit(storage, u8, u256) — Storage is a specific struct type
// We need to pass &mut Storage (MutableReference), not just the object ID

async function main() {
  console.log("=== Fix type passing for validate_* ===\n");
  
  // The validation functions take &mut Storage, not Storage
  // Let's check exact signatures again
  const vd = await client.getNormalizedMoveFunction({
    package: NAVI_V15, module: "validation", function: "validate_deposit"
  });
  console.log("validate_deposit full params:");
  vd.parameters.forEach((p, i) => {
    const s = JSON.stringify(p);
    const isMut = s.includes("MutableReference");
    const isRef = s.includes("Reference");
    console.log(`  [${i}]: ${isMut ? "&mut " : isRef ? "&" : ""}${s.slice(0, 100)}`);
  });
  
  const vb = await client.getNormalizedMoveFunction({
    package: NAVI_V15, module: "validation", function: "validate_borrow"
  });
  console.log("\nvalidate_borrow full params:");
  vb.parameters.forEach((p, i) => {
    const s = JSON.stringify(p);
    const isMut = s.includes("MutableReference");
    const isRef = s.includes("Reference");
    console.log(`  [${i}]: ${isMut ? "&mut " : isRef ? "&" : ""}${s.slice(0, 100)}`);
  });
}

main().catch(console.error);
