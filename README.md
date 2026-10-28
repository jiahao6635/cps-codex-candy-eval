# CPS Codex 能力测试 v0.1.6

面向 Codex Proxy RS（CPS）的独立进程插件，参考 [haowang02/cpa-plugin-codex-candy-eval](https://github.com/haowang02/cpa-plugin-codex-candy-eval) 实现。无需 CPA、额外管理密码、Python 或在线指纹服务。

## 安装与使用

安装包与 SHA-256 校验文件见 [v0.1.6 Release](https://github.com/jiahao6635/cps-codex-candy-eval/releases/tag/v0.1.6)。

最低要求 CPS **3.33.0**，进程协议 RPC v7、management v2。SDK 固定于 CPS v3.33.0 的提交 `8c8618aa0f841638262262e3338c115bc075f125`，兼容目标为 [CPS v3.33.0](https://github.com/zyycn/codex-proxy-rs/releases/tag/v3.33.0)。尚未在运行中的 CPS 安装验收。

使用 RPC v5 的 CPS 宿主请继续使用插件 v0.1.1 或 v0.1.2；CPS v3.32.0（RPC v6）使用 v0.1.3；CPS v3.33.0（RPC v7）使用 v0.1.4 及之后的版本。旧版 CPS 3.29.3–3.29.6（RPC v4）继续使用 v0.1.0。同一插件实例沿用 `history` 状态命名空间与 schema v1，升级不自动迁移或清理已有历史。

1. 打开 CPS → 插件管理 → 安装 → 上传包，选 `local.codex-candy-eval-0.1.6-x86_64-unknown-linux-gnu.tar.gz`（Linux x86_64）。Apple Silicon 本机 CPS 使用对应的 `aarch64-apple-darwin` 包。
2. 确认来源和完整信任，接受制品并启用；无额外插件配置项。
3. 从插件菜单打开「Codex 能力测试」，选 Client Key、模型和账号，点击测试。

所选 Key 必须有权访问目标账号和模型，并有可用预算。账号指定通过 `host.model.execute_stream` 完成；宿主负责凭据、代理、账号约束、计费和请求日志。插件只获取展示事实，不读取原始账号令牌或 Key 密钥，不改账号、分组、优先级或 Key。

## 已实现

- **糖果题**：与参考项目同题，每账号 1–10 次，选择推理强度。沿用“回答包含独立数字 21”启发式评分，答错不重试；原文供人工核对，文本提到 21 不代表其最终结论正确。账号最近结果、历史轮次和逐题结果展示“✓ 答对”“✕ 答错”或“! 请求失败”；混合轮次显示“部分答对”，不把请求完成等同于答对。
- **模型指纹**：从同一参考库的 36 道挑战随机抽取 3 道，使用模型默认推理强度，保留系统提示和题目前缀。复用固定的 Go 检测算法、校准、候选库及黄金样本；部分样本只排名，不显示概率，非模型样式的数字序列不归因。概率仅比较内置候选，不能证明真实模型身份。
- **画鹈鹕**：原版与多合一版，保存模型原文。账号行与历史卡片直接显示静态 SVG 缩略图，点击后在弹窗放大，展示账号、模型、推理强度、绘图版本、时间及用量。支持 SVG/CSS 动画，不执行 JavaScript、不加载外部资源；依赖 HTML 脚本的动画无法播放。SVG 无法预览时仍可展开回答原文。
- **账号辨识与测试**：显示账号名称、邮箱、完整账号 ID 及套餐；通用的 `openai OAuth` 名称优先显示邮箱。支持按名称、邮箱或 ID 搜索，单行或批量测试；账号并发可选 1–4，默认 2，每账号内部的题目仍依次执行。全选只作用于当前可见的已启用账号。可在已发出的题目完成后暂停，历史中的待继续轮次可续测。
- **紧凑列表**：桌面端横向排列配置和账号结果，每行可展开历史；鼠标移到账号信息可查看完整名称、邮箱及账号 ID，窄屏保留卡片布局。
- **测评进度**：主按钮、当前账号和进度区显示转圈图标，并显示账号批次、当前题数与本题等待秒数，不估算完成百分比。执行中禁用重复提交，仍可搜索账号、展开旧历史和查看绘图。暂停会等待当前题完成；准备阶段暂停则不会发送题目。系统开启减少动态效果时保留静态图标与文字提示。
- **按账号查看历史**：历史按稳定账号 ID 归组，可切换当前测试类型或全部测试。停用账号和已移除账号的保留记录仍可查看，测试按钮禁用。新记录保存名称、邮箱、套餐快照；旧记录通过账号 ID 关联当前资料，缺少资料时展示原名称与 ID。列表只加载摘要，原文和绘图按需读取。
- **统计与筛选**：按账号、当前模型和推理强度统计糖果题答对次数；请求失败不进入分母。最近 20 次答题可点击查看详细原文，可筛选账号状态或按正确率和时间排序。
- **持久范围**：沿用旧状态及其 64 个槽位，新增历史索引和最多 1200 个轮次槽位，宿主总空间上限 16 MiB。每个账号每种测试保留最近 20 轮，达到上限后新测试覆盖同组最早的已结束轮次；总槽位耗尽时覆盖最早的已结束轮次。字节配额耗尽时写入失败，不自动删除记录。升级不会清空旧数据；旧版已经覆盖或清除的记录无法恢复。
- **重复计费保护**：先保存请求中状态，再调用模型。浏览器断开或进程重启后，未确认结果的题目不会自动重发；刷新后保留的 `running` 记录显示“请求未确认 / 请核对日志”，不会显示为仍在本页执行或持续转圈。在 CPS 请求日志核对后停止该轮，再新建测试。

模型结果支持 JSON/SSE 和 CPS 的 WebSocket 原文事件；有解析视图时直接读取，没有解析视图时解析原文 JSON。

每题都构造新的 Codex 会话，复用参考项目固定的 Codex CLI 0.163.0 上下文；约 1.4 万输入 Token 仅是参考估计，实际以 CPS 用量为准。通过 CPS 已支持的 `client_metadata.ws_request_header_x_openai_internal_codex_responses_lite` 投影传递 Responses Lite 标识；无需修改宿主。插件不会执行模型发出的工具调用。

## 使用限制

- 每个插件实例最多同时执行 4 题，页面按所选并发推进账号队列；关闭页面会终止页面队列，已保存的待继续轮次可恢复，尚未创建的后续账号需要重新勾选。并发会增加瞬时额度消耗，并可能受 Client Key 或上游并发限制。
- 模型建立与读取共用最多 **120 秒**；宿主请求剩余预算不足时会缩短，并为流清理、评分和状态保存预留时间。Management 请求上限为 **170 秒**。与 CPA 参考项目的 3/10 分钟上限不同；无自动重试、定时巡检、通知或自动优先级调整。
- 每轮受 CPS **256 KiB** 单条状态上限约束。超大回答不参与评分；若汇总状态超限，保留请求事实并移除回答原文，页面显示原因。
- 本地协议测试模拟 CPS 和模型返回，浏览器测试使用明确的演示账号。尚未在真实 CPS 安装、调用真实模型或验证生产计费，也未进行 Linux 进程实跑。

## 构建与验证

当前验证记录见 [v0.1.4 兼容性与结果标识验证](VALIDATION-v0.1.4.md)。历史记录保留在 [v0.1.3 验证](VALIDATION-v0.1.3.md)、[v0.1.2 账号与历史验证](VALIDATION-v0.1.2.md)、[v0.1.1 兼容性验证](VALIDATION-v0.1.1.md) 和 [v0.1.0 验证](VALIDATION.md)。

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

`engine/` 负责题目、Codex 请求构造和离线评分；`backend/` 负责 CPS 协议和状态；`web/` 包含页面和离线公式渲染库；`scripts/` 提供构建、归档校验和浏览器测试。安装包内无凭据、管理地址或演示数据。

## 来源与许可

参考项目固定提交 `4f8367642cc1e629c4ee15a975e5e0fc53c4ac16`（MIT）。指纹算法与库来自 `Ikaleio/lm-detector` 的 `654c8334bb53951aaf04cbd61252d163649e1369`（MIT）。公式渲染使用 Temml 0.13.5（MIT）。来源声明及许可证在 `legal/` 和 `engine/data/lm-detector/README.md`，均随包分发。CPS SDK 为 Apache-2.0；第三方依赖许可汇总见 `legal/THIRD-PARTY-LICENSES.txt`。
