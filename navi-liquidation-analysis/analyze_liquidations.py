#!/usr/bin/env python3
"""
NAVI Protocol Liquidation History Analyzer

每筆清算記錄：
- 時間戳、tx digest
- liquidator vs borrower（是否自清算）
- 抵押品資產 / 負債資產 / 清算金額
- 清算時的 collateral_price & debt_price（來自 NAVI event）
- Pyth 同時間點的現貨價格
- 價格差（NAVI 用的 oracle 價 vs Pyth hermes 歷史價）
- Gas 費用（SUI）
- Checkpoint 號碼
- 距離前一筆清算的時間間隔（同 borrower）

輸出：logs/liquidations.csv + logs/liquidations.jsonl
"""

import requests
import json
import csv
import time
import os
from datetime import datetime, timezone

# ── 常數 ──────────────────────────────────────────────────────────────────────

RPC = "https://fullnode.mainnet.sui.io:443"
PYTH_API = "https://hermes.pyth.network/api/get_price_feed"

NAVI_PKG = "0x1e4a13a0494d5facdbe8473e74127b838c2d446ecec0ce262e2eddafa77259cb"
EVENT_TYPE = f"{NAVI_PKG}::event::LiquidationEvent"

# asset_id → (symbol, Pyth price feed ID, token_decimals, price_decimals)
# price_decimals: raw oracle price / 10^price_decimals = USD value
# Validated empirically: SUI event price ~920853790, Pyth ~0.921 → price_dec=9
# USDC event price ~999756, expected ~$1 → price_dec=6
ASSET_MAP = {
    0:  ("SUI",        "0x23d7315113f5b1d3ba7a83604c44b94d79f4fd69af77f804fc7f920a6dc65744", 9,  9),
    1:  ("USDC",       "0xeaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a", 6,  6),
    2:  ("USDT",       "0x2b89b9dc8fdf9f34709a5b106b472f0f39bb6ca9ce04b0fd7f2e971688e2e53b", 6,  6),
    3:  ("WETH",       "0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace", 8,  8),
    4:  ("CETUS",      "0xe5b274b2611143df055d6e7cd8d93fe1961716bcd4dca1cad87a83bc1e78c1ef", 9,  7),
    6:  ("WBTC",       "0xc9d8b075a5c69303365ae23633d4e085199bf5c520a3b90fed1322a0342ffc33", 8,  8),
    10: ("USDC-native","0xeaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a", 6,  6),
    14: ("SUI-e",      "0x23d7315113f5b1d3ba7a83604c44b94d79f4fd69af77f804fc7f920a6dc65744", 9,  9),
}

MIST_PER_SUI = 1_000_000_000

# ── RPC helpers ───────────────────────────────────────────────────────────────

def rpc(method, params, retries=3):
    payload = {"jsonrpc": "2.0", "id": 1, "method": method, "params": params}
    for attempt in range(retries):
        try:
            r = requests.post(RPC, json=payload, timeout=30)
            d = r.json()
            if "error" in d:
                raise Exception(f"RPC error: {d['error']}")
            return d["result"]
        except Exception as e:
            if attempt == retries - 1:
                raise
            time.sleep(1)

def pyth_price_at(feed_id, unix_ts_ms):
    """Get Pyth historical price at a given timestamp (ms)."""
    ts = int(unix_ts_ms) // 1000
    try:
        r = requests.get(
            PYTH_API,
            params={"id": feed_id, "publish_time": ts},
            timeout=10
        )
        if r.status_code != 200:
            return None
        d = r.json()
        if not d:
            return None
        p = d[0] if isinstance(d, list) else d
        price_raw = int(p["price"]["price"])
        expo = int(p["price"]["expo"])
        price = price_raw * (10 ** expo)
        conf_raw = int(p["price"]["conf"])
        conf = conf_raw * (10 ** expo)
        publish_time = p["price"]["publish_time"]
        lag_s = ts - publish_time
        return {
            "price": price,
            "conf": conf,
            "publish_time": publish_time,
            "lag_s": lag_s,  # how stale the Pyth price was at liquidation time
        }
    except Exception:
        return None

# ── 主邏輯 ────────────────────────────────────────────────────────────────────

def fetch_all_events(limit_per_page=50, max_pages=200):
    """Paginate through all LiquidationEvent, newest-first."""
    all_events = []
    cursor = None
    for page in range(max_pages):
        result = rpc("suix_queryEvents", [
            {"MoveEventType": EVENT_TYPE},
            cursor,
            limit_per_page,
            True  # descending (newest first)
        ])
        data = result.get("data", [])
        all_events.extend(data)
        print(f"  page {page+1}: +{len(data)} events (total {len(all_events)})")
        if not result.get("hasNextPage"):
            break
        cursor = result.get("nextCursor")
        time.sleep(0.1)
    return all_events

