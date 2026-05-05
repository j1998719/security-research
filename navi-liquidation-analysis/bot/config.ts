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
export const GAS_FLASH_MIST          = BigInt(_cfg.gas_flash_mist);
// Wallet-swap PTB is 2 Cetus flash swaps + NAVI liquidation — actual gas lighter than full budget.
// Use 60% of GAS_FLASH_MIST as the profit-calculator estimate.
export const GAS_WALLET_SWAP_MIST    = BigInt(_cfg.gas_flash_mist) * 60n / 100n;
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
    7:  { symbol: "NAVX",   pyth: "0x88250f854c019ef4f88a5c073d52a18bb1c6ac437033f5932cd017d24917ab46", tokenDec: 9 },
    8:  { symbol: "WBTC",   pyth: "0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43", tokenDec: 8 },
    9:  { symbol: "AUSD",   pyth: "0xeaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a", tokenDec: 6 },
    10: { symbol: "USDC",   pyth: "0xeaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a", tokenDec: 6 },
    11: { symbol: "ETH",    pyth: "0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace", tokenDec: 8 },
    12: { symbol: "USDY",   pyth: "0xe393449f6aff8a4b6d3e1165a7c9ebec103685f3b41e60db4277b5b6d10e7326", tokenDec: 6 },
    13: { symbol: "NS",     pyth: "0xbb5ff26e47a3a6cc7ec2fce1db996c2a145300edc5acaabe43bf9ff7c5dd5d32", tokenDec: 6 },
    14: { symbol: "BTC2",   pyth: "0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43", tokenDec: 8 },
    15: { symbol: "DEEP",   pyth: "0x29bdd5248234e33bd93d3b81100b5fa32eaa5997843847e2c2cb16d7c6d9f7ff", tokenDec: 6 },
    16: { symbol: "FDUSD",  pyth: "0xccdc1a08923e2e4f4b1e6ea89de6acbc5fe1948e9706f5604b8cb50bc1ed3979", tokenDec: 6 },
    17: { symbol: "BLUE",   pyth: "0x04cfeb7b143eb9c48e9b074125c1a3447b85f59c31164dc20c1beaa6f21f2b6b", tokenDec: 9 },
    18: { symbol: "BUCK",   pyth: "0xfdf28a46570252b25fd31cb257973f865afc5ca2f320439e45d95e0394bc7382", tokenDec: 9 },
    19: { symbol: "USDT",   pyth: "0x2b89b9dc8fdf9f34709a5b106b472f0f39bb6ca9ce04b0fd7f2e971688e2e53b", tokenDec: 6 },
    20: { symbol: "stSUI",  pyth: "0x0b3eae8cb6e221e7388a435290e0f2211172563f94769077b7f4c4c6a11eea76", tokenDec: 9 },
    21: { symbol: "BTC",    pyth: "0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43", tokenDec: 8 },
    22: { symbol: "LBTC2",  pyth: "0x8f257aab6e7698bb92b15511915e593d6f8eae914452f781874754b03d0c612b", tokenDec: 9 },
    23: { symbol: "LBTC",   pyth: "0x8f257aab6e7698bb92b15511915e593d6f8eae914452f781874754b03d0c612b", tokenDec: 8 },
    24: { symbol: "WAL",    pyth: "0xeba0732395fae9dec4bae12e52760b35fc1c5671e2da8b449c9af4efe5d54341", tokenDec: 9 },
    25: { symbol: "HAEDAL", pyth: "0xe67d98cc1fbd94f569d5ba6c3c3c759eb3ffc5d2b28e64538a53ae13efad8fd1", tokenDec: 9 },
    26: { symbol: "XBTC",   pyth: "0xae8f269ed9c4bed616c99a98cf6dfe562bd3202e7f91821a471ff854713851b4", tokenDec: 8 },
    27: { symbol: "IKA",    pyth: "0x2b529621fa6e2c8429f623ba705572aa64175d7768365ef829df6a12c9f365f4", tokenDec: 9 },
    28: { symbol: "LBTC3",  pyth: "0x8f257aab6e7698bb92b15511915e593d6f8eae914452f781874754b03d0c612b", tokenDec: 6 },
    29: { symbol: "MBTC",   pyth: "0x6665073f5bc307b97e68654ff11f3d8875abd6181855814d23ab01b8085c0906", tokenDec: 8 },
    30: { symbol: "YBTC",   pyth: "0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43", tokenDec: 8 },
    31: { symbol: "XAUm",   pyth: "0xd7db067954e28f51a96fd50c6d51775094025ced2d60af61ec9803e553471c88", tokenDec: 9 },
    32: { symbol: "WBTC",   pyth: "0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43", tokenDec: 8 },
    33: { symbol: "suiUSDe", pyth: "0xeaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a", tokenDec: 6 },
    34: { symbol: "USDSUI", pyth: "0xeaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a", tokenDec: 6 },
    35: { symbol: "EACRED", pyth: "0x40ac3329933a6b5b65cf31496018c5764ac0567316146f7d0de00095886b480d", tokenDec: 6 },
};
