# A00 账号规则与接口契约 v1

日期：2026-10-04。依据：[开发计划](../account-system-plan.md)。

状态：账号规则已收敛，尚未实现密码账号。用户后续已选择全站自托管，应用、中间件与运维服务统一由 Docker Compose 管理；运行配置、实例信息与测量记录仅保存在私有部署目录，不入 Git。

本阶段没有接入业务接口、创建数据库迁移或设计新页面。技术探针与验证见 本机私有 A00 验证记录（不入库）。

## 1. 决策表

| 决策 | 本轮执行默认值 | 理由与边界 |
| --- | --- | --- |
| 登录账号 | `用户名#四位编号`，固定不变；NFKC＋英文小写作为唯一键 | 允许同名；登录不能遍历同名用户试密码；原始大小写用于本人展示 |
| 展示昵称 | 可改，初始等于注册名；公开编号按当前昵称空间分配 | 昵称变化不改变登录账号；账号面板明确区分，公开编号不保证与登录账号尾号一直相同 |
| 玩家归属 | `players.id` 为唯一归属；密码与 Linux.do 都是登录方式 | 经典、每日榜与历史共享；不增加云端棋盘同步 |
| 正式账号绑定冲突 | 返回冲突，不自动合并 | 只保留既有“游客进入已有 Linux.do 账号”的受控合并 |
| 恢复 | 单次恢复码，或已绑定 Linux.do 的新一轮 OAuth 验证 | 无邮箱短信；不凭名字、分数或截图找回；不支持解绑 |
| 名称命中 | 拒绝新命名；外部/历史名称公开展示安全别名 | 保留身份与成绩；历史登录账号不能因新词库而失效 |
| 密码 | 15—128 个 Unicode code point，UTF-8，完整保留空格和大小写 | 不归一化、不截断；拒绝非法孤立 surrogate；允许粘贴/密码管理器 |
| 密码 KDF | **原生 scrypt**：N=32768、r=8、p=3、dkLen=32、maxmem=48 MiB | 采用 Node 内建实现；不新增密码库；实际认证并发与限流在 A04 验证 |
| 新正式会话 | 随机 256-bit bearer，30 天绝对有效期 | 数据库只存 token SHA-256；正式凭据新增/修改/恢复时撤销旧 token |
| 第三方限制 | Linux.do 的 active/silenced/trust 检查只控制该登录/绑定渠道 | 不把上游状态自动等同本站全站封禁；本站账号状态若未来引入，单独定义 |

这些是执行已授权 A00 所采用的推荐规则，不表示用户逐项单独确认。后续若调整登录标识、恢复或账号合并行为，应先更新本契约。

## 2. 数据与身份不变量

### 2.1 最小数据扩展

不改 0001—0004 迁移；A03 从 0005 开始增加：

| 数据 | 必需字段/约束 | 用途 |
| --- | --- | --- |
| `password_credentials` | `player_id` PK；`login_handle`、`login_handle_key` UNIQUE；algorithm、salt、derived_key、params_version、updated_at | 登录名独立于可变展示名；盐至少 16 随机字节，派生值 32 字节 |
| `players` 扩展 | `auth_version` 默认 0；display_name_source；名称审核版本/状态、唯一public_alias（单调序号分配） | auth_version 是安全凭据版本；不能用展示昵称版本代替 |
| `tokens` 扩展 | auth_method、auth_version、authenticated_at、expires_at | 保留原 token_hash 主键；授权时核对当前版本/到期时间 |
| `recovery_codes` | player_id UNIQUE、code_hash、created_at | 一次仅一条有效恢复码；消费与改密同事务 |
| `reauth_grants` | grant_hash PK、player_id、token_hash、auth_version、purpose、expires_at | 5 分钟、限定操作、单次二次验证证明 |
| `auth_operations` | request_id PK、actor_scope、action、retry_secret_hash、payload_hmac、status、expires_at、response_ciphertext、nonce、result_auth_version、结果资源版本 | 10 分钟受保护的操作意图/回执，恢复响应丢失，不存明文密码 |
| 登录账号预留 | operation_id UNIQUE、login_handle_key UNIQUE、expires_at | 注册/首次设密前明确分配账号，最终写入凭据时原子消费；不可占用已有凭据的 key |
| OAuth state/code 扩展 | action、来源玩家/token 哈希、auth_version、client_nonce_hash、过期时间与完成结果引用 | 登录、绑定、二次验证分离；回调不能信任客户端传来的目标 playerId |

