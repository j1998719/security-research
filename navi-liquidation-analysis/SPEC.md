# NAVI 清算系統規格文件

> 最後更新：2026-05-03 rev2  
> 適用版本：bot/ 目錄下所有 .ts 原始碼

---

## 一、系統概覽

本系統針對 Sui 主網上的 NAVI Protocol（借貸協議）實作兩個獨立工具：

| 工具 | 入口 | 用途 |
|------|------|------|
| **analyze** | `analyze.ts` | 離線分析工具：掃描歷史清算事件，計算盈虧、gas、debt age，格式化輸出給 Telegram |
| **navi-bot** | `navi-bot.ts` | 線上監控機器人：即時追蹤借款人 HF，發現機會後自動執行清算交易 |
| **init_bot** | `init_bot.ts` | 一次性全量掃描工具：遍歷所有 NAVI 用戶，建立初始 position cache |

共用模組：
- `position-store.ts`：倉位管理核心（BotState、掃描、cache I/O），被 `init_bot.ts` 和 `navi-bot.ts` 共用
- `config.ts`：asset metadata、bot 參數
- `network.ts`：主網／測試網地址（NAVI 合約、Cetus 池、Pyth oracle）
- `telegram.ts`：Telegram 推播（非關鍵，失敗不影響主流程）

---

## 二、共用模組

### 2.1 `config.ts`

**職責**：所有可調參數的單一來源。

**關鍵常數**

| 常數 | 說明 |
|------|------|
| `ASSETS` | `Record<number, { symbol, pyth, tokenDec }>`<br>asset_id → token 元資料<br>**tokenDec 必須與鏈上 coin 的 decimals 一致**（8 位 BTC 類、9 位 SUI 類、6 位穩定幣） |
| `DRY_RUN` | `1` = 只記錄，不送出交易 |
| `MIN_PROFIT_USD` | 清算最低預期獲利門檻（美元），低於此值跳過 |
| `GAS_BUDGET_MIST` | 每筆清算交易的 gas 預算（MIST 單位） |
| `HF_SLOW_THRESHOLD` | HF 低於此值升入快速監控層（預設 1.5） |
| `SLOW_INTERVAL_MS` | 慢層掃描間隔（預設 600,000 ms = 10 分鐘） |
| `SCAN_DAYS` | analyze 工具預設回溯天數（預設 90） |

**ASSETS 維護規則**
- 新增 NAVI reserve 時必須同步更新 `ASSETS` 和 `analyze.ts` 的 `PRICE_RANGE`
- `tokenDec` 優先以鏈上實際 coin decimals 為準，可用 `loadAssetConfigs()` 驗證
- `pyth` 為 Pyth price feed ID（hex string），`null` 表示無 Pyth feed，bot 無法監控該 asset 的價格變動

### 2.2 `network.ts`

**職責**：網路地址管理，主網使用 hardcode 常數（零延遲），測試網在啟動時動態拉取 ISV。

**主要結構**

```
NetworkAddrs {
  NAVI_PKG, NAVI_STORAGE, PYTH_ORACLE
  NAVI_INCENTIVE_V2, NAVI_INCENTIVE_V3, NAVI_FLASH_CONFIG
  ORACLE_PRO_PKG, ORACLE_CONFIG, SUPRA_HOLDER, SWITCHBOARD_AGG
  POOLS: Record<asset_id, { id, isv, coinType }>
  ORACLE_PRO_FEEDS: Record<asset_id, { pioId, pioIsv, feedId }>
  CETUS_PKG, CETUS_GLOBAL_CONFIG
  CETUS_POOLS: Record<"coinA,coinB", CetusPool>
}
```

**ISV（initialSharedVersion）規則**
- 主網所有物件的 ISV hardcode，不需要 RPC 查詢
- 測試網的 ISV 在每次啟動時透過 `buildTestnetAddrs()` 從鏈上動態獲取
- 每次 NAVI 升級合約後必須更新主網 ISV

### 2.3 `position-store.ts`

**職責**：`init_bot.ts` 和 `navi-bot.ts` 共用的倉位管理邏輯。

**主要 exports**

