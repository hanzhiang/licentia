# 接入指南（已实测）

这份文档描述**两条接入路径**：开发者怎么把产品接进来，客户端怎么和服务器通信。
所有命令与请求都在本机实际跑过，末尾附本次运行的原始输出。

---

## 一、开发者接入：从注册到发出第一个码

### 1. 注册开发者账号

管理后台登录页 → 「立即注册」，或直接调接口：

```http
POST /admin/v1/auth/register
Content-Type: application/json

{ "email": "dev@example.com", "password": "至少8位", "developer_name": "某某软件工作室" }
```

返回 `requires_verification` 和（非生产环境）`dev_code`，用验证码调用
`POST /admin/v1/auth/verify-email` 后拿到会话。**未验证邮箱不能登录。**

注册成功即创建了一个独立租户——这个账号就是该租户的 `developer_owner`，
后续所有数据都只属于它自己。

### 2. 建产品、策略、渠道

```http
POST /admin/v1/catalog/products   { "code": "dorm-check", "name": "宿舍查寝" }
POST /admin/v1/catalog/policies   { ... 期限/设备数/席位/功能 ... }
POST /admin/v1/catalog/channels   { "code": "default", "name": "直销" }
```

- **产品 code 的前 4 个字符会成为授权码前缀**（`dorm-check` → `D0RM`）
- 策略决定：有效期、设备数上限、席位数、并发数、功能权益、离线窗口、心跳间隔
- 前 4 位不足 4 个字母数字会直接报错，这是刻意的

### 3. 发码

```http
POST /admin/v1/batches
Idempotency-Key: <唯一值，必填>
{ "product_id": "...", "policy_id": "...", "channel_id": "...", "quantity": 100 }
```

- 单批上限 `BATCH_SYNC_THRESHOLD`（默认 1 万），超过请分批
- `quantity <= 100` 时明文码随响应返回；更多请用 `GET /admin/v1/batches/:id/export`
- 同 `Idempotency-Key` 重放返回首次结果，不会重复发码

### 4. 交付给客户

```http
POST /admin/v1/batches/:id/deliver    { "to": "customer@example.com" }
POST /admin/v1/licenses/:id/deliver   { "to": "customer@example.com" }
```

不传 `to` 时回落到该授权绑定的组织联系人邮箱。每次交付都写入 `license_deliveries`，
可查重发次数与送达结果（`GET /admin/v1/licenses/:id/deliveries`）。

---

## 二、客户端接入：设备 → 激活 → 心跳

### 1. 设备标识

客户端首次运行时生成稳定指纹并持久化，之后每次激活/心跳都用同一个：

| `fp_type` | 适用 | 说明 |
|---|---|---|
| `machine_id` | 桌面端 | 机器指纹（示例用 hostname+platform+arch 的 SHA-256） |
| `install_id` | 通用 | 安装时随机生成并持久化，重装即失效 |
| `openid` / `unionid` | 小程序 | 微信身份 |
| `account` | 服务端 | 业务账号 |

**不要用易变的指纹**（如网卡 MAC 可能变、IP 一定变），否则用户会被反复占用设备额度。

### 2. 激活

```http
POST /client/v1/activate        (client-api，默认 :3002)
{
  "code": "D0RM-XXXX-XXXX-XXXX-XXXX-C",
  "app":    { "product_code": "dorm-check", "version": "2.4.1" },
  "device": { "fp_type": "machine_id", "fingerprint": "...", "platform": "windows" },
  "context": { "user_id": "student-1001" }
}
```

成功返回：

```json
{
  "client_token": "ct_...",
  "license": { "status": "activated", "features": ["dorm","leave"],
               "device": { "bound": 1, "limit": 5 } },
  "offline_license": "<JWS>",
  "server_time": 1793xxxxxx
}
```

- 首次激活 `201`，同设备重复激活 `200`（幂等，不占新设备额度）
- `context.user_id` 是**席位**的计费单位；不传则按激活记录计

### 3. 心跳

```http
POST /client/v1/heartbeat
Authorization: Bearer ct_xxx
{ "context": { "user_id": "student-1001" } }
```

- 返回**新的** `client_token`，客户端必须立即替换（旧 token 有 5 分钟重叠窗口）
- 心跳间隔取策略的 `heartbeat_hours`；服务端按这个窗口统计在线席位与并发
- 席位/并发超限返回 `429 SEAT_CONCURRENCY_LIMIT`

### 4. 离线许可

激活与心跳都会下发一枚 Ed25519 签名的离线许可，有效期 = 策略的 `offline_window_days`。
客户端断网时用它本地判定权益，不需要连服务器。

验签用 `GET /.well-known/jwks.json` 的公钥；支持双 kid 轮换（旧许可在并行验证窗内仍可验）。