`linuxdo_id` 继续留在 players，保持唯一索引。`players.token_hash` 仅是兼容遗留字段，不作为密码或绕过 tokens 表的认证入口。

注册账号与游客公开名字原本属于不同生命周期：已注册的登录账号永久保留，不因改昵称释放。公开昵称/编号唯一性继续由展示名键控制；两套键不能混用。

注册或设密时，先尝试当前游客编号（若合法且可用），再在对应注册名前缀中选择空闲编号。数据库最终裁决唯一性，不能仅八次随机失败就宣称耗尽。确定耗尽返回 `name_crowded`，不借机更改用户选择的名字。

### 2.2 四类账号与转换

`accountKind = guest | password | linuxdo | linked`。匿名表示没有 player，不是第五类持久账号。

- guest → password：原地设密，保留 ID；撤销游客 token，签发正式 token。不能创建第二个玩家再“搬分”。
- linuxdo → linked：近期验证该 Linux.do 身份后设密；保留 ID、头像和历史；用户明确选择合规的本地登录账号及公开昵称。
- password → linked：验证当前密码，再 OAuth 绑定未占用 provider ID；保留本地登录账号与公开昵称。Linux.do 后续改名只更新外部资料，不覆盖本地名字。
- guest → linuxdo：未占用身份原地绑定；已占用身份走既有游客合并事务。后者会改变玩家 ID，需先按第 7 节处理游戏状态。
- password/linked → 另一正式账号：只能显式退出/登录切换；绝不自动合并。

仅 Linux.do 且未设置本地凭据的账号继续跟随外部用户名；若名称命中，输出固定、安全且可区分的别名，如“玩家·短编号”。短编号必须有唯一分配依据，不能只随意截断 UUID 假设不会冲突。

### 2.3 会话迁移

- 新 guest token 维持现有生命周期；匿名新开和本地游玩不依赖密码功能开关。
- 上线时为既有 Linux.do token 设置“迁移时刻＋30 天”兼容到期时间，不以旧 created_at 回算而立即踢下线；既有纯游客 token 仍无到期时间。
- 游客升级或正式凭据设置/修改/恢复时，事务内递增 auth_version、删除全部旧 token、撤销旧 reauth grant 与未完成敏感 OAuth 意图，创建当前新 token。
- 普通登录不撤销其他设备；当前设备 logout 只删当前 token，并撤销该 token 发起的未完成绑定/二次验证；用户已退出后回调不得恢复该敏感操作。
- 旧 OAuth code 也绑定版本，改密后不能再兑换成新 token。纯登录 OAuth 不允许覆盖另一账号的浏览器状态，仍需客户端 nonce 和身份版本校验。

## 3. 公共协议

接口延续现有 JSON/Bearer 格式。新请求体必须是对象，限制为 8 KiB（读取时限流截断，不只信任 Content-Length）；无效/重复关键字段不得隐式宽松转换。身份通过 token 获取，不接受客户端指定 playerId 作为授权依据。

所有凭据、二次验证和私有账号响应 `Cache-Control: no-store`。敏感字段只能在 body/Authorization 中，不进入 URL、日志、分析、分享或结果队列。

成功认证返回 `AuthResult`：

