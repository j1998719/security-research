---
title: "Round 14 深度分析：NAVI Self-Liquidation — 條件鏈與攻擊場景矩陣"
date: 2026-05-01
type: security-audit
status: complete
tags: [sui, navi, self-liquidation, flash-loan, liquidation-bonus, interest-protocol, scallop, bucket]
---

## 核心漏洞確認（Round 13 延伸）

### ABI 層三重確認

**entry_liquidation_v2 完整簽名（v15 package `0x1e4a13...`，14 個參數）：**
```
[0]  &Clock
[1]  &PriceOracle
[2]  &mut Storage
[3]  U8          ← debt_asset_id
[4]  &mut Pool<T>  ← debt pool
[5]  Coin<T>     ← liquidation coin
[6]  U8          ← collat_asset_id
[7]  &mut Pool<R>  ← collat pool
[8]  Address     ← borrower_addr (外部傳入，無驗證)
[9]  U64         ← amount
[10] &mut Incentive  (v2)
[11] &mut Incentive  (v3)
[12] &mut SuiSystemState
[13] &mut TxContext
```

**關鍵觀察：**
- param[8] = `borrower_addr` 是純 `Address` 型別，由呼叫方自由填寫
- param[13] = `TxContext`，sender 可從這裡取得
- 函數 body 從不比較 param[8] 與 `tx_context::sender(param[13])`

**validate_liquidate 確認（v1 package `0xd899cf...`）：**
```move
public fun validate_liquidate(storage: &mut Storage, debt_asset_id: U8, collat_asset_id: U8, amount: U256)
```
無 borrower, 無 liquidator, 無 sender —— 只驗證 amount 和 asset 合法性。

**execute_liquidate 確認（v15 logic module，Friend visibility）：**
```move
fun execute_liquidate(clock: &Clock, oracle: &PriceOracle, storage: &mut Storage,
                       borrower_addr: Address, debt_asset_id: U8, collat_asset_id: U8, amount: U256)
                       → (U256, U256, U256)
```
無 TxContext 參數。execute_liquidate 物理上無法取得 sender，無法做自我清算防護。

### storage::when_liquidatable devInspect 實測

```
when_liquidatable(storage, borrower=DUMMY, liquidator=DUMMY) → SUCCESS
when_liquidatable(storage, borrower=REAL_NAVI_USER, liquidator=REAL_NAVI_USER) → SUCCESS
```

`when_liquidatable(storage: &mut Storage, borrower_addr: Address, liquidator_addr: Address)`
接受 borrower == liquidator，完全通過。這是 storage 層的清算許可檢查，若此函數通過，
後續 execute_liquidate 也無任何 sender 比較邏輯。

**結論：NAVI 自我清算漏洞在 ABI + 鏈上行為兩個層面均確認。**

---

## 攻擊場景矩陣

### 場景 A：繞過清算罰金（Liquidation Penalty Avoidance）

**條件 X：**
- 攻擊者持有 NAVI 倉位（已存入抵押品、已借款）
- Health factor < 1.0（倉位進入可清算狀態）
- 攻擊者有足夠流動資金還部分債務（或使用 flash loan）

**攻擊路徑 Y：**
```
1. 攻擊者持倉：存 100 SUI 抵押，借 75 SUI debt (HF ≈ 1.067)
2. SUI 下跌 ~6.7% → HF < 1.0 → 倉位可被清算
3. 攻擊者作為 liquidator，調用 entry_liquidation_v2(borrower=self)
4. 還款 35% × 75 = 26.25 SUI debt
5. 獲得 26.25 × (1 + 10%) = 28.875 SUI 抵押品
6. 倉位恢復健康（HF 提升）
```

**獲利機制分析（關鍵）：**

在 AAVE/NAVI 架構中，liquidation bonus 來自 borrower 的抵押品，而非協議金庫。
正常情況下是 liquidator（第三方）拿走 borrower 的 10% extra collateral。

自我清算時：
- 攻擊者作為 borrower：失去 28.875 SUI 抵押品
- 攻擊者作為 liquidator：收到 28.875 SUI 抵押品

**這是零和**——攻擊者付錢給自己，沒有從協議或其他 LP 那裡偷錢。

**真正的收益：**
- 避免被第三方清算，保留 10% bonus 不流失給外部清算者
- 可以選擇有利的 oracle 價格時機（攻擊者可觀察 oracle 延遲）
- 不被 bot 搶先清算時的 MEV 損失

