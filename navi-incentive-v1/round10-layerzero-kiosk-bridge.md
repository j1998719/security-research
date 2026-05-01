---
title: "Round 10 Security Audit: LayerZero DVN / Sui Kiosk / Sui Native Bridge"
date: 2026-05-01
type: security-audit
status: complete
tags: [sui, layerzero, kiosk, bridge, dvn, nft, white-hat]
---

## Packages Audited

| Target | Address / Source |
|---|---|
| LayerZero EndpointV2 (mainnet) | `0x31beaef889b08b9c3b37d19280fc1f8b75bae5b2de2410fc3120f403e9a36dac` |
| LayerZero ULN-302 (mainnet) | `0x3ce7457bed48ad23ee5d611dd3172ae4fbd0a22ea0e846782a7af224d905dbb0` |
| Sui Kiosk | `0x2::kiosk` (system framework) |
| Sui Native Bridge | `0xb::bridge` (system package) |

---

## 方向一：LayerZero on Sui — DVN 配置審計

### Package 地址確認

從 GitHub `LayerZero-v2/packages/layerzero-v2/sui/contracts/endpoint-v2/Move.lock` 找到：
- **EndpointV2 mainnet**: `0x31beaef889b08b9c3b37d19280fc1f8b75bae5b2de2410fc3120f403e9a36dac`
- **ULN-302 mainnet**: `0x3ce7457bed48ad23ee5d611dd3172ae4fbd0a22ea0e846782a7af224d905dbb0`

注意：鏈上查詢 `endpoint_v2` / `oapp_core` / `oft` 模組交易均返回 0 筆，表示 LayerZero 在 Sui mainnet **目前幾乎沒有實際流量**，尚屬 cold deployment 階段。

### 關鍵函數

**EndpointV2 `verify()`**
```
pub fn verify(endpoint, receive_library: &CallCap, messaging_channel, src_eid, sender, nonce, payload_hash, clock)
```
- 先呼叫 `message_lib_manager.assert_receive_library()` 確認呼叫方是合法的 receive library
- 再呼叫 `messaging_channel.verify()` 將 payload hash 存入 channel

**EndpointV2 `lz_receive()`**
- 執行 OApp 的 `lz_receive`，只有 OApp 的 CallCap 才能呼叫
- 設計上 receive library → verify → lz_receive 是解耦的兩步

**ULN-302 `verifiable_internal()`** (核心 DVN 邏輯)
```move
// ALL required_dvns must verify
required_dvns.all!(|dvn| self.verified(*dvn, header_hash, payload_hash, confirmations))
// optional: threshold out of optional_dvns must verify
verified_optional_dvn_count >= optional_dvn_threshold
```

**ULN-302 `assert_at_least_one_dvn()`**
```move
assert!(required_dvns().length() > 0 || optional_dvn_threshold() > 0, EAtLeastOneDVN)
```
→ 設定時強制至少有一個 DVN，但**沒有強制最少兩個**。

### 問題 A：lz_receive 是否需要 trusted endpoint？

**安全。** `verify()` 需要 receive library 持有 `CallCap`，這是 package-level capability，無法偽造。endpoint 不是 entry function，外部呼叫者必須通過 message library 路由，無法繞過。

### 問題 B：DVN 配置誰可更改？

`set_config()` 簽名：
```
pub fn set_config(endpoint, caller: &CallCap, oapp: address, lib: address, eid: u32, config_type: u32, config: vector<u8>)
```
- `caller` 必須是 OApp 的 CallCap 或其 delegate（`assert_authorized` 強制）
- OApp owner 才能修改自己的 DVN 配置，外部無法更改他人配置 → **此點安全**

### 問題 C：1-of-1 DVN 漏洞

**風險評級：可疑（設計層面風險，非代碼漏洞）**

`assert_at_least_one_dvn` 只要求 ≥1 個 DVN，允許 `required_dvns = [single_dvn_address]`。若 OApp 設置單一 required DVN：

**攻擊路徑：**
1. 攻擊者識別某個 OApp 使用單一 DVN（例如 USDC bridge OApp）
2. DDoS 該 DVN 的 RPC 或滲透其 off-chain 簽名服務
3. 偽造或延遲 DVN verification，阻止合法訊息交付（活性攻擊）
4. 或：若滲透成功，DVN 為惡意訊息簽名 → 偽造跨鏈 message（完整性攻擊）