```json
{
  "kind": "authenticated",
  "player": {"id":"uuid","name":"小螃蟹","tag":"4821","linuxdo":false,"avatar":null,"trustLevel":null},
  "account": {"kind":"password","loginHandle":"小螃蟹#4821","authMethods":["password"],"authVersion":1,"hasRecoveryCode":true},
  "token": "opaque-random-token",
  "expiresAt": 1790000000000
}
```

时间字段统一 Unix 毫秒；示例时间仅说明类型。`AuthResult` 为本人私有信息，不复用到榜单。`player` 保留现有字段，linked 玩家允许同时具有 tag 与 linuxdo=true。

`GET /api/me` 保留现有 `{player,best,bestLevel,rank,games}`，增加 `account`、`capabilities`、`sessionExpiresAt`。capabilities 至少包含 `canRename`、`canSetPassword`、`canChangePassword`、`canBindLinuxdo`、`canRotateRecoveryCode`；由后端真实能力计算。

错误保留 `{error,message}`，可增加 `field`；429 同时包含 Retry-After。公共 error 枚举：

| HTTP | error | 语义 |
| --- | --- | --- |
| 400 | bad_request / bad_name / bad_password / login_handle_required | 格式或新命名策略不满足；不回显触发的敏感词 |
| 401 | invalid_credentials | 账号不存在、密码错误统一；不返回候选账号 |
| 401 | unauthorized | bearer 无效或到期 |
| 403 | reauth_required / invalid_reauth / linuxdo_blocked / linuxdo_level | 二次验证缺失或外部登录渠道条件不满足 |
| 409 | binding_conflict / credentials_exist / identity_changed / name_crowded | 当前状态冲突；不回传另一账号的个人资料 |
| 409 | operation_conflict / operation_stale | 幂等请求内容不同或结果的安全版本已经失效 |
| 410 | operation_expired | 回执已过期；改走登录/恢复，不再重放秘密 |
| 429 | rate_limited | 受限时间明确；不永久锁死账号 |
| 503 | password_auth_disabled / name_policy_unavailable | 功能预算门禁或词库不可用；已有本地游戏继续 |

登录时不检查现有 loginHandle 是否命中新词库。用户输入裸用户名时可本地提示补全 `#编号`，不能查询其是否存在或列出可选尾号。

## 4. 写操作重试与二次验证

### 4.1 WriteOperation

注册、设密、改密、恢复和恢复码轮换先准备意图，最终 body 带 `requestId`（UUIDv7，时间来自 capabilities.serverNow＋本页单调时钟）、`retrySecret`（浏览器随机 32 字节 base64url）与 `operationTicket`。同一意图重试时保持不变；密码仅停留内存，不持久化。

`POST /api/auth/operations` 接收 `{action,requestId,retrySecret,name?,loginHandle?}`。除匿名注册/恢复/OAuth兑换外要求 Bearer；action 白名单为 `register | set_password | change_password | recover_password | rotate_recovery | exchange_login`。返回 `{operationTicket,expiresAt,loginHandle?}`。ticket 使用服务端签名，绑定 action、actor、requestId、retrySecret哈希、到期时间；不接受无准备意图的最终写请求。

注册/首次设密的准备步骤还要审核名字、预留编号并返回完整 loginHandle。客户端先保存完整账号及意图，再发密码；即使最终响应丢失且回执过期，也知道该用哪个账号尝试登录，不必盲目再注册。准备操作消耗注册/设密限流预算，重放同一意图不再次扣该预算。无法持久化意图时要求用户先复制完整账号并明确确认临时状态，不悄悄跳过保护。

