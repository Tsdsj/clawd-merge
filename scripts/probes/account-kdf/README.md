# A00 密码 KDF 可行性探针

仅用于技术调查；不会被游戏入口或 Worker 业务路由引用。使用固定公开测试密码/盐，只接受四个固定 GET 路径，无 D1、KV、OAuth、secret 或生产绑定。不要将它当成认证服务部署。

本地使用已有独立 Miniflare 安装：

```bash
MINIFLARE_MODULE=/absolute/path/to/miniflare node scripts/probes/account-kdf/run.mjs
```

临时云端预览（须已有 Cloudflare 开发权限；不要使用 leaderboard/wrangler.toml）：

```bash
wrangler dev --remote --config scripts/probes/account-kdf/wrangler.toml --port 8796 --inspector-port 9296
```

另一个终端：

```bash
PROBE_URL=http://127.0.0.1:8796 node scripts/probes/account-kdf/run.mjs
```

完成后停止本次 Wrangler 进程。不要执行 `wrangler deploy`，不为探针建立正式公开路由。输出包含每种算法三次真实响应及与 Node 的确定性结果比较；100,000 次 PBKDF2 仅为诊断对照，不是推荐生产参数。

`nodeCpuMs` 是本机 Node 的 CPU 时间，`roundTripMs` 是客户端到目标的完整等待时间；二者都不是 Cloudflare 计费 CPU。预览成功也不证明免费套餐的生产限额足够。参数拒绝预期返回422，runner记录为结果；若成功但派生值不同则直接失败。

测试盐固定是为了跨运行时比对；实际密码存储必须每用户独立随机盐。此目录没有实现密码注册、认证、限流或安全回执。
