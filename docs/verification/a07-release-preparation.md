# A07 · 发布准备与操作清单

日期：2026-10-04。**仅发布准备，不是上线记录。** 当前没有切换应用镜像、静态站点或生产数据库，没有启用线上密码入口。真实 OAuth2 沿用用户确认，不重复实测；手机软键盘和实际密码管理器仍按 [A06](account-system.md) 保留人工待验项。

## 已准备的材料

- 两个独立入口开关：`PASSWORD_REGISTRATION_ENABLED` 控制密码注册和首次设密；`ACCOUNT_BINDING_ENABLED` 控制新绑定，包括 legacy 游客绑定。生产配置默认均为 `0`。关闭后已有账号的密码登录、改密、恢复和完成态回执仍可用；未提交的新注册/绑定不能借旧意图绕过。
- `scripts/check-release-compose.mjs`：读取最终 Compose JSON，只输出检查码，不输出私有配置。核对候选 API/backup 镜像、loopback Web、未发布 API 端口、Certbot 不活跃、代理模板、来源及显式开关/密钥挂载。密码账号存在后使用 `--require-password-service`，避免回退误关登录。
- `scripts/rehearse-account-release.mjs`：源 SQLite 只读，创建全新私有目录，备份成副本后迁移；核对原字段逐行摘要、完整性、外键/归属、重启幂等、再备份与恢复一致性，并生成名称审核聚合。拒绝覆盖旧输出、拒绝把副本写入本仓库。
- `scripts/prepare-account-release.mjs`：只打包干净的已提交代码；生成源码包、静态包和 SHA-256 manifest。要求固定 `PRODUCTION_DATASET`，不复制环境文件、密钥、数据库或工作区未提交文件；不执行部署。
- Docker 镜像增加 `org.opencontainers.image.revision` 标签；由固定 release SHA 构建。镜像标签、源码包与静态包必须属于同一次发布。

## 准备阶段验证

1. 服务器现有服务、Node 运行时、磁盘/内存余量和 Caddy loopback 接入已只读核对。
2. 使用现有私有备份的副本完成0001—0007兼容迁移、原字段保留、重启和恢复演练；源文件不变，无完整性或关联异常。详细报告保存在本机私有目录，不入库。**这份演练备份不替代发布窗口内的新备份。**
3. 目标环境短时探针使用内存数据库、随机测试密钥、禁用容器网络、1 CPU/256 MiB 上限，无生产数据或密钥挂载。三轮共18个请求验证两路 KDF 并发、繁忙拒绝、健康与排行榜响应；达到脚本设定的延迟与内存门槛。同期线上只读健康采样正常。详细指标及机器信息只留私有记录。
4. 探针是受限短时工程证据，不代表长期稳定性或任意流量容量；上线后仍需观察失败码、KDF繁忙、响应时间与资源上限。
5. 独立只读审查未发现发布门禁或私有副本工具的阻断问题。门禁关闭、完成回执、原账号恢复、legacy路径和真实Compose解析都有回归。

本地回归：`npm test` 338/338、生产 SQLite 适配层 API 38/38、Compose 3/3、名称包一致性通过；D1 兼容回归通过。最终候选按同提交 CI 放行。

## 固定候选版本并打包

在本机干净仓库中，确认该 commit 的 CI 成功，再通过私有环境注入既有来源和数据集标识：

```bash
# PUBLIC_ORIGIN / PRODUCTION_DATASET 从既有私有配置读取，不能随迁移随意改名。
node scripts/prepare-account-release.mjs --out-dir "$PRIVATE_RELEASE_OUTPUT"
node scripts/rehearse-account-release.mjs --source "$PRIVATE_BACKUP_COPY" --out-dir "$PRIVATE_NEW_REHEARSAL_DIR"
```

保留输出 `manifest.json`、两个归档包以及原始备份。实际地址、目录映射、keyring、镜像 digest 与数据库统计只存私有交付记录。不要把这份输出目录移入 Git 或作为整个网站目录发布。

## 获得上线授权后的顺序

以下步骤尚未执行。上线是单独的操作，需要明确授权；人工待验项应完成或由负责人明确接受其验证范围。