- requestId 本身不授予访问回执的权力；服务端核验 retrySecret 的 SHA-256，并对 payload 使用服务端独立密钥的 HMAC，避免数据库内存在可离线试密码的普通请求摘要。
- 成功响应包含的新 token/一次性恢复码以 AES-256-GCM 加密，使用私有文件中的版本化专用密钥，随机 nonce 和关联操作 ID；数据库不存可直接登录的明文。密码本身绝不写回执。
- 单个事务内写入玩家/凭据/恢复码/token/回执；并发由唯一键＋条件写入认领。重复且一致的请求重放同一结果，不重新创建凭据或轮换恢复码。
- 升级/改密已经撤销原 token 后，重试可用匹配的操作证明访问自己的回执，不要求已撤销 token 重新成为有效会话；仍验证 actor_scope、结果 auth_version 与结果 token 未撤销。
- 回执的账号版本或结果资源版本已被后续改密/退出/恢复码轮换废弃，返回 operation_stale。首先核验 ticket 到期时间，过期后的原 requestId 不能被当成全新注册，即使数据库已经清理回执也一样；短期保留不含秘密的 tombstone（建议 24 小时）仅用于友好诊断，不靠永久保留它实现防重放。
- 新建匿名账号回执过期前需让用户保存完整登录账号；未知结果时 UI 不生成第二个 requestId 盲目注册。
- Secret 轮换需保留回执 TTL 内旧解密版本；密钥不入库。回执清理由已有运维机制扩展，先预览再执行，不本步创建自动化。

此机制属于 A04 必测设计，A00 没有实现或证明事务正确性。确认密码是前端字段，不进入服务端 payload HMAC。

### 4.2 ReauthGrant

`POST /api/account/reauth`，Bearer，body `{password,purpose}`。purpose 只允许 `bind_linuxdo | change_password | rotate_recovery`；验证成功返回 `{kind:"reauth",reauthProof,expiresAt}`，5 分钟有效，一次使用，绑定 playerId、tokenHash、authVersion 和 purpose。

Linux.do-only 用户通过新 OAuth 流程获得 `set_password` 或 `rotate_recovery` grant；linked 用户也可通过新 OAuth 获得 `recover_password` grant。只承诺本系统看到新完成的 OAuth 流程，不假设提供方支持强制重新输入密码的 `prompt`/`max_age` 参数。

改密时可把旧密码验证直接合并到改密 endpoint，仍执行相同授权与版本约束，前端无需多一次往返；是否拆请求不能改变安全语义。

## 5. Endpoint 契约

| 方法/路径 | 鉴权与 body | 成功与原子副作用 |
| --- | --- | --- |
| POST `/api/register` | 原游客格式 `{name}` | 保持原 guest 行为与201；增加共用名称审核，不静默改成密码注册 |
| POST `/api/auth/password/register` | 匿名；`{password,...WriteOperation}`；名字/完整账号取已准备的 register 意图 | 201 AuthResult＋recoveryCode；创建一名玩家；已有 bearer 时拒绝并引导设密/切换 |
| POST `/api/auth/password/login` | `{loginHandle,password}` | 200 AuthResult；新 token；不返回 recoveryCode，不迁移游客记录 |
| POST `/api/account/password` | Bearer；`{operation:"set",password,reauthProof?,...WriteOperation}`；名字/账号来自 set_password 意图 | guest 可持原游客 token 原地升级；linuxdo 需 set_password grant；201 AuthResult＋recoveryCode；已有密码409 |
| POST `/api/account/password` | Bearer；`{operation:"change",oldPassword,newPassword,...WriteOperation}` | 200 AuthResult；验证旧密码、递增版本、撤销全部旧会话；已有恢复码保持有效，避免无谓要求重新保存 |
| POST `/api/auth/password/recover` | `{loginHandle,recoveryCode,newPassword,...WriteOperation}` | 200 AuthResult＋新的 recoveryCode；原恢复码只消费一次，旧会话全部撤销 |
| POST `/api/account/password` | Bearer；`{operation:"recover",newPassword,reauthProof,...WriteOperation}` | 仅 linked 且 recover_password OAuth grant；200 AuthResult＋新 recoveryCode；不接受旧持久 bearer 单独重置密码 |
| POST `/api/account/recovery-code` | Bearer；`{reauthProof,...WriteOperation}` | 200 `{recoveryCode,createdAt}`；仅正式账号；原码失效，当前会话不变 |
| POST `/api/rename` | Bearer；`{name}` | 原 guest 兼容；password/linked 修改展示昵称，不修改 loginHandle；仅 linuxdo 先设置本地密码账号，再自主修改公开昵称；不修改上游身份 |
| POST `/api/logout` | 当前 Bearer | 保留原 `{ok:true}`；撤销当前会话及关联未完成敏感意图 |