| 名稱 | 類型 | 說明 |
|------|------|------|
| `BotState` | class | prices / configs / positions / fastSet / triedAddresses；包含 `computeHF()` 和 `bestLiquidation()` |
| `liveIndex()` | function | 用線性推算取得當下精確的 borrow/supply index |
| `reserveCache` | Map | 模組級快取，避免重複 RPC；`startReserveIndexUpdater` 每 60s 清空重填 |
| `loadAssetConfigs()` | async | 從 NAVI_STORAGE reserves table 讀取每個 asset 的 liqThreshold、liqBonus、coinType |
| `loadPositions()` | async | 四段式全量掃描（見 4.5 節）|
| `loadPositionsFromCache()` | async | 從 `logs/positions-cache.json` 恢復倉位 |
| `savePositionsCache()` | function | 序列化 positions → JSON |
| `loadUserPosition()` | async | 載入單一地址的 scaledCollateral / scaledDebt |
| `getUserInfo()` | async | 讀取 user_info table 取得 collaterals/loans asset ID 列表 |

**過濾原則**：`loans.length === 0` 的地址在 Phase 1 即跳過，不進 Phase 3。純 supplier（無借款）不可能被清算，不需要維護在 cache。

### 2.4 `telegram.ts`

- 非同步，失敗靜默（不拋出異常，不影響 bot 主迴圈）
- 需要環境變數 `TELEGRAM_TOKEN` 和 `TELEGRAM_CHAT`
- 訊息格式：HTML（支援 `<b>`, `<code>`, `<a>`）

---

## 三、analyze.ts — 離線分析工具

### 3.1 用途

事後分析工具，不需要 wallet，只讀取鏈上事件資料。主要用途：
1. 研究市場競爭態勢（哪些 liquidator 在活動）
2. 驗證 bot 的清算機會是否被偵測到
3. 計算各清算事件的實際 profit / net profit

### 3.2 CLI 模式

```
npx tsx analyze.ts                          # 市場概覽（最近 500 筆事件）
npx tsx analyze.ts --days N                 # 最近 N 天所有事件 + liquidator 彙總
npx tsx analyze.ts --date YYYY-MM-DD        # 單日所有事件（UTC+8）
npx tsx analyze.ts --from YYYY-MM-DD --to YYYY-MM-DD  # 日期區間所有事件
npx tsx analyze.ts --last N                 # 最近 N 筆事件 + liquidator 彙總
npx tsx analyze.ts --gas                    # 搭配 --days 顯示 flash vs direct gas 對比
```

所有日期以 UTC+8 為準。

### 3.3 資料流程

```
scanEvents()
    ↓ 取得 LiquidationEvent 列表
fetchTxMeta()
    ↓ 取得每筆 TX 的 gas 用量、gas price、是否用 flash
fetchBorrowTimes()
    ↓ 取得每個借款人的 BorrowEvent，推算 debt age
secEventList() / secLiquidatorSummary()
    ↓ 格式化輸出
tg() 或 console.log
```

### 3.4 LiqEvent 資料結構

```typescript
interface LiqEvent {
  txDigest:    string;   // 完整 TX hash，不截斷
  ts:          number;   // 毫秒 Unix timestamp
  date:        string;   // "YYYY-MM-DD" UTC+8
  time:        string;   // "HH:MM:SS" UTC+8
  liquidator:  string;   // sender 地址
  borrower:    string;   // user（被清算者）地址
  collatAsset: number;   // collateral asset_id
  debtAsset:   number;   // debt asset_id
  collatUsd:   number;   // 以 Pyth 當下價格換算的 USD 金額
  debtUsd:     number;
  collatAmt:   bigint;   // raw token 數量
  debtAmt:     bigint;
  debtDec:     number;   // debt token 的 tokenDec
  treasury:    bigint;   // 協議收取的 treasury 部分
  collatPrice: bigint;   // raw Pyth price（event 內）
  collatDec:   number;   // collateral tokenDec
  bonusPct:    number;   // (collatUsd / debtUsd - 1) * 100
  valid:       boolean;  // bonusPct 在 [0.5%, 30%] 範圍內且 debtUsd > $0.001
}
```

### 3.5 價格計算

**`detectPriceDec(raw: bigint, id: number): number`**

- 透過 `PRICE_RANGE` 自動推斷 Pyth 價格的小數位數
- 嘗試順序：`[9, 6, 8, 7]`，取第一個讓 `raw / 10^d` 落在合理價格區間的 d
- 若無 PRICE_RANGE 設定（未知 asset），fallback 為 9
- **每個 asset 的 PRICE_RANGE 必須正確設定，否則 USD 計算會嚴重偏差**

**已知各 asset 的 tokenDec 與 PRICE_RANGE 對照**

