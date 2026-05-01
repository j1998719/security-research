"""
NAVI Liquidation Monitor Bot
Async framework: asyncio + aiohttp + websockets

Architecture:
  PythMonitor  ──price_queue──▶  HFUpdater ──liquidation_queue──▶  Liquidator
  EventMonitor ──────────────▶  PositionStore
                                     ▲
                                  startup load
"""

import asyncio
import aiohttp
import json
import logging
import heapq
import time
from dataclasses import dataclass, field
from typing import Dict, Optional, List, Tuple

import websockets

from config import (
    SUI_RPC, PYTH_WS, NAVI_PKG, NAVI_STORAGE,
    ASSETS, RAY, SLOW_INTERVAL_S, MIN_PROFIT_SUI, GAS_BUDGET_SUI,
)

# ── logging ───────────────────────────────────────────────────────────────────

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    handlers=[
        logging.StreamHandler(),
        logging.FileHandler("logs/bot.log"),
    ]
)
log = logging.getLogger("navi-bot")

# ── data models ───────────────────────────────────────────────────────────────

@dataclass
class AssetConfig:
    symbol:       str
    liq_threshold: float   # e.g. 0.80
    liq_bonus:    float    # e.g. 0.10
    token_dec:    int
    price_dec:    int

@dataclass
class UserPosition:
    address:       str
    # asset_id -> raw_amount (in token's smallest unit)
    collaterals:   Dict[int, int] = field(default_factory=dict)
    debts:         Dict[int, int] = field(default_factory=dict)
    hf:            float = float("inf")
    last_updated:  float = 0.0        # unix timestamp

    def is_slow(self) -> bool:
        return self.hf > 1.5

    def needs_slow_update(self) -> bool:
        return self.is_slow() and (time.time() - self.last_updated) > SLOW_INTERVAL_S

# ── shared state ──────────────────────────────────────────────────────────────

class State:
    def __init__(self):
        # asset_id -> USD price (float)
        self.prices:    Dict[int, float] = {}
        # asset_id -> AssetConfig
        self.configs:   Dict[int, AssetConfig] = {}
        # address -> UserPosition
        self.positions: Dict[str, UserPosition] = {}
        # min-heap of (hf, address) for fast-tier positions
        self.fast_heap: List[Tuple[float, str]] = []

    def update_price(self, asset_id: int, price: float):
        self.prices[asset_id] = price

    def upsert_position(self, pos: UserPosition):
        self.positions[pos.address] = pos

    def compute_hf(self, pos: UserPosition) -> float:
        """
        HF = Σ(collateral_i × price_i × liq_threshold_i)
           / Σ(debt_i × price_i)
        Returns inf if no debt.
        """
        collat_value = 0.0
        for asset_id, raw in pos.collaterals.items():
            cfg = self.configs.get(asset_id)
            price = self.prices.get(asset_id)
            if cfg and price:
                amount = raw / (10 ** cfg.token_dec)
                collat_value += amount * price * cfg.liq_threshold

        debt_value = 0.0
        for asset_id, raw in pos.debts.items():
            cfg = self.configs.get(asset_id)
            price = self.prices.get(asset_id)
            if cfg and price:
                amount = raw / (10 ** cfg.token_dec)
                debt_value += amount * price

        if debt_value == 0:
            return float("inf")
        return collat_value / debt_value

    def best_liquidation(self, pos: UserPosition) -> Optional[dict]:
        """
        Find most profitable (collat_asset, debt_asset) pair.
        Returns None if no profitable liquidation exists.
        """
        best = None
        for debt_id, debt_raw in pos.debts.items():
            debt_cfg = self.configs.get(debt_id)
            debt_price = self.prices.get(debt_id)
            if not debt_cfg or not debt_price:
                continue
            debt_amount = debt_raw / (10 ** debt_cfg.token_dec)
            # NAVI caps repay at 50% of debt
            repay_amount = debt_amount * 0.5
            repay_usd = repay_amount * debt_price

            for collat_id, collat_raw in pos.collaterals.items():
                collat_cfg = self.configs.get(collat_id)
                collat_price = self.prices.get(collat_id)
                if not collat_cfg or not collat_price:
                    continue
                bonus = collat_cfg.liq_bonus
                received_usd = repay_usd * (1 + bonus)
                profit_usd = received_usd - repay_usd
                # rough gas deduction
                profit_usd -= GAS_BUDGET_SUI * self.prices.get(0, 1.0)

                if profit_usd > MIN_PROFIT_SUI * self.prices.get(0, 1.0):
                    if best is None or profit_usd > best["profit_usd"]:
                        best = {
                            "borrower":    pos.address,
                            "debt_asset":  debt_id,
                            "collat_asset": collat_id,
                            "repay_amount": repay_amount,
                            "profit_usd":   profit_usd,
                        }
        return best

