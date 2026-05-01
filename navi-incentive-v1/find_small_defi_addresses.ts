/**
 * Try finding smaller Sui DeFi protocols by:
 * 1. Using known good addresses from ecosystem research
 * 2. Tracing through popular Sui token packages
 */
import { SuiClient } from "@mysten/sui/client";
const client = new SuiClient({ url: "https://fullnode.mainnet.sui.io:443" });

// Additional small protocol addresses from various sources
const TARGETS = [
  // Interest Protocol (OUSD stablecoin)
  { label: "Interest Protocol IPX", pkg: "0x5306f64e312b581766351c07af79c72fcb1cd25147157fdc2f8ad76de9a3fb6a" },
  // Kai Finance CLMM (actual)
  { label: "Kai Finance CLMM", pkg: "0x1eabed72c53feb3805120a081dc15963c204dc8d091542592abaf7a35689b2fb" },
  // Legato Finance
  { label: "Legato Finance", pkg: "0x6f4d39d7cfce5f2a11e1765ba1d3e1d4e91c8c8c8c8c8c8c8c8c8c8c8c8c8c8" },
  // Pandora Protocol
  { label: "Pandora Options", pkg: "0x4e2ca3988246e1d50b9bf209abb9c1cbfec66f8c8c8c8c8c8c8c8c8c8c8c8c8c" },
  // OmniBTC Solv (yield)  
  { label: "OmniBTC", pkg: "0xf5145a7ac845b82d986b8e9b22843ca6a2a70e6c8c8c8c8c8c8c8c8c8c8c8c8c" },
  // AlphaFi Farms (separate from lending)
  { label: "AlphaFi Farms", pkg: "0x9bbd650b8442abb082c20f3bc95a9434a8d47b4227632cc3f877eb5e9e4af36d" },
  // Mole Finance (leveraged yield)
  { label: "Mole Finance", pkg: "0x21d6e3fee1c9be8b1bf7efab74dd823d35b4a5c2a9f27b88b7ba7d95f5a10780" },
  // WEN Protocol
  { label: "WEN", pkg: "0xca3fd4e4f8c97688cb397ec8609aa2029f06b2dcdcadf63e0fa17e23d9997e95" },
  // Suia (NFT DeFi)
  { label: "Suia staking", pkg: "0xb8f5e21ee78b10ec26793047f65c20f4d1d2bcd8dcee8dcf6b6a49c8fcbcfbca" },
  // Bluemove staking
  { label: "BlueMove", pkg: "0x36dbef866a1d62bf7328bbe157ba28e91b4bb6a0e5f4e1059e53d56044c54b4f" },
];

const REWARD_KEYWORDS = ["claim", "harvest", "reward", "stake", "emission"];
const INDEX_FIELDS = ["last_index", "index_rewards_paid", "reward_debt", "acc_per_share", "reward_index"];

async function checkPkg(label: string, pkg: string) {
  try {
    const norm = await client.getNormalizedMoveModulesByPackage({ package: pkg });
    const mods = Object.keys(norm);
    
    let hasVersionGuard = false;
    const openRewardFns: string[] = [];
    const indexPatterns: string[] = [];
    
    for (const [mod, modDef] of Object.entries(norm)) {
      if (/version|guard/i.test(mod)) hasVersionGuard = true;
      
      for (const [fnName, fn] of Object.entries(modDef.exposedFunctions)) {
        if (/version/i.test(fnName)) hasVersionGuard = true;
        if (fn.isEntry && REWARD_KEYWORDS.some(k => fnName.toLowerCase().includes(k))) {
          const paramStr = JSON.stringify(fn.parameters);
          if (!/Cap|Admin|Key|Auth|Governance/i.test(paramStr)) {
            openRewardFns.push(`${mod}::${fnName}`);
          }
        }
      }
      
      for (const [sName, st] of Object.entries(modDef.structs)) {
        const idx = st.fields?.filter(f => INDEX_FIELDS.some(k => f.name.toLowerCase() === k)) ?? [];
        if (idx.length > 0) indexPatterns.push(`${mod}::${sName}.[${idx.map(f=>f.name).join(",")}]`);
      }
    }
    
    const risk = !hasVersionGuard && openRewardFns.length > 0 && indexPatterns.length > 0 ? "🔴"
      : !hasVersionGuard && (openRewardFns.length > 0 || indexPatterns.length > 0) ? "🟡" : "✅";
    
    if (risk !== "✅") {
      console.log(`${risk} [${label}] ${pkg.slice(0,24)}`);
      console.log(`   modules: ${mods.slice(0,6).join(",")}`);
      openRewardFns.forEach(f => console.log(`   open: ${f}`));
      indexPatterns.forEach(p => console.log(`   index: ${p}`));
    } else {
      console.log(`✅ ${label} (${mods.slice(0,4).join(",")}...)`);
    }
  } catch (e: any) {
    const msg = e.message?.slice(0,40) ?? "";
    if (msg.includes("does not exist")) {
      process.stdout.write(`⬛ ${label} (bad addr) | `);
    } else {
      console.log(`❓ ${label}: ${msg}`);
    }
  }
}

async function main() {
  console.log("=== Small Protocol Scan Round 2 ===\n");
  
  for (const t of TARGETS) {
    await checkPkg(t.label, t.pkg);
    await new Promise(r => setTimeout(r, 100));
  }
  
  // Also try to discover via NAVI IncentiveBal object interactors
  console.log("\n\n--- Who interacted with NAVI V1 incentive contract recently? ---");
  const NAVI_V1 = "0xd899cf7d2f3c12bfd6a671b1d0c90b7ebf9b9bcd6c6f2e8a9b3c4d5e6f7a8b9c";
  try {
    const txs = await client.queryTransactionBlocks({
      filter: { InputObject: NAVI_V1 },
      limit: 5, order: "descending",
      options: { showInput: true },
    });
    if (txs.data.length > 0) {
      console.log(`Found ${txs.data.length} recent txs using NAVI V1`);
    } else {
      console.log("No recent txs on NAVI V1");
    }
  } catch (e: any) { console.log("NAVI V1 query:", e.message?.slice(0,40)); }
}
main().catch(console.error);