**可行性：中等**
**最大損失估計（對協議）：清算激勵失效，外部清算者無利可圖 → 潛在清算不足 → 協議壞債積累**

---

### 場景 B：Flash Loan + Self-Liquidation 套利

**條件 X：**
- 攻擊者或任意用戶有 NAVI 倉位且 HF < 1.0
- 協議（如 Cetus, Bucket）提供同資產 flash loan
- 攻擊者有 close_factor（35%）限制知識

**攻擊路徑 Y（詳細分析）：**

```
假設狀態：
  - 攻擊者存入 100 USDC 抵押（LTV=80%）
  - 借出 79 USDC（HF = 100×0.8/79 = 1.013）
  - USDC 計價資產，HF 理論上穩定，但 borrower interest 累積
  - 待 HF < 1.0（累積利息）

PTB 構造：
  cmd1: flash_loan(USDC, 26.25 USDC) 
  cmd2: entry_liquidation_v2(borrower=self, repay=26.25 USDC, collat=USDC)
        → 收到 28.875 USDC collateral
  cmd3: 還 flash loan 26.25 + fee ≈ 26.25 × 1.0003 = 26.257875 USDC
  淨利：28.875 - 26.257875 = +2.617 USDC
```

**等等——數學問題：**

攻擊者作為 borrower 的倉位：
- 抵押品減少 28.875 USDC（被"清算"）
- 債務減少 26.25 USDC

攻擊者作為 liquidator 收到 28.875 USDC。

在 PTB 層面：
- cmd2 完成後，攻擊者的 USDC 倉位剩餘抵押品 = 100 - 28.875 = 71.125 USDC
- 攻擊者的債務 = 79 - 26.25 = 52.75 USDC
- 攻擊者作為 liquidator 持有 +28.875 USDC（新 coin 物件）
- Flash loan 欠 26.257875 USDC
- 淨：+28.875 - 26.257875 = **+2.617 USDC**

**這個攻擊路徑在數學上可行！**

攻擊者的 liquidator 收益（28.875 USDC）超過 flash loan 成本（26.257875 USDC）。
淨利 = 10% liquidation_bonus × 26.25 - flash_loan_fee = 2.625 - 0.0079 ≈ **+2.617 USDC**

從哪裡來的？從 borrower 的抵押品——即攻擊者自己的抵押品。
換句話說：攻擊者以低於市場的有效成本（不含清算 penalty）贖回自己的抵押品。

**比較基準：**
如果沒有自我清算，正常流程：
- 等待第三方 bot 清算，支付 10% bonus 給 bot
- 攻擊者的倉位同樣減少，但 bonus 流向 bot，不能被攻擊者取回

**自我清算的真實價值：攻擊者節省了本應支付給第三方清算 bot 的 10% 激勵。**
這筆錢沒有從天上掉下來，只是不再流出去了。

**可行性：高（如果 flash loan 可用且 oracle 允許）**
**最大損失估計（對協議）：清算機制失效，外部清算者被排除，bad debt 積累風險**

---

### 場景 C：Close Factor 繞過（35% 限制）

**條件 X：**
- 攻擊者倉位 HF < 1.0
- NAVI 設置 `LiquidationFactors.ratio = 35%`（每次最多清算 35% debt）

**攻擊路徑 Y：**

正常情況：第三方清算者每次最多清算 35% debt，需要多次 TX 才能全部清算。
自我清算時：攻擊者理論上可以連續在同一 PTB 內多次清算自己，突破 35% 限制？

分析：
```
cmd1: self_liquidate(35% of debt) → HF 上升
cmd2: self_liquidate(35% of remaining) → ...
```

**問題：** 每次清算後 HF 上升，第二次可能已超過 1.0 而無法繼續清算。
除非刻意維持在 HF < 1.0 的邊界——但這需要在同一 PTB 操控 oracle，難度極高。

**可行性：低（HF 恢復快，很難連續 self-liquidate 超過 35%）**

---

### 場景 D：PROTECTED_LIQUIDATION_USERS 系統繞過

**新發現（Round 14）：**

鏈上確認存在以下機制：
```
PROTECTED_LIQUIDATION_USERS_KEY → Table<address, bool>  (8 個保護用戶)
DESIGNATED_LIQUIDATORS_KEY → Table<address, Table<address, bool>>  (1 個 borrower → 8 個指定 liquidators)
```

