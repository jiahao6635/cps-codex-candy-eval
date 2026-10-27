# v0.1.4 兼容性与结果标识验证

验证日期：2026-10-27。目标为 CPS v3.33.0，SDK/CLI 固定提交 `8c8618aa0f841638262262e3338c115bc075f125`，RPC v7、management v2。

## 适配与判定

- [CPS v3.33.0](https://github.com/zyycn/codex-proxy-rs/releases/tag/v3.33.0) 仅支持 RPC v7。v0.1.3 使用 RPC v6，不能在该宿主安装；必须重新编译和打包，不能只修改版本号。
- 协议夹具处理新增的 Suspend、Resume/Resumed 和 CallbackConsumed，运行管理路由、模型流与状态读写回归。
- 对照 [CPA candy.go](https://github.com/haowang02/cpa-plugin-codex-candy-eval/blob/e84acaff30cadeb300d988f9cbc002742fa3fa0d/internal/plugin/candy.go)：请求成功且回答含前后不紧邻 ASCII 数字的 21，即判答对。现有正则与该规则等价，不改评分含义，也不重写旧记录。
- 增加“最少取出21颗”“21颗”“最少取出**21**个”的评分用例；121、210、2 1 不通过。该规则为文本启发式，不验证整段数学推理。
- 最近结果、历史轮次与逐题结果增加图标、文字和语义颜色。全部题目答对才显示绿色；混合结果显示“部分答对”，错误文本中出现 21 仍显示请求失败。
- 保留原有插件身份、history schema v1 和全局 64 轮上限。

## 验证结果

- Go race/vet、Rust fmt/Clippy、2 个单元测试和 5 个协议集成测试通过。
- 最终 macOS 包提取的插件进程通过 4 个模拟宿主协议用例；超时用例继续使用进程内虚拟时间。Linux 静态 ELF 交叉构建完成。
- 两个安装包的资源与当前源码逐字节一致，版本、协议及 SHA-256 校验通过。
- 使用 CPS v3.33.0 原始 `runtime/src/package/validation.rs` 和对应 SDK 在隔离校验器中实际解析归档：v0.1.3 被拒绝为 `Manifest(Incompatible)`，v0.1.4 两个平台通过。校验器仅为没有图标的本插件使用等价的无图标返回分支；没有启动整个 CPS 服务或跳过清单/归档/摘要校验。
- Playwright/Chrome 严格 CSP 全流程回归通过；包含新成功标识、部分答对、请求失败不标绿、旧历史、暂停续测、加载提示、绘图、明暗主题、手机布局和减少动态效果。
- 已目检深色成功状态截图 `.build/screenshots/candy-success-dark.png`；截图使用演示数据，不包含用户账号。浅色截图为 `candy-success.png`。

## 边界

- 用户之前报告的是通用安装校验提示，尚无该次服务端日志与精确版本；已确认 RPC v6/v7 不兼容，但不能凭该通用提示排除下载文件不完整或选错附件等其他原因。
- 未在目标 CPS 安装、未调用真实模型、未在 Linux 主机实跑，真实升级后的历史保留仍需目标环境验证。
- 发布入口：[v0.1.4 Release](https://github.com/jiahao6635/cps-codex-candy-eval/releases/tag/v0.1.4)，提供 Linux x86_64、macOS ARM64 安装包及各自的 SHA-256 校验文件。

## 安装包 SHA-256

- `local.codex-candy-eval-0.1.4-aarch64-apple-darwin.tar.gz`
  `003fa5da8c55d3e916a177024098fe707acb4031acb368d56de5f06c24a59eba`
- `local.codex-candy-eval-0.1.4-x86_64-unknown-linux-gnu.tar.gz`
  `e801b6df32c654b725293b6a67c10e87cff7dffd0f75917a46236ba34a4e457c`

归档与对应 `.sha256` 文件位于 `dist/`。