| asset_id | symbol | tokenDec | PRICE_RANGE |
|----------|--------|----------|-------------|
| 0 | SUI | 9 | [0.05, 20] |
| 1 | USDC (bridged) | 6 | [0.8, 1.2] |
| 2 | USDT (bridged) | 6 | [0.8, 1.2] |
| 3 | WETH (bridged) | 8 | [500, 20000] |
| 4 | CETUS | 9 | [0.001, 2] |
| 5 | vSUI | 9 | [0.05, 20] |
| 6 | haSUI | 9 | [0.05, 20] |
| 7 | NAVX | 9 | [0.001, 5] |
| 8 | WBTC | 8 | [10000, 300000] |
| 9 | AUSD | 6 | [0.8, 1.2] |
| 10 | USDC (native) | 6 | [0.8, 1.2] |
| 11 | ETH (native) | 8 | [500, 20000] |
| 12 | USDY | 6 | [0.95, 1.15] |
| 13 | NS | 6 | [0.05, 10] |
| 14 | BTC2 (bridged) | 8 | [30000, 200000] |
| 15 | DEEP | 6 | [0.001, 2] |
| 16 | FDUSD | 6 | [0.8, 1.2] |
| 17 | BLUE | 9 | [0.001, 5] |
| 18 | BUCK | 9 | [0.8, 1.2] |
| 19 | USDT (native) | 6 | [0.8, 1.2] |
| 20 | stSUI | 9 | [0.05, 20] |
| 21 | BTC | 8 | [10000, 300000] |
| 23 | LBTC | 8 | [30000, 200000] |
| 24 | WAL | 9 | [0.05, 20] |
| 26 | XBTC | 8 | [10000, 300000] |
| 29 | MBTC | 8 | [10000, 300000] |
| 30 | YBTC | 8 | [10000, 300000] |

### 3.6 BorrowEvent 查詢

**`fetchBorrowTimes(events)`**

- 每個借款人呼叫一次 `queryEvents({ Sender: borrower })`（不能混合 `MoveEventType + Sender` 篩選器）
- 在取回的事件中過濾 `ev.type.split("::").pop() === "BorrowEvent"`
- 最大回溯 5 年（1825 天），避免永無止境翻頁
- 每頁最多 50 筆，最多翻 50 頁
- 比對邏輯：找最近一筆 `asset === liqEv.debtAsset && ts <= liqEv.ts` 的 BorrowEvent
- BorrowEvent 欄位：新版有 `market_id`，舊版為 `reserve`，兩者都要處理

### 3.7 輸出格式

**每筆事件的卡片格式**（`secEventList`）

```
#N  YYYY-MM-DD HH:MM:SS  [⚡flash|direct]  ·  DEBT_SYM→COLLAT_SYM  ·  profit $X.XX  net $X.XX
  Borrower   0x12345678  Liquidator 0xabcdefgh  debt age Xd Xh  (since YYYY-MM-DD HH:MM)
  Debt          X.XXXX SYMBOL        $X.XX
  Collat        X.XXXX SYMBOL        $X.XX  bonus X.X%
  Treasury $X.XX
  Gas  X,XXX,XXX MIST · X.XXXX SUI = $X.XX  @X,XXX/unit
  TX <完整 txDigest，不截斷>
```

**規則**
- 地址只顯示前 10 個字元（`0x` + 8 位 hex）
- TX digest 完整顯示，不截斷
- 金額統一換算為 USD，使用同一個 `$()` formatter（< $1k 顯示 `$X.XX`，≥ $1k 顯示 `$Xk`，≥ $1M 顯示 `$XM`）
- bonus 為 `(collatUsd / debtUsd - 1) * 100`，這是我們自己計算的數字，不是 NAVI 官方設定值
- profit = `collatUsd - debtUsd`；net profit = `profit - gasUsd`
- treasury 是協議扣走的部分，已包含在 collatUsd 內（不另行扣除）

**SUI 價格來源**：從當天事件的 `collatAsset == 0` 且 `collatPrice > 0.1` 的事件中提取，用於 gas USD 換算。

### 3.8 valid 判定邏輯

```
valid = bonusPct >= 0.5 && bonusPct <= 30 && debtUsd > 0.001
```

- `valid = false` 的事件：不計入 profit 統計，但仍顯示在列表中（方便排查 asset config 問題）
- 常見 `valid = false` 原因：
  - asset 未設定 PRICE_RANGE → `detectPriceDec` 返回 9 → 價格偏差 → bonus 異常
  - asset 的 `tokenDec` 設定錯誤

---

## 三點五、init_bot.ts — 全量掃描工具