def get_tx_details(digest):
    return rpc("sui_getTransactionBlock", [
        digest,
        {
            "showInput": True,
            "showEffects": True,
            "showEvents": False,
            "showObjectChanges": False,
            "showBalanceChanges": False,
        }
    ])

def extract_gas_sui(tx):
    """Return gas cost in SUI from tx effects."""
    try:
        effects = tx.get("effects", {})
        gas = effects.get("gasUsed", {})
        total_mist = (
            int(gas.get("computationCost", 0)) +
            int(gas.get("storageCost", 0)) -
            int(gas.get("storageRebate", 0))
        )
        return total_mist / MIST_PER_SUI
    except Exception:
        return None

def get_checkpoint_seq(tx):
    try:
        return int(tx.get("effects", {}).get("checkpoint") or tx.get("checkpoint", 0))
    except Exception:
        return None

def get_checkpoint_ts(seq):
    try:
        cp = rpc("sui_getCheckpoint", [str(seq)])
        return int(cp.get("timestampMs", 0))
    except Exception:
        return None

def navi_price_to_usd(price_raw, asset_id):
    """Convert NAVI oracle event price to USD.
    NAVI stores price_raw / 10^price_decimals = USD (matches asset token decimals for most assets).
    """
    info = ASSET_MAP.get(asset_id)
    if info is None:
        return price_raw / 1e8  # fallback
    _, _, token_dec, price_dec = info
    return price_raw / (10 ** price_dec)

