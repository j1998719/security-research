import { SuiClient } from "@mysten/sui/client";
const client = new SuiClient({ url: "https://fullnode.mainnet.sui.io:443" });

const REWARD_KW = ["claim", "reward", "harvest", "redeem", "collect_reward", "stake", "update_points"];

async function checkPkg(label: string, pkg: string) {
  try {
    const mods = await client.getNormalizedMoveModulesByPackage({ package: pkg });
    const modNames = Object.keys(mods);
    let hasVersionGuard = false;
    const rewardEntries: string[] = [];
    const rewardTrackingStructs: string[] = [];

    for (const [modName, modData] of Object.entries(mods)) {
      const structs = (modData as any).structs ?? {};
      for (const [sname, sd] of Object.entries(structs)) {
        const fields = (sd as any).fields ?? [];
        if (fields.some((f: any) => f.name === "version" || f.name === "package_version")) hasVersionGuard = true;
        // Check for reward-index tracking patterns
        if (fields.some((f: any) => ["index", "last_index", "user_index", "reward_index", "last_update_index"].includes(f.name))) {
          rewardTrackingStructs.push(`${modName}::${sname}`);
        }
      }
      const fns = (modData as any).exposedFunctions ?? {};
      for (const [fnName, fnData] of Object.entries(fns)) {
        if (REWARD_KW.some(kw => fnName.toLowerCase().includes(kw)) && (fnData as any).isEntry) {
          rewardEntries.push(`${modName}::${fnName}`);
        }
      }
    }

    const interesting = !hasVersionGuard && (rewardEntries.length > 0 || rewardTrackingStructs.length > 0);
    const symbol = interesting ? "⚠️" : "✓";
    console.log(`${symbol} ${label} (${pkg.slice(0,18)}...) guard=${hasVersionGuard?"YES":"NO"} entries=${rewardEntries.length} tracking_structs=${rewardTrackingStructs.length}`);
    if (!hasVersionGuard && rewardEntries.length > 0) {
      for (const fn of rewardEntries) console.log(`    [entry] ${fn}`);
    }
    if (rewardTrackingStructs.length > 0 && !hasVersionGuard) {
      console.log(`    [structs with index] ${rewardTrackingStructs.join(", ")}`);
    }
    return { hasVersionGuard, rewardEntries, rewardTrackingStructs };
  } catch { return null; }
}

async function main() {
  // Scallop BorrowIncentive base package (used by both old and new)
  await checkPkg("Scallop BorrowInc BASE", "0x41c0788f4ab64cf36dc882174f467634c033bf68c3c1b5ef9819507825eb510b");
  
  // The new BorrowIncentive pkg found in recent txs
  // tx showed: 0x74922703605ba0548a55::user::stake — need full ID
  // Let me search for it via recent events
  
  // Haedal Protocol - haSUI liquid staking
  // Token: 0xbde4ba4c2e274a60ce15c1cfff9e5c42e41654ac8b6d906a57efa4bd3c29f47d::hasui::HASUI
  await checkPkg("Haedal haSUI pkg", "0xbde4ba4c2e274a60ce15c1cfff9e5c42e41654ac8b6d906a57efa4bd3c29f47d");
  
  // Aftermath staking (af-SUI) 
  await checkPkg("Aftermath afSUI pkg", "0x7f6ce7ade63857c4fd16ef7783fed2dfc4d7fb7e40615abdb653030b76aef0c6");
  
  // DEEP token protocol (DeepBook?) 
  await checkPkg("DeepBook V3", "0xdeeb7a4662eec9f2f3def03fb937a663dddaa2e215b8078a284d026b7946c270");
  
  // Bucket Protocol  
  await checkPkg("Bucket BKT", "0xce7ff77a83ea0cb6fd39bd8748e2ec89a3f41e8efdc3f4eb123e0ca37b184db2");
  
  // NAVX token (NAVI token)
  await checkPkg("NAVX token", "0xa99b8952d4f7d947ea77fe0ecdcc9e5fc0bcab2841d6e2a5aa00c3044e5544b5");
  
  // SCA token (Scallop token) 
  await checkPkg("SCA token", "0x7016aae72cfc67f2fadf55769c0a7dd54291a583b63051a5ed71081cce836ac6");
  
  // stSUI token (Haedal or other) 
  await checkPkg("stSUI (stsui)", "0xd1b72982e40348d069bb1ff701e634c117bb5f741f44dff91e472d3b01461e55");
  
  // IKA token
  await checkPkg("IKA", "0x7262fb2f7a3a14c888c438a3cd9b912469a58cf60f367352c46584262e8299aa");
  
  // WAL token (Walrus)
  await checkPkg("WAL/Walrus", "0x356a26eb9e012a68958082340d4c4116e7f55615cf27affcff209cf0ae544f59");
  
  // BLUE token
  await checkPkg("BLUE", "0xe1b45a0e641b9955a20aa0ad1c1f4ad86aad8afb07296d4085e349a50e90bdca");
  
  // HAEDAL token
  await checkPkg("HAEDAL token", "0x3a304c7feba2d819ea57c3542d68439ca2c386ba02159c740f7b406e592c62ea");
  
  // xBTC
  await checkPkg("xBTC", "0x876a4b7bce8aeaef60464c11f4026903e9afacab79b9b142686158aa86560b50");
}
main().catch(console.error);