# ── RPC helpers ───────────────────────────────────────────────────────────────

async def rpc(session: aiohttp.ClientSession, method: str, params: list):
    async with session.post(SUI_RPC, json={
        "jsonrpc": "2.0", "id": 1, "method": method, "params": params
    }) as resp:
        d = await resp.json()
        if "error" in d:
            raise Exception(f"RPC {method}: {d['error']}")
        return d["result"]

# ── startup: load asset configs ───────────────────────────────────────────────

async def load_asset_configs(session: aiohttp.ClientSession, state: State):
    """Read liq_threshold and liq_bonus for each asset from NAVI storage."""
    log.info("Loading asset configs from chain...")
    # get reserves table ID
    obj = await rpc(session, "sui_getObject", [NAVI_STORAGE, {"showContent": True}])
    reserves_table_id = (obj["data"]["content"]["fields"]["reserves"]
                          ["fields"]["id"]["id"])

    dfs = await rpc(session, "suix_getDynamicFields", [reserves_table_id, None, 50])
    tasks = []
    for entry in dfs["data"]:
        asset_id = int(entry["name"]["value"])
        obj_id   = entry["objectId"]
        tasks.append(_load_one_asset(session, state, asset_id, obj_id))
    await asyncio.gather(*tasks)
    log.info(f"Loaded {len(state.configs)} asset configs")

async def _load_one_asset(session, state, asset_id, obj_id):
    obj = await rpc(session, "sui_getObject", [obj_id, {"showContent": True}])
    fields = (obj["data"]["content"]["fields"]
              .get("value", {}).get("fields", {}))
    lf = fields.get("liquidation_factors", {}).get("fields", {})
    ltv_raw = int(fields.get("ltv", 0))
    threshold_raw = int(lf.get("threshold", 0))
    bonus_raw     = int(lf.get("bonus", 0))

    asset_meta = ASSETS.get(asset_id, {})
    state.configs[asset_id] = AssetConfig(
        symbol        = asset_meta.get("symbol", f"asset_{asset_id}"),
        liq_threshold = threshold_raw / RAY,
        liq_bonus     = bonus_raw / RAY,
        token_dec     = asset_meta.get("token_dec", 9),
        price_dec     = asset_meta.get("price_dec", 9),
    )

# ── startup: load existing positions ─────────────────────────────────────────

