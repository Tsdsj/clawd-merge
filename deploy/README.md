# Docker Compose 自托管

前端静态文件、Node API、SQLite持久化、HTTPS和运维任务均运行在自有服务器。Compose 管理 `web`、`api`、`backup`。接在宿主机 Caddy 后面时，由 Caddy 提供 HTTPS；独立 TLS 模式才启用 `certbot`。不需要另开数据库网络端口。

仓库只提供通用代码与模板。实际主机、域名、账号、密钥、备份、巡检截图和运行参数在私有部署目录中管理，不加入Git，也不放进公开构建上下文。`leaderboard/wrangler.toml` 只保留旧运行时的开发模板。

## 文件与权限

- `compose.yaml`：服务、重启策略、日志轮转、资源上限与数据挂载。
- `compose.proxied.yaml`：宿主机反代模式，覆盖端口为 loopback 8080、选择 HTTP 模板并将 Certbot 移入回退 profile。
- `nginx-proxied.conf`：Caddy 后面的 HTTP 静态资源/API 代理，沿用安全响应头及不含 query 的日志。
- `Dockerfile`：Node24应用镜像，无额外npm生产依赖，以UID1000运行。
- `nginx.conf`：HTTPS、静态资源和API反代；从私有 `PUBLIC_HOST` 渲染。
- `nginx-bootstrap.conf`：首次签发证书时的HTTP验证入口，不提供业务API。
- `nginx-start.sh`：启动代理并定期重新加载共享证书，不挂载Docker socket。
- `server/backup.mjs`：在线SQLite备份、完整性检查、14天同机备份轮转。

为data/backups目录设置UID1000可写，其他用户不可读；OAuth Secret单独保存为UID1000可读的0400文件，由Compose secret挂载，不能写进镜像或Compose源码。配置与TLS私钥仅给运维账户和相应容器访问。

宿主机反代模式下，Caddy 占用 80/443，clawd 仅发布 `127.0.0.1:8080`（私有 `WEB_PROXY_PORT` 可调整）。独立 TLS 模式才由 clawd 发布 80/443。API3000 仅在 Compose 网络内可达，SQLite 没有网络端口。API 仅在该私有反代结构中启用 `TRUST_PROXY=1`；不要把 API 端口另行发布到公网。

## 已接入宿主机 Caddy 的发布方式

这是宿主机已有统一 HTTPS 入口时的更新方式。不要再按下面的独立 TLS 首次签发步骤启动 Certbot。

1. 将本目录的 `compose.yaml`、`compose.proxied.yaml` 同步到私有 Compose 目录；将 `nginx-proxied.conf` 与 `nginx-start.sh` 同步到 `CLAWD_DEPLOY_DIR` 指定的配置目录。两个目录可能不同，不能只上传源码包。
2. 私有 `.env` 保留 `COMPOSE_FILE=compose.yaml:compose.proxied.yaml`。始终在该 Compose 目录中运行命令：

   ```bash
   docker compose --env-file .env config --quiet
   docker compose --env-file .env config --services
   docker compose --env-file .env ps
   ```

   默认服务应只有 `api`、`web`、`backup`。检查最终 web 端口只有 `127.0.0.1:8080 -> 80`，没有公网 80/443，也没有 API 的宿主端口。
3. **显式 `-f` 会覆盖 `.env` 的 `COMPOSE_FILE` 选择。** 发布工具如果指定文件，必须每次使用完整组合：

   ```bash
   docker compose --env-file .env -f compose.yaml -f compose.proxied.yaml config --quiet
   ```

   build、up、ps、logs、exec、run 都沿用同一组合；禁止在 Caddy 模式下只传 `-f compose.yaml`。通过检查和发布审批后，才对已核定版本执行更新。
4. 账号功能开放另有发布门禁。批准后追加 `compose.password.yaml` 时，必须保留 proxied 文件：`-f compose.yaml -f compose.proxied.yaml -f compose.password.yaml`。不能用 password overlay 替换反代 overlay。
5. 不修改现有 Caddy 站点、宿主防火墙、Docker live-restore 或 SSH 设置。已有证书目录保留作回退材料；回退应用版本时继续使用 proxied 组合，不能直接抢回 80/443。

反代信任边界：宿主代理必须覆盖 `X-Real-IP`；若前面有 CDN，只信任从已核实 CDN 地址发来的客户端 IP 信息。Nginx 模板信任 loopback 和默认 Docker 私网范围 `172.16.0.0/12`，不会把任意公网来源声明的头直接当作客户端地址；自定义 Docker 网段需在私有配置中核对。此配置依赖宿主本地端口及容器网络隔离，不应让不可信容器加入 clawd 网络。不要把 8080 改成 `0.0.0.0`，也不要额外信任所有来源。

仓库配置检查：`npm run test:deploy`（需要支持 `!override` 的 Docker Compose，不需要启动 Docker 容器）。它验证 loopback 端口、模板覆盖、Certbot 默认排除，以及与密码 overlay 的叠加结果。实际服务器仍需检查 `nginx -t`、外部 HTTPS/API 和容器发布端口。

## 独立 TLS 初始化与更新