**用途**：一次性（或定期）跑完整 user_info 掃描，將結果存入 `logs/positions-cache.json`。Bot 啟動時只需讀取快取，不需等待掃描完成。

```bash
npx tsx bot/init_bot.ts           # 使用預設 mainnet RPC
SUI_RPC=https://... npx tsx bot/init_bot.ts
SCAN_CONSUMERS=1 npx tsx bot/init_bot.ts   # 限制並發，減少 rate limit
```

**與 navi-bot.ts 的分工**

| 職責 | init_bot.ts | navi-bot.ts |
|------|------------|-------------|
| 全量掃描 user_info | ✅ 主動執行 | 每 30min 背景執行（refresh） |
| 啟動時讀取 cache | ✗ | ✅ 立即開始監控 |
| Pyth 價格訂閱 | ✗ | ✅ |
| HF 計算 / 清算 | ✗ | ✅ |

---

## 四、navi-bot.ts — 線上清算機器人

### 4.1 架構

```
init_bot.ts (離線)          positions-cache.json
                                    │
navi-bot.ts 啟動 ───────────────────┘ loadPositionsFromCache()
    │
    ├── startPositionRefresher (30min)  重跑 loadPositions() + 存 cache
    │
PythMonitor (WebSocket)
    │  onPrice(assetId, price) → state.prices
    ↓
BotState.prices
    │
    ├── hfUpdater (50ms loop)
    │     ├── fast tier: recompute HF for positions with HF ≤ 1.5
    │     └── slow tier: sweep all positions every 10min
    │           → handleLiquidatable → enqueue → liquidator
    │
EventMonitor (10s poll)            BorrowEvent → loadUserPosition → state.positions
    │
liquidationEventMonitor (10s poll) LiquidationEvent → Telegram 推播
    │
startReserveIndexUpdater (60s)     刷新 borrowIndex/supplyIndex cache
```

### 4.2 BotState（定義於 position-store.ts）

```typescript
class BotState {
  prices:         Map<asset_id, USD_price>
  configs:        Map<asset_id, AssetConfig>
  positions:      Map<address, UserPosition>
  triedAddresses: Set<address>   // 避免重複 loadUserPosition
  fastSet:        Set<address>   // HF ≤ HF_SLOW_THRESHOLD 的地址，每 50ms 重算
}
```

**`computeHF(pos)`**：即時計算 HF，使用 `liveIndex()` 推算出當前精確的 borrow/supply index（不等待鏈上更新），公式：

```
HF = Σ(collateral_i × price_i × liqThreshold_i) / Σ(debt_j × price_j)
```

**HF 計算安全規則**：若任何 collateral 或 debt 資產缺少 Pyth 價格（`pyth: null`），直接回傳 `Infinity`（不可知，視為安全）。避免計算出 HF=0 的假陽性警報。

**`bestLiquidation(pos)`**：找出最佳清算組合。repayAmount 以實際可拿到的 collateral 為上限（`maxRepayByCollat = collatUsd / (1 + liqBonus)`），並與 50% debt cap 取最小值。

### 4.3 兩層監控架構

| 層 | 觸發條件 | 頻率 | 目的 |
|---|---------|------|------|
| **fast tier** | HF ≤ 1.5 | 每 50ms | 接近清算臨界的倉位高頻監控 |
| **slow tier** | 所有其他倉位 | 每 10min | 廣覆蓋，用於發現新的 near-liq 倉位 |

從 slow → fast 的升級條件：`prevHF > 1.5 && newHF ≤ 1.5`  
從 fast 移除：`HF > 1.5` 或已清算

### 4.4 liveIndex — 即時利率推算（position-store.ts）

```typescript
liveIndex(assetId, "borrow" | "supply"): bigint
```

- 每 60s 從鏈上拉取最新的 `borrowIndex`、`supplyIndex`、`borrowRatePerSec`、`supplyRatePerSec`
- 兩次刷新之間，用線性推算計算出「現在這一秒」的精確 index
- 這讓 HF 計算精準到秒級，能捕捉利率驅動的清算（不需要等待鏈上 index 更新）

### 4.5 倉位掃描（position-store.ts: `loadPositions`）

**navi-bot.ts 啟動流程**

1. `loadPositionsFromCache()`：從 `logs/positions-cache.json` 恢復，讓監控立刻生效
2. 無論有無快取：背景跑一次 `loadPositions()`（refresh + prune）
3. 若無快取：警告並提示先跑 `init_bot.ts`，bot 仍在背景掃描並逐步建立 positions