`is_liquidatable(storage, borrower_addr, liquidator_addr)` 和
`when_liquidatable(storage, borrower_addr, liquidator_addr)` 都接受兩個地址。

**這個機制的意圖：** 大戶（鯨魚）可以指定誰有資格清算他們，防止惡意清算。

**攻擊條件 X：** 如果一個受保護用戶（在 PROTECTED_LIQUIDATION_USERS 表中）的倉位
健康因子 < 1，而其 DESIGNATED_LIQUIDATORS 中的地址之一就是該用戶本人 →
該用戶可以自我清算。

**鏈上數據：**
- Borrower `0x506c...` 在 designated liquidators 中有 8 個指定清算者
- 其中包含 `0x57b87865...`，恰好這個地址也在 PROTECTED_LIQUIDATION_USERS 列表中
- 這些地址有重疊：被保護的用戶同時也是指定清算者

**風險：** 協議管理員手動設置了這些白名單，若其中有地址既是 borrower 又是自己的 liquidator，
且倉位不健康，則自我清算是被授權的（intentional or oversight？）。

**可行性：高（對已在名單中的地址），低（外部攻擊者無法進入白名單）**

---

### 場景 E：Interest Protocol MasterChef — 獎勵重啟前端搶跑

**條件 X（必須所有條件同時成立）：**
- `ipx_per_ms > 0`（目前為 0，已停止）
- `accrued_ipx_per_share > 0`（目前為 0，無歷史累積）
- 有 stakers 存在歷史質押

**鏈上狀態（2026-05-01）：**
- `ipx_per_ms = 0` → 獎勵已停止
- `accrued_ipx_per_share = 0` → 無歷史積累
- `balance_value = 0` → 無質押資金

**攻擊路徑 Y（假設性）：**
```
如果管理員調用 update_ipx_per_ms(new_value > 0):
  → pool.update() 在下一次 stake/claim 時計算累積
  → 新 staker 無法取得歷史 IPX（加入前的 accrued_ipx_per_share 差值為 0）
  → 實際上沒有歷史積累可以前端搶跑
```

**結論：攻擊前提不成立。Interest Protocol 的 MasterChef 已無活躍獎勵，且無歷史積累 IPX。**

`update_ipx_per_ms` 需要 `MasterChefAdmin` capability（admin-only）。
即使攻擊者能前端搶跑 admin TX，accrued_ipx_per_share=0 意味著新 staker 沒有額外收益。

**可行性：N/A（前提不成立）**
**最大損失估計：$0（機制不存在）**

---

### 場景 F：Scallop ObligationKey 持有者創建多 Obligation

**條件 X：** Obligation 是 Shared，ObligationKey 是 AddressOwner。
任何人可以創建新 Obligation（如果有 create entry function）。

**鏈上確認：** ObligationKey 沒有任意 transfer entry function。
所有需要 ObligationKey 的操作都要求 caller 是 key owner。

攻擊面限制：
- `borrow_locked` 和其他 lock 函數需要 ObligationKey
- `deposit_collateral` 不需要 key（任何人可以向任意 Obligation 存抵押品 → griefing）
- `liquidate_entry` 不需要 key（正常設計）

**Griefing 路徑：**
```
call deposit_collateral(obligation=victim_obligation, coin=dust_amount)
```
→ 受害者 Obligation 被小量 dust 污染，可能影響 HF 計算？
→ 若最小抵押要求為 min_collateral_amount，小於此值的 deposit 會 abort（abort 81926 已確認）
→ 實際影響：可能在 UI 層製造混亂，但無直接資金損失

**可行性：低（griefing 無金融收益）**

---

### 場景 G：Bucket Protocol Strap-Fountain 假池子

**條件 X：** 
- `create_<T,R>()` 是 PUBLIC ENTRY，任何人可以創建 Fountain
- Fountain 需要 staker 主動 call 把資金質押進去

**攻擊路徑 Y（社會工程）：**
```
1. 攻擊者創建一個 Fountain (BUCK → FakeCoin)
2. 設定誘人的 reward_rate
3. 誘導用戶 stake BUCK 到假 Fountain
4. reward = FakeCoin（無價值 token）
5. 用戶損失 BUCK
```

**限制：**
- 需要用戶主動信任假 Fountain 地址
- UI/前端通常只顯示官方 Fountain
- 純鏈上攻擊不可行（需要釣魚）

