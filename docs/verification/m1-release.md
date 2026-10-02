# M1 发布记录

2026-10-02，用户明确授权“开始部署 M1”。

**部署完成，生产基础检查通过；完整设备验收尚未关闭。**

- 游戏：https://tsdsj.github.io/clawd-merge/
- API：https://clawd-merge-leaderboard.tt-lab.workers.dev
- 产品发布提交：`1b5a16a0b4a2cc53f5a513eaa590b7b74a2c45bc`（T01—T07）。本记录后续文档提交不改变产品源码。
- Worker 版本：`a85288f3-3107-4c57-bd2e-096b5de9360c`，100% 部署。
- 前一 Worker 版本：`384927d4-861f-4742-b21e-6484804006fa`，仅作配套回退依据。

## 发布步骤与证据

1. T07 提交后，先推送 `codex/m1-release` 分支；[预发布 CI](https://github.com/Tsdsj/clawd-merge/actions/runs/37026611986) 的 `regression` 和 `d1` 均成功。涵盖 91 项单元／接口回归、真实 HTTP 超时及隔离 workerd/D1 测试。
2. 获取 D1 Time Travel 恢复点，并导出迁移前 SQL 到本机仓库外的受限目录。导出 127201 字节，导入隔离 SQLite 后 `PRAGMA integrity_check` 返回 `ok`。备份包含用户数据，不入库、不公开下载链接。
3. 远程仅待应用 `0003_score_receipts.sql`；应用成功。增量创建回执表和索引，不清空已有数据。
4. Worker dry-run 成功，随后发布上述新版本。未更换 OAuth 配置或密钥。
5. 新 Worker 生产 API 检查通过后推送 `main`，触发 Pages。[主分支 CI](https://github.com/Tsdsj/clawd-merge/actions/runs/37026953898) 与 [Pages 发布](https://github.com/Tsdsj/clawd-merge/actions/runs/37026952205) 均成功。
6. 从生产地址获取 `index.html` 及 `src/` 下全部 JS/CSS，共 18 个文件，SHA-256 与本地发布源码完全一致。

## 生产基础检查

- CORS 对游戏 origin 正常；匿名恢复核验返回 401。
- 独立测试游客开局后，恢复核验为 `valid`。
- 0 分测试提交并发发送 3 次，均返回同一接受结果；随后核验为 `used`；更改内容返回 409。
- 新开局清理已用 session 后，旧请求仍可重放原回执。
- 直接查询生产 D1，确认测试身份恰有 `games=1`、`scores=1`、`receipts=1`、`best_score=0`。
- 该身份从未进入公开榜单。测试后注销，并按精确 player ID 清理本次测试的成绩、回执、凭证、令牌及身份；确认身份剩余数为 0。未清理其他用户记录。
- 真实浏览器访问生产页面：首屏直接本地游玩、键盘投放、手动暂停、榜单加载、关闭榜单仍保持暂停、刷新显示一投存档、继续原局成功；最后清理此次一投本地测试局。

## 剩余验收与回退边界

本次生产 API 检查使用 0 分合成请求，验证的是上传协议与 D1 事务，不代表实玩完整长局。以下内容仍未完成，不能宣称已经全部验收：

- 手机真机触屏、横竖屏、低端设备性能、系统回收后的恢复范围。
- 真实系统后台／失焦切换及回到游戏后的手动恢复。
- 真实 LINUX DO OAuth 完整登录链路；本次沿用现有配置与密钥，未代用户登录。
- 生产完整长局及真实网络切换；本轮本地长局／故障注入证据见 [T07 报告](m1-t07.md)。

如需回退，应一起考虑 Worker 和前端；新前端不得搭配不支持可靠补传的旧 Worker。保留新增回执表及历史数据，不以删表回退。数据库恢复可能覆盖发布后的新数据，不属于本次部署授权下的自动操作。