async def load_positions(session: aiohttp.ClientSession, state: State):
    """
    Bootstrap risky positions by replaying recent BorrowEvent.
    For each unique borrower address, load their full position.
    """
    log.info("Bootstrapping positions from recent borrow events...")
    event_type = f"{NAVI_PKG}::event::BorrowEvent"
    borrowers: set[str] = set()
    cursor = None

    # scan last ~2000 borrow events to find active borrowers
    for _ in range(40):  # 40 pages × 50 = 2000 events
        result = await rpc(session, "suix_queryEvents", [
            {"MoveEventType": event_type}, cursor, 50, True
        ])
        for ev in result["data"]:
            addr = ev.get("parsedJson", {}).get("user", "")
            if addr:
                borrowers.add(addr)
        if not result.get("hasNextPage"):
            break
        cursor = result.get("nextCursor")
        await asyncio.sleep(0.05)

    log.info(f"Found {len(borrowers)} unique borrowers, loading positions...")

    # load positions in parallel batches of 20
    borrowers_list = list(borrowers)
    for i in range(0, len(borrowers_list), 20):
        batch = borrowers_list[i:i+20]
        await asyncio.gather(*[
            _load_user_position(session, state, addr) for addr in batch
        ])
        await asyncio.sleep(0.1)

    # push initial fast-tier positions to heap
    for addr, pos in state.positions.items():
        hf = state.compute_hf(pos)
        pos.hf = hf
        pos.last_updated = time.time()
        if not pos.is_slow():
            heapq.heappush(state.fast_heap, (hf, addr))

    log.info(f"Loaded {len(state.positions)} positions, "
             f"{len(state.fast_heap)} in fast tier")

async def _load_user_position(session, state, address: str):
    """
    Use devInspectTransactionBlock to call NAVI's get_user_all_positions view.
    Falls back to raw storage read if not available.
    """
    try:
        # devInspect the NAVI storage::get_user_info function
        result = await rpc(session, "sui_devInspectTransactionBlock", [
            "0x0",  # sender (unused for read)
            {
                "kind": "ProgrammableTransaction",
                "inputs": [
                    {"type": "object", "objectType": "sharedObject",
                     "objectId": NAVI_STORAGE,
                     "initialSharedVersion": "1",
                     "mutable": False},
                    {"type": "pure", "valueType": "address", "value": address},
                ],
                "transactions": [{
                    "MoveCall": {
                        "package": NAVI_PKG,
                        "module": "storage",
                        "function": "get_user_all_positions",
                        "typeArguments": [],
                        "arguments": [{"Input": 0}, {"Input": 1}],
                    }
                }]
            },
            None, None
        ])
        _parse_user_position(result, address, state)
    except Exception as e:
        log.debug(f"Position load failed for {address[:16]}...: {e}")

def _parse_user_position(inspect_result, address: str, state: State):
    """Parse devInspect result into UserPosition. Protocol-specific."""
    # TODO: parse the BCS-encoded return value from get_user_all_positions
    # Structure depends on NAVI's actual return type.
    # Placeholder: create empty position so address is tracked
    if address not in state.positions:
        state.positions[address] = UserPosition(address=address)

# ── price monitor ─────────────────────────────────────────────────────────────

async def pyth_monitor(state: State, price_queue: asyncio.Queue):
    """
    Subscribe to Pyth Hermes WebSocket for real-time price updates.
    Pushes (asset_id, price) tuples to price_queue.
    """
    feed_map = {
        meta["pyth"]: asset_id
        for asset_id, meta in ASSETS.items()
        if meta.get("pyth")
    }
    feed_ids = list(feed_map.keys())

    while True:
        try:
            log.info("Connecting to Pyth Hermes WebSocket...")
            async with websockets.connect(PYTH_WS) as ws:
                await ws.send(json.dumps({
                    "ids":  feed_ids,
                    "type": "subscribe",
                    "verbose": False,
                    "binary": False,
                }))
                log.info(f"Subscribed to {len(feed_ids)} Pyth feeds")

                async for raw in ws:
                    msg = json.loads(raw)
                    if msg.get("type") != "price_update":
                        continue
                    feed_id = "0x" + msg.get("price_feed", {}).get("id", "")
                    asset_id = feed_map.get(feed_id)
                    if asset_id is None:
                        continue
                    p = msg["price_feed"]["price"]
                    price = int(p["price"]) * (10 ** int(p["expo"]))
                    await price_queue.put((asset_id, price))

        except Exception as e:
            log.warning(f"Pyth WS disconnected: {e}, reconnecting in 3s...")
            await asyncio.sleep(3)

