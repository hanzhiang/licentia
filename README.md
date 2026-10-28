# Licentia

> **多租户软件授权与许可管理平台**
> Multi-tenant software licensing & entitlement platform

Licentia 用来给商业软件发"钥匙"：把授权码发给客户，客户在设备上激活，客户端定期心跳续验，
断网时靠离线签名许可继续工作；到期、续费、吊销、换机都有明确的状态机和审计留痕。

它面向的是**要把软件卖给学校、机构或企业**的团队——需要按客户隔离数据、按渠道分发、
能对账、能追溯、出事能恢复。

名字取自拉丁语 *licentia*（许可、授权）。

---

## 它解决什么问题

卖软件时绕不开这几件事，Licentia 把它们做成了一套可交付的系统：

| 问题 | 做法 |
|---|---|
| 授权码怎么发、怎么防止被猜 | 31 字符集 + Damm 校验位（79.3 bit 熵），批量发码带幂等键 |
| 客户换电脑怎么办 | 设备指纹绑定 + 当月自助换机配额 + 管理端解绑即时踢下线 |
| 客户断网还能用吗 | Ed25519 离线许可，带时钟回拨守卫和离线窗口 |
| 怎么防止一个码装十台机器 | 设备数/席位数/并发数三种限制，按设备或按用户计 |
| 到期了怎么提醒 | 30/7/1 天三级提醒，邮件或短信真实投递，失败退避到死信 |
| 渠道商怎么只管自己的码 | RBAC 角色 + 门户自助 |
| 谁在什么时候改了什么 | 哈希链审计，可独立验链 |
| 数据丢了怎么办 | pg_dump 备份 + 一键恢复演练，校验行数/迁移/授权/审计链四项 |

---

## 核心能力

| 能力 | 实现位置 |
|---|---|
| **多租户隔离**：数据库层强制 RLS，连接角色 NOBYPASSRLS | `db/migrations` + `packages/db` |
| **授权码生命周期**：发码 → 激活 → 心跳 → 续期 → 吊销，状态机穷举 | `packages/domain` |
| **授权码体系**：31 字符集、Damm 校验位、混淆字符归一化 | `packages/keygen` |
| **离线许可**：JWS EdDSA 紧凑签名，双 kid 轮换并行验证窗 | `packages/signer` |
| **IAM / RBAC**：RS256 访问令牌、可轮换吊销的 refresh、scrypt 口令、Redis 跨副本登录限流 | `apps/admin-api/iam` |
| **审计哈希链**：同事务写链 + advisory lock 防分叉 + 验链 API | `packages/audit` |
| **API Key**：明文一次性、常数时间比较、7 天重叠轮换、按秒限流 | `packages/db` + `apps/open-api` |
| **Webhook**：Outbox 扇出 → HMAC 签名投递 → 指数退避 → 死信 → 端点熔断 | `apps/worker` |
| **通知投递**：SMTP / 短信网关，pending → sent 真实状态机 | `packages/notify` |
| **自助门户**：手机验证码登录、组织授权激活、自助换机 | `apps/portal-api` |
| **管理后台**：产品策略、发码、授权与设备、客户、报表、审计、API Key、Webhook | `web/` |
| **渠道工作台**：独立前端，面向渠道发码账号 | `partner-web/` |
| **TS SDK**：零依赖，激活/心跳/离线验签/Webhook 验签 | `sdks/ts` |
| **存量迁移**：旧 SQLite 库 dry-run、幂等导入、旧码兜底 | `apps/tools` |
| **备份恢复演练**：角色、授权、分区行数、审计链四维校验 | `apps/tools/backup.ts` |

---

## 架构

```
调用方                         进程（互不调用）              共享存储
─────────────────────────────────────────────────────────────────────
管理员     ── 管理后台 5173 ──▶ admin-api  3001 ─┐
渠道账号   ── 渠道台  5174 ──▶         ─────────┤
终端客户   ── 门户    ───────▶ portal-api 3004 ─┤──▶ PostgreSQL 55432
业务系统   ── API Key ───────▶ open-api   3003 ─┤    （28 表 + RLS + 分区）
客户端 SDK ── 码/token ──────▶ client-api 3002 ─┤
                               worker        ──┴──▶ Redis / Vault
                               （到期扫描、Outbox、投递、提醒）
```

**几个关键设计取舍**

- **共享数据库而非服务拆分**。单机交付阶段，五个进程共用一个 PostgreSQL，租户隔离靠数据库
  RLS 强制实施而不是靠应用自觉。代价是边界耦合，收益是事务一致性与运维简单。
