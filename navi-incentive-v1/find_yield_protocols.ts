import { SuiClient } from "@mysten/sui/client";
const client = new SuiClient({ url: "https://fullnode.mainnet.sui.io:443" });

async function main() {
  console.log("=== Find Yield Tokenization Protocols on Sui ===\n");

  // 1. Search for MarketCreatedEvent type across any package
  // Nemo uses MarketCreatedEvent - other similar protocols might too
  console.log("--- Searching for market/yield events ---");
  const eventTypes = [
    "MarketCreatedEvent", "MintPY", "MintYT", "MintPT",
    "BurnPY", "RedeemYield", "YieldClaimed", "PrincipalToken"
  ];

  for (const evtType of eventTypes) {
    try {
      // We can't do wildcard package search, but let's see if there are known events
      const evts = await client.queryEvents({
        query: { MoveEventType: `0x2b71664477755b90f9fb71c9c944d5d0d3832fec969260e3f18efc7d855f57c4::market_factory::${evtType}` },
        limit: 1,
      });
      if (evts.data.length > 0) {
        console.log(`Nemo::market_factory::${evtType}: found`);
      }
    } catch {}
  }

  // 2. Check Haedal Protocol (liquid staking)
  console.log("\n--- Haedal Protocol search ---");
  // Try to find via known haedal token
  try {
    const resp = await (client as any).transport.request({
      method: "suix_queryObjects",
      params: [
        { filter: { StructType: "0x2::coin::CoinMetadata" } },
        null, 50, false,
      ],
    });
    // Won't work - too many coins
  } catch {}

  // Try known Haedal addresses from ecosystem data
  const haedal_candidates = [
    "0xdaa46292632c3c4d8f31f23ea0f9b36a28ff3677e9684980e4438403a67a3d8f", // wrong
    "0x50a0a8c29e4431c4025d4d8d1afacf1e6e89c61df9bd4c5b2d7c47c85f5c4b2e", // guess
  ];

  // 3. Check Typus Finance correct address
  // Typus Finance yield products
  console.log("\n--- Looking for Typus yield products ---");
  // Their perps package was found: 0xe27969a7... and 0x90032191...
  // Let me check their options/yield product packages
  const typus_packages = [
    "0xe27969a7ab3f9ba84da8ee0cee17e4e86b50d00f7e2a65bfa1f36c4efd8a2fdc",
    "0x9003219110acc3cdb27d83e07ddbdaff17e15ef6acf01e3f8a14ad89c98e8de8",
  ];

  for (const pkg of typus_packages) {
    try {
      const norm = await client.getNormalizedMoveModulesByPackage({ package: pkg });
      const mods = Object.keys(norm);
      const ytMods = mods.filter(m => 
        m.includes("yield") || m.includes("principal") || m.includes("maturity") ||
        m === "py" || m === "sy" || m === "pt" || m === "yt"
      );
      if (ytMods.length > 0) {
        console.log(`${pkg.slice(0,20)}: yield modules: ${ytMods.join(", ")}`);
      } else {
        console.log(`${pkg.slice(0,20)}: modules=${mods.slice(0,5).join(", ")}...`);
      }
    } catch (e: any) {
      console.log(`${pkg.slice(0,20)}: error ${e.message?.slice(0,40)}`);
    }
  }

  // 4. Bucket Protocol flash loan check - is flash_borrow safe?
  console.log("\n--- Bucket Protocol flash_borrow hot potato check ---");
  const BUCKET = "0xce7ff77a83ea0cb6fd39bd8748e2ec89a3f41e8efdc3f4eb123e0ca37b184db2";
  try {
    // Check FlashReceipt type
    const st = await client.getNormalizedMoveStruct({ package: BUCKET, module: "buck", struct: "FlashReceipt" });
    console.log(`FlashReceipt abilities: [${st.abilities.abilities.join(", ")}]`);
    if (st.abilities.abilities.length === 0) console.log("✅ Proper hot potato");
    else console.log("⚠️  Has abilities:", st.abilities.abilities.join(", "));
  } catch (e: any) {
    // Try other struct names
    console.log("FlashReceipt not found, trying other names...");
    for (const name of ["Receipt", "FlashLoan", "LoanReceipt", "BorrowReceipt"]) {
      try {
        const st = await client.getNormalizedMoveStruct({ package: BUCKET, module: "buck", struct: name });
        console.log(`${name} abilities: [${st.abilities.abilities.join(", ")}]`);
        break;
      } catch {}
    }
  }

  // 5. Check flash_borrow return type in detail
  try {
    const fn = await client.getNormalizedMoveFunction({ package: BUCKET, module: "buck", function: "flash_borrow" });
    console.log(`flash_borrow returns: ${JSON.stringify(fn.return).slice(0,150)}`);
    // If second return is a struct with no abilities, it's a hot potato
    const secondRet = fn.return[1];
    if (secondRet) {
      const retStr = JSON.stringify(secondRet);
      const addr = retStr.match(/"address":"([^"]+)"/)?.[1];
      const name = retStr.match(/"name":"([^"]+)"/)?.[1];
      if (addr && name) {
        try {
          const mod = retStr.match(/"module":"([^"]+)"/)?.[1];
          const st = await client.getNormalizedMoveStruct({ package: addr, module: mod!, struct: name });
          console.log(`Receipt type ${name} abilities: [${st.abilities.abilities.join(", ")}]`);
          if (st.abilities.abilities.length === 0) console.log("✅ Bucket flash loan has hot potato receipt");
          else console.log(`⚠️  NOT a hot potato! Abilities: ${st.abilities.abilities.join(", ")}`);
        } catch {}
      }
    }
  } catch {}
}
main().catch(console.error);