新注册返回的 recoveryCode 为服务器随机 32 字节、base64url 或分组显示形式；保存去分隔符后的高熵字节的 SHA-256。解析只消除产品主动加入的分组符，不对任意输入做会降熵的模糊匹配。

登录、旧密码验证、恢复及 grant 消费必须抵御“校验后状态变化”：读取凭据版本→计算→事务内重新校验版本/token/grant→写结果。不能用计算开始时的旧凭据签发一个改密后仍有效的新 token。

### 5.1 OAuth 意图

`POST /api/auth/linuxdo/start`：保留 returnTo，增加 `action`、`clientNonce` 和必要的 `reauthProof`；回调地址/returnTo 校验继续沿用既有允许列表。

| action | 发起身份 | 行为 |
| --- | --- | --- |
| login | 匿名或用户已明确切换 | 按 linuxdo_id 找/建玩家，不隐式合并密码账号 |
| bind | 当前 guest/password；password 需 bind_linuxdo grant | 绑定未占用身份；已属于自己幂等；另一正式账号409；guest 允许既有受控合并 |
| reauth | 当前 linuxdo/linked；携带限定 purpose | 必须返回已绑定的同一 linuxdo_id，生成 scoped grant，不换玩家 |

`clientNonce` 是浏览器一次性随机 32 字节，预先保存在 sessionStorage，服务端只存其哈希。callback 仅在 URL fragment 返回短期登录码；`POST /api/auth/exchange {code,clientNonce,...WriteOperation}` 校验浏览器绑定，再返回 AuthResult 或 ReauthGrant。兑换成功但响应丢失可按受保护回执重放；不把 code 当作无限期认证凭据。

旧版 start 没有 action 时：无 bearer → login；有效纯游客 bearer → 兼容游客绑定；有正式密码凭据的 bearer → 拒绝并提示刷新客户端，**绝不能按旧逻辑自动合并**；仅 Linux.do bearer 可兼容旧重新登录语义。旧版 code 保持一次性和原TTL，不获得新的敏感操作 grant。

回调重复、并发创建同一 linuxdo_id、source 玩家在回调前升级/退出、code 被消费后的重试，均需定义明确事务结果；数据库唯一冲突不能变成部分成功。记录幂等操作的完成结果，不能重复迁移 games/挑战次数。

## 6. 名称策略与限制参数

### 6.1 词库决策

候选来源固定为 `houbb/sensitive-word-data@fe6fc2921836217b8c90619db81b24af8b22d80f`。A00仅下载统计；A03已采用固定来源的69条首版筛选集，保留LICENSE/NOTICE、来源摘要与标签统计，见[词库维护说明](../../leaderboard/data/name-policy/README.md)。上游没有逐词来源清单，不把代码仓库许可证当作对全部词条来源的额外担保。A03尚未发布。

采用“固定版本本地数据＋项目人工筛选＋允许/拒绝回归语料”。不自动跟随上游 main，不请求外部在线审核。原始 deny 文件为空，实际主词库是 dict 文件；不能误把空 deny 当成全部审核词。

审核流水线：合法 Unicode/NFKC → 2—12 code point与字符集 → 保留词 → 基础词库 → 明确变体规则 → 项目精确例外。展示值和审核值分开保存；审核可检查去 `_ - ·` 分隔后的副本，但不能改变登录账号原文或密码。

