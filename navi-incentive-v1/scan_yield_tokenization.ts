/**
 * Scan for Nemo-type vulnerabilities in other Sui yield tokenization protocols
 * Pattern: PT/YT split protocols (Pendle-like on Sui)
 * Targets: any protocol with py/sy modules or principal/yield token split
 */
import { SuiClient } from "@mysten/sui/client";
const client = new SuiClient({ url: "https://fullnode.mainnet.sui.io:443" });

// Known yield tokenization protocols on Sui (by research)
const TARGETS = [
  // Kai Finance (kSUI)
  { label: "Kai Finance", pkg: "0xfa7ac3951fdca92c5200d468d31a365eb03b2be9936fde615e69f0c1274ad3a0" },
  // Haedal Protocol
  { label: "Haedal", pkg: "0xdaa46292632c3c4d8f31f23ea0f9b36a28ff3677e9684980e4438403a67a3d8f" },
  // Spring Sui (sSUI issuer - might have yield components)
  { label: "Spring", pkg: "0x53a8c1ffcdac36d993ce3c454d001eca57224541d1953d827ef96ac6d7f8142e" },
  // Bucket Protocol (BUCK stablecoin)
  { label: "Bucket", pkg: "0xce7ff77a83ea0cb6fd39bd8748e2ec89a3f41e8efdc3f4eb123e0ca37b184db2" },
  // Typus Finance (yield vaults)
  { label: "Typus Finance", pkg: "0x4c0f5f1e5a0a5a9f0d6e4f1e5a0a5a9f0d6e4f1e5a0a5a9f0d6e4f1e5a0a5a9f" },
];

// Keywords for yield tokenization pattern
const YT_KEYWORDS = ["principal", "yield", "maturity", "expiry", "pt_", "yt_", "py_", "sy_", "interest_index", "yield_index"];
const FLASH_KEYWORDS = ["borrow", "flash", "flash_loan"];

async function checkProtocol(label: string, pkg: string) {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`[${label}] ${pkg.slice(0, 24)}...`);

  let modules: string[] = [];
  try {
    const norm = await client.getNormalizedMoveModulesByPackage({ package: pkg });
    modules = Object.keys(norm);
    console.log(`  Modules: ${modules.join(", ")}`);
  } catch (e: any) {
    console.log(`  ❌ Package error: ${e.message?.slice(0, 60)}`);
    return;
  }

  // Check for yield tokenization modules
  const ytModules = modules.filter(m => 
    m === "py" || m === "sy" || m === "pt" || m === "yt" ||
    m.includes("principal") || m.includes("yield") || m.includes("maturity")
  );
  if (ytModules.length > 0) {
    console.log(`  ⚠️  Yield tokenization modules: ${ytModules.join(", ")}`);
  }

  // Check for flash loan patterns
  for (const mod of modules.slice(0, 10)) {
    try {
      const normMod = await client.getNormalizedMoveModule({ package: pkg, module: mod });
      for (const [fnName, fn] of Object.entries(normMod.exposedFunctions)) {
        const lower = fnName.toLowerCase();
        
        // Flash loan check
        if (FLASH_KEYWORDS.some(k => lower.includes(k)) && fn.visibility === "Public") {
          // Check return type for hot potato
          const retStr = JSON.stringify(fn.return);
          console.log(`  🔍 Flash: ${mod}::${fnName} (entry=${fn.isEntry}) return=${retStr.slice(0,80)}`);
        }

        // Yield index mutation check
        if (YT_KEYWORDS.some(k => lower.includes(k)) && fn.visibility === "Public") {
          const hasMutRef = fn.parameters.some(p => JSON.stringify(p).includes("MutableReference"));
          if (hasMutRef) {
            console.log(`  ⚠️  Yield+MutRef: ${mod}::${fnName}(${fn.parameters.length} params, entry=${fn.isEntry})`);
          }
        }
      }
    } catch {}
  }
}

async function main() {
  for (const t of TARGETS) {
    await checkProtocol(t.label, t.pkg);
    await new Promise(r => setTimeout(r, 200));
  }

  // Also try searching for PT/YT-type events on Sui
  console.log("\n\n=== Searching for PT/YT protocols via event types ===");
  // SuiFrens / other protocols that emit maturity events
  const searchTerms = ["MaturityEvent", "MintPY", "RedeemPY", "FlashBorrow"];
  for (const term of searchTerms) {
    try {
      const evts = await client.queryEvents({
        query: { MoveEventType: `0x%::py::${term}` } as any, // wildcard doesn't work, but try
        limit: 1,
      });
      if (evts.data.length > 0) {
        console.log(`Found ${term}: ${evts.data[0].type}`);
      }
    } catch {}
  }
}
main().catch(console.error);