**現狀緩解：** 由於 Sui 上 LZ 目前幾乎沒有 OApp 存活流量，實際影響接近零。但 Kelp DAO 型漏洞的結構性風險存在。

**建議：** OApp 部署時應配置 `required_dvns: [dvn1, dvn2]`（至少兩個），或使用 `optional_dvns` 做 m-of-n。

---

## 方向二：Sui Kiosk 邏輯漏洞審計

### B1：Transfer Policy Royalty Bypass — 安全

從 `purchase()` 源碼：
```move
public fun purchase<T>(self: &mut Kiosk, id: ID, payment: Coin<SUI>): (T, TransferRequest<T>) {
    let price = df::remove<Listing, u64>(&mut self.id, Listing { id, is_exclusive: false });
    assert!(price == payment.value(), EIncorrectAmount);
    df::remove_opt<Lock, bool>(&mut self.id, Lock { id });
    let item = dof::remove<Item, T>(&mut self.id, Item { id });
    (item, transfer_policy::new_request(id, paid, object::id(self)))
}
```

`purchase()` 強制返回 `TransferRequest<T>` hot potato，必須在同一 PTB 內交給某個 `TransferPolicy<T>::confirm_request()` 消費。如果 RoyaltyRule 在該 policy 中，則 royalty 必須付清否則 tx abort。

**PTB 順序操控無效**：hot potato 語義下，`TransferRequest` 不能被 drop，必須消費，且只有 `confirm_request()` 能消費它，而 `confirm_request()` 必須驗證所有 rule receipts 都已 add。無法先轉移再不付款。

**廢棄合約繞過**：`purchase()` 是在 `0x2` 系統 package 中的函數，沒有廢棄版本可繞過。

**結論：B1 安全。**

### B2：Kiosk Lock 繞過 — 安全

`take()` 源碼：
```move
public fun take<T>(self: &mut Kiosk, cap: &KioskOwnerCap, id: ID): T {
    assert!(self.has_access(cap), ENotOwner);
    assert!(!self.is_locked(id), EItemLocked);   // ← 鎖定檢查
    assert!(!self.is_listed_exclusively(id), EListedExclusively);
    ...
}
```

`is_locked()` 檢查 dynamic field `Lock { id }` 是否存在。`lock_internal()` 是 `public(package)` 且只在 `lock()` 中調用。

`uid_mut()` 需要 `allow_extensions == true`（默認 false）。即使 allow_extensions 開啟，通過 `uid_mut` 操作 dynamic field 可以刪除 Lock 鍵，但這**需要知道 Lock 鍵的類型**。由於 `Lock` struct 定義在 `sui::kiosk` 模塊，其 key 類型是公開的，理論上可以通過 uid_mut 刪除 Lock dynamic field。

**潛在攻擊向量（條件限制）：**
- 條件 1：kiosk.allow_extensions 必須為 true（非默認，需要 owner 明確開啟）
- 條件 2：攻擊者必須持有 KioskOwnerCap（即攻擊者就是 owner）
- 若攻擊者是 owner，他本可以選擇不 lock，因此這不是真正的繞過

**結論：B2 安全。** 任何 lock bypass 都需要 KioskOwnerCap，即攻擊者本身是 kiosk owner，屬於設計內行為。

### B3：Listing Price Manipulation — 安全（但有細節）

`list()` 實現：
```move
public fun list<T>(self: &mut Kiosk, cap: &KioskOwnerCap, id: ID, price: u64) {
    assert!(self.has_access(cap), ENotOwner);
    assert!(self.has_item_with_type<T>(id), EItemNotFound);
    assert!(!self.is_listed_exclusively(id), EListedExclusively);
    // Overwrites existing Listing dynamic field
    df::add(&mut self.id, Listing { id, is_exclusive: false }, price);
}
```

注意：`list()` 直接用 `df::add` 覆蓋同一 key。如果 item 已 listed，再次調用 `list()` 可以**直接修改價格而不需先 delist**。這是有意為之的設計，允許 owner 重新定價。

**誰可以調用？** `KioskOwnerCap` required → 只有 kiosk owner 可以修改，外部無法操控他人的 listing price。

**結論：B3 安全。** 價格修改受 KioskOwnerCap 保護。