# ── event monitor: track new borrows ─────────────────────────────────────────

async def event_monitor(session: aiohttp.ClientSession, state: State):
    """Poll for new BorrowEvent to track new positions."""
    event_type = f"{NAVI_PKG}::event::BorrowEvent"
    cursor = None
    while True:
        try:
            result = await rpc(session, "suix_queryEvents", [
                {"MoveEventType": event_type}, cursor, 20, False
            ])
            for ev in result["data"]:
                addr = ev.get("parsedJson", {}).get("user", "")
                if addr and addr not in state.positions:
                    await _load_user_position(session, state, addr)
                    log.info(f"Tracked new borrower {addr[:20]}...")
            if result.get("hasNextPage"):
                cursor = result.get("nextCursor")
        except Exception as e:
            log.warning(f"Event monitor error: {e}")
        await asyncio.sleep(10)

# ── HF updater ────────────────────────────────────────────────────────────────

async def hf_updater(
    state: State,
    price_queue: asyncio.Queue,
    liquidation_queue: asyncio.Queue,
):
    """
    Main loop:
    - On every price update: recompute HF for fast-tier positions.
    - Every SLOW_INTERVAL_S: recompute HF for slow-tier positions.
    - Push to liquidation_queue if HF < 1.0.
    """
    last_slow_sweep = 0.0

    while True:
        # ── drain price queue, update state.prices ────────────────────────
        updated_assets: set[int] = set()
        try:
            while True:
                asset_id, price = price_queue.get_nowait()
                state.update_price(asset_id, price)
                updated_assets.add(asset_id)
        except asyncio.QueueEmpty:
            pass

        if updated_assets:
            # recompute fast-tier positions that use any updated asset
            new_heap = []
            while state.fast_heap:
                _, addr = heapq.heappop(state.fast_heap)
                pos = state.positions.get(addr)
                if not pos:
                    continue
                # only recompute if position uses a price-updated asset
                affected = (
                    updated_assets & set(pos.collaterals) |
                    updated_assets & set(pos.debts)
                )
                if affected:
                    hf = state.compute_hf(pos)
                    pos.hf = hf
                    pos.last_updated = time.time()
                    log.debug(f"HF {addr[:16]}... = {hf:.4f}")

                    if hf < 1.0:
                        opp = state.best_liquidation(pos)
                        if opp:
                            log.warning(
                                f"LIQUIDATABLE {addr[:16]}... HF={hf:.4f} "
                                f"profit={opp['profit_usd']:.2f} USD"
                            )
                            await liquidation_queue.put(opp)
                        continue  # don't re-add to fast heap

                    if pos.is_slow():
                        continue  # graduated to slow tier
                    heapq.heappush(new_heap, (hf, addr))
                else:
                    heapq.heappush(new_heap, (pos.hf, addr))
            state.fast_heap = new_heap

        # ── slow sweep ────────────────────────────────────────────────────
        now = time.time()
        if now - last_slow_sweep > SLOW_INTERVAL_S:
            last_slow_sweep = now
            for addr, pos in list(state.positions.items()):
                if not pos.needs_slow_update():
                    continue
                hf = state.compute_hf(pos)
                prev_hf = pos.hf
                pos.hf = hf
                pos.last_updated = now

                if hf < 1.0:
                    opp = state.best_liquidation(pos)
                    if opp:
                        log.warning(
                            f"[SLOW] LIQUIDATABLE {addr[:16]}... HF={hf:.4f}"
                        )
                        await liquidation_queue.put(opp)

                elif hf < 1.5 and prev_hf >= 1.5:
                    # graduated from slow to fast tier
                    log.info(f"Promoted {addr[:16]}... to fast tier (HF={hf:.4f})")
                    heapq.heappush(state.fast_heap, (hf, addr))

        await asyncio.sleep(0.05)  # ~20 iterations/sec when idle

