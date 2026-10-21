# v0.1.1 兼容性验证

验证日期：2026-10-21（Asia/Shanghai）。目标为 [CPS v3.29.7](https://github.com/zyycn/codex-proxy-rs/releases/tag/v3.29.7)，源码与 SDK 固定于 `78bc57c5cf24b01a38e985cdd739bb4ae89ce11f`。

## 适配范围

- CPS v3.29.7 的 `plugin-host-compatibility.json` 仅接受进程协议 v5；已发布的插件 v0.1.0 包使用 v4，需要重新编译、打包，不能只调整兼容版本字符串。
- 插件 v0.1.1 使用新 SDK 和同提交官方打包代码，最低宿主版本设为 3.29.7，management 能力仍为 v2。
- 支持新 SDK 的 `WirePayload::WebSocket`：使用已有 JSON 解析视图，或解析 WebSocket 原文；保留 JSON/SSE 路径。
- `history` 命名空间、schema v1 和状态字段保持不变；无需迁移检测历史。
- 修复同一进程同一毫秒创建多个评分引擎时临时文件名重复的问题。

## 已通过

- `go test -race ./...`、`go vet ./...`：评分及指纹黄金样本测试通过。
- `cargo +1.99.1 fmt --check`、`clippy --all-targets -- -D warnings`、`cargo test --locked`：2 个单元测试、2 个协议集成测试通过。
- 协议集成测试对 JSON、原始 SSE、带解析视图的 WebSocket、仅原文的 WebSocket 分别验证指定账号与 Client Key、评分、历史查询、禁止重复发送、上游失败分类；同时携带非 UTF-8 字节请求头验证 v5 快照编解码。无效 WebSocket 原文记录为请求失败，不计为答错。
- 解包 macOS ARM64 的 v0.1.1 安装包后，以空环境变量启动真实插件进程，通过相同的 v5 集成测试。宿主回调和模型回答为本地夹具，不发生真实模型调用。
- 实际运行旧 v0.1.0 安装包，确认它拒绝 v5 握手。
- Linux x86_64 静态 ELF 构建通过。
- 两个平台的包内 protocol v5、manifest v2、management v2 均与 v3.29.7 宿主支持清单匹配；资源、文件集合、可执行位和 SHA-256 校验通过。

## 发行产物

| 平台 | 安装包 | SHA-256 |
| --- | --- | --- |
| macOS ARM64 | `dist/local.codex-candy-eval-0.1.1-aarch64-apple-darwin.tar.gz` | `bc3b153da46c305b98cddab972f3c7f119f8376da67af6146d47ba7e8fcf090d` |
| Linux x86_64 | `dist/local.codex-candy-eval-0.1.1-x86_64-unknown-linux-gnu.tar.gz` | `c638d877f581bba130e267b548ba558a63059b2a8c8dac7bec92b392b4873327` |

同名 `.sha256` 文件位于 `dist/`。旧 v0.1.0 安装包和 Release 保留。

## 未验证

未在运行中的 CPS 安装、启用或验证升级后的历史数据；未调用真实模型或验证生产计费；Linux ELF 未在 Linux 宿主实际启动。此次未重新进行浏览器流程测试，管理页仅更新版本号，交互未变。

安装包与校验文件见 [v0.1.1 Release](https://github.com/jiahao6635/cps-codex-candy-eval/releases/tag/v0.1.1)。未修改任何生产 CPS 实例。
