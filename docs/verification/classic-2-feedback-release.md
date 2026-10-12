# classic-2 修复与等级反馈发布

2026-10-12，用户明确要求使用 hk-server 部署当前本地修复版。生产切换于当日 23:52（Asia/Shanghai）完成。

- 生产入口：<https://clawd.ttqq.dev>。
- 产品源码提交：`396c78940392d5b62920942ef60b3c90b5755379`。
- 回退版本：`220b0edb8768ffb30d2b26a3793f70d3325bccac`。
- 发布范围：冰冻约束、磁力落稳吸附、旧规则奖励隔离、原等级颜色与能力配件、基础等级标识、磁力目标/受阻/消耗反馈及音效生命周期。
- 未包含停止中的大样本平衡脚本、研究数据或候选概率规则；未恢复高负载模拟。

## 发布证据

1. 从独立干净副本使用已有 `prepare-account-release.mjs` 打包指定提交。源工作区未提交研究成果保留，未清理或混入发布包。
2. [对应提交 CI](https://github.com/Tsdsj/clawd-merge/actions/runs/38272285610) 的 regression、d1 均成功：386 项全量回归、38 项生产 SQLite API、3 项 Compose 检查，以及名称包、真实 HTTP 超时和 D1 检查通过。
3. 服务器候选归档和 52 个静态资源 SHA-256 验证通过；固定 Node digest 构建镜像，镜像及 API/backup 容器 revision 与产品提交一致。
4. 发布 Compose 预检通过，Web 仍只绑定 loopback，API 未增加宿主端口。原 PUBLIC_ORIGIN、持久化数据集标识、账号能力开关和 keyring 保留。
5. 发布窗口 SQLite 备份 487424 bytes，完整性校验通过。旧版本目录、镜像、配置、keyring 和回退脚本保留在私有发布记录中。无数据库 schema 变更，未恢复或覆盖数据库。
6. API healthy、Web 和周期 backup running；Nginx 配置检查通过，周期备份输出校验成功。
7. 公网 HTTPS 的发布资源 **52/52** 哈希与 manifest 一致。health 返回 ok，capabilities 保持 password/registration/linuxdo 开启，leaderboard 返回 HTTP 200。
8. 使用生产模块在隔离浏览器创建无上传事件的 Game 实例：同堆普通对照 0 分，磁力载体合成 2 分；受阻与启动前消耗可复现；冰冻受碰撞位移为 0、到期解除；15 种能力载体的基础颜色匹配普通等级。页面有基础等级和磁力反馈入口，无新增 pageerror。

## 发布中遇到的问题

第一次在一次性备份阶段失败，尚未修改版本配置。实际检查发现 `docker compose run -v ...:rw` 没有覆盖服务的只读数据库挂载；先恢复旧版 API/backup 并验证健康，再在旧备份副本上验证显式 Docker 挂载。第二次发布使用显式读写数据挂载生成窗口备份，并成功切换。周期备份服务仍保持只读。

发布错误回退的 shell 入口同步使用 `set -Eeuo pipefail`，避免函数内错误未进入 ERR trap。首次产生的零字节备份已保留并标为失败，不作为有效恢复材料。操作清单的相应命令已修正。

## 边界与回退

应用回退使用已保留的旧配置和旧镜像，不覆盖数据库；发布后的新写入不能用发布前备份直接替换。具体备份、回滚脚本、容器指纹及原始证据在私有记录中，本公开文档不收录机器配置、凭据或玩家数据。

沿用既有 DNS、Cloudflare 入口与 Caddy，未修改 DNS、SSH、防火墙或其它项目服务。原有 Cloudflare Insights 脚本被 CSP 拦截的控制台消息仍存在，未放宽 CSP。

本次没有重做真实账号登录、手机真机听感或长时性能验收；也不宣称未完成的平衡目标已通过。发布成功与这些验证边界分别记录。
