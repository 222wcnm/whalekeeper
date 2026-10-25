# tools/verify-ui — dsh-manager 扩展 UI 自动验收

两条互补的验证路径，目标都是替代 manual-e2e.md 里的人工步骤：

| 脚本 | 原理 | 适用环境 | 现状 |
|------|------|----------|------|
| `verify-cdp.js` | 零依赖 CDP 直连（headless Chrome + `Extensions.loadUnpacked` + Page.captureScreenshot），与 `tools/icons/_gen-icons.js` 同手法 | **沙箱内可用（已实测）** | 33 断言通过（扩展加载、popup/日志页截图 + 文本断言、页面内面板注入/展开（含托管绿点+端口、展开时胶囊位置不变、面板在胶囊上方、扩展重载后旧面板提示刷新/刷新后恢复）、停止两步确认态（首击确认/3s 还原，不执行）、日志页「加载更早/复制全部」交互、popup 设置校验交互、徽标三步实测（附加扩展 SW：port 0→绿点/无监听→清空/恢复默认）、console 异常检查） |
| `verify-ui.js` | Google 官方 chrome-devtools-mcp（stdio 传输 MCP 客户端，手写零依赖） | 沙箱外（子进程管道在受限沙箱内被拦，spawn EINVAL） | 覆盖扩展加载/弹 popup/快照/截图；后续可扩交互断言 |

## verify-cdp.js（推荐先用）

2026-10-26 发布前重新完成三轮真实隔离 E2E **196/196**，含 Chrome 156 **121/121**。
扩展页面与托管面板等待实际就绪，合成帧仅派发到已注入的本扩展隔离上下文，避免固定
sleep 在慢启动/重载时误报。正式证据根 `.e2e-current/run-mvo3y5wp-91931053/`。
本轮工具进程对原 AppData 安装目录的路径访问异常慢；用户独立终端对照正常，因此选择
同字节 D 盘 CLI 副本复验，生产源码及 150s 预算原样，详见 `native-host/test/VERIFICATION.md`。
下述三轮数据为 2026-10-19 历史验收，与本轮重新执行分别保留。

0.2.1-rc.2 Chrome 155 已通过 **121/121**（2026-10-19），最终三轮生产源码隔离
集成验收 **196/196**（第一轮运行浏览器，后两轮固定/动态生命周期），全部通过。
旧表的 33 条是 M3 历史记录；修复前已有 108 条基线。
新增用例验证会话行只读、认证页另开、有效端口与真实 SSE 断线/隐藏重连（有隔离 fixture
时必须运行）。建议通过 `native-host/test/e2e-current-isolated.js` 的
`DSH_MANAGER_VERIFY_UI=1` 调起，子进程沿用隔离状态，不触及日常实例。
认证证据可由 `VERIFY_DSH_MANAGER_BASE_DIR` 指定，`VERIFY_FIXTURE_URL` 为本 case 控制端点，
`VERIFY_EVIDENCE_DIR` 为 case 产物目录；普通独立运行没有 fixture 时仅新增恢复段明确 SKIP。
Windows 隔离时同时建立 `USERPROFILE/AppData/Local` 与 Roaming：Chrome 的默认目录
判定使用已知文件夹 API，Local 不存在会令 CDP 安全检查无法确认非默认 profile。
Chrome profile 保持全新、同 case、短路径；不读取日常 profile，也不关闭默认目录保护。
启动失败证据保存在同 case 的 `chrome-stderr.log`，输出仅保留脱敏尾部与本次进程状态。

```powershell
node tools/verify-ui/verify-cdp.js
```

流程：启动独立 profile 的 headless Chrome → CDP 加载 `extension/`（unpacked）→
依次打开 `popup.html` 与 `logs.html` → 读 `document.body.innerText` 做文本断言 +
截图存档 → 收集扩展页面 console 异常（`exceptionThrown`/`console.error`）→
导航到真实 dsh Web UI 页面（`VERIFY_DSH_URL`，默认 `http://127.0.0.1:8080/`）断言
页面内管理面板（design §8.6）注入/徽章/状态文本/展开后按钮状态 → 干净退出。

产物在 `tools/verify-ui/shots/`（已 gitignore）：`popup.png` / `logs.png` /
`popup-text.txt` / `logs-text.txt` / `panel.png` / `panel-open.png`。

环境变量：`CHROME_PATH`（自定义 Chrome，如 Chrome for Testing）、
`VERIFY_CDP_PORT`（默认 9335）、`VERIFY_DSH_URL`（面板注入的目标页面）。

**实测事实（2026-08-14，Chrome 151）**：
- headless Chrome + CDP 在沙箱内**可用**（HTTP `/json/*` 与 WebSocket 均通）；
- `Extensions.loadUnpacked` 可用（无需 `--load-extension`，Chrome 137+ 已移除该旗标）；
- 扩展经真实 native host（HKCU 注册）拉到真实机器状态——popup 显示本机 8080 的
  dsh web 实例（running/健康/优雅停机已启用），logs 页显示真实日志文件内容，
  页面无未捕获异常。

## verify-ui.js（MCP 路径，沙箱外）

```powershell
node tools/verify-ui/verify-ui.js --list   # 连接并列出 MCP 工具（快速诊断）
node tools/verify-ui/verify-ui.js          # 完整流程
```

经 `npx -y chrome-devtools-mcp@1.7.0 --categoryExtensions --usageStatistics=false`
拉起官方 MCP 服务器（版本钉死，README 与脚本同步）。用它访问全部扩展类工具：
`install_extension` / `reload_extension` / `trigger_extension_action` /
`evaluate_script(serviceWorkerId)` / `list_console_messages` /
`take_snapshot` + `click` 等——适合把 manual-e2e.md 步骤 13 的交互流
（点按钮、断言 toast、复制）固化成 pass/fail。

注意：
- chrome-devtools-mcp 只支持 stdio 传输（无 HTTP 模式），受限沙箱拦截子进程
  管道（实测 spawn EINVAL），故本脚本需在沙箱外/提权终端运行；
- Chrome 137+ 的坑（`--disable-extensions` 等）由 chrome-devtools-mcp 内部处理，
  实测 Chrome 151 下扩展工具可用；
- `chrome://extensions` 等内部页面不能自动化；扩展重载用 `reload_extension` 工具。

## 待扩展（对应 manual-e2e.md 步骤 13）

- 按钮点击流：`take_snapshot` 取 uid → `click` → 断言状态文本/toast
  （MCP 路径）；或 CDP 路径用 `Runtime.evaluate` 直接派发点击。
- 「复制全部」的剪贴板断言（headless 下 `navigator.clipboard` 需留意权限）。
- Service Worker console 读取（MCP `evaluate_script(serviceWorkerId)`，SW 的
  console 隔离需实测）。
