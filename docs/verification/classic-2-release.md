# classic-2 发布记录

2026-10-12，按用户明确授权（“部署更新一版上去，做好老版本备份”）发布。

- 生产站点：<https://clawd.ttqq.dev>
- 产品发布提交：`220b0edb8768ffb30d2b26a3793f70d3325bccac`（classic-2 特殊掉落、王冠与升天抉择、平衡调参、文档）。后续文档提交不改变产品源码。
- 回退版本：`cd8d634798b7368a179e4e8968babafe07f7afe8`（6 字符密码策略版）。
- 数据库：无 schema 变更（本次未改动 `leaderboard/`、`server/`、`deploy/`），未执行数据迁移。

## 发布证据

1. 本机全量回归 357/357 通过（含 classic-2 新增 18 项）；发布包由 `scripts/prepare-account-release.mjs` 从干净提交生成，`manifest.json` 记录源码/静态包 SHA-256 与 52 个资源哈希。
2. 发布窗口内停写后生成一次性 SQLite 备份并完整性校验通过（487,424 字节），写入独立 release 子目录，不参与常规 14 天轮转；周期备份服务随后恢复并以同版本镜像成功验证。
3. 变更前状态已打包为回滚材料：旧 `.env`/Compose/代理配置/旧 release 目录归档与容器、镜像快照。旧镜像 `clawd-api:cd8d634…` 保留。
4. Compose 预检通过（`config --quiet`、发布前检查脚本）：web 仅 `127.0.0.1:8080→80`，api 不发布宿主端口，certbot 未激活，密码服务与 keyring 挂载满足 `--require-password-service`。
5. 新 API 镜像以固定 Node digest 构建，revision 标签与发布提交一致，容器 healthy，启动日志无异常。
6. 公网 HTTPS 全量校验：`index.html`、src、样式、图标等 **52/52** 资源 SHA-256 与发布 manifest 完全一致。
7. `GET /api/health` 返回 `{"ok":true}`；`GET /api/auth/capabilities` 为 `passwordEnabled=true`、`registrationEnabled=true`、`linuxdoEnabled=true`；`GET /api/leaderboard` 正常，历史榜单数据保留。
8. 生产页面浏览器启动检查：`rulesVersion=classic-2`、`specialRules=true`；抉择面板、下一个徽标、图鉴特殊篇 3 条目均在 DOM 中；`apiBase` 与 `saveScope` 沿用原生产值，未改数据集标识。控制台仅有既有的 CSP 拦截 Cloudflare 统计脚本错误（A07 记录在案，未放宽防护）。

## 回退

- 应用回退：将私有 `.env` 的版本/源码/静态目录指回 `cd8d634…`，重新创建 api/web/backup 即可；旧镜像与旧 release 目录仍在，数据库不动。
- 数据回退：本次无 schema 变更，正常回退不需要恢复数据库；如确需数据恢复，须停写并另行明确授权，不得用发布前备份直接覆盖发布后的新写入。

## 待真机验收（不阻塞）

- 手机横屏抉择面板与触控布局、震动手感、分享卡未受影响的真机确认。
- 发布后观察：特殊掉落实际频率与失败码、KPI 无异常。

本记录不包含服务器地址、凭据、机器配置或玩家数据。