- **事件与业务同事务**。所有领域事件写进 `events` 表（Outbox），由 worker 异步发布，
  不会出现"业务成功但事件丢了"。
- **写接口幂等**。发码、续期、吊销都要求幂等键，同键同体重放返回首次结果。
- **审计可独立验证**。每条审计记录串进哈希链，任何人可以重算整条链确认没被篡改。

更完整的架构评估见 [架构审查报告](docs/architecture/review/2026-10-28-license-platform-codebase-architecture.html)。

---

## 快速开始

```bash
pnpm install
docker compose -f deploy/docker-compose.yml up -d   # PostgreSQL 55432 + Redis + Vault
pnpm db:migrate                                     # 建表 + 种子数据 + 权限
pnpm seed:users                                     # 种子账号
pnpm dev                                            # 拉起全部服务 + 管理后台
```

- 管理后台：<http://localhost:5173>
- 渠道工作台：<http://localhost:5174>
- 初始账号：`admin@demo.local` / `Passw0rd!demo`

| 邮箱 | 角色 | 权限要点 |
|---|---|---|
| super@lp.local | super_admin | 全部，需 `X-Tenant-Id` 指定租户 |
| admin@demo.local | tenant_admin | 本租户全部 |
| operator@demo.local | operator | 发码/续期/吊销 |
| partner@demo.local | partner | 渠道发码 |
| support@demo.local | support | 查询/解绑 |
| finance@demo.local | finance | 只读报表/审计 |

详细上线流程见 [交付与运维手册](docs/OPERATIONS.md)。

---

## 测试

```bash
pnpm test        # 单元 + 集成 60 项（Vault 未启动时自动跳过）
pnpm test:e2e    # 端到端 42 项（真实 PostgreSQL）
pnpm smoke       # HTTP 全链路 13 步：登录 → RBAC → 发码 → 激活 → 心跳 → 吊销 → 验链
pnpm backup:drill # 备份 → 建临时库 → 恢复 → 比对 → 验审计链 → 清理
```

---

## API 速查

```
POST /admin/v1/auth/login|refresh|logout          匿名
POST /admin/v1/batches                            license:issue    幂等键必带
GET  /admin/v1/licenses[/:id]                     license:read
POST /admin/v1/licenses/:id/renew                 license:renew    幂等键
POST /admin/v1/licenses/:id/revoke                license:revoke:approve
GET  /admin/v1/audit-events[/verify]              audit:read
POST /admin/v1/webhook-endpoints[/:id/reset-breaker]  webhook:write
POST /client/v1/activate|heartbeat                授权码 / client token
POST /open/v1/validate                            API Key + validate scope
GET  /.well-known/jwks.json                       公开
POST /portal/v1/auth/otp/request|verify           匿名
POST /portal/v1/licenses/activate-org             门户令牌
POST /portal/v1/activations/:id/release           门户令牌，月配额
```

统一错误格式：`{ "error": { "code", "message", "details", "request_id" } }`

---

## 目录结构

```
apps/
  admin-api/    运营管理面：IAM、发码、授权、报表、Webhook
  client-api/   客户端面：激活、心跳、JWKS
  open-api/     开放面：业务系统校验
  portal-api/   自助门户：终端客户
  worker/       后台任务：过期扫描、Outbox、投递、提醒
  tools/        存量迁移、备份恢复演练
packages/       13 个共享包（domain / db / signer / audit / notify …）
sdks/ts/        零依赖 TypeScript SDK
web/            管理后台（Vue3 + Element Plus）
partner-web/    渠道工作台
db/migrations/  6 个迁移，线性可回滚
```

---

## 已知限制

- 应用进程目前直接跑在宿主机上，**没有应用镜像**，部署不可复现
- worker 为单进程单实例，**没有健康探测**，是异步能力的单点
- 数据库为单实例，无高可用
- 渠道账号尚未做渠道级数据隔离（详见架构审查报告）
- JWT 私钥默认落在本机 `data/keys`，多副本需共享卷或改 KMS

这些是已知且记录在案的取舍，不是意外。

---

## 许可

**非商业使用免费，商业使用需授权。**

本项目采用 [Licentia Source-Available License 1.0](LICENSE)：允许个人学习、研究、教学，
以及教育、科研、公益、政府机构的公益用途；**禁止任何商业使用**（付费产品、付费服务、
打包进收费产品、营利组织的创收业务等）。

商业授权请联系：<rylanx@126.com>

> 注意：由于限制商业使用，本协议不属于 OSI 定义的开源许可，属于"源码可见"（source-available）。

---

## 作者

**Rylan** · <rylanx@126.com>
