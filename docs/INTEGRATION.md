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

## 五、尚未支持：远程授权

你提的第二种激活方式（客户端上报设备码 → 开发者在后台批准 → 客户端拿到授权），
**目前没有实现**。现在的激活只有一条路径：客户端直接提交授权码。

要实现，需要在现有链路上加三段：

1. **设备码申请**：客户端在无码状态下把自己的设备指纹 + 应用标识提交到
   `POST /client/v1/device-requests`，服务端生成一次性 `request_code` 返回给客户端显示
2. **开发者批准**：管理后台新增「待批准设备」页，开发者选择产品/策略/有效期后批准，
   服务端生成授权码并绑定该设备，写入激活记录
3. **客户端轮询/长轮询**：`GET /client/v1/device-requests/:request_code`，
   未批准返回 `pending`，批准后返回与激活接口完全相同的响应体

关键设计点：
- 请求必须有过期时间（如 10 分钟），否则会堆积大量僵尸请求
- 批准动作要落审计，且受渠道范围约束
- 批准后下发的仍是普通授权码，**后续链路完全复用**，不需要第二套心跳/离线逻辑
- 客户端轮询需要限流，避免变成 DDoS 手段

这部分我还没动代码。要做的话是个中等规模的功能（新表 + 两个接口 + 一个后台页面）。
