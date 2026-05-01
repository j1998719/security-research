import { SuiClient } from "@mysten/sui/client";
import { Transaction } from "@mysten/sui/transactions";
const client = new SuiClient({ url: "https://fullnode.mainnet.sui.io:443" });

const PKG = "0x83bbe0b3985c5e3857803e2678899b03f3c4a31be75006ab03faf268c014ce41";
const DUMMY = "0x0000000000000000000000000000000000000000000000000000000000001337";

async function main() {
  console.log("=== Mystery Lending Package Deep Dive ===\n");
  console.log(`Package: ${PKG}`);

  // 1. Identify what protocol this is
  console.log("\n--- Protocol identification ---");
  try {
    // Check for known struct names
    for (const [mod, structs] of [
      ["market", ["Market", "Version", "VersionCap"]],
      ["obligation", ["Obligation", "ObligationKey"]],
      ["borrow_dynamics", ["BorrowDynamic", "BorrowIndex"]],
      ["flash_loan", ["FlashLoan", "FlashLoanReceipt", "Receipt"]],
    ] as [string, string[]][]) {
      for (const struct of structs) {
        try {
          const st = await client.getNormalizedMoveStruct({ package: PKG, module: mod, struct });
          console.log(`${mod}::${struct} exists, abilities: [${st.abilities.abilities.join(", ")}]`);
          // Print key fields
          for (const f of st.fields.slice(0, 5)) {
            const t = JSON.stringify(f.type).slice(0, 60);
            console.log(`  field ${f.name}: ${t}`);
          }
        } catch {}
      }
    }
  } catch {}

  // 2. Check version guard
  console.log("\n--- Version guard? ---");
  try {
    const mod = await client.getNormalizedMoveModule({ package: PKG, module: "current_version" });
    const fns = Object.keys(mod.exposedFunctions);
    console.log(`current_version fns: ${fns.join(", ")}`);
    
    const verFn = mod.exposedFunctions["check_version_and_upgrade"];
    if (verFn) console.log("Has check_version_and_upgrade");
    
    // Check market module for version field
    const market = await client.getNormalizedMoveModule({ package: PKG, module: "market" });
    for (const [name, struct] of Object.entries(market.structs)) {
      if (struct.fields?.some(f => f.name === "version")) {
        console.log(`market::${name} has version field`);
      }
    }
  } catch {}

  // 3. Flash loan hot potato check
  console.log("\n--- Flash loan hot potato ---");
  try {
    const fn = await client.getNormalizedMoveFunction({ package: PKG, module: "flash_loan", function: "borrow_flash_loan" });
    console.log(`borrow_flash_loan visibility: ${fn.visibility}, isEntry: ${fn.isEntry}`);
    console.log(`returns: ${JSON.stringify(fn.return).slice(0, 200)}`);
    
    // Check receipt type
    for (const ret of fn.return) {
      const s = JSON.stringify(ret);
      const addr = s.match(/"address":"([^"]+)"/)?.[1];
      const name = s.match(/"name":"([^"]+)"/)?.[1];
      const mod = s.match(/"module":"([^"]+)"/)?.[1];
      if (addr && name && mod && !["Coin", "Balance"].includes(name)) {
        try {
          const st = await client.getNormalizedMoveStruct({ package: addr, module: mod, struct: name });
          console.log(`Receipt type ${name} abilities: [${st.abilities.abilities.join(", ")}]`);
          if (st.abilities.abilities.length === 0) console.log("✅ Proper hot potato");
          else console.log("⚠️  NOT a hot potato");
        } catch {}
      }
    }
  } catch (e: any) { console.log("Error:", e.message?.slice(0,60)); }

  // 4. borrow_dynamics::update_borrow_index — can anyone call it?
  console.log("\n--- borrow_dynamics::update_borrow_index accessibility ---");
  try {
    const fn = await client.getNormalizedMoveFunction({ package: PKG, module: "borrow_dynamics", function: "update_borrow_index" });
    console.log(`visibility: ${fn.visibility}, isEntry: ${fn.isEntry}`);
    console.log("params:");
    for (let i = 0; i < fn.parameters.length; i++) {
      const p = JSON.stringify(fn.parameters[i]).slice(0, 100);
      console.log(`  [${i}]: ${p}`);
    }
    // If requires no cap/admin, might be callable
    const requiresCap = fn.parameters.some(p => {
      const s = JSON.stringify(p);
      return s.includes("Cap") || s.includes("Admin") || s.includes("Key");
    });
    console.log(`Requires cap/admin: ${requiresCap}`);
  } catch (e: any) { console.log("Error:", e.message?.slice(0,60)); }

  // 5. Check recent transactions on this package
  console.log("\n--- Recent transactions ---");
  try {
    const txs = await client.queryTransactionBlocks({
      filter: { MoveFunction: { package: PKG, module: "flash_loan" } },
      limit: 5,
      order: "descending",
    });
    console.log(`Recent flash_loan txs: ${txs.data.length}`);
    for (const tx of txs.data.slice(0, 3)) {
      console.log(`  ${tx.digest.slice(0,24)} @ checkpoint ${tx.checkpoint}`);
    }
  } catch (e: any) { console.log("Error:", e.message?.slice(0,60)); }

  // 6. Check if this is Scallop or NAVI
  console.log("\n--- Identify protocol ---");
  try {
    const evts = await client.queryEvents({
      query: { MoveEventModule: { package: PKG, module: "market" } },
      limit: 3,
      order: "descending",
    });
    if (evts.data.length > 0) {
      console.log(`Market events (latest): ${evts.data[0].type?.split("::").pop()}`);
      console.log(`TX: ${evts.data[0].id?.txDigest?.slice(0,24)}`);
    }
  } catch {}

  // Also check obligation events
  try {
    const evts = await client.queryEvents({
      query: { MoveEventModule: { package: PKG, module: "borrow" } },
      limit: 3,
      order: "descending",
    });
    if (evts.data.length > 0) {
      console.log(`Borrow events: ${evts.data[0].type?.split("::").pop()}`);
    }
  } catch {}
}
main().catch(console.error);