def analyze_events(events):
    rows = []
    # Track per-borrower: last liquidation checkpoint for lag calculation
    last_liq_checkpoint = {}

    for i, ev in enumerate(events):
        tx_digest = ev.get("id", {}).get("txDigest", "")
        ts_ms = int(ev.get("timestampMs", 0))
        data = ev.get("parsedJson", {})

        sender = data.get("sender", "")
        borrower = data.get("user", "")
        collat_asset_id = int(data.get("collateral_asset", 0))
        debt_asset_id = int(data.get("debt_asset", 0))
        collat_amount_raw = int(data.get("collateral_amount", 0))
        debt_amount_raw = int(data.get("debt_amount", 0))
        collat_price_raw = int(data.get("collateral_price", 0))
        debt_price_raw = int(data.get("debt_price", 0))
        treasury_raw = int(data.get("treasury", 0))

        collat_info = ASSET_MAP.get(collat_asset_id, (f"asset_{collat_asset_id}", None, 9, 9))
        debt_info = ASSET_MAP.get(debt_asset_id, (f"asset_{debt_asset_id}", None, 6, 6))

        collat_symbol = collat_info[0]
        debt_symbol = debt_info[0]
        collat_decimals = collat_info[2]
        debt_decimals = debt_info[2]

        collat_amount = collat_amount_raw / (10 ** collat_decimals)
        debt_amount = debt_amount_raw / (10 ** debt_decimals)
        treasury_amount = treasury_raw / (10 ** collat_decimals)

        collat_price_usd = navi_price_to_usd(collat_price_raw, collat_asset_id)
        debt_price_usd = navi_price_to_usd(debt_price_raw, debt_asset_id)

        collat_value_usd = collat_amount * collat_price_usd
        debt_value_usd = debt_amount * debt_price_usd
        liquidation_bonus_usd = collat_value_usd - debt_value_usd

        is_self_liquidation = (sender.lower() == borrower.lower())

        # ── Tx details ────────────────────────────────────────────────────────
        print(f"[{i+1}/{len(events)}] tx={tx_digest[:20]}... ", end="", flush=True)
        try:
            tx = get_tx_details(tx_digest)
            gas_sui = extract_gas_sui(tx)
            cp_seq = get_checkpoint_seq(tx)
        except Exception as e:
            print(f"tx_err={e}")
            gas_sui = None
            cp_seq = None

        # ── Pyth historical price ─────────────────────────────────────────────
        pyth_collat = None
        collat_feed_id = collat_info[1] if len(collat_info) > 1 else None
        if collat_feed_id:
            pyth_collat = pyth_price_at(collat_feed_id, ts_ms)
            time.sleep(0.05)

        pyth_collat_price = pyth_collat["price"] if pyth_collat else None
        pyth_collat_lag_s = pyth_collat["lag_s"] if pyth_collat else None
        oracle_vs_pyth_pct = None
        if pyth_collat_price and collat_price_usd:
            oracle_vs_pyth_pct = (collat_price_usd - pyth_collat_price) / pyth_collat_price * 100

        # ── Checkpoint lag from previous liquidation of same borrower ─────────
        prev_cp = last_liq_checkpoint.get(borrower)
        cp_lag = (cp_seq - prev_cp) if (cp_seq and prev_cp) else None
        last_liq_checkpoint[borrower] = cp_seq

        ts_str = datetime.fromtimestamp(ts_ms / 1000, tz=timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")
        print(f"{ts_str} | {collat_symbol}→{debt_symbol} | {'SELF' if is_self_liquidation else 'bot'}")

        rows.append({
            "timestamp": ts_str,
            "ts_ms": ts_ms,
            "tx_digest": tx_digest,
            "is_self_liquidation": is_self_liquidation,
            "liquidator": sender,
            "borrower": borrower,
            # collateral
            "collat_asset": collat_symbol,
            "collat_amount": f"{collat_amount:.6f}",
            "collat_price_navi_usd": f"{collat_price_usd:.6f}",
            "collat_value_usd": f"{collat_value_usd:.4f}",
            # debt
            "debt_asset": debt_symbol,
            "debt_amount": f"{debt_amount:.6f}",
            "debt_price_navi_usd": f"{debt_price_usd:.6f}",
            "debt_value_usd": f"{debt_value_usd:.4f}",
            # bonus
            "liquidation_bonus_usd": f"{liquidation_bonus_usd:.4f}",
            "treasury_amount": f"{treasury_amount:.6f}",
            # pyth comparison
            "pyth_collat_price_usd": f"{pyth_collat_price:.6f}" if pyth_collat_price else "",
            "pyth_staleness_s": pyth_collat_lag_s if pyth_collat_lag_s is not None else "",
            "oracle_vs_pyth_pct": f"{oracle_vs_pyth_pct:.4f}" if oracle_vs_pyth_pct is not None else "",
            # execution
            "gas_sui": f"{gas_sui:.6f}" if gas_sui is not None else "",
            "checkpoint_seq": cp_seq if cp_seq else "",
            "cp_lag_from_prev_liq": cp_lag if cp_lag is not None else "",
        })

        time.sleep(0.05)

    return rows

def write_csv(rows, path):
    if not rows:
        return
    with open(path, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
        writer.writeheader()
        writer.writerows(rows)

def write_jsonl(rows, path):
    with open(path, "w", encoding="utf-8") as f:
        for r in rows:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")

def print_summary(rows):
    if not rows:
        print("No liquidations found.")
        return
    total = len(rows)
    self_liq = sum(1 for r in rows if r["is_self_liquidation"])
    print(f"\n{'='*60}")
    print(f"Total liquidations : {total}")
    print(f"Self-liquidations  : {self_liq} ({self_liq/total*100:.1f}%)")

    # Top liquidators
    from collections import Counter
    liq_counter = Counter(r["liquidator"] for r in rows)
    print(f"\nTop 5 liquidators:")
    for addr, cnt in liq_counter.most_common(5):
        self_tag = " [SELF]" if any(
            r["is_self_liquidation"] and r["liquidator"] == addr for r in rows
        ) else ""
        print(f"  {addr[:20]}...  {cnt} times{self_tag}")

    # Gas stats
    gas_vals = [float(r["gas_sui"]) for r in rows if r["gas_sui"]]
    if gas_vals:
        print(f"\nGas (SUI): min={min(gas_vals):.4f}  max={max(gas_vals):.4f}  avg={sum(gas_vals)/len(gas_vals):.4f}")

    # Oracle vs Pyth
    oracle_diffs = [float(r["oracle_vs_pyth_pct"]) for r in rows if r["oracle_vs_pyth_pct"]]
    if oracle_diffs:
        print(f"\nOracle vs Pyth (collateral price %):")
        print(f"  min={min(oracle_diffs):.4f}%  max={max(oracle_diffs):.4f}%  avg={sum(oracle_diffs)/len(oracle_diffs):.4f}%")

    # Checkpoint lag
    cp_lags = [int(r["cp_lag_from_prev_liq"]) for r in rows if r["cp_lag_from_prev_liq"] != ""]
    if cp_lags:
        print(f"\nCheckpoint lag (same borrower, consecutive liquidations):")
        print(f"  min={min(cp_lags)}  max={max(cp_lags)}  avg={sum(cp_lags)/len(cp_lags):.1f}")

# ── Entry point ───────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import sys

    os.makedirs("logs", exist_ok=True)

    max_events = int(sys.argv[1]) if len(sys.argv) > 1 else 200

    print(f"Fetching NAVI LiquidationEvent (max {max_events})...")
    events = fetch_all_events(limit_per_page=50, max_pages=max_events // 50 + 1)
    events = events[:max_events]
    print(f"Total events to analyze: {len(events)}\n")

    print("Enriching with tx details + Pyth prices...")
    rows = analyze_events(events)

    csv_path = "logs/liquidations.csv"
    jsonl_path = "logs/liquidations.jsonl"
    write_csv(rows, csv_path)
    write_jsonl(rows, jsonl_path)

    print(f"\nSaved: {csv_path} ({len(rows)} rows)")
    print(f"Saved: {jsonl_path}")

    print_summary(rows)
