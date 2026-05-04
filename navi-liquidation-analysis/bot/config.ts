/**
 * Bot tuning constants and asset metadata.
 * All tunable params live in config.json.
 * Network addresses and RPC URLs: network.ts uses sui_rpcs from here.
 * Private key: bot_key in config.json (keep config.json out of version control).
 */

import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dir = dirname(fileURLToPath(import.meta.url));

interface ConfigJson {
  dry_run:           boolean;
  min_profit_usd:    number;
  max_slippage_bps:  number;
  gas_wallet_mist:   number;
  gas_flash_mist:    number;
  gas_budget_mist:   number;
  hf_slow_threshold: number;
  slow_interval_ms:  number;
  auto_swap:         boolean;
  sui_rpcs:          string[];
  telegram_token:    string;
  telegram_chat:     string;
  bot_key:           string;
}

const _cfg: ConfigJson = JSON.parse(readFileSync(join(__dir, "config.json"), "utf8"));

// Sui system clock object (never changes)
export const CLOCK = "0x0000000000000000000000000000000000000000000000000000000000000006";
export const RAY   = BigInt("1000000000000000000000000000"); // 1e27

// Runtime flags — override via config.json
export const DRY_RUN            = process.env.DRY_RUN === "1" || _cfg.dry_run;
export const MIN_PROFIT_USD     = _cfg.min_profit_usd;
export const MAX_SLIPPAGE_BPS   = _cfg.max_slippage_bps;
export const GAS_WALLET_MIST    = BigInt(_cfg.gas_wallet_mist);
export const GAS_FLASH_MIST     = BigInt(_cfg.gas_flash_mist);
export const GAS_BUDGET_MIST    = BigInt(_cfg.gas_budget_mist);
export const HF_SLOW_THRESHOLD  = _cfg.hf_slow_threshold;
export const SLOW_INTERVAL_MS   = _cfg.slow_interval_ms;
export const AUTO_SWAP          = _cfg.auto_swap;

// Network / integration
export const SUI_RPCS        = _cfg.sui_rpcs;
export const TELEGRAM_TOKEN  = _cfg.telegram_token;
export const TELEGRAM_CHAT   = _cfg.telegram_chat;
export const BOT_KEY         = _cfg.bot_key;

// asset_id → metadata (tokenDec verified empirically; pyth = Pyth price feed ID)
export const ASSETS: Record<number, { symbol: string; pyth: string | null; tokenDec: number }> = {
    0:  { symbol: "SUI",    pyth: "0x23d7315113f5b1d3ba7a83604c44b94d79f4fd69af77f804fc7f920a6dc65744", tokenDec: 9 },
    1:  { symbol: "USDC",   pyth: "0xeaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a", tokenDec: 6 },
    2:  { symbol: "USDT",   pyth: "0x2b89b9dc8fdf9f34709a5b106b472f0f39bb6ca9ce04b0fd7f2e971688e2e53b", tokenDec: 6 },
    3:  { symbol: "WETH",   pyth: "0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace", tokenDec: 8 },
    4:  { symbol: "CETUS",  pyth: "0xe5b274b2611143df055d6e7cd8d93fe1961716bcd4dca1cad87a83bc1e78c1ef", tokenDec: 9 },
    5:  { symbol: "vSUI",   pyth: "0x23d7315113f5b1d3ba7a83604c44b94d79f4fd69af77f804fc7f920a6dc65744", tokenDec: 9 },
    6:  { symbol: "haSUI",  pyth: "0x23d7315113f5b1d3ba7a83604c44b94d79f4fd69af77f804fc7f920a6dc65744", tokenDec: 9 },
    7:  { symbol: "NAVX",   pyth: null, tokenDec: 9 },
    8:  { symbol: "WBTC",   pyth: "0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43", tokenDec: 8 },
    9:  { symbol: "AUSD",   pyth: "0xeaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a", tokenDec: 6 },
    10: { symbol: "USDC",   pyth: "0xeaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a", tokenDec: 6 },
    11: { symbol: "ETH",    pyth: "0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace", tokenDec: 8 },
    12: { symbol: "USDY",   pyth: null, tokenDec: 6 },
    13: { symbol: "NS",     pyth: null, tokenDec: 6 },
    14: { symbol: "BTC2",   pyth: null, tokenDec: 8 },
    15: { symbol: "DEEP",   pyth: null, tokenDec: 6 },
    16: { symbol: "FDUSD",  pyth: null, tokenDec: 6 },
    17: { symbol: "BLUE",   pyth: null, tokenDec: 9 },
    18: { symbol: "BUCK",   pyth: null, tokenDec: 9 },
    19: { symbol: "USDT",   pyth: null, tokenDec: 6 },
    20: { symbol: "stSUI",  pyth: null, tokenDec: 9 },
    21: { symbol: "BTC",    pyth: "0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43", tokenDec: 8 },
    22: { symbol: "a22",    pyth: null, tokenDec: 9 },
    23: { symbol: "LBTC",   pyth: null, tokenDec: 8 },
    24: { symbol: "WAL",    pyth: "0xeba0732395fae9dec4bae12e52760b35fc1c5671e2da8b449c9af4efe5d54341", tokenDec: 9 },
    25: { symbol: "HAEDAL", pyth: null, tokenDec: 9 },
    26: { symbol: "XBTC",   pyth: null, tokenDec: 8 },
    27: { symbol: "IKA",    pyth: null, tokenDec: 9 },
    28: { symbol: "a28",    pyth: null, tokenDec: 6 },
    29: { symbol: "MBTC",   pyth: null, tokenDec: 8 },
    30: { symbol: "YBTC",   pyth: null, tokenDec: 8 },
    31: { symbol: "XAUm",   pyth: "0xd7db067954e28f51a96fd50c6d51775094025ced2d60af61ec9803e553471c88", tokenDec: 9 },
    32: { symbol: "WBTC",   pyth: "0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43", tokenDec: 8 },
    33: { symbol: "suiUSDe", pyth: "0xeaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a", tokenDec: 6 },
    34: { symbol: "USDSUI", pyth: "0xeaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a", tokenDec: 6 },
    35: { symbol: "EACRED", pyth: "0x40ac3329933a6b5b65cf31496018c5764ac0567316146f7d0de00095886b480d", tokenDec: 6 },
};
