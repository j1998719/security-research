"""
NAVI Protocol constants and asset registry.
"""

SUI_RPC     = "https://fullnode.mainnet.sui.io:443"
PYTH_WS     = "wss://hermes.pyth.network/ws"
PYTH_HTTP   = "https://hermes.pyth.network"

NAVI_PKG     = "0x1e4a13a0494d5facdbe8473e74127b838c2d446ecec0ce262e2eddafa77259cb"
NAVI_STORAGE = "0xbb4e2f4b6205c2e2a2db47aeb4f830796ec7c005f88537ee775986639bc442fe"

RAY = int(1e27)

# asset_id -> (symbol, pyth_feed_id, token_decimals, price_decimals, liq_threshold, liq_bonus)
# liq_threshold / RAY, liq_bonus / RAY are read from chain at startup
ASSETS: dict[int, dict] = {
    0:  {"symbol": "SUI",        "pyth": "0x23d7315113f5b1d3ba7a83604c44b94d79f4fd69af77f804fc7f920a6dc65744", "token_dec": 9,  "price_dec": 9},
    1:  {"symbol": "USDC",       "pyth": "0xeaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a", "token_dec": 6,  "price_dec": 6},
    2:  {"symbol": "USDT",       "pyth": "0x2b89b9dc8fdf9f34709a5b106b472f0f39bb6ca9ce04b0fd7f2e971688e2e53b", "token_dec": 6,  "price_dec": 6},
    3:  {"symbol": "WETH",       "pyth": "0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace", "token_dec": 8,  "price_dec": 8},
    4:  {"symbol": "CETUS",      "pyth": "0xe5b274b2611143df055d6e7cd8d93fe1961716bcd4dca1cad87a83bc1e78c1ef", "token_dec": 9,  "price_dec": 7},
    5:  {"symbol": "haSUI",      "pyth": "0x23d7315113f5b1d3ba7a83604c44b94d79f4fd69af77f804fc7f920a6dc65744", "token_dec": 9,  "price_dec": 9},  # proxy SUI price
    6:  {"symbol": "WBTC",       "pyth": "0xc9d8b075a5c69303365ae23633d4e085199bf5c520a3b90fed1322a0342ffc33", "token_dec": 8,  "price_dec": 8},
    7:  {"symbol": "NAVX",       "pyth": None,                                                                   "token_dec": 9,  "price_dec": 9},
    9:  {"symbol": "AUSD",       "pyth": "0xeaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a", "token_dec": 6,  "price_dec": 6},
    10: {"symbol": "USDC-native","pyth": "0xeaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a", "token_dec": 6,  "price_dec": 6},
    11: {"symbol": "ETH",        "pyth": "0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace", "token_dec": 8,  "price_dec": 8},
    21: {"symbol": "BTC",        "pyth": "0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43", "token_dec": 8,  "price_dec": 8},
}

# slow polling interval for low-risk positions (HF > 1.5)
SLOW_INTERVAL_S  = 60.0
# fast: every price tick (on Pyth update event)

# liquidation profit threshold: skip if expected profit < this (SUI)
MIN_PROFIT_SUI   = 0.5

# gas budget for liquidation PTB (SUI)
GAS_BUDGET_SUI   = 0.1
