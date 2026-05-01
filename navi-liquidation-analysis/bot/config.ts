/**
 * NAVI Protocol constants and asset registry.
 * Private key is loaded from NAVI_BOT_KEY env var (hex, no 0x prefix).
 */

export const SUI_RPC    = process.env.SUI_RPC    ?? "https://fullnode.mainnet.sui.io:443";
export const PYTH_WS    = process.env.PYTH_WS    ?? "wss://hermes.pyth.network/ws";

export const NAVI_PKG     = "0x1e4a13a0494d5facdbe8473e74127b838c2d446ecec0ce262e2eddafa77259cb";
export const NAVI_STORAGE = "0xbb4e2f4b6205c2e2a2db47aeb4f830796ec7c005f88537ee775986639bc442fe";
export const PYTH_ORACLE  = "0x1568865ed9a0b5ec414220e8f79b3d04c77acc82358f6e5ae4635687392ffbef";
export const CLOCK        = "0x0000000000000000000000000000000000000000000000000000000000000006";
export const ZERO_ADDR    = "0x0000000000000000000000000000000000000000000000000000000000000000";

export const RAY = BigInt("1000000000000000000000000000"); // 1e27

// Dry-run mode: compute and log opportunities but don't submit transactions
export const DRY_RUN = process.env.DRY_RUN === "1";

// Skip positions with expected profit (in SUI) below this threshold
export const MIN_PROFIT_SUI = 0.5;

// Gas budget for liquidation PTB (in MIST = 1e9 SUI)
export const GAS_BUDGET_MIST = BigInt(100_000_000); // 0.1 SUI

// Slow tier: positions with HF > this value are refreshed every SLOW_INTERVAL_MS
export const HF_SLOW_THRESHOLD = 1.5;
export const SLOW_INTERVAL_MS  = 60_000;

// asset_id → metadata
export const ASSETS: Record<number, {
  symbol:    string;
  pyth:      string | null; // Pyth price feed ID
  tokenDec:  number;
  priceDec:  number;
}> = {
  0:  { symbol: "SUI",         pyth: "0x23d7315113f5b1d3ba7a83604c44b94d79f4fd69af77f804fc7f920a6dc65744", tokenDec: 9, priceDec: 9 },
  1:  { symbol: "USDC",        pyth: "0xeaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a", tokenDec: 6, priceDec: 6 },
  2:  { symbol: "USDT",        pyth: "0x2b89b9dc8fdf9f34709a5b106b472f0f39bb6ca9ce04b0fd7f2e971688e2e53b", tokenDec: 6, priceDec: 6 },
  3:  { symbol: "WETH",        pyth: "0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace", tokenDec: 8, priceDec: 8 },
  4:  { symbol: "CETUS",       pyth: "0xe5b274b2611143df055d6e7cd8d93fe1961716bcd4dca1cad87a83bc1e78c1ef", tokenDec: 9, priceDec: 7 },
  5:  { symbol: "haSUI",       pyth: "0x23d7315113f5b1d3ba7a83604c44b94d79f4fd69af77f804fc7f920a6dc65744", tokenDec: 9, priceDec: 9 },
  6:  { symbol: "WBTC",        pyth: "0xc9d8b075a5c69303365ae23633d4e085199bf5c520a3b90fed1322a0342ffc33", tokenDec: 8, priceDec: 8 },
  7:  { symbol: "NAVX",        pyth: null, tokenDec: 9, priceDec: 9 },
  9:  { symbol: "AUSD",        pyth: "0xeaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a", tokenDec: 6, priceDec: 6 },
  10: { symbol: "USDC-native", pyth: "0xeaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a", tokenDec: 6, priceDec: 6 },
  11: { symbol: "ETH",         pyth: "0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace", tokenDec: 8, priceDec: 8 },
  21: { symbol: "BTC",         pyth: "0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43", tokenDec: 8, priceDec: 8 },
};
