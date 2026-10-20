# v0.1.0 验证记录

日期：2026-10-20（Asia/Shanghai）。参考源码提交：`4f8367642cc1e629c4ee15a975e5e0fc53c4ac16`；CPS SDK/CLI 源码提交：`16d8a3f87309d9346a5f204673390fe20478b40e`。

## 已通过

- Go：`go test -race ./...`、`go vet ./...`；指纹黄金样本逐项比较到 1e-9，覆盖完整归因、部分归因和非模型序列；糖果数字边界、SVG 提取、无效绘图、随机挑战和 Codex 上下文检查。
- Rust：`cargo +1.99.1 fmt --check`、`clippy --all-targets -- -D warnings`、`cargo test`；2 个单元测试及 1 个协议集成测试，检查指定账号/Key、状态版本写入、已结束题目禁止重放、请求失败不当作答错及历史查询。
- Chromium + Playwright：模拟管理桥完成多个账号糖果题、指纹、绘图、刷新后的历史恢复；检查桌面、390px 窄屏和暗色外观。使用与 CPS 相同的关键 CSP（含 `frame-src 'none'`），绘图采用 data SVG 图片模式，模型标记无法访问父页面。
- 官方 CLI 逻辑打包：使用上述固定提交的 `plugin-cli/src/main.rs`，在隔离的临时 Cargo 项目构建工具，依赖同一固定 SDK。包清单经官方 `Manifest` 规范化，protocol v4 / management v2。
- 归档：逐一核对所有文件 SHA-256、文件集合、可执行位、平台魔数及归档摘要文件。
- macOS ARM64 **实际发布包进程**：解包后空环境变量启动，运行同一协议集成测试，验证握手、内嵌 Go 引擎释放执行、评分、持久状态及失败分类；模型和宿主均为测试夹具。
- Linux x86_64：Rust 与 Go 均交叉构建为静态 Linux ELF；包内目标为 Linux/x86_64。

## 产物摘要

- `local.codex-candy-eval-0.1.0-aarch64-apple-darwin.tar.gz`
  - SHA-256：`5f7e33067f78ab09610e3b3a81cdfa90dece95dc037a4bfc649f447d68c2f2d7`
- `local.codex-candy-eval-0.1.0-x86_64-unknown-linux-gnu.tar.gz`
  - SHA-256：`52fbee38e93aaa78a9345ecbb9aa0a9432696de84b171014bc21ac6c5c0c98eb`

## 尚未验证

未上传或启用任何线上插件；未请求真实模型、消耗真实账号额度或验证真实账单；未在 Linux 宿主实际启动；未验证安装后的完整管理页桥、停用与版本切换。兼容声明不是对任意后续 3.x 版本的实测证明。

截图位于 `.build/screenshots/`，明确使用演示账号；不可作为线上安装或真实模型能力的证据。首版无自动重试、巡检、通知或账号优先级调整。