### 市場擴展注意點

BlueMove / Clutchy 等使用 `list_with_purchase_cap` + 自定義 TransferPolicy 的市場，需要確認：
- `PurchaseCap` 是否被安全保管（丟失會永久鎖定 NFT）
- 自定義 TransferPolicy 是否有 bypass 規則（需要對各 marketplace package 做獨立審計）

---

## 方向三：Sui 原生橋安全審計

### Package 地址

`0x000000000000000000000000000000000000000000000000000000000000000b`（系統地址）

### 關鍵函數

| 函數 | 可見性 | 作用 |
|---|---|---|
| `approve_token_transfer` | Public | 提交委員會簽名，記錄轉帳批准 |
| `claim_token` | Public | token 接收方自行認領 |
| `claim_and_transfer_token` | Public | 任何人代為轉帳給 recipient |
| `execute_system_message` | Public | 執行系統消息（緊急暫停、更新限額等）|
| `send_token` / `send_token_v2` | Public | 發起跨鏈轉帳 |

### 委員會簽名驗證

`verify_signatures()` 實現：
```move
assert!(threshold >= required_voting_power, ESignatureBelowThreshold);
```

`required_voting_power` 對所有消息類型返回 **3334**（scale 10000，即 **33.34%**）。

**注意：這是最低閾值，不是 2/3 多數。** 實際安全性取決於委員會成員的 stake 分佈。如果三個最大 validators 合計 stake > 33.34%，他們三個人合謀即可通過任何消息。不過這是 Sui PoS 系統設計，委員會成員是 Sui 的 active validators。

### 重播保護 — 安全

**Sui 端發起的轉帳：**
- `sequence_nums: VecMap<u8, u64>` 追蹤每種 message type 的下一個序號
- `approve_token_transfer` 對 Sui-originated 消息：`assert!(!record.claimed)` 防止重複認領
- 消息 key = `(source_chain, message_type, seq_num)`，唯一

**外鏈發起的轉帳：**
- `token_transfer_records` 使用 message key 作索引
- 如果 key 已存在，直接返回 `TokenTransferAlreadyApproved` event，不做第二次處理

**結論：重播保護充分。**

### approve_token_transfer 權限 — 設計觀察

`approve_token_transfer` 是完全 **permissionless**（無 capability 要求），任何人可以提交。安全性依賴：
1. `verify_signatures()` 驗證至少 33.34% voting power 的委員會成員 ECDSA 簽名
2. 消息包含 `source_chain` 和 `seq_num`，偽造需要破解 ECDSA

**潛在問題（低風險）：** 攻擊者可以先於正式 relayer 提交一個合法 message（搶先跑），但效果相同（因為接收方是 message 中指定的地址）。不影響安全，只影響誰付 gas。

### 緊急暫停機制

`execute_system_message` 包含 `emergency_op_pause` 邏輯，委員會可以暫停橋。同樣需要 33.34% voting power 簽名。暫停期間 `send_token` 和 `claim_token` 會 abort（`paused` 字段檢查）。

**風險：** 若 33.34% 的 validators 被攻陷或串謀，可以惡意暫停橋，造成活性攻擊。

### Rate Limiter

`limiter` 模塊追蹤每個路由的轉帳量，`check_and_record_sending_transfer` 超限後 abort，防止單筆大額攻擊的影響範圍。

---

## 總結風險評級

| 目標 | 漏洞 | 風險評級 |
|---|---|---|
| LayerZero EndpointV2 | lz_receive 身份驗證 | 安全 |
| LayerZero DVN 配置 | set_config 權限 | 安全 |
| LayerZero DVN 配置 | 1-of-1 DVN 設計風險 | 可疑（需 OApp 操作建議） |
| Kiosk B1 | TransferPolicy royalty bypass | 安全 |
| Kiosk B2 | Lock 繞過 | 安全 |
| Kiosk B3 | Listing price manipulation | 安全 |
| Sui Bridge | 委員會簽名驗證 | 安全（33.34% 閾值設計）|
| Sui Bridge | 重播保護 | 安全 |
| Sui Bridge | approve_token_transfer 無權限 | 設計觀察（低風險）|
| Sui Bridge | 緊急暫停可被 33% 觸發 | 設計風險（PoS 信任假設）|
