# DSH Manager — 浏览器扩展管理 DSH 运行状态 · 设计规格索引

- 文档范围：M1–M13（扩展实际版本见 `extension/manifest.json`）
- 最近整理：2026-10-26
- 状态：0.2.1-rc.2 Windows修复与隔离验收通过（§2.1.3：178单测/428smoke/196三轮E2E/121浏览器）；macOS/Firefox未新增实测
- 目标平台：Windows 10/11 + Chrome / Edge（Linux 平台层与安装器已实测；Firefox/macOS 列为后续）

---

原设计规格按主题拆分为以下七篇，章节编号保持不变。旧文档中“design §X”的引用可在此表定位。
改动时请编辑对应主题文件；这七篇合起来是项目的设计规格。
旧审查报告里 `docs/design.md:行号` 指拆分前的位置；现行内容请按章节号查找。

| 章节 | 内容 | 文件 |
|---|---|---|
| §1–5 | 背景、事实基线与架构 | [01-foundations.md](design/01-foundations.md) |
| §6 | 原生宿主与就绪协议 | [02-native-host.md](design/02-native-host.md) |
| §7 | dsh 生命周期插件 | [03-lifecycle-plugin.md](design/03-lifecycle-plugin.md) |
| §8.1–8.9 | 浏览器扩展界面与后台 | [04-extension-ui.md](design/04-extension-ui.md) |
| §8.10–8.12 | 会话感知与扩展边界 | [05-extension-sessions.md](design/05-extension-sessions.md) |
| §9–14 | 流程、安装、安全与验收 | [06-operations.md](design/06-operations.md) |
| §15–17 | 路线图、风险与参考 | [07-roadmap.md](design/07-roadmap.md) |
