# CPS Codex 能力测试 v0.1.2

面向 Codex Proxy RS（CPS）的独立进程插件，参考 [haowang02/cpa-plugin-codex-candy-eval](https://github.com/haowang02/cpa-plugin-codex-candy-eval) 实现。无需 CPA、额外管理密码、Python 或在线指纹服务。

## 安装与使用

要求 CPS **3.29.7 或以上的 3.x 版本**，进程协议 v5、management v2。SDK 固定于 CPS v3.29.7 的提交 `78bc57c5cf24b01a38e985cdd739bb4ae89ce11f`；当前验证目标为 v3.29.7，尚未在运行中的 CPS 安装验收。

CPS v3.29.7 的宿主只支持 RPC v5，旧插件 v0.1.0（RPC v4）不能直接安装运行。旧版 CPS 3.29.3–3.29.6 请继续使用 v0.1.0；升级到 CPS 3.29.7 时需安装 v0.1.1 或更新版本。插件沿用同一 `history` 状态命名空间与 schema v1，无需转换测试历史。详见 [CPS v3.29.7 升级说明](https://github.com/zyycn/codex-proxy-rs/releases/tag/v3.29.7)。

1. 打开 CPS → 插件管理 → 安装 → 上传包，选 `dist/local.codex-candy-eval-0.1.2-x86_64-unknown-linux-gnu.tar.gz`（Linux x86_64）。Apple Silicon 本机 CPS 使用对应的 `aarch64-apple-darwin` 包。
2. 确认来源和完整信任，接受制品并启用；无额外插件配置项。
3. 从插件菜单打开「Codex 能力测试」，选 Client Key、模型和账号，点击测试。

所选 Key 必须有权访问目标账号和模型，并有可用预算。账号指定通过 `host.model.execute_stream` 完成；宿主负责凭据、代理、账号约束、计费和请求日志。插件只获取展示事实，不读取原始账号令牌或 Key 密钥，不改账号、分组、优先级或 Key。

## 已实现

- **糖果题**：与参考项目同题，每账号 1–10 次，选择推理强度。沿用“回答包含独立数字 21”启发式评分，答错不重试；原文供人工核对，文本提到 21 不代表其最终结论正确。
- **模型指纹**：从同一参考库的 36 道挑战随机抽取 3 道，使用模型默认推理强度，保留系统提示和题目前缀。复用固定的 Go 检测算法、校准、候选库及黄金样本；部分样本只排名，不显示概率，非模型样式的数字序列不归因。概率仅比较内置候选，不能证明真实模型身份。
- **画鹈鹕**：原版与多合一版，保存模型原文。账号行与历史卡片直接显示静态 SVG 缩略图，点击后在弹窗放大，展示账号、模型、推理强度、绘图版本、时间及用量。支持 SVG/CSS 动画，不执行 JavaScript、不加载外部资源；依赖 HTML 脚本的动画无法播放。SVG 无法预览时仍可展开回答原文。
- **账号辨识与测试**：显示账号名称、邮箱、完整账号 ID 及套餐；通用的 `openai OAuth` 名称优先显示邮箱。支持按名称、邮箱或 ID 搜索，单行测试或勾选多个账号串行测试；全选只作用于当前可见的已启用账号。可在本题结束后暂停，历史中的待继续轮次可续测。
- **按账号查看历史**：历史按稳定账号 ID 归组，可切换当前测试类型或全部测试。停用账号和已移除账号的保留记录仍可查看，测试按钮禁用。新记录保存名称、邮箱、套餐快照；旧记录通过账号 ID 关联当前资料，缺少资料时展示原名称与 ID。列表只加载摘要，原文和绘图按需读取。
- **持久范围**：宿主私有状态保留**所有账号合计最近 64 轮**，不是每个账号 64 轮；空间满时只覆盖最早的已结束轮次。页面明确展示已保存数量与上限。旧版已覆盖或清除的记录无法恢复，升级不清空已有状态。
- **重复计费保护**：先保存请求中状态，再调用模型。浏览器断开或进程重启后，未确认结果的题目不会自动重发；在 CPS 请求日志核对后停止该轮，再新建测试。

模型结果支持 JSON/SSE 和 CPS v5 的 WebSocket 原文事件；有解析视图时直接读取，没有解析视图时解析原文 JSON。

每题都构造新的 Codex 会话，复用参考项目固定的 Codex CLI 0.163.0 上下文；约 1.4 万输入 Token 仅是参考估计，实际以 CPS 用量为准。通过 CPS 已支持的 `client_metadata.ws_request_header_x_openai_internal_codex_responses_lite` 投影传递 Responses Lite 标识；无需修改宿主。插件不会执行模型发出的工具调用。

## 使用限制

- 每个插件实例同时执行一题。页面顺序推进批量队列；关闭页面会终止页面队列，已保存的待继续轮次可恢复，尚未创建的后续账号需要重新勾选。
- 模型流读取最多 **120 秒**，为 CPS 管理桥 180 秒期限留出建连及保存时间；与 CPA 参考项目的 3/10 分钟上限不同。无自动重试、定时巡检、通知或自动优先级调整。
- 每轮受 CPS **256 KiB** 单条状态上限约束。超大回答不参与评分；若汇总状态超限，保留请求事实并移除回答原文，页面显示原因。
- 本地协议测试模拟 CPS 和模型返回，浏览器测试使用明确的演示账号。尚未在真实 CPS 安装、调用真实模型或验证生产计费；Linux ELF 已构建，但本机没有 Linux 运行环境，未进行 Linux 进程实跑。

## 构建与验证

当前验证记录见 [v0.1.2 账号与历史验证](VALIDATION-v0.1.2.md)；协议适配记录见 [v0.1.1 兼容性验证](VALIDATION-v0.1.1.md)；v0.1.0 的历史记录保留在 [VALIDATION.md](VALIDATION.md)。

要求 Go 1.26+、Rust 1.99.1、目标 Rust std，以及与上述 SDK 一致的 CPS `cpr-plugin` 打包工具。代码只通过固定 Git SDK 依赖宿主，无本地源码路径依赖。

```sh
# 本机测试并生成 macOS ARM64 包
CPR_PLUGIN_BIN=/path/to/cpr-plugin bash scripts/build.sh aarch64-apple-darwin

# Linux x86_64 静态 ELF 包（macOS 可用 rust-lld 交叉链接）
rustup target add x86_64-unknown-linux-musl --toolchain 1.99.1
CPR_PLUGIN_BIN=/path/to/cpr-plugin bash scripts/build.sh x86_64-unknown-linux-gnu

# 页面交互、严格 CPS CSP、窄屏与明暗主题
PLAYWRIGHT_PATH=/path/to/playwright CHROME_BINARY=/path/to/chrome node scripts/browser-qa.mjs
```

CPS 包名中的 `linux-gnu` 来自官方打包工具的 Linux 平台命名；实际二进制是面向 Linux x86_64 的静态 musl ELF，不依赖服务端 glibc。离线 Go 引擎嵌入 Rust 可执行文件，启动时在宿主提供的私有可执行工作目录释放，正常退出时删除。

`engine/` 负责题目、Codex 请求构造和离线评分；`backend/` 负责 CPS 协议和状态；`web/` 为无依赖页面；`scripts/` 提供构建、归档校验和浏览器测试。安装包内无凭据、管理地址或演示数据。

## 来源与许可

参考项目固定提交 `4f8367642cc1e629c4ee15a975e5e0fc53c4ac16`（MIT）。指纹算法与库来自 `Ikaleio/lm-detector` 的 `654c8334bb53951aaf04cbd61252d163649e1369`（MIT）。来源声明及许可证在 `legal/` 和 `engine/data/lm-detector/README.md`，均随包分发。CPS SDK 为 Apache-2.0；第三方依赖许可汇总见 `legal/THIRD-PARTY-LICENSES.txt`。
