/**
 * Check NAVI Protocol other packages + Scallop Spool V1 (pre-V2)
 * NAVI SDK: https://github.com/naviprotocol/navi-sdk/blob/main/src/address.ts
 */
import { SuiClient } from "@mysten/sui/client";
const client = new SuiClient({ url: "https://fullnode.mainnet.sui.io:443" });

const REWARD_KEYWORDS = ["claim", "reward", "harvest", "collect", "redeem", "earn", "incentive", "emission", "vest"];

async function checkPkg(label: string, pkg: string) {
  console.log(`\n=== [${label}] ${pkg.slice(0, 24)}... ===`);
  try {
    const norm = await client.getNormalizedMoveModulesByPackage({ package: pkg });
    const modules = Object.keys(norm);
    console.log(`Modules: ${modules.join(", ")}`);

    let hasVersionGuard = false;
    const entries: string[] = [];
    const indexPatterns: string[] = [];

    for (const mod of modules) {
      const normMod = norm[mod];
      for (const [fnName, fnDef] of Object.entries(normMod.exposedFunctions)) {
        if (fnDef.isEntry) {
          entries.push(`${mod}::${fnName}`);
          const lower = fnName.toLowerCase();
          if (REWARD_KEYWORDS.some(k => lower.includes(k))) {
            const params = fnDef.parameters.map(p => {
              const s = JSON.stringify(p);
              return s.match(/"name":"(\w+)"/)?.[1] ?? s.slice(0, 20);
            });
            console.log(`  ✅ REWARD ENTRY: ${mod}::${fnName}(${params.slice(0,5).join(",")})`);
          }
        }
        const allLower = (mod + fnName).toLowerCase();
        if (allLower.includes("version") || allLower.includes("versioned")) {
          hasVersionGuard = true;
        }
      }
      for (const [sName, sDef] of Object.entries(normMod.structs)) {
        if (sDef.fields?.some((f: any) => f.name === "version")) hasVersionGuard = true;
        const idxFields = sDef.fields?.filter((f: any) =>
          f.name.includes("index") || f.name.includes("reward_debt") || f.name === "accrued_rewards"
        ).map((f: any) => f.name);
        if (idxFields && idxFields.length > 0) {
          indexPatterns.push(`${mod}::${sName}[${idxFields.join(",")}]`);
        }
      }
    }

    console.log(`Version guard: ${hasVersionGuard ? "✅ YES" : "❌ NONE ⚠️"}`);
    if (indexPatterns.length > 0) {
      console.log(`INDEX PATTERNS: ${indexPatterns.slice(0, 5).join("; ")}`);
    }
  } catch (e: any) {
    console.log(`ERROR: ${e.message?.slice(0, 100)}`);
  }
}

async function main() {
  // NAVI Protocol other packages
  // From navi-sdk address.ts (approximate based on known protocol structure)
  const TARGETS = [
    // Scallop Spool V1 (pre-V2)
    { label: "Scallop Spool V1", pkg: "0xe87f1b2d498106a2c61421cec75b7b5c5e348512b0dc263949a0e7a3c256571a" },
    // NAVI flash loan package
    { label: "NAVI Flash Loan", pkg: "0x8375a5fad54c74ef42168e0f3e8ee58c14dbda09b15b01c7b6c1c89bb8f9a90c" },
    // NAVI Oracle
    { label: "NAVI Oracle", pkg: "0x9183f69a0bcc5c7c2b99afbcab45e12ea6cdbaa0e8cf9bba2609c3d71f22067f" },
    // Turbos Finance old package (pre-version-guard, let's verify)
    { label: "Turbos CLMM v1 (old)", pkg: "0x91bfbc386a41afcfd9b2533058d7e915a1d3829089cc268ff4333d54d6339ca1" },
    // FlowX older FaaS
    { label: "FlowX FaaS old", pkg: "0xba153169476e8c3114962261d1edc70de5ad9781b83cc617ecc8c1923191cae0" },
  ];

  for (const t of TARGETS) {
    await checkPkg(t.label, t.pkg);
    await new Promise(r => setTimeout(r, 200));
  }
}
main().catch(console.error);
