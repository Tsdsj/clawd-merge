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
| `POST` | `/api/score` | `{ sessionId, score, drops, maxLevel }` → `{ best, rank, improved }` |
| `GET` | `/api/leaderboard?limit=50` | 前 N 名（最多 100），每人只计最佳成绩 |

需要身份的接口都带 `Authorization: Bearer <token>`。

## 安全

- **token**：浏览器保存一个随机 token（localStorage），数据库里只存它的 SHA-256；一个账号可以有多个 token（多设备）。
- **LINUX DO 登录**：标准 OAuth2 授权码流程。`state` 随机、一次性、10 分钟过期（防 CSRF）；登录完成后只把 2 分钟有效的**一次性登录码**放进网址，前端再用它换 token，真正的 token 不会出现在网址或浏览器历史里；登录后只允许跳回 `ALLOWED_ORIGINS` 里的页面（防开放重定向）。被禁言或未激活的 L 站账号不能登录。
- **防刷（尽力而为）**：网页游戏的成绩总是可以被伪造，这里挡住的是明显的作弊：
  - 每局成绩必须带一个服务端签发、只能用一次的 `sessionId`；
  - 从开局到提交的**真实耗时**必须够完成这么多次投放（每次投放至少间隔 0.5 秒）；
  - 分数不能超过投放次数允许的上限；
  - 注册、登录、改名、开局、提交都有频率限制。

## 本地开发与测试

不需要 Cloudflare 账号：测试和本地 API 用 Node 自带的 SQLite 模拟 D1（需要 Node 22.5+），本地 API 还自带一个**假的 LINUX DO 授权页**。

```bash
npm test          # 在仓库根目录运行接口测试（包括完整的 L 站登录流程）
npm run lb:dev    # 本地 API: http://localhost:8787
```

本地 API 跑起来后，打开 `http://localhost:5173/?api=http://localhost:8787` 就能连它玩，点「用 LINUX DO 登录」会跳到假的授权页，随便填个用户名即可。

API 覆盖参数只对 loopback 页面生效（`localhost`、`127.0.0.1`、`[::1]`），并且目标也必须是 loopback HTTP(S) origin；不接受路径、账号密码、查询参数或 fragment。生产页面与局域网 IP 页面忽略覆盖参数。无效参数回退到 `src/config.js` 配置的地址，不会向参数指定的目标发送登录 token 或登录码。

本地身份按 API 地址分别保存，切换端口或主机名后需要使用对应身份；旧版共享的本地身份不会自动迁移，需重新登录或注册。线上身份存储键保持不变。
