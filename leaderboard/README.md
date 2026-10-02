# 合成大Clawd 排行榜（Cloudflare Workers + D1）

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