**`loadPositions()` 四階段 pipeline**

| 階段 | 方法 | 說明 |
|------|------|------|
| Phase 1 | `getDynamicFields(user_info table, limit=200)` | 逐頁掃描，inter-page 150ms throttle，指數退讓處理 429 / socket reset |
| Phase 2 | `multiGetObjects` × `SCAN_CONSUMERS`（預設 2）workers | 並行拉取 UserInfo |
| **過濾** | `loans.length === 0 → skip` | 無借款的地址不進 Phase 3，大幅減少 RPC 量 |
| Phase 3 | `loadUserPosition` × 50 concurrent | 並行載入每個用戶的 scaledCollateral/scaledDebt |
| Phase 4 | 清除 stale positions | 刪除不在 user_info 中的舊倉位 |

**為何 user_info 可直接 iter**：NAVI 對所有有過 collateral 或 loan 的地址都在 `user_info` table 建立 entry，包含 `collaterals: vector<u8>` 和 `loans: vector<u8>`。直接遍歷此 table 即可覆蓋所有歷史帳戶，不需要 BorrowEvent lookback。

每 30 分鐘重跑一次（`startPositionRefresher`），維持資料新鮮度並 prune 已關閉的倉位。

### 4.6 EventMonitor

- 監聽 `BorrowEvent`（每 10s poll）
- 僅處理未曾見過的地址（`triedAddresses` 去重）
- 用於在全掃描間隔期間即時追蹤新借款人

### 4.7 liquidationEventMonitor

- 監聽所有 `LiquidationEvent`（每 10s poll）
- **只做 logging，不執行清算**
- 用途：對照分析哪些清算機會我們沒有發現，區分「沒偵測到」vs「看到但 filtered out」

### 4.8 Oracle 更新

**`addOracleUpdates(tx, ...assetIds)`**

在同一個 PTB 內：
1. 從 Pyth Hermes 拉取最新 VAA，透過 `SuiPythClient.updatePriceFeeds()` 寫入 Pyth shared object
2. 呼叫 `oracle_pro::update_single_price_v2` 讓 NAVI 讀到最新價格

這解決了 NAVI error 1502（oracle 過期）問題。若 Pyth VAA 推送失敗，仍繼續嘗試 oracle_pro 更新（non-fatal）。

### 4.9 detectFrontrun

交易失敗或 dry-run 後呼叫，等 2.5s 後查詢借款人的最近交易，檢查是否有競爭者捷足先登，並推播詳細資訊（對方地址、gas price、timing）。

### 4.10 廣播策略

```
broadcastTx(tx, keypair)
```

- 若設定了多個 RPC（SUI_RPC + TRITON + SHINAMI），用 `Promise.allSettled` 同時廣播到全部
- 返回最先成功的 digest
- Sui 無 mempool，廣播多個節點提升入塊速度但不能 bid gas

### 4.11 30 分鐘報告

每 30 分鐘推播一次 Telegram 報告，包含：
- 倉位總覽（total / fast / slow）
- 最低 HF 前 5 名（借款地址、HF 值、資產明細）
- 利率驅動最快到期前 5 名（`estimateTimeToLiqSec` 用線性插值估算距離 HF=1.0 的時間）

---

## 五、liquidation-executor.ts — 清算交易建構

### 5.1 三種資金來源

優先順序：Cetus Flash → NAVI Flash → Wallet Direct

| 來源 | 觸發條件 | 說明 |
|------|---------|------|
| **CetusFlash** | `CETUS_POOLS` 中有 `debtType,collatType` 或 `collatType,debtType` 的池 | Flash swap 取得 debt coin，清算後用 collateral coin 還款，profit 留在錢包 |
| **NaviFlash** | `debtType === collatType`（同 asset 清算） | NAVI 原生 flash loan，不需要 Cetus 池 |
| **Wallet** | 以上都不適用，或 debtAsset === 0（SUI 直接從 gas 拆） | 從錢包直接支付 debt coin |

### 5.2 CetusFlash 執行流程

```
flash_swap(a2b=false)   → 取得 Balance<debtCoin>
  ↓
coin::from_balance      → Coin<debtCoin>
  ↓
liquidation_v2          → (Coin<collatCoin>, Coin<excessDebtCoin>)
  ↓
swap_pay_amount         → 計算需還多少 collat
  ↓
splitCoins + into_balance → Balance<collatCoin>（還款用）
  ↓
repay_flash_swap        → 還給 Cetus pool
  ↓
transferObjects([collatCoin, excessDebtCoin], sender) → profit 到錢包
```