# ── liquidator ────────────────────────────────────────────────────────────────

async def liquidator(
    session: aiohttp.ClientSession,
    liquidation_queue: asyncio.Queue,
    state: State,
):
    """
    Consume liquidation opportunities.
    Build PTB, submit, confirm, log result.
    """
    # track addresses we've already submitted to avoid double-submits
    in_flight: set[str] = set()

    while True:
        opp: dict = await liquidation_queue.get()
        borrower = opp["borrower"]

        if borrower in in_flight:
            log.debug(f"Skip {borrower[:16]}...: already in flight")
            continue

        # re-verify HF is still < 1.0 before submitting (race condition guard)
        pos = state.positions.get(borrower)
        if not pos or pos.hf >= 1.0:
            log.debug(f"Skip {borrower[:16]}...: HF recovered to {pos.hf:.4f}")
            continue

        in_flight.add(borrower)
        try:
            digest = await _execute_liquidation(session, opp, state)
            if digest:
                log.info(
                    f"[TX SUCCESS] {digest} | borrower={borrower[:20]}... "
                    f"debt={opp['debt_asset']} collat={opp['collat_asset']} "
                    f"repay={opp['repay_amount']:.4f} "
                    f"profit≈{opp['profit_usd']:.2f} USD"
                )
                # remove position — it may have been cleared
                state.positions.pop(borrower, None)
            else:
                log.warning(f"[TX FAILED] borrower={borrower[:20]}...")
        except Exception as e:
            log.error(f"[TX ERROR] {borrower[:20]}...: {e}")
        finally:
            in_flight.discard(borrower)

async def _execute_liquidation(
    session: aiohttp.ClientSession,
    opp: dict,
    state: State,
) -> Optional[str]:
    """
    Build and submit the liquidation PTB.
    Returns tx digest on success, None on failure.

    PTB steps:
      1. Flash loan from Cetus (debt token)
      2. entry_liquidation_v2(borrower, repay_coin, collateral_type)
      3. Repay flash loan
      4. Transfer profit to self

    TODO: implement PTB construction using Sui SDK or pysui.
    Currently returns None (stub).
    """
    log.info(
        f"[PTB] Building liquidation for {opp['borrower'][:20]}... "
        f"repay={opp['repay_amount']:.4f} "
        f"debt_asset={opp['debt_asset']} collat_asset={opp['collat_asset']}"
    )
    # ── PTB construction stub ─────────────────────────────────────────────
    # When implementing:
    #   tx = Transaction()
    #   [coin] = tx.move_call(CETUS_PKG::flash_loan::borrow, ...)
    #   [collat] = tx.move_call(NAVI_PKG::incentive_v3::entry_liquidation_v2,
    #       args=[storage, clock, oracle, borrower, repay_coin, ...])
    #   tx.move_call(CETUS_PKG::flash_loan::repay, args=[coin, receipt])
    #   tx.transfer_objects([collat], sender)
    # ─────────────────────────────────────────────────────────────────────
    return None  # remove when PTB is implemented

# ── main ──────────────────────────────────────────────────────────────────────

async def main():
    import os
    os.makedirs("logs", exist_ok=True)
    log.info("Starting NAVI liquidation bot...")

    state = State()
    price_queue: asyncio.Queue = asyncio.Queue()
    liquidation_queue: asyncio.Queue = asyncio.Queue()

    async with aiohttp.ClientSession() as session:
        # startup: load asset configs and initial positions
        await load_asset_configs(session, state)
        await load_positions(session, state)

        log.info("Starting async workers...")
        await asyncio.gather(
            pyth_monitor(state, price_queue),
            event_monitor(session, state),
            hf_updater(state, price_queue, liquidation_queue),
            liquidator(session, liquidation_queue, state),
        )

if __name__ == "__main__":
    asyncio.run(main())
