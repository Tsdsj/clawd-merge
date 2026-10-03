# API 与账号服务

当前采用 Node + SQLite 自托管，支持游客、密码、Linux.do、双登录方式四种身份。密码与新绑定按发布门禁开放；完整协议见 [账号契约](../docs/design/account-contract.md)，上线与回退见 [A07 清单](../docs/verification/a07-release-preparation.md)。

- `PASSWORD_AUTH_ENABLED`：原生密码服务总开关，由密码 Compose overlay 开启；已有密码账号后保持启用。
- `PASSWORD_REGISTRATION_ENABLED=0`：暂停密码注册/首次设密，保留已有密码登录、改密与恢复。
- `ACCOUNT_BINDING_ENABLED=0`：暂停新绑定（含 legacy 游客绑定），保留已有登录方式和近期验证。
- 密钥和实例配置只放私有环境；普通功能回退不覆盖数据库、不退回不识别密码凭据的后端。

## 旧 Worker/D1 参考

以下为旧运行时资料，不是当前密码账号的部署入口；新密码功能只在原生服务实现。

> 当前默认部署方式为 [Docker Compose 自托管](../deploy/README.md)。以下 Cloudflare 说明保留为旧运行时兼容参考；真实 Worker/D1/OAuth 配置不写入仓库模板。

### 历史排行榜（Cloudflare Workers + D1）

一个零依赖的 Cloudflare Worker，数据存在 D1（SQLite）。前端仍然托管在 GitHub Pages，跨域调用这个 API。

玩家有两种身份：