1. 安装Docker Engine和Compose插件。为实际实例准备私有环境文件，字段参照 `.env.example`，生产镜像固定到验证过的digest。
2. 配置域名DNS及入站80/443；保留现有可用SSH通道，不在未验证密钥时关闭密码登录。
3. 在项目根目录生成静态产物（`public/`已忽略）：

   ```bash
   PUBLIC_ORIGIN=https://game.example.invalid node scripts/build-site.mjs
   ```

   实际部署值由私有环境注入。保持已有浏览器数据时，还需设置 `PRODUCTION_DATASET`，其值是持久化数据集标识，迁移时不要随API地址改写。静态文件只发布生成的public目录，禁止发布仓库根目录、secrets、数据库或备份。

4. 首次启动先使用bootstrap代理配置；执行 `docker compose config --quiet`，构建api镜像，启动web。
5. 通过Compose一次性运行Certbot webroot签发证书，再换正式代理模板并重建web。证书请求使用实际私有域名配置；不要提交带真实域名的命令脚本。
6. 启动全部服务，检查API health、HTTPS、证书自动续期dry-run、在线备份与恢复；验证主机重启后恢复。
7. 更新应用时生成新release镜像和静态产物，固定镜像版本；保留上个镜像与数据备份。Dockerfile/schema改变时先在副本测试，不能直接回退到不兼容数据库的旧程序。

`certbot`每12小时尝试续期；Nginx每6小时核验并reload读取新证书。人工验证续期使用 `renew --dry-run --no-random-sleep-on-renew`，避免把Certbot默认随机等待误判为故障。

`backup`每6小时做一致性备份，并在成功验证后轮转它自己创建的旧文件。**同机备份不等于异机容灾**；实际部署另保存受限的离线副本，异机自动备份需配置已授权的目标和凭据，不默认向任何外部存储发送数据。

常用命令（实际env与compose路径由运维环境提供）：

```bash
docker compose ps
docker compose logs --tail 30 api
docker compose run --rm --entrypoint node backup server/backup.mjs
docker compose exec api node leaderboard/ops/run.mjs --sqlite /data/clawd.sqlite --out /tmp/ops-report
```

日志不应输出密码、token、OAuth code或完整请求体。Nginx访问日志用不带query的URI；错误日志阈值避免普通请求错误附带OAuth查询参数。运行报告与备份都不入库。

## D1迁移与切换

1. 先导出并恢复一份D1副本；验证完整性、迁移版本、各业务表计数和稳定排序后的行摘要。原始导出与摘要保存在私有目录，不提交玩家信息。
2. 在隔离副本验证生产Node适配器：现有token、最佳分、经典成绩回执、每日次数与并发幂等都要保留。
3. 新站先保持维护状态，旧API进入暂停写入状态；确认旧写入安静后再次导出最终快照。
4. 停止新站api/backup，离线恢复最终SQLite，核对全部业务表摘要一致，再启动。迁移保留原playerId/token/session与receipt，不从聚合排行榜重建历史。
5. 调整同一个Linux.do应用的主页、回调和图标地址；使用原凭据保留provider身份。切换中未完成的旧OAuth流程提示从新站重试，不能把旧回调code转交给新redirect_uri强行兑换。
6. 开放新站、验证真实OAuth及游玩。旧Worker可短期只转发已打开旧标签页的请求，**不再绑定或写入旧D1**。新站的HTML/API/OAuth/数据库均不依赖这个兼容入口。
7. 旧D1保留只读回退副本，旧Pages只提供搬家入口；明确兼容期与后续人工退役。切勿同时恢复旧D1写入，否则会出现双主分叉。

回退优先回退自托管程序版本，保留当前数据库。若要退回旧基础设施，必须停写、导出最新SQLite并校验同步，不能把初始快照直接覆盖上线后新增数据。

## 旧域名本机数据

浏览器localStorage不能跨来源自动共享。`migration.html`提供一次性、由用户确认的搬家：

- 使用固定来源/目标校验、窗口引用与随机nonce的postMessage，不把token/存档放进URL或上传服务器。
- 只搬本项目生产数据集，排除其他网站与开发环境；沿用原scope，避免破坏存档及补传队列。
- 迁移前取得两个模式的存档锁；有其他游戏页面持锁时先提示关闭。
- 不覆盖新地址的不同账号、存档或结果；同一账号保留新地址的登录凭据，本机最高分取较高值、图鉴取并集。存储失败时回退已写值，原地址数据始终保留。
- 过期凭据不会延长有效期；已有待处理记录仍按原身份/原规则处理。

旧Pages工作流从仓库变量注入公开迁移地址，生成部署artifact，具体实例值不进入Git源码。变量名称见 `.github/workflows/legacy-pages.yml`。先将Pages切换为Actions部署，再手动发布该兼容入口，避免普通源码提交重新发布旧游戏。

## 验证入口

`npm test`覆盖原游戏、API、生产SQLite/HTTP适配器、数据搬家与旧API兼容；`npm run test:http`核验真实HTTP超时；`npm run test:d1`保留旧实现的回执/并发参考。`node test/domain-migration-browser.mjs`启动两个隔离的临时来源，用合成数据验证跨来源交互。

生产数据核对、真实OAuth、实际浏览器、HTTPS续期、Compose健康和重启恢复的证据放在私有交付记录；不能只用单元测试或容器running状态宣称整站迁移完成。