1. 确认唯一 release SHA 与 CI，核对归档 SHA-256。源码和静态文件用保留权限、忽略归档原属主的方式解包到新的版本目录（GNU tar 可用 `--same-permissions --no-same-owner`）；源码/静态目录须可供容器用户读取，目录0755、普通文件0644，可执行脚本0755，外层私有目录继续受限；不覆盖当前版本，不改 `PUBLIC_ORIGIN`、`PRODUCTION_DATASET`、旧迁移来源或 Linux.do 应用设置。
2. 用候选源码构建 `clawd-api:<SHA>`，固定现有 Node 镜像 digest；核对镜像 revision 标签。准备私有 keyring：**已有文件绝不能覆盖或重新生成**，轮换需保留短期回执所需版本。初次生成使用 `scripts/create-password-keys.mjs --out <源码目录外的私有文件>`；没有宿主 Node 时将源码只读挂载到 `/source`、私有目录挂载到 `/keys`，在现有 Node 容器中运行该脚本。仅该文件设为 UID1000 可读的0400，不把私钥加入镜像。单独备份 keyring。
3. 备份私有 `.env` 与代理配置。同步两个 Compose 基础/反代文件、密码 overlay、代理模板和启动脚本到各自目录。更新镜像/源码/静态目录到同一候选版本，数据目录保持原位。
4. 私有 `.env` 持久设置 `COMPOSE_FILE=compose.yaml:compose.proxied.yaml:compose.password.yaml`；`PASSWORD_REGISTRATION_ENABLED=0`、`ACCOUNT_BINDING_ENABLED=0`。有密码账号后，不能遗漏密码 overlay，也不能用关闭整个密码服务来回退。
5. 解析完整 Compose 并检查，**所有后续命令复用同一三文件组合**：

   ```bash
   compose() { docker compose --env-file .env -f compose.yaml -f compose.proxied.yaml -f compose.password.yaml "$@"; }
   # 宿主有 Node 时：
   compose config --format json | node "$RELEASE_SOURCE/scripts/check-release-compose.mjs" --image "$IMAGE" --require-password-service
   # 宿主没有 Node 时：使用候选镜像，仅运行检查脚本；不挂数据或密钥。
   compose config --format json | docker run --rm -i --network none --read-only --entrypoint node \
     --mount "type=bind,src=$RELEASE_SOURCE/scripts/check-release-compose.mjs,dst=/check.mjs,readonly" \
     "$IMAGE" /check.mjs --image "$IMAGE" --require-password-service
   ```

6. 安排维护窗口；不承诺零停机。停止旧 api 与周期 backup 后，创建本窗口备份，写入独立 release 子目录，避免被常规14天轮转清理。运行备份必须加 `--no-deps`，不得意外重启旧 API：

   ```bash
   compose stop api backup
   compose run --rm --no-deps --entrypoint node -e "BACKUP_DIR=/backups/release-$RELEASE" backup server/backup.mjs
   ```

   核对备份完整性、权限和可恢复性。禁止直接复制运行中的 WAL 主文件作为备份。
7. 先启动兼容 api，由迁移器应用新增 schema；核对健康、迁移记录和日志。`/api/auth/capabilities` 应为 `passwordEnabled=true`、`registrationEnabled=false`；读取已有账号资料、榜单与原资格，不能只以 `/api/health` 的200判定密码服务已就绪。
8. 再切换前端。静态目录使用固定版本路径，并重建 web 以更新 bind mount；不能假设换宿主 symlink 会自动更新既有容器挂载。核对外部 HTTPS、页面/API、实际资源 SHA、CSP 和浏览器来源，然后恢复周期 backup。Caddy、80/443、SSH、防火墙不随应用发布调整。
9. 观察兼容阶段通过后，按授权将两个新入口开关置1并重建 api；保持完整 Compose 组合、同一 keyring 和数据目录。最终核对 capabilities、错误码与成绩/次数归属。真实账号验收仅按用户明确允许的范围执行。

## 回退规则

- **优先收窄入口**：设两个新入口开关为0，保留密码服务、keyring、新 schema 和已有账号登录/恢复；完成态回执仍可重放。配置通过重新创建 api 生效，等待旧进程退出，不假称撤销已经完成的请求。
- **前端回退**：恢复已核定的静态版本路径并重建 web；保持兼容后端与 Caddy overlay。旧前端不提供密码 UI，不能把已有密码用户的访问路径全部替换成不支持密码的页面；保留当前账号入口或先做前向修复。
- **后端回退**：只能选已验证支持当前 schema、凭据和撤销语义的镜像。首次发布没有这样的历史镜像时，采用关闭新入口＋前向修复；禁止直接退到不识别密码凭据的历史程序。
- **数据库回退**：新 API 一旦可能接收任何游戏或账号写入，发布前备份就不是最新数据。不得直接覆盖；必须停写、保留最新快照、审查增量与恢复方案，并取得明确的数据恢复授权。数据回滚不属于普通应用回退。
- 任一检查失败即暂停开放新入口，保留候选/旧产物、备份、keyring及私有报告。不要删除新表列，不把账号/游戏数据上传到工单或仓库。

## 上线后记录模板

在私有运行记录中填写：批准范围/时间、release SHA与镜像ID、归档校验、备份与恢复结果、迁移结果、两个开关状态、健康/资源/失败码观察、静态资源一致性、用户验收范围、回退决策。本文件当前不标记任何生产上线步骤为完成。