- **LINUX DO 登录**：通过 [LINUX DO Connect](https://connect.linux.do)（OAuth2）登录。名字就是 L 站用户名，不会重复；同一账号可以在多台设备上同时登录，成绩跟着账号走。
- **游客**：随便起名，可以和别人重名，会自动带上 `#4821` 这样的 4 位编号。身份只保存在当前浏览器里；之后登录 L 站，游客的成绩会并入 L 站账号。

## 部署

需要一个 Cloudflare 账号（免费版就够）。以下命令都在 `leaderboard/` 目录下执行。

### 首次部署

```bash
cd leaderboard
npx wrangler login                      # 浏览器里授权 Cloudflare
npx wrangler d1 create clawd-merge      # 创建数据库，记下输出里的 database_id
```

把 `database_id` 填进 [`wrangler.toml`](wrangler.toml)，然后：

```bash
npx wrangler d1 migrations apply clawd-merge --remote   # 建表 / 升级表结构
npx wrangler secret put LINUXDO_CLIENT_SECRET           # 粘贴 LINUX DO Connect 的 Client Secret
npx wrangler deploy                                     # 部署，输出 Worker 地址
```

部署完会得到形如 `https://clawd-merge-leaderboard.<你的子域>.workers.dev` 的地址：

1. 把它填进前端 [`src/config.js`](../src/config.js) 的 `LEADERBOARD_API`，提交并推送。
2. 在 [LINUX DO Connect](https://connect.linux.do) 的应用设置里，把**回调地址**设为 `<Worker 地址>/api/auth/linuxdo/callback`。
3. 把应用的 **Client ID** 填进 `wrangler.toml` 的 `LINUXDO_CLIENT_ID`（Client ID 是公开的，可以提交；**Client Secret 只用上面的 `wrangler secret put` 设置，不要写进任何文件**）。

### 以后更新

```bash
npx wrangler d1 migrations apply clawd-merge --remote   # 有新迁移时才需要
npx wrangler deploy
```

> **国内访问提醒**：`*.workers.dev` 在中国大陆经常连不上，这也会让 LINUX DO 登录的回调失败。如果玩家主要在国内，建议把一个自己的域名托管到 Cloudflare，然后在 `wrangler.toml` 里加上：
>
> ```toml
> routes = [{ pattern = "api.你的域名.com", custom_domain = true }]
> ```
>
> 重新 `npx wrangler deploy` 后，把 `LEADERBOARD_API` 改成 `https://api.你的域名.com`，并把 LINUX DO Connect 的回调地址改成 `https://api.你的域名.com/api/auth/linuxdo/callback`。

### 配置项（`wrangler.toml` 的 `[vars]`）

| 变量 | 作用 |
| --- | --- |
| `ALLOWED_ORIGINS` | 允许调用 API、登录后允许跳回的网页来源，逗号分隔 |
| `GAME_URL` | 登录出错又不知道从哪来时，跳回的游戏地址 |
| `BLOCKED_WORDS` | 额外的屏蔽词，逗号分隔；游客名字里**包含**这些词就不能用 |
| `LINUXDO_CLIENT_ID` | LINUX DO Connect 应用的 Client ID |
| `LINUXDO_MIN_TRUST_LEVEL` | 允许登录的最低 L 站信任等级，默认 `0` |
| `LINUXDO_CLIENT_SECRET` | **Secret**，用 `wrangler secret put` 设置，不在这个文件里 |

## 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `POST` | `/api/register` | `{ name }` → `{ player, token }`，游客身份，名字可重名（带 `#编号`） |
| `POST` | `/api/rename` | 游客改名 `{ name }`，每人每天 10 次 |
| `POST` | `/api/logout` | 注销当前设备的 token |
| `GET` | `/api/me` | 自己的资料、最佳成绩和排名 |
| `POST` | `/api/auth/linuxdo/start` | `{ returnTo }` → `{ url }`，跳去 L 站授权；带着游客 token 调用会在登录后合并成绩 |
| `GET` | `/api/auth/linuxdo/callback` | L 站授权回调，跳回游戏页并在网址 `#login=` 里带一个一次性登录码 |
| `POST` | `/api/auth/exchange` | `{ code }` → `{ player, token }`，用一次性登录码换 token |
| `POST` | `/api/session` | 开始一局，返回一次性的 `sessionId` |
| `GET` | `/api/session/check?sessionId=...` | 只读核验本人的旧凭证，返回 `{ status, serverNow, expiresAt }`；不消费或续签 |
| `POST` | `/api/score` | `{ sessionId, score, drops, maxLevel }` → `{ best, rank, improved }` |
| `GET` | `/api/leaderboard?limit=50` | 前 N 名（最多 100），每人只计最佳成绩 |

需要身份的接口都带 `Authorization: Bearer <token>`。

恢复核验的 `status` 为 `valid`、`expired`、`used` 或 `invalid`。不存在或不属于当前玩家的凭证统一返回 `invalid`，`expiresAt` 为 `null`；未认证返回 401。有效期仍为原开局后 3 小时，核验使用服务端时间并返回 `Cache-Control: no-store`。恢复成功不免除最终成绩提交时的校验；客户端不能通过恢复申请替代凭证。

断点续玩的只读接口本身不改表；包含可靠补传的版本必须先应用 `0003_score_receipts.sql`，再更新 Worker，最后发布前端。旧客户端的开局和提交字段保持兼容。

### 成绩幂等回执

`POST /api/score` 以服务端 sessionId 唯一标识一局。相同身份、相同 score/drops/maxLevel 的重复请求返回首次接受时的 `{ improved, best, rank }`；不同内容返回 409 `score_conflict`。回执中的排名是提交时个人最佳排名，实时名次通过 `/api/me` 或榜单查询。

凭证消费、成绩写入、局数累加、最佳成绩条件更新、回执接受在同一个 D1 batch 事务完成。任何写入失败整体回滚，凭证仍可重试。回执独立于 sessions 保留，开新局清理已用凭证不会删除回执；已经接受的结果可在原凭证过期后确认。首次提交仍须满足原有效期和全部防刷规则。

429 响应带 `Retry-After`（秒），CORS 显式暴露该头；401 等待原身份重新登录，规则拒绝与内容冲突不应无限重试。请求限流仍适用于重复查询。游客与已有 LINUX DO 身份合并时，已上传成绩和回执归属一起迁移；前端要求先处理未确认游客成绩再绑定。

迁移为增量加表，不重置历史成绩。升级前已经使用、却没有可关联回执的旧 session 不会被猜测为成功。回退代码时保留回执表和数据；旧版 Worker 不具备新的补传语义，不能与宣称可靠补传的前端混用。

## 安全

- **token**：浏览器保存一个随机 token（localStorage），数据库里只存它的 SHA-256；一个账号可以有多个 token（多设备）。
- **LINUX DO 登录**：标准 OAuth2 授权码流程。`state` 随机、一次性、10 分钟过期（防 CSRF）；登录完成后只把 2 分钟有效的**一次性登录码**放进网址，前端再用它换 token，真正的 token 不会出现在网址或浏览器历史里；登录后只允许跳回 `ALLOWED_ORIGINS` 里的页面（防开放重定向）。被禁言或未激活的 L 站账号不能登录。
- **防刷（尽力而为）**：网页游戏的成绩总是可以被伪造，这里挡住的是明显的作弊：
  - 每局成绩必须带服务端签发的 `sessionId`，只接受一次；同内容重试仅返回回执；
  - 从开局到提交的**真实耗时**必须够完成这么多次投放（每次投放至少间隔 0.5 秒）；
  - 分数不能超过投放次数允许的上限；
  - 注册、登录、改名、开局、提交都有频率限制。

## 本地开发与测试

不需要 Cloudflare 账号：测试和本地 API 用 Node 自带的 SQLite 模拟 D1（需要 Node 22.13+），本地 API 还自带一个**假的 LINUX DO 授权页**。

```bash
npm test          # 在仓库根目录运行接口测试（包括完整的 L 站登录流程）
npm run lb:dev    # 本地 API: http://localhost:8787
```

额外验证入口（不属于默认快速测试）：

```bash
node test/upload-timeout.integration.mjs  # 真实 HTTP 响应体停滞，约 16 秒
MINIFLARE_MODULE=/path/to/node_modules/miniflare node leaderboard/test/d1-receipts.integration.mjs
```

第二条使用已有 Miniflare/workerd 包，在隔离本地 D1 上验证并发唯一接受、冲突拒绝、事务回滚和回执重放，不访问线上数据库，不向项目添加依赖。故意触发回滚时会打印预期的 `isolated rollback test` 错误，最终应显示 PASS 并以 0 退出。

本地 `dev-server.mjs` 可选 `SCORE_FAULTS=1` 开启故障注入；默认关闭，部署的 Worker 不包含这些端点。`POST /__test__/score-mode` 接受 `pass`、`fail-before`、`drop-after`，`GET /__test__/stats` 只返回测试库的成绩、回执和局数计数。仅用于隔离测试数据，不用于线上。

本地 API 跑起来后，打开 `http://localhost:5173/?api=http://localhost:8787` 就能连它玩，点「用 LINUX DO 登录」会跳到假的授权页，随便填个用户名即可。

API 覆盖参数只对 loopback 页面生效（`localhost`、`127.0.0.1`、`[::1]`），并且目标也必须是 loopback HTTP(S) origin；不接受路径、账号密码、查询参数或 fragment。生产页面与局域网 IP 页面忽略覆盖参数。无效参数回退到 `src/config.js` 配置的地址，不会向参数指定的目标发送登录 token 或登录码。

本地身份按 API 地址分别保存，切换端口或主机名后需要使用对应身份；旧版共享的本地身份不会自动迁移，需重新登录或注册。线上身份存储键保持不变。

## 每日挑战接口（T10 开发版）

以下接口使用独立数据表和凭证，部署前须先应用 `0004_daily_challenges.sql`。本次只完成本地实现，尚未远程迁移或部署。

| 方法 | 路径 | 行为 |
| --- | --- | --- |
| GET | `/api/challenges/today` | 服务器北京时间题目、serverNow；已登录时附当日 allowance 与个人 me，匿名为 null |
| POST | `/api/challenges/session` | `{ challengeId, rulesVersion, requestId, mode?: "formal" }`；原子领取一次机会，稳定请求标识可重放 |
| GET | `/api/challenges/session/check?sessionId=...` | 本人原凭证核验，不领取、不续期；返回 valid／used／expired／invalid |
| POST | `/api/challenges/score` | 正式成绩提交，原子接受并返回不可变回执 |
| GET | `/api/challenges/leaderboard?challengeId=...&limit=20` | 每题前 N 名（最多 100）、总人数与本人 me；不含经典或练习成绩 |

题目对象包括 `challengeId`、`rulesVersion`、`count`、`startsAt`、`endsAt`、`submitUntil`、`attemptLimit`、`settleSeconds`、`stableSeconds`。以服务端返回值为准，不使用设备日期领取正式机会。当前规则为 100 投、每日 3 次、8 秒结算上限、0.75 秒落稳；旧题截止为次日北京时间 00:10。

开局响应包含 `session`、`challenge`、`allowance`、`serverNow` 和当前 `status`（valid／used／expired）。`session` 包含 sessionId、playerId、challengeId、rulesVersion、attempt、startedAt、submitUntil。相同 requestId 的身份／题目／版本必须一致；不可在响应不明时换 requestId 重试。已结束或过期的重放不能作为新正式局开始。

成绩请求示例字段（题目、版本与凭证必须来自原开局）：

```json
{
  "mode": "formal",
  "sessionId": "原正式凭证",
  "challengeId": "2026-10-03",
  "rulesVersion": "daily-1",
  "score": 3465,
  "drops": 100,
  "maxLevel": 9,
  "clawsUsed": 1,
  "settlingMs": 1200,
  "reason": "limit"
}
```

`reason` 为 `limit` 或 `danger`；limit 须 100 投且结算至少 750 ms，最多 8000 ms。未到 100 投时 settlingMs 须为 0。首次提交必须在服务器截止前处理；已接受的相同内容可在截止后重放 `{ sessionId, challengeId, rulesVersion, improved, best, rank }`。不同内容返回 409，不覆盖原回执。限流返回 Retry-After，客户端仍需遵守。

典型错误：`attempts_exhausted`（当日机会用完）、`challenge_changed`（需刷新日题）、`rules_mismatch`、`start_conflict`、`score_conflict`、`challenge_expired`、`bad_session`、`wrong_mode`。身份只由 Bearer token 确定；不能用请求体指定别人身份。

游客合并到已有 LINUX DO 身份时，已用次数相加，每题最佳取更高值，同分保留较早时间；历史接受回执不改写。合并后的 used 可能大于 3，remaining 始终是 `max(0, 3-used)`。客户端先处理未完成正式局、未确认开局和待处理成绩，再绑定或退出。

本地 `SCORE_FAULTS=1` 才启用的故障控制增加了挑战开局、提交、核验以及服务时钟模拟；仅供 loopback 隔离测试，不属于 Worker 路由，不会随 Worker 发布。验证证据见 [T10 交付记录](../docs/verification/m2-t10.md)。

## 运行观察与维护

`npm run ops:report -- --help` 提供只读 SQLite / D1 聚合报告、快照比较和有界清理候选。报告不会迁移、删除或部署；成绩/回执及挑战次数账本保留。未采集的上传成功率、真实完成率和留存明确为未知。详见[运行说明](../docs/operations/README.md)与[T12 验证](../docs/verification/m2-t12.md)。

## 名称策略与账号数据基础（A03，未部署）

游客注册/改名使用版本化本地策略；被替代的存量名称仍保留原身份和成绩。维护、许可证、筛选范围及只读扫描见[词库说明](data/name-policy/README.md)，迁移与后续认证边界见[A03记录](../docs/verification/a03-name-policy-and-migration.md)。0005准备账号表与会话元数据，密码入口仍未开启；本阶段不执行生产迁移。
