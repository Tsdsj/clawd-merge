# 合成大Clawd 排行榜（Cloudflare Workers + D1）

一个零依赖的 Cloudflare Worker，数据存在 D1（SQLite）。前端仍然托管在 GitHub Pages，只是跨域调用这个 API。

## 部署

需要一个 Cloudflare 账号（免费版就够）。以下命令都在 `leaderboard/` 目录下执行。

```bash
cd leaderboard
npx wrangler login                      # 浏览器里授权 Cloudflare
npx wrangler d1 create clawd-merge      # 创建数据库，记下输出里的 database_id
```

把 `database_id` 填进 [`wrangler.toml`](wrangler.toml)，替换 `REPLACE_WITH_YOUR_DATABASE_ID`，然后：

```bash
npx wrangler d1 execute clawd-merge --remote --file=schema.sql   # 建表
npx wrangler deploy                                              # 部署，输出 Worker 地址
```

部署完会得到形如 `https://clawd-merge-leaderboard.<你的子域>.workers.dev` 的地址。把它填进前端的 [`src/config.js`](../src/config.js) 里的 `LEADERBOARD_API`，提交并推送，GitHub Pages 上的游戏就启用排行榜了。

> **国内访问提醒**：`*.workers.dev` 在中国大陆经常连不上。如果玩家主要在国内，建议把一个自己的域名托管到 Cloudflare，然后在 `wrangler.toml` 里加上：
>
> ```toml
> routes = [{ pattern = "api.你的域名.com", custom_domain = true }]
> ```
>
> 重新 `npx wrangler deploy` 后，把 `LEADERBOARD_API` 改成 `https://api.你的域名.com`。

### 配置项（`wrangler.toml` 的 `[vars]`）

| 变量 | 作用 |
| --- | --- |
| `ALLOWED_ORIGINS` | 允许调用 API 的网页来源，逗号分隔。默认是 GitHub Pages 和本地开发地址 |
| `BLOCKED_WORDS` | 额外的屏蔽词，逗号分隔；名字里**包含**这些词就不能注册 |

## 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `POST` | `/api/register` | `{ name }` → `{ player, token }`。名字 2~12 个字，不区分大小写查重 |
| `GET` | `/api/me` | 需要 `Authorization: Bearer <token>`，返回自己的最佳成绩和排名 |
| `POST` | `/api/session` | 开始一局，返回一次性的 `sessionId` |
| `POST` | `/api/score` | `{ sessionId, score, drops, maxLevel }`，返回 `{ best, rank, improved }` |
| `GET` | `/api/leaderboard?limit=50` | 前 N 名（最多 100），每人只计最佳成绩 |

## 身份与防刷

- **用户名绑定浏览器**：注册时服务端生成一个随机 token 交给浏览器保存（localStorage），数据库里只存它的 SHA-256。清除浏览器数据会丢失这个名字。
- **不能重名**：名字经过 NFKC 规范化（全角字母视同半角）后按小写唯一。`admin`、`官方`、`Claude` 等保留名不能直接注册。
- **防刷（尽力而为）**：网页游戏的成绩总是可以被伪造，这里挡住的是明显的作弊。
  - 每局成绩必须带一个服务端签发、只能用一次的 `sessionId`；
  - 从开局到提交的**真实耗时**必须够完成这么多次投放（每次投放至少间隔 0.5 秒）；
  - 分数不能超过投放次数允许的上限；
  - 注册每个 IP 每小时 5 次，开局和提交每人每小时各有上限。

## 本地开发与测试

不需要 Cloudflare 账号：测试和本地 API 用 Node 自带的 SQLite 模拟 D1（需要 Node 22.5+）。

```bash
npm test          # 在仓库根目录运行接口测试
npm run lb:dev    # 本地 API: http://localhost:8787
```

本地 API 跑起来后，打开 `http://localhost:5173/?api=http://localhost:8787` 就能连它玩。也可以直接用 `npx wrangler dev`。
