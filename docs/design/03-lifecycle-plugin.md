# dsh 生命周期插件

[返回设计规格索引](../design.md) · 原规格 §7

---

## 7. dsh 生命周期插件（plugin/dsh-lifecycle，M2 已实现）

### 7.1 定位

- 独立 npm 包（包名建议 `dsh-lifecycle`），按 dsh 插件规范组织，通过 `dsh plugin --profile web add dsh-lifecycle` 安装（或用户 `cordis.patch.yml` 覆盖层挂载）。
- 与浏览器扩展**完全解耦、双向可选**：
  - 不装插件：扩展照常工作（停止降级 taskkill，状态用端口探活）。
  - 不装扩展：插件独立可用（`curl -X POST http://127.0.0.1:3080/_lifecycle/shutdown` 即可优雅停机）。
- 它解决的问题恰恰是进程外组件做不到的：**进入 dsh 自身的 dispose 生命周期**（F7/F12）。

### 7.2 接口

| 方法 | 路径 | 请求 | 响应 | 语义 |
|------|------|------|------|------|
| POST | `/_lifecycle/shutdown` | 无 body | `202 {"ok":true}`（先刷出响应，再 dispose 退出） | 优雅停止：`appExit(0)` → 整棵 fiber 树 dispose → 进程退出（F7 同路径） |
| GET | `/_lifecycle/health` | 无 | `200` JSON（见下） | 健康/富状态；供宿主与 curl 读取 |

health 响应（v1 最小集；v2 扩展会话/作业等聚合字段）：

```json
{
  "ok": true,
  "pid": 12345,
  "uptimeMs": 182000,
  "port": 3080,
  "nodeVersion": "v22.16.0"
}
```

### 7.3 实现要点（基于 F12 核验的源码契约）

1. **注入**：`inject: ['webServer', 'appExit']`——`webServer` 提供 `register({kind:'exact', path, handler})` 并返回 disposer；`appExit` 是 dsh-cmdline 提供的官方退出出口（= launcher 的 `shutdown` → `fiber.dispose()`）。新版 launcher 给 dispose 5 秒宽限，正常完成后设置 `process.exitCode`；宿主等待端口关闭和 PID 退出（§6.3 stop），排空超时则复核 PID 后 taskkill 回退。
2. **响应先于退出**：shutdown 处理器在 `res.end()` 完成回调后 `setImmediate(() => ctx.appExit(0))`，确保 202 刷出到 socket 再开始 dispose（避免响应被截断）。
3. **安全围栏（自管）**：插件路由不经过 `/api` 网关围栏（F9/F12），必须自行校验：
   - `req.socket.remoteAddress` 必须为回环地址；
   - Host 头必须回环；
   - **请求头 `sec-fetch-site` 为 `cross-site` 时拒绝**（与官方 `isTrustedApiRequest` 对齐）；
   - **Origin 缺失或与 Host 同源**——由此扩展页面直接 fetch（带 `chrome-extension://` Origin）被拒，而「扩展 → 宿主 → HTTP」链路（宿主请求无 Origin）天然合规；
   - 方法白名单：shutdown 仅 POST、health 仅 GET，其余 405（附 `Allow` 头）。
4. **生命周期**：两个 disposer 在插件 `apply` 返回的清理函数中统一释放（随 fiber 停止/更新自动摘除路由）。
5. **富状态聚合（v2）**：通过 `ctx.get()` 只读宿主 Cordis 服务（会话数、活动作业、token 统计等）——只取叶子字段、构造最小自有对象，绝不序列化 live 服务对象（dsh 插件规范）。

骨架示意（正式实现按 dsh 插件包规范补 Invariant/测试/README）：

```js
// plugin/dsh-lifecycle 插件骨架
export const name = 'dsh-lifecycle'
export const inject = ['webServer', 'appExit']

const isLoopback = (addr) => addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1'

function allow(req) {
  if (!isLoopback(req.socket.remoteAddress ?? '')) return false
  const host = req.headers.host ?? ''
  if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host)) return false
  const origin = req.headers.origin
  if (origin !== undefined) {
    try { if (new URL(origin).host !== host) return false } catch { return false }
  }
  return true
}

export function apply(ctx) {
  const dispose = [
    ctx.webServer.register({ kind: 'exact', path: '/_lifecycle/health', handler: async (req, res) => {
      if (!allow(req) || req.method !== 'GET') { res.writeHead(req.method === 'GET' ? 403 : 405); res.end(); return }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        ok: true, pid: process.pid,
        uptimeMs: Math.round(process.uptime() * 1000),
        port: ctx.webServer.port, nodeVersion: process.version,
      }))
    }}),
    ctx.webServer.register({ kind: 'exact', path: '/_lifecycle/shutdown', handler: async (req, res) => {
      if (!allow(req) || req.method !== 'POST') { res.writeHead(req.method === 'POST' ? 403 : 405); res.end(); return }
      res.writeHead(202, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true }), () => setImmediate(() => ctx.appExit(0)))
    }}),
  ]
  return () => { for (const d of dispose) d() }
}
```

### 7.4 与宿主的协作分工（M2）

- **stop**：宿主先 POST `/_lifecycle/shutdown` → 端口关闭后继续等 PID 退出 ≤ 10s → 超时复核 PID 后回退 taskkill。
- **restart**：shutdown → 等 stopped → 用 run 记录的 `cmdline` 原样重放 spawn。插件**不自行 respawn**：插件进程内拿不到 profile 名（`cmdlineArgs` 只含 launcher 之后的内部参数，F12），而宿主恰好持有权威启动命令，职责归属清晰。
- **status**：存活判定仍以「PID 存活 + 端口探活」为权威（插件缺失不能把 running 误判为 stopped）；`health` 仅作富状态补充（§4.2.6）。

---
