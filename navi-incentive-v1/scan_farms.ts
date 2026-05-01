import { SuiClient } from "@mysten/sui/client";
const client = new SuiClient({ url: "https://fullnode.mainnet.sui.io:443" });

const REWARD_KW = ["claim", "reward", "harvest", "redeem", "collect_reward"];
const INDEX_FIELDS = ["index", "last_index", "user_index", "reward_index", "acc_reward", "reward_per_share", "reward_debt"];

async function checkPkg(label: string, pkg: string) {
  try {
    const mods = await client.getNormalizedMoveModulesByPackage({ package: pkg });
    let hasVersionGuard = false;
    const rewardEntries: string[] = [];
    const indexStructs: string[] = [];
    
    for (const [modName, modData] of Object.entries(mods)) {
      const structs = (modData as any).structs ?? {};
      for (const [sname, sd] of Object.entries(structs)) {
        const fields = (sd as any).fields ?? [];
        if (fields.some((f: any) => f.name === "version" || f.name === "package_version")) hasVersionGuard = true;
        if (fields.some((f: any) => INDEX_FIELDS.includes(f.name))) {
          indexStructs.push(`${modName}::${sname}[${fields.filter((f: any) => INDEX_FIELDS.includes(f.name)).map((f: any) => f.name).join(",")}]`);
        }
      }
      const fns = (modData as any).exposedFunctions ?? {};
      for (const [fnName, fnData] of Object.entries(fns)) {
        if (REWARD_KW.some(kw => fnName.toLowerCase().includes(kw)) && (fnData as any).isEntry) {
          rewardEntries.push(`${modName}::${fnName}`);
        }
      }
    }

    if (rewardEntries.length > 0 || indexStructs.length > 0) {
      console.log(`${!hasVersionGuard && (rewardEntries.length > 0 || indexStructs.length > 0) ? "⚠️" : "✓"} ${label}`);
      console.log(`   pkg=${pkg.slice(0,22)} guard=${hasVersionGuard?"YES":"NO"}`);
      if (rewardEntries.length > 0) console.log(`   entries: ${rewardEntries.join(", ")}`);
      if (indexStructs.length > 0) console.log(`   index_structs: ${indexStructs.join(", ")}`);
    }
  } catch { /* skip */ }
}

async function main() {
  // Protocols with farm/staking functionality not yet checked
  
  // Kai Finance (kSUI)
  await checkPkg("Kai Finance kSUI",   "0xfa7ac3951fdca92c5200d468d31a365eb03b2be9936fde615e69f0c1274ad3a0");
  await checkPkg("Kai Finance v2",     "0xf325ce1300e8dac124071d3152c5c5ee6174914f8bc2161e88329cf579246efc");
  
  // Nemo Protocol
  await checkPkg("Nemo Finance",       "0x0e20b9eeda9ff9daf9cf9b68b3f46c8c5d54e1b0b70d9e37b7f1e24d5c6f9a3");
  
  // Interest Protocol
  await checkPkg("Interest Protocol",  "0x5c45d10c26c5fb53bfaff819237aa12aa4a25d68e2f1bde2831b09f7f50e7e55");
  
  // Typus Finance (DOV)
  await checkPkg("Typus Finance",      "0x4a7b2c3e1d5f8a9b0c2d4e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b");
  
  // FlowX Finance (farming)
  await checkPkg("FlowX farm",         "0xba153169476e8c3114962261d1edc70de5ad9781b83cc617ecc8c1923191cae0");
  
  // Suia (launch platform)
  await checkPkg("Suia",               "0x3c4059c4e22dcf4b6d7e7cdaade1b3e0d4b4b2c4e6f8a0b2c4d6e8f0a2b4c6d8");
  
  // Port Finance Sui
  await checkPkg("Port Finance",       "0x6a45882bfe6b65be25c04fd98d9f6b7cd90f2f79ea85f83ab47eae7de8d5aed");
  
  // Scallop veSCA
  await checkPkg("Scallop veSCA",      "0x3a5e3a8b813a24f5f6b0a1c7e2d3b8f1c4a5e6d7b8c9d0e1f2a3b4c5d6e7f8a9");
  
  // Doubleup (social gambling)
  await checkPkg("DoubleUp",           "0x0e20b9eeda9ff9daf9cf9b68b3f46c8c5d54e1b0b70d9e37b7f1e24d5c6f9a3");
  
  // Kriya DEX farms
  await checkPkg("Kriya farm",         "0x2bfc50e6b6ca08c27f9de6a9ab2a7e6a7d9e1c6b9e3f2d8a7b3c5e4f6a8d1c2");
  
  // Look for Sui staking/farm protocols via events search
  console.log("\n=== Searching by recent high-value events ===");
  // Check some known addresses from NAVI SDK token list
  const tokenPkgs = [
    "0xa99b8952d4f7d947ea77fe0ecdcc9e5fc0bcab2841d6e2a5aa00c3044e5544b5", // NAVX
    "0x960b531667636f39e85867775f52f6b1f220a058c4de786905bdf761e06a56bb", // USDY (Ondo)
    "0x5145494a5f5100e645e4b0aa950fa6b68f614e8c59e17bc5ded3495123a79178", // NS (Suins)
    "0x5f496ed5d9d045c5b788dc1bb85f54100f2ede11e46f6a232c29daada4c5bdb6", // SUI-based
    "0x2053d08c1e2bd02791056171aab0fd12bd7cd7efad2ab8f6b9c8902f14df2ff2", // AUSD
  ];
  for (const pkg of tokenPkgs) {
    await checkPkg(`Token pkg ${pkg.slice(0,14)}`, pkg);
  }
}
main().catch(console.error);