不自动把所有字转拼音，也不做无依据的繁简猜测。词库 tags 共 43,768 行，少于总词数，标签映射和未标注词分类在 A03 整理；不能假设每个词都有可用分类。

精确例外必须由维护者登记理由与版本，只影响明确误拦，不覆盖产品保留词与明确禁止规则。展示 Linux.do/存量名字命中时使用稳定别名；不要每次读榜随机换名。

### 6.2 首版限制（可配置，变更需回归）

- 保留游客注册每 IP 5 次/小时；密码注册复用注册预算，不能两条入口各获 5 次。
- 密码登录与 reauth 共用 IP 30 次/15 分钟、归一化账号 10 次/15 分钟；成功也计入计算预算。不存在账号使用相同账号桶及 dummy KDF。
- 恢复每 IP 10 次/小时、账号 5 次/小时；改密/设密/轮换每玩家 5 次/小时。未知账号的恢复统一无效凭据，不暴露是否绑定 Linux.do。
- 账号桶以 HMAC 标识避免数据库/日志中堆积明文账号；计数使用 B01 修复后的原子操作。多桶消耗顺序固定，不要求拒绝后退还已消耗的 IP 额度。
- 输入格式、体积、功能开关和限流通过之后才执行 KDF。身份错误不得靠返回更细时间或错误码区分账号存在性；不宣称绝对时间恒定。
- 原生 scrypt 调用会占用执行资源，即使改成 callback API 也不能假设免费得到独立线程池；后续要测对排行/开局延迟的影响。CPU/内存负载验证未通过，不开放密码入口。

## 7. 游戏归属与旧客户端

- `authMethods`/capabilities 决定 UI，不再把 `!player.linuxdo` 当成 guest。
- **同 playerId 换 token**（重新登录、原地升级、改密）不是换账号：安全完成后更新当前身份；通过服务端原 session 核验，继续使用原局凭证，不发新局、不重置挑战次数。
- **playerId 改变**：当前在线局不得转交新玩家。经典已开始局先结束或明确转本地；每日未完成正式局、未知开局和待提交记录先处理。仅保存成功并不等于可以安全合并。
- 任何未安全落盘的结果都阻止导航/换号。原地设密也需要处理正在执行的上传请求，确保 token 撤销产生的401只让原账号记录等待新凭据，不将成绩丢弃或改挂。
- 对本机身份保存、account 请求响应和跨标签页事件增加身份版本校验。旧响应只有原 playerId/token/版本仍匹配才更新；一次意图的 token 轮换使用已验证的新旧关系，不用“ID相同”放行任意响应。
- publicPlayer 在经典/每日榜/分享卡保持相同的安全名称和身份标识；旧本地分享图片无法撤回。旧存档里的 playerName 只是历史标签，不作认证依据。
- 服务器已经持久化的回执维持提交时快照；新排名采用完整排序规则，不能重写历史回执来伪装当前名次。

## 8. A00 放行与后续验证

已完成：产品默认规则、身份状态、字段/错误码/接口、兼容策略、固定词库候选核对、Node/本地 workerd/云端预览 KDF 对比。

运行路线已选择 Node 与 SQLite 自托管。密码参数不因运行平台变化而减弱；A04 仍须完成实际 Node 认证接口、限流、并发和恢复验证。具体实例与测量证据保存在本机私有运行记录中。

A01 可按已有计划执行。A02 可使用本契约做原型；A03 数据准备可继续，但密码入口维持关闭；A04 使用自托管路线并完成验证。以上账号阶段仍遵守用户后续授权范围；基础设施迁移已交付，未包含密码账号实现。


## A04 实现细化（2026-10-04）

