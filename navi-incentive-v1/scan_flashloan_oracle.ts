/**
 * Scan for:
 * 1. Nemo-type: flash loan without hot potato repayment enforcement
 *    - entry fn returns Coin<T> directly OR flash_loan fn is public without receipt
 * 2. Oracle-type: protocols that might use AMM spot prices
 *    - Look for calls to pool/CLMM price functions in lending protocols
 */
import { SuiClient } from "@mysten/sui/client";
const client = new SuiClient({ url: "https://fullnode.mainnet.sui.io:443" });

const FLASH_KEYWORDS = ["flash", "loan", "borrow", "lend"];

async function scanPkg(label: string, pkg: string) {
  console.log(`\n${"=".repeat(55)}`);
  console.log(`[${label}] ${pkg.slice(0,26)}...`);

  try {
    const norm = await client.getNormalizedMoveModulesByPackage({ package: pkg });
    const modules = Object.keys(norm);
    console.log(`Modules: ${modules.join(", ")}`);

    for (const mod of modules) {
      const normMod = norm[mod];
      
      for (const [fnName, fnDef] of Object.entries(normMod.exposedFunctions)) {
        const lower = fnName.toLowerCase();
        const hasFlashKw = FLASH_KEYWORDS.some(k => lower.includes(k));
        if (!hasFlashKw) continue;

        // Check parameters for hot potato (no-ability receipt/cap)
        const params = fnDef.parameters.map(p => JSON.stringify(p));
        const returnTypes = fnDef.return?.map(r => JSON.stringify(r)) ?? [];
        
        // Look for return types that include Coin/Balance (potential unsafe flash loan)
        const returnsCoin = returnTypes.some(r => r.includes("balance") || r.includes("Balance") || r.includes("Coin") || r.includes("coin"));
        
        // Check if return includes a receipt/cap type (hot potato = has no abilities)
        // Typically flash receipts are named: Receipt, FlashLoan, Ticket, Promise
        const returnsReceipt = returnTypes.some(r => 
          r.toLowerCase().includes("receipt") || 
          r.toLowerCase().includes("flashloan") || 
          r.toLowerCase().includes("ticket") ||
          r.toLowerCase().includes("promise") ||
          r.toLowerCase().includes("hot")
        );

        const mark = fnDef.isEntry ? "✅entry" : "   pub";
        if (returnsCoin && !returnsReceipt) {
          console.log(`  🔴 FLASH RISK? ${mod}::${fnName} returns Coin/Balance WITHOUT receipt`);
          console.log(`     isEntry:${fnDef.isEntry} returns:[${returnTypes.slice(0,3).join(",")}]`);
        } else if (hasFlashKw) {
          // Log all flash-related functions for review
          console.log(`  ${mark} ${mod}::${fnName} returns:[${returnTypes.slice(0,2).map(r => {
            const name = r.match(/"name":"(\w+)"/)?.[1] ?? r.slice(0,20);
            return name;
          }).join(",")}]`);
        }
      }

      // Oracle check: look for price/quote getters in structs
      for (const [sName, sDef] of Object.entries(normMod.structs)) {
        const fields = sDef.fields?.map((f: any) => f.name) ?? [];
        const hasPriceFeed = fields.some(f => f.includes("price") || f.includes("oracle") || f.includes("feed") || f.includes("twap"));
        if (hasPriceFeed) {
          console.log(`  [ORACLE STRUCT] ${mod}::${sName}: ${fields.filter(f => f.includes("price") || f.includes("oracle") || f.includes("feed")).join(", ")}`);
        }
      }
    }
  } catch (e: any) {
    console.log(`ERROR: ${e.message?.slice(0,80)}`);
  }
}

async function main() {
  const TARGETS = [
    // Lending protocols with flash loan capabilities
    { label: "Scallop Lending", pkg: "0xefe8b36d5b2e43728cc323298626b83177803521d195cfb11e15b910e892fddf" },
    { label: "Suilend", pkg: "0xf95b06143fe2104bd06d7dd4a5aaf51ea906e4d1adca7e6339e59c2c15aee8a2" },
    { label: "NAVI Protocol v2", pkg: "0x1729d61a35df2a72c37de62a44aed2fc62e9f63bebb4024eddbb40e5e6cd9b15" },
    // Bucket Protocol (CDP with flash loan)
    { label: "Bucket Protocol", pkg: "0xce7ff77a83ea0cb6fd39bd8748e2ec89a3f41e8efdc3f4eb123e0ca37b184db2" },
    // Typus Perp (has flash loan?)
    { label: "Typus Perp v2", pkg: "0x9003219180252ae6b81d2893b41d430488669027219537236675c0c2924c94d9" },
    // AlphaFi Lending
    { label: "AlphaFi Lending", pkg: "0x2f8f6d5da7f13ea37daa397724441673fe3e6251600ef5925a866f16c3872e3e" },
  ];

  for (const t of TARGETS) {
    await scanPkg(t.label, t.pkg);
    await new Promise(r => setTimeout(r, 200));
  }

  console.log("\n=== DONE ===");
  console.log("🔴 = flash loan returns Coin without hot potato receipt");
  console.log("[ORACLE STRUCT] = protocol tracks price data internally (may use spot price)");
}
main().catch(console.error);