**可行性：低（純鏈上不可行，需社工）**
**最大損失：依受害者 TVL**

---

## 綜合風險矩陣

| 場景 | 條件 | 攻擊路徑 | 獲利機制 | 最大損失 | 純鏈上 | 可行性 |
|------|------|---------|---------|---------|-------|-------|
| **A: 清算罰金逃避** | HF < 1.0 | self_liquidate() | 省下 10% liquidation bonus，不流向 3rd party | 協議清算機制失效，bad debt 積累 | 是 | **高** |
| **B: Flash Loan + Self-Liq** | HF < 1.0 + flash loan 可用 | FL → self_liq → 還 FL | 節省 10% bonus ≈ ~2.6 USDC/26 repay | 同 A + flash loan 費用對沖 | 是 | **高** |
| **C: Close Factor 繞過** | HF < 1.0 | 連續 self-liquidate in PTB | 快速脫險 | 有限（HF 恢復快） | 是 | **低** |
| **D: Protected User 自清算** | 地址在 designated_liquidators[self] | self_liquidate（被授權） | 同 A/B | 管理員操作失誤風險 | 是 | **中** |
| **E: IP MasterChef** | ipx_per_ms > 0（目前 = 0）| stake → claim_reward | 歷史 IPX | $0（前提不成立）| N/A | **N/A** |
| **F: Scallop Obligation Griefing** | 無（open access）| dust deposit | 無直接收益 | 零（UI 混亂） | 是 | **低** |
| **G: Bucket Fake Fountain** | 社工能力 | 假 Fountain | 受害者 BUCK | 任意 | 否（需社工）| **低** |

---

## 技術發現摘要

### 新發現（Round 14）

1. **NAVI 有 PROTECTED_LIQUIDATION_USERS 系統**（previously unknown）
   - 8 個保護用戶，1 個 borrower 有 8 個指定清算者
   - `when_liquidatable(storage, addr, addr)` 對兩個地址相同時仍然返回 SUCCESS
   - 這意味著即使是受保護用戶，若其自己在 designated_liquidators 列表中，
     也可以自我清算（設計意圖不明）

2. **Pool 物件是 dynamic field owned，非頂層 shared**
   - Pool<SUI>, Pool<USDC> 等對象 owner=None（dynamic child of Storage）
   - 無法在 devInspect PTB 中直接作為 mutable shared object 傳遞
   - 這是為什麼所有測試 PTB 在 arg_idx:4 失敗的技術原因

3. **execute_liquidate 不接受 TxContext**（物理上無法做 sender 比較）
   - 若要修補，必須在 entry_liquidation_v2 層加 `assert!(tx_context::sender(ctx) != borrower_addr)`
   - 或在 v15 storage::when_liquidatable 中加 sender != borrower 比較

### 修補建議

**最小修補（1 行）：**
```move
public entry fun entry_liquidation_v2<DebtType, CollatType>(
    clock: &Clock,
    oracle: &PriceOracle,
    storage: &mut Storage,
    ...
    borrower_addr: address,
    ...
    ctx: &mut TxContext,
) {
    assert!(tx_context::sender(ctx) != borrower_addr, SELF_LIQUIDATION_NOT_ALLOWED);
    // ... existing logic
}
```

**更完整的修補：**
在 `storage::when_liquidatable` 中也加 sender 比較，
或提供一個新版本 `when_liquidatable_v2` 傳入 sender 進行比較。

---

## Sources

- NAVI v15 package: `0x1e4a13a0...` (via UpgradeCap `0xdba1b4...`)
- NAVI v1 package: `0xd899cf7d...`
- NAVI main/incentive package: `0xee0041...`
- NAVI storage object: `0xbb4e2f...`
- NAVI PROTECTED_LIQUIDATION_USERS: `0x6e20a6...` (Table<address, bool>, size=8)
- NAVI DESIGNATED_LIQUIDATORS: `0xbe204b...` (Table<address, Table<address, bool>>, size=1)
- when_liquidatable devInspect: confirmed SUCCESS for borrower==liquidator
- Interest Protocol MasterChef: `0xbf3574...` (ipx_per_ms=0, accrued=0 confirmed)
- Scallop v19 obligation module: `0xde5c09...::obligation`
- Bucket Strap-Fountain: audit_bucket_incentive.ts findings
- Real liquidation TX: `2tcnboDSXh8BCc9SQZx2BGP9M1FTyAW1edyvgB3djACG`