**时钟回拨守卫**：客户端应记住见过的最大 `server_time`，本地时间比它倒退超过容忍值时
拒绝离线运行，强制联网重验。

### 5. 服务端校验（第三方业务系统用）

```http
POST /open/v1/validate        (open-api，默认 :3003)
Authorization: Bearer lpk_live_...
{ "code": "D0RM-..." }
```

返回 `valid` 与原因（`LIC_REVOKED` / `LIC_EXPIRED` 等）。结果按秒级缓存，
吊销会通过 Redis 广播立即失效。

---

## 三、客户端要处理的状态

| 情况 | 服务端返回 | 客户端动作 |
|---|---|---|
| token 过期 / 无效 | `401 AUTH_REQUIRED` | 用本地保存的授权码静默重新激活一次 |
| 设备被解绑（换机） | `401 AUTH_REQUIRED` | 提示用户重新激活 |
| 授权被吊销 | `410 LIC_REVOKED` | 停止服务，提示联系供应商 |
| 授权被暂停 | `423 LIC_SUSPENDED` | 暂停功能，保留数据 |
| 席位/并发已满 | `429 SEAT_CONCURRENCY_LIMIT` | 提示"席位已满"，不要重试轰炸 |
| 网络不可达 | — | 用离线许可继续，到期前必须联网 |

---

## 四、本次实测记录

用真实服务跑通「发码 → 客户端激活 → 心跳」：

```bash
# 1. 发一个码（owner 账号）
code=D0RM-4KMK-PAAV-M3SG-RVXH-X

# 2. 跑仓库自带的接入示例
LICENSE_CODE=$code LICENSE_STATE_FILE=./data/demo-client-state.json pnpm client:demo
```

输出：

```json
{ "step": "activate",  "valid": true, "features": ["dorm","leave"],
  "expires_at": "2026-11-05T02:08:13.000Z", "source": "offline" }
{ "step": "heartbeat", "valid": true, "features": ["dorm","leave"],
  "expires_at": "2026-11-05T02:08:13.000Z", "source": "offline" }
```

`source: "offline"` 表示权益是**用离线许可本地算出来的**——即使 client-api 挂了，
客户端在离线窗口内仍可继续工作。`expires_at` 是离线窗口（7 天），不是授权本身的到期日。

---

## 五、远程授权（已实现）

除了"客户端拿着授权码激活"，还有第二条路径：**客户端先上报设备，开发者后台批准，客户端轮询拿码**。
适合设备已经装好、但码还没发到用户手上的场景。

### 1. 客户端申请设备码

```http
POST /client/v1/device-requests        (client-api :3002，匿名)
{
  "product_code": "dorm-check",
  "tenant_code":  "demo",              // 产品编码在多个开发者下重名时必填
  "app_version":  "2.4.1",
  "user_id":      "student-1001",      // 可选，作为席位归属
  "device": { "fp_type": "machine_id", "fingerprint": "...", "platform": "windows" }
}
```

返回：

```json
{ "request_code": "A9WA-XDMY", "expires_at": "...", "poll_interval_s": 3 }
```

把 `request_code` 显示给用户，让他报给客服。**有效期 10 分钟**，同一设备每小时最多申请 5 次。

### 2. 开发者在后台批准

管理面板 →「待批准设备」，选择策略后批准。对应接口：

```http
GET  /admin/v1/device-requests?status=pending     license:read
POST /admin/v1/device-requests/:id/approve        license:issue   { "policy_id": "..." }
POST /admin/v1/device-requests/:id/reject         license:issue   { "note": "未购买" }
```

批准时按策略生成一张**普通授权码**并绑定这张申请；拒绝会带上原因让客户端展示。

### 3. 客户端轮询并激活

```http
POST /client/v1/device-requests/:code/poll
{ "device": { "fp_type": "machine_id", "fingerprint": "...", "platform": "windows" } }
```

```json
{ "status": "pending",  "expires_at": "..." }
{ "status": "approved", "code": "D0RM-...", "product_code": "dorm-check" }
{ "status": "rejected", "note": "未购买" }
{ "status": "expired" }
```

拿到 `approved` 后用返回的 `code` 走**标准激活接口**——后续心跳、离线许可、校验全部复用，
不存在第二套鉴权。

**轮询必须带同样的设备指纹**，否则别人拿到短码也能把授权领走（服务端会按"不存在"处理）。

SDK 已封装：

```ts
const { requestCode } = await client.requestDeviceApproval();
showToUser(requestCode);                       // 展示给用户报给客服
const entitlement = await client.awaitDeviceApproval(requestCode, { timeoutMs: 10 * 60_000 });
```

### 安全约束

- 申请码 10 分钟过期，同设备每小时限 5 次
- 批准受渠道范围约束，且落审计（`device_request.approve` / `.reject`）
- 重复批准、批准已过期申请都会被拒
- 策略与申请产品不一致时拒绝批准
