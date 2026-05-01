import { SuiClient } from "@mysten/sui/client";
import { Transaction } from "@mysten/sui/transactions";

const client = new SuiClient({ url: "https://fullnode.mainnet.sui.io:443" });
const DUMMY = "0x0000000000000000000000000000000000000000000000000000000000001337";

const SCALLOP_LATEST = "0xde5c09ad171544aa3724dc67216668c80e754860f419136a68d78504eb2e2805";
const X_ORACLE = "0x1478a432123e4b3d61878b629f2c692969fdb375644f1251cd278a4b1e7d7cd6";
const CDR      = "0x200abe9bf19751cc566ae35aa58e2b7e4ff688fc1130f8d8909ea09bc137d668";

async function main() {
  // Check x_oracle type
  const oracleObj = await client.getObject({ id: X_ORACLE, options: { showContent: true } });
  const oracleType = (oracleObj.data?.content as any)?.type ?? "";
  console.log("X_ORACLE type:", oracleType.slice(0, 120));
  
  // Check CDR type
  const cdrObj = await client.getObject({ id: CDR, options: { showContent: true } });
  const cdrType = (cdrObj.data?.content as any)?.type ?? "";
  console.log("CDR type:", cdrType.slice(0, 120));
  
  // Check what borrow_entry expects for XOracle
  const fn = await client.getNormalizedMoveFunction({
    package: SCALLOP_LATEST, module: "borrow", function: "borrow_entry"
  });
  console.log("\nborrow_entry param types:");
  fn.parameters.forEach((p, i) => {
    const s = JSON.stringify(p);
    const pkg = s.match(/"address":"(0x[0-9a-f]+)"/)?.[1] ?? "";
    const module_ = s.match(/"module":"(\w+)"/)?.[1] ?? "";
    const name = s.match(/"name":"(\w+)"/)?.[1] ?? "?";
    if (pkg) {
      console.log(`  [${i}]: ${pkg.slice(0,16)}...::${module_}::${name}`);
    } else {
      console.log(`  [${i}]: ${name}`);
    }
  });
}

main().catch(console.error);