**`a2b` 方向說明**
- pool key 為 `debtType,collatType`：`a2b=false`（B→A，取得 coinA=debt）
- pool key 為 `collatType,debtType`：`a2b=true`（A→B，取得 coinB=debt）

### 5.3 liquidation_v2 呼叫

```
incentive_v3::liquidation_v2<DebtType, CollatType>(
  clock, pyth_oracle, storage,
  debt_asset_id, debt_pool, repay_coin,
  collat_asset_id, collat_pool,
  borrower,
  incentive_v2, incentive_v3,
  0x5 (random object)
)
```

回傳：`(Coin<CollatType>, Coin<DebtType>)` — collateral 和多餘的 debt

### 5.4 gas 設定

```typescript
tx.setGasPrice(referenceGasPrice * 2n)   // 2× 基準 gas price 確保入塊
tx.setGasBudget(GAS_BUDGET_MIST)         // 預設 0.1 SUI
```

---

## 六、環境變數

| 變數 | 必填 | 說明 |
|------|------|------|
| `NAVI_BOT_KEY` | live mode 必填 | Ed25519 private key（hex，無 0x prefix） |
| `TELEGRAM_TOKEN` | 選填 | Telegram bot token |
| `TELEGRAM_CHAT` | 選填 | Telegram chat ID |
| `DRY_RUN` | 選填 | `1` = dry-run 模式 |
| `NETWORK` | 選填 | `testnet` 啟用測試網（預設 mainnet） |
| `SUI_RPC` | 選填 | 自訂 RPC endpoint |
| `PYTH_WS` | 選填 | 自訂 Pyth WebSocket endpoint |
| `TRITON_KEY` | 選填 | Triton One API key（廣播第二 RPC）|
| `SHINAMI_KEY` | 選填 | Shinami API key（廣播第三 RPC）|
| `MIN_PROFIT_USD` | 選填 | 清算最低獲利門檻（預設 0） |
| `SCAN_DAYS` | 選填 | analyze 預設回溯天數（預設 90） |
| `DEBUG` | 選填 | 非空值 = 啟用 debug log |
| `SCAN_CONSUMERS` | 選填 | `loadPositions` Phase 2 的並發 worker 數（預設 2，rate limit 嚴重時設 1）|

---

## 七、錯誤處理原則

1. **Telegram 永不崩潰**：`tg()` 吃掉所有異常
2. **RPC 429 / socket reset 退避**：producer 和 consumer 遇到 `429`、`UND_ERR_SOCKET`、`ECONNRESET` 自動指數退讓（5s → 10s → 20s → … 上限 60s），最多重試 8 次
3. **Oracle VAA 失敗非致命**：NAVI oracle_pro 步驟仍會嘗試，可能因 Pyth shared object 夠新而成功
4. **TX 失敗後 detectFrontrun**：不重試，改為記錄競爭者資訊
5. **loadUserPosition 失敗靜默**：單一用戶資料載入失敗不影響其他用戶
6. **position cache 損壞忽略**：直接執行全掃描

---

## 八、已知限制與注意事項

1. **未知 asset 的 USD 計算不可靠**：若 `ASSETS` 缺少某 asset_id，tokenDec 預設值為 `9`（debt）/ `6`（collat），PRICE_RANGE 也無法匹配，priceDec fallback 為 9。兩者同時錯誤時 USD 計算偏差可達 1000×。
   - **處理方式**：用 probe 腳本查 NAVI Storage reserves，確認 `coin_type` 後設定正確 tokenDec 和 PRICE_RANGE。

2. **Cetus POOLS 需要手動維護**：新增清算對時必須查鏈找到對應的 Cetus pool id 和 isv，否則只能用 wallet direct 模式。

3. **BorrowEvent 查詢用 `Sender` filter**：NAVI 的 BorrowEvent 不支援 `MoveEventType + Sender` 複合篩選，只能用單一 `Sender` filter 後在 code 內篩 type。

4. **HF 計算假設**：`liveIndex` 的線性推算在利率劇烈波動時不準確，但在 60s 刷新周期內誤差可忽略。

5. **分析工具的 bonus 是衍生值**：`bonusPct = (collatUsd/debtUsd - 1) * 100` 是我們基於 on-chain price 計算的近似值，並非 NAVI 合約設定的 `liquidation_bonus` 參數。正常範圍應在 5-15%（各 asset 不同）。