- 密码认证在 `server/password-auth.mjs` 实现，通过 Node SQLite 短同步事务提交；scrypt 在事务外异步执行，进入事务后重验凭据/身份版本。Legacy Worker/D1 保持旧能力，新密码入口关闭。
- `GET /api/auth/capabilities` 返回服务能力与 `serverNow`；UUIDv7 的签发时间同时限制准备与回执为十分钟，拒绝未来时间。清理回执后也不能用旧 ID 重新登记。
- `POST /api/auth/operations/result` 只接受原三件证明，返回 pending 或受保护结果；`POST /api/auth/operations/cancel` 仅取消尚未完成的操作。已提交时返回完成结果，不声称撤销。
- A04 准备操作不包含 `exchange_login`；新 OAuth 绑定/近期验证仍归 A05。密码入口默认关闭，Compose 密码 overlay 为发布阶段明确启用项。
- 独立密钥用途为 ticket / receipt / payload / rate。保留 TTL 内旧版本；运维报告预览最多 500 行一批的过期回执脱敏、24 小时 tombstone 清理与 token/grant/reservation 清理，不自动执行。


## A05 实现细化（2026-10-04）

- 原生账号服务启用且已配置 Linux.do 时，`oauthAccountActions=true`。新动作复用 `exchange_login` 操作意图：准备 body 增加 `oauthAction`、`clientNonce` 和 reauth 的 `purpose`；start 同时携带该意图的三件证明，服务器验证 action/purpose/nonce 与准备信息一致。密码绑定的近期证明在首次 start 原子消费，重试同一 start 返回相同的加密保存授权地址。
- `0007_oauth_account_flows.sql` 只作增量；0001—0006 不改动。新流程独立于 legacy OAuth 表。回调完成外部授权后仅保存加密的最小身份/登录码材料，不创建玩家、不绑定或合并；原浏览器兑换 nonce＋操作证明后，在同一 SQLite 事务中完成写入与受保护回执。
- OAuth 操作最长十分钟；一次性登录码两分钟。回调 URL fragment 增加 `oauth=1` 格式标记；密码、reauth grant、最终 token 不进入 URL。重复 callback/兑换、取消、退出和回执过期均有明确状态；取消未提交授权可阻止后续兑换，已经提交的操作只返回完成结果，不假称撤销。
- 新绑定撤销源账号旧会话并递增版本；游客合入已有 Linux.do 时撤销源游客凭据，只迁移允许的历史/局/次数；目标账号的既有会话保持。旧客户端仍走受控 legacy 路径，不能将正式密码账号当游客吞并，不能获取敏感 grant。
- OAuth reauth 必须返回当前已绑定的同一外部身份。设密、恢复和轮换恢复码证明仅用于指定用途/玩家/token/版本，五分钟且单次消费。OAuth 恢复准备使用 `recover_password`＋`recoveryMethod:"linuxdo"` 和当前 Bearer；最终发送到 `/api/account/password` 的 recover 分支。
- 仅 Linux.do、未设本地密码时，没有用于密码恢复的完整本地账号；界面明确其恢复码不能代替 Linux.do 登录，并引导先设置密码登录，届时生成新的完整恢复信息。
- 浏览器 nonce、登录码和操作证明仅放本标签页 sessionStorage；导航前确认写入成功。密码和 grant 只在内存。兑换响应丢失后，可刷新并检查原回执；跨页身份变化不能被旧回跳覆盖。
- 过期会话保留本机玩家和原局，允许密码或 Linux.do 重新登录同一玩家。后者使用匿名 OAuth 登录，但客户端绑定旧身份指纹并核验结果 playerId；错误的外部账号不替换当前身份。新身份也不能接管本机保留的另一玩家正式局。
- OAuth 前保存原局，包括尚未投放但已有凭证的经典局；返回后核验原凭证，不创建替代机会。经典手动暂停可恢复；每日模式返回原模式并保留原机会。跨身份游客流程仍先处理正式记录，经典已开始局需明确转本地。
- 新表密文与 nonce 随既有运维报告按期限清理；预览不写数据，每批上限沿用 500 行。未新增生产定时任务。
