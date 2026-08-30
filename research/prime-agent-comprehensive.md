# Prime Agent 全面调研报告

调查日期：2026-08-28  
调研对象：[`PrimeIntellect-ai/prime-agent`](https://github.com/PrimeIntellect-ai/prime-agent)  
资料范围：项目官方 README、官方仓库文档、源码包清单、许可证、贡献/开发规则、Changelog 和官方安装脚本。本文的事实判断均回溯到这些一手资料；“适合/不适合”属于基于事实的工程判断。

## 1. 先给结论

Prime Agent 不是一个“更大的聊天窗口”，也不是只会生成代码的 CLI。它是一个面向 coding 和 research、尤其是长期运行任务的本地 Agent runtime，核心设计是：

```text
模型
  │ 只面对一个主要工具：持久 Python REPL
  ▼
Python 控制环境
  ├─ 读写文件、运行项目命令、处理数据
  ├─ 调用 Python-backed skills / MCP
  ├─ 递归创建子 agent（RLM）
  └─ 维护任务状态与长期工作上下文
        │
        ▼
TypeScript host + daemon + worker
  ├─ provider 调用、session、队列与生命周期
  ├─ schedule / heartbeat / goal / autonomous
  └─ transcript、kernel state、harness state、artifacts 持久化
```

官方对它的定义是开源 coding and research agent，支持 general and long-running work。它把 prompt/context 视为可编程变量，把递归子 agent 视为函数调用，并通过 Continual Harness 保存可复用的 prompt、memory、skill description 和 sub-agent specification。[官方 README](https://github.com/PrimeIntellect-ai/prime-agent)

我的总体判断：

- 如果任务需要跨多轮持续工作、后台继续执行、递归拆解、持久上下文或可编程工作流，Prime Agent 很有价值。
- 如果任务只是一次性问答或一次短小代码修改，它可能比简单 CLI 更复杂。
- 如果任务要求强安全隔离、严格确定性、云端多租户、高可用队列或不可失败的生产控制，不能把 Prime Agent 本身当作完整解决方案。

## 2. 它到底是什么

### 2.1 产品定位

官方 README 将 Prime Agent 定位为“Self-Improving RLM Harness”，并明确称其为 open-source coding and research agent。它围绕两个抽象构建：

1. **Recursive Language Model（RLM）**：模型在持久 REPL 中工作，把上下文当变量，把递归子 agent 当可编程调用。
2. **Continual Harness**：把补充 prompt、memory、skill description 和可复用的 sub-agent specification 保存为持久状态，并允许通过小的、基于证据的更新持续改进。

来源：[README](https://github.com/PrimeIntellect-ai/prime-agent)、[RLM programming model](https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/rlm.md)、[RLM runtime architecture](https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/rlm-runtime.md)

### 2.2 它与 Pi 的关系

官方 README 说明 agent 和 TUI 建立在 [`pi`](https://github.com/earendil-works/pi) 之上。当前 monorepo 仍保留 `@earendil-works/pi-*` 的 workspace 名称、`pi` 的 bin/manifest 字段和部分 `PI_*` 兼容环境变量，但官方开发文档强调这些是继承而来的源码/兼容细节，公开产品名、CLI、release artifact 和仓库名是 Prime Agent。[README](https://github.com/PrimeIntellect-ai/prime-agent)、[Development](https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/development.md)

因此，使用者应把它理解为：

> Pi 生态基础之上的、增加了持久 Python 控制面、RLM、daemon 和长期任务能力的 Prime Agent 产品。

### 2.3 当前版本与项目状态

在本次读取的 `main` 分支源码中，根 `package.json` 和 coding-agent package 的版本均为 `0.8.1`；Changelog 中有 `[0.8.1] - 2026-08-26`，同时保留了大量 `[Unreleased]` 条目，说明项目仍在快速迭代。[根 package.json](https://github.com/PrimeIntellect-ai/prime-agent/blob/main/package.json)、[coding-agent package.json](https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/package.json)、[Changelog](https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/CHANGELOG.md)

这代表两个重要事实：

- 它已经具备较完整的产品化运行时，而不只是实验性 prompt wrapper。
- 接口、daemon 协议和运行行为仍可能变化；生产使用应固定 release 版本，而不是无条件跟随 `main`。

## 3. 安装、运行与使用入口

### 3.1 安装方式

官方 Quickstart 支持 macOS 和 Linux 的稳定版安装，也提供基于 `main` 的 beta 安装；源码运行要求 Node.js `22.8.0` 或更高版本。公开安装脚本会下载版本化 release artifact，而不是直接把源码目录当作安装路径。[Quickstart](https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/quickstart.md)、[Development](https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/development.md)、[官方安装脚本](https://app.primeintellect.ai/prime-agent/install.sh)

稳定版安装命令：

```bash
curl -fsSL https://app.primeintellect.ai/prime-agent/install.sh | sh
```

源码运行方式：

```bash
git clone https://github.com/PrimeIntellect-ai/prime-agent
cd prime-agent
npm ci
./prime-agent.sh
```

源码 runner 可以从任意目录启动，并保留调用者的工作目录；因此可以让源码 checkout 作用于另一个测试项目。[Quickstart](https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/quickstart.md)

### 3.2 认证与模型来源

Prime Agent 支持 `/login` 选择订阅型 provider，也支持环境变量或 `~/.prime/agent/auth.json` 中的 API key。官方列出的订阅登录包括 ChatGPT Plus/Pro（Codex）、Claude Pro/Max 和 GitHub Copilot；API-key provider 覆盖 Anthropic、OpenAI、Prime Inference、Google Gemini、DeepSeek、Mistral、Groq、Cerebras、Cloudflare、xAI、OpenRouter、Vercel AI Gateway、ZAI、OpenCode、Hugging Face、Fireworks、Kimi、MiniMax、Xiaomi 等。[Providers](https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/providers.md)

凭据解析优先级是：

1. CLI 的 `--api-key`；
2. `auth.json`；
3. 环境变量；
4. `models.json` 中的 custom provider key。

官方文档还说明 `auth.json` 按 `0600` 创建，并支持 literal value、环境变量名和 shell command 三种 key 形式。[Providers](https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/providers.md)

这使 Prime Agent 适合在个人机器、CI worker、企业代理或自定义 provider 环境中运行，但不代表它自动替你完成 secret manager、租户隔离或密钥轮换。

### 3.3 四种主要运行入口

| 入口 | 用途 | 适合场景 |
|---|---|---|
| Interactive TUI | 人在终端中持续协作 | 日常开发、调试、探索、长任务 |
| Print `-p` | 一次性输出后退出 | shell pipeline、批处理、简单自动化 |
| JSON mode | 输出 JSON event stream | CI、日志采集、自动化 runner |
| RPC mode | stdin/stdout JSONL 命令与事件 | 自定义 UI、IDE、宿主程序集成 |
| ACP mode | Agent Client Protocol over NDJSON | Zed、VS Code、评测 harness 等 ACP client |

官方 Usage、RPC 和 ACP 文档分别定义了这些入口的行为。JSON 适合“导出所有事件并以退出码结束”的批处理；RPC 暴露 Prime Agent 自己更丰富的命令面；ACP 适合外部程序交互式驱动一个 session。[Usage](https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/usage.md)、[RPC](https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/rpc.md)、[ACP](https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/acp.md)

## 4. 核心运行模型

### 4.1 持久 Python REPL 是模型的控制面

默认 RLM runtime 只向模型暴露一个主要内置工具：`ipython`。模型通过 Python 完成文件读写、运行命令、处理数据、调用 skills、使用 MCP 和创建子 agent。TypeScript host 负责 provider 请求、session state、工具执行、调度、子 agent 生命周期和 transcript 写入。[RLM programming model](https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/rlm.md)

Python 状态跨 tool call 和 context compaction 保留，例如变量、import、函数、解析结果和 task handle 都可以继续使用。`bash()` 每次创建独立进程，而 Python namespace 和环境变化持续存在。[RLM programming model](https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/rlm.md)

这比“每轮重新给模型一组无状态工具”更适合：

- 数据探索和中间结果较多的研究任务；
- 需要连续运行命令、解析结果、再决定下一步的调试任务；
- 多阶段迁移、测试、修复和验证；
- 需要把工作流封装成 Python-backed skill 的自动化。

### 4.2 宿主、kernel、worker 的职责分离

官方架构将 interactive TUI、print/JSON/RPC client、supervisor、session worker、`AgentSessionRuntime`、root session、Python kernel、RLM child runtime 和 storage 分开。client 负责渲染和输入；supervisor 负责发现、路由、attach、worker 健康和消息投递；worker 负责 root session、scheduler、kernel 和 descendants；`AgentSession` 负责 provider、队列、工具、compaction、goals、子 agent 和 transcript。[Architecture](https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/architecture.md)

这意味着关闭终端 UI 通常只是 detach，后台 worker 可以继续持有 session；它不是把全部执行状态放在终端进程里。[Long-running agents](https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/long-running-agents.md)

### 4.3 Session 与 artifacts

持久 session 默认保存在 `~/.prime/agent/sessions/`，相关 artifact 在 `~/.prime/agent/session-artifacts/` 下。官方列出的可能 artifact 包括 JSONL transcript、kernel state、scheduled jobs、harness state 和子 agent session 文件。[RLM runtime architecture](https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/rlm-runtime.md)

可以通过 `PRIME_AGENT_CODING_AGENT_DIR`、`PRIME_AGENT_SESSION_DIR`、`--session-dir` 等方式隔离配置和 session。对于 CI、测试和多项目环境，应该显式指定隔离目录，避免不同任务共享 session 或凭据。[Development](https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/development.md)、[Usage](https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/usage.md)

## 5. 递归子 agent：Prime Agent 最有辨识度的能力

### 5.1 RLM 调用方式

Python kernel 预加载 `rlm` callable：

```python
api_review = await rlm(
    "Review the public API and report findings to the parent.",
    name="api-reviewer",
)
test_review = await rlm(
    "Review test coverage and report missing cases.",
    name="test-reviewer",
)
```

调用在“任务被接收”后立即返回一个 handle，不会等待子 agent 完成，也不会直接返回答案。子 agent 通过 `agent_message.send(..., receiver_role="parent")` 或写文件把结果交回父 agent。[RLM programming model](https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/rlm.md)、[RLM runtime architecture](https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/rlm-runtime.md)

### 5.2 它解决什么问题

RLM 适合把一个大任务拆成并行的、边界清楚的子任务，例如：

- API、实现、测试、文档分别审查；
- 代码质量、安全、性能、兼容性分别调查；
- research 任务按论文、源码、实验、复现分工；
- 大型迁移按 package、service 或 subsystem 分工；
- 一个 agent 运行慢测试，另一个分析失败日志，父 agent 汇总决策。

这里的关键不是“多开几个聊天”，而是子 agent 是正常的 `AgentSession`，继承 provider、skills、tools、session machinery 和 retry policy，同时有自己的 context 与 session directory。[RLM runtime architecture](https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/rlm-runtime.md)

### 5.3 生命周期、深度和成本

当前文档说明：

- child handle 包含 `rlm_child_id`、name、session directory 和 model；
- parent-scoped registry 可在 compaction、kernel restart 和 parent restore 后恢复；
- 完成的 daemon-backed child 可以继续被 attach、message 或 follow-up；
- 默认最大递归深度为 2，root 可以创建 child 和 grandchild；
- 子 agent 的 usage/cost 会异步归因到创建它的 parent assistant turn；
- 子 agent 增加总账单成本，但不会把 child context 伪装成 parent 自身的 context-window 使用量。

来源：[RLM runtime architecture](https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/rlm-runtime.md)、[Long-running agents](https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/long-running-agents.md)

工程含义：RLM 很适合“多个独立视角”，不适合无边界地递归复制 agent。生产工作流必须限制子 agent 数量、模型、thinking level、超时、workspace 和总预算。

## 6. 长期运行能力

### 6.1 Daemon 与断线续跑

daemon supervisor 管理 worker、client attachment、routing、health、message delivery 和 recovery。worker 崩溃影响单个 root session tree；恢复时会重新建立 root runtime，且不会重放不确定的副作用。官方 daemon 文档还描述了 session lease、command journal、generation-aware event cursor、reconnect、snapshot、backpressure 和 bounded recovery。[Daemon architecture](https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/daemon.md)

这使它适合：

- 需要运行几十分钟到数小时的开发任务；
- 关闭终端后仍要继续的编译、测试、迁移或研究；
- 人可以稍后 attach 查看进展并继续操作的任务；
- 同一台机器上同时维护多个相互独立的 agent session。

但这些是单机 daemon/worker 的生命周期能力，不等于跨机器高可用队列、数据库事务、工作流编排平台或 SLA。

### 6.2 Heartbeat、schedule、goal、autonomous 的区别

Prime Agent 有四种容易混淆的长期机制：

| 机制 | 本质 | 典型用途 |
|---|---|---|
| `/heartbeat` | 当前用户 session 的 recurring instruction | 定期检查状态、提醒 agent |
| `rlm_heartbeat` | agent 从 Python 管理的多个 recurring instruction | 子任务监控、测试完成检查 |
| `prime-agent schedule` | 面向 addressable agent 的一次性/cron prompt | 定时运行指定工作 |
| `/goal` | 跨 turn 持久化的目标及其进度 | 迁移、发布、研究等长目标 |
| `/autonomous` | 有预算和质量 gate 的自动 continuation policy | 无人值守执行与修复 |

官方文档说明 schedule 的 due tick 先 claim，遗漏 tick 会 coalesce，避免无限堆积；goal 记录 token、elapsed time、continuation count；autonomous 可以按 continuation、turn、token、wall-clock 和 quality gate 限制运行。[Long-running agents](https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/long-running-agents.md)

一个典型的无人值守命令：

```bash
prime-agent -p \
  --autonomous \
  --autonomous-gate "npm run check" \
  --autonomous-max-continuations 3 \
  --autonomous-max-turns 12 \
  --autonomous-max-tokens 80000 \
  --autonomous-timeout-ms 1800000 \
  "Fix the failing check and report the verified result."
```

必须注意：通过 gate 只代表 gate 验证的命令通过；达到 limit 不代表任务成功，也不代表模型完成了用户目标。[Usage](https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/usage.md)、[Long-running agents](https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/long-running-agents.md)

### 6.3 Compaction 与连续性

自动 compaction 会压缩旧消息、保留近期上下文，并且 Python kernel 的变量、import、helper function 和 task state 可以继续存在。compaction 不是完成信号，也不会自动停止 goal、autonomous、heartbeat 或 child session。[Long-running agents](https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/long-running-agents.md)

适合长任务，但也带来一个运营问题：任务状态可能同时存在于 transcript、kernel namespace、harness state、文件和子 agent session 中。需要可审计结果时，应将最终状态写入明确的结构化 artifact，而不能只依赖聊天上下文。

## 7. Skills、Extensions 与 Packages

### 7.1 Markdown Skills

Prime Agent 实现 Agent Skills standard，skill 使用 `SKILL.md` 做发现、路由和指令加载。系统启动时只把 skill metadata 放进 prompt；任务匹配后再加载完整 `SKILL.md`，这是 progressive disclosure。[Skills](https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/skills.md)

skill 可以从以下位置发现：

- `~/.prime/agent/skills/`、`~/.agents/skills/`；
- 项目 `.prime/agent/skills/` 和 `.agents/skills/`；
- package 的 `skills/` 目录或 `package.json` 的 `pi.skills`；
- settings 中配置的路径；
- CLI 的 `--skill` 路径；
- Prime Agent 内置 skills。

Prime Agent 自带的 built-in skills 包括 Prime Intellect 产品工作流、skill creator 和基于 Serper 的 websearch skill。[Skills](https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/skills.md)

### 7.2 Python-backed Skills

Python-backed skill 是 Markdown skill 的超集：除 `SKILL.md` 外，还可以有 `pyproject.toml` 和 `src/<import_name>/__init__.py`，被安装到持久 kernel venv 后，模型可以直接调用例如：

```python
report = await release_audit(repository=".", target_version="0.4.0")
```

它适合把反复出现的流程变成可复用的、带 typed callable、依赖、脚本和验证行为的能力。例如 release audit、数据分析、API 检查、合规扫描、项目专用测试入口。[Skills](https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/skills.md)、[RLM programming model](https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/rlm.md)

### 7.3 Continual Harness 与 skill 的区别

`/refine` 可以根据当前 trajectory 对 supplemental prompt、memory、skill description 和 sub-agent specification 做小的 create/update/delete，并保存 before/after snapshot 以支持 rollback；它不会改写 immutable base system prompt。[RLM runtime architecture](https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/rlm-runtime.md)

但 harness 中的 reusable skill description 不等于一个真正安装的 Python package。官方文档明确区分：重复流程若需要可执行功能，仍应通过 skill creator 打包成 Python-backed skill。[Skills](https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/skills.md)

### 7.4 Packages 与扩展风险

package 可以通过 npm、git、HTTP URL 或本地路径安装，包含 extensions、skills、prompt templates 和 themes。extension 可以增加 custom tools、commands、事件处理和 UI；package 依赖会被安装到独立 module root。[Packages](https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/packages.md)

官方的安全警告非常明确：Prime Agent packages 具有完整系统访问权；extensions 执行任意代码，skills 可以指示模型采取包括运行 executable 在内的任意动作。因此第三方 package、Python skill、extension、仓库内 skill 都应当先审查。[Packages](https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/packages.md)、[Skills](https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/skills.md)

## 8. 适合做什么任务

下面的评级是基于官方能力的工程判断，不是官方 benchmark 分数。

### 8.1 最适合：长时间、多阶段、需要上下文的 coding 任务

| 任务 | 适配度 | 原因 |
|---|---:|---|
| 大型重构 | 很高 | 可持续读取、编辑、运行检查，并跨多轮保留状态 |
| 依赖升级/框架迁移 | 很高 | goal + autonomous + quality gate 能形成“改—测—修”的闭环 |
| 测试补齐与失败修复 | 很高 | 持久 kernel 便于反复运行命令，子 agent 可分拆测试区域 |
| 跨模块 bug 调查 | 很高 | 可保存中间实验结果和日志，长任务不受单个聊天窗口限制 |
| 代码库架构理解 | 很高 | Python 文件/数据处理 + project context + 可保留研究成果 |
| 复杂 code review | 高 | RLM 可以并行做 API、测试、安全、文档等独立审查 |
| 性能调查 | 高 | 一个 session 可持续记录 benchmark、profile、假设与复测结果 |
| 发布前验证 | 高 | autonomous gate、session artifact、结构化输出适合做发布检查 |

这些判断直接对应官方的持久 kernel、子 agent、goal、autonomous、compaction、session artifact 和 headless mode 能力。[RLM](https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/rlm.md)、[Long-running agents](https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/long-running-agents.md)、[Usage](https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/usage.md)

### 8.2 很适合：研究、分析和评测型任务

Prime Agent 官方 README 明确把 research 列为产品用途，并说明其长期运行能力尤其面向 evaluations in research。[README](https://github.com/PrimeIntellect-ai/prime-agent)

典型任务包括：

- 阅读一个大型代码库并生成架构报告；
- 调查多个候选实现、论文或 API，并把证据写入文件；
- 运行实验、保存数据、比较结果、继续下一轮实验；
- 使用子 agent 分别处理文献、源码、复现和反例；
- 长时间运行 benchmark 或 evaluation，并在结束后汇总 artifact；
- 对固定项目反复积累研究方法、memory 和 reusable sub-agent specification。

Python REPL 对这类任务的价值在于中间数据可以留在 kernel，harness state 可以沉淀可复用经验，session 又可以从终端 detach 后继续。[RLM runtime](https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/rlm-runtime.md)

### 8.3 很适合：个人或团队的项目专用 Agent

如果一个项目有稳定的命令、规范和工作流，可以使用：

- `AGENTS.md` / `CLAUDE.md` 项目指令；
- `.prime/agent/skills/` 项目 skill；
- project settings；
- Python-backed skill；
- prompt template、extension 和 theme package。

例如可以做一个“发布审计 Agent”“数据库迁移 Agent”“客户 SDK 兼容性 Agent”或“内部数据清洗 Agent”。Prime Agent 启动时会加载 context file；skill 按需加载；package 可以把可执行能力一起分发。[Quickstart](https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/quickstart.md)、[Usage](https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/usage.md)、[Skills](https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/skills.md)、[Packages](https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/packages.md)

### 8.4 很适合：CI、批处理和自定义宿主

推荐按任务类型选择入口：

- **一次性 CI 检查**：`prime-agent -p`；
- **需要逐事件采集**：`--mode json`；
- **需要外部程序发送 prompt、监听事件、控制 session**：`--mode rpc`；
- **需要 IDE 或通用 Agent Client Protocol**：`--mode acp`；
- **Node/TypeScript 宿主**：直接使用 `AgentSession`，官方 RPC 文档明确建议不必为了集成而启动子进程。[Usage](https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/usage.md)、[RPC](https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/rpc.md)、[ACP](https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/acp.md)

这使它可嵌入：

- CI runner；
- 评测 harness；
- IDE/custom UI；
- 本地自动化脚本；
- 需要把 agent 作为一个步骤调用的 Node/TypeScript 应用。

## 9. 典型使用场景

### 场景 A：个人开发者的“持续协作工程师”

```text
cd project
prime-agent
  ├─ 先理解项目和约定
  ├─ 逐步修改代码
  ├─ 运行检查和测试
  ├─ 中途关闭终端
  └─ 稍后 prime-agent attach / --resume 继续
```

适合迁移、复杂 bug、跨文件重构和需要人机反复确认的工作。项目命令、目录约定和安全规则应写入 `AGENTS.md`，而不是每次重新解释。[Quickstart](https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/quickstart.md)、[Usage](https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/usage.md)

### 场景 B：夜间运行的“改代码—跑检查—继续修复”

使用 `-p --autonomous`，设置 `--autonomous-gate`、最大 turn/token/time 和独立 workspace。第二天检查 diff、gate 输出和 session artifact。

适合：依赖升级、机械迁移、补测试、格式化、修复静态检查错误。前提是任务可回滚，gate 命令足够有代表性，且 workspace 中不存在不应被模型触发的生产副作用。[Usage](https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/usage.md)

### 场景 C：多视角代码审查

父 agent 固定审查目标后，用 RLM 创建多个有明确输出契约的 child：

```text
child 1: API 与兼容性
child 2: 安全与权限
child 3: 测试与回归风险
child 4: 文档与项目规范
parent: 汇总、去重、按严重级别排序
```

子 agent 必须写回结构化结果或发送明确消息；父 agent 不应假设 `rlm()` 会直接返回完整答案。[RLM](https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/rlm.md)

### 场景 D：代码库/技术研究

一个长期 session 保存搜索结果、实验数据、源码路径、假设和下一步；研究流程稳定后，再将它提炼为 skill 或 harness state。适合 architecture survey、竞品/实现对比、API 迁移调查和可复现技术报告。[README](https://github.com/PrimeIntellect-ai/prime-agent)、[Skills](https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/skills.md)

### 场景 E：项目专用可执行技能

把内部流程封装为 Python-backed skill，例如：

```text
release-audit(repository, target_version)
database-migration_check(environment, migration_dir)
dependency-policy_scan(lockfile)
service-health_report(service, window)
```

适合拥有固定输入、固定输出、固定验证方式的团队流程。若只是文字指导，用 Markdown skill 即可；若需要真正调用库、解析数据或访问受控 API，再使用 Python-backed skill。[Skills](https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/skills.md)

### 场景 F：IDE 或内部工具集成

若外部客户端需要交互式发送 prompt、接收 token/tool stream、取消 turn，可以使用 ACP；若需要 Prime Agent 自己的 schedule、heartbeat、observe、agent messaging 等 richer command surface，则使用 RPC。ACP 一条连接只承载一个 session，第二个并发 session 应启动第二个进程。[ACP](https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/acp.md)、[RPC](https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/rpc.md)

### 场景 G：定时工作助手

可以使用 `prime-agent schedule add`、`/heartbeat` 或 `rlm_heartbeat` 做定时 prompt，例如定时检查 benchmark、扫描测试结果、提醒项目状态。[Long-running agents](https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/long-running-agents.md)

但定时 prompt 只是“唤起 agent”，不是可靠业务调度器。需要 webhook 去重、数据库游标、跨机器重试、 exactly-once 通知或最终一致性时，应由外部控制面承担，Prime Agent 只作为执行器。

## 10. 不适合或需要谨慎的任务

### 10.1 不适合把它当安全沙箱

官方 architecture、RLM 和 daemon 文档都明确说明：worker/kernel 是生命周期与故障隔离，不是 security sandbox；Python kernel、模型生成的 Python/bash、skills、extensions 和 package 代码以 worker 的操作系统权限运行。[Architecture](https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/architecture.md)、[RLM runtime](https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/rlm-runtime.md)、[Daemon](https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/daemon.md)

因此不应直接在默认宿主权限下处理：

- 不可信第三方仓库；
- 会执行构建脚本的恶意项目；
- 未审查的 Python-backed skill 或 extension；
- 含 prompt injection 的文档和 issue 内容；
- 可能访问宿主机 secret、SSH key、云凭据的 workspace。

官方建议对不可信 workspace 或 generated code 使用外部 sandbox/restricted execution environment。[RLM runtime](https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/rlm-runtime.md)

### 10.2 不适合当分布式任务平台

Prime Agent 的 schedule、worker recovery、session lease 和 daemon protocol 很完整，但官方资料描述的是本机 supervisor/worker/session runtime，并没有把它定义为跨机器队列、数据库、分布式锁、SLA 或多租户 control plane。[Daemon](https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/daemon.md)、[Long-running agents](https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/long-running-agents.md)

如果目标是“监控几万仓库、可靠去重、跨节点调度、失败重试、审计和通知”，应由外部服务发现任务、保存状态和执行重试；Prime Agent 只接收一个已固定的 job。

### 10.3 不适合不可验证的不可逆生产操作

autonomous mode 的 quality gate 可以要求命令通过，但官方明确说 gate 只验证自身覆盖的内容，limit 也不等于成功。[Usage](https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/usage.md)

因此不要让它在没有额外审批和隔离的情况下直接：

- 执行生产数据库迁移；
- 删除云资源或数据；
- 发布未经人工审阅的版本；
- 发送不可撤回的外部消息；
- 修改权限、密钥、网络或基础设施策略。

可以让它生成计划、执行 dry-run、在 sandbox 中验证，并由外部系统和人完成最终授权。

### 10.4 不适合追求完全确定性的任务

LLM 生成的代码、命令和分析仍可能出错；持久状态还可能把错误的假设带入后续 turns。对于格式转换、账务计算、合规判定、权限决策等任务，Prime Agent 应作为提议者或分析器，不应作为唯一真相来源。需要由确定性程序、schema、测试和人工审批兜底。

### 10.5 不适合一次性极简单任务的默认方案

如果只是“解释一个函数”“把一段文本总结成三句话”或“一次性改一处拼写”，持久 daemon、kernel、session 和 skill discovery 都可能成为额外负担。此类任务优先考虑 `prime-agent -p`，或选择更轻量的模型 API/CLI。

## 11. 集成模式与推荐部署方式

### 11.1 本地开发机

```text
Prime Agent TUI
    │
    ├─ 当前 project workspace
    ├─ ~/.prime/agent/auth.json
    ├─ ~/.prime/agent/sessions/
    └─ local daemon / workers / Python kernel
```

适合个人开发、研究、复杂重构和后台任务。建议：

- 使用 git checkpoint、branch 或 disposable clone；
- 将项目规范写入 `AGENTS.md`；
- 将危险命令写入明确的禁止清单；
- 不把生产凭据放进 workspace；
- 给不同项目使用不同 session/config 目录。[Quickstart](https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/quickstart.md)、[Development](https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/development.md)

### 11.2 CI / batch runner

推荐：

1. 外部 CI 创建一次性的 workspace；
2. 固定 commit/ref 和输入文件；
3. 通过 `-p` 或 JSON mode 启动 Prime Agent；
4. 使用 `--tools`、`--no-context-files`、`--no-skills`、`--no-extensions` 等选项收窄 surface；
5. 设置 autonomous 的 turn/token/time gate；
6. 只上传结构化结果和审计 artifact；
7. job 结束后销毁 workspace 和隔离 config。

这些 CLI 选项和 JSON event contract 在官方 Usage/JSON 文档中定义。[Usage](https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/usage.md)、[JSON mode](https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/json.md)

### 11.3 IDE / custom UI

ACP 的优点是遵循通用 Agent Client Protocol，外部 IDE 不必理解 Prime Agent 的内部命令；RPC 的优点是保留 Prime Agent 自身的 session、schedule、heartbeat、observe 和 messaging 能力。[ACP](https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/acp.md)、[RPC](https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/rpc.md)

需要注意：

- RPC 是严格 LF-delimited JSONL；不要使用会把 Unicode line separator 当换行的通用 readline 实现；
- ACP 一次连接一个 session；需要并发 session 时启动多个进程；
- ACP stdio server 是 trusted-code boundary，不是 sandbox；
- 外部客户端给出的 cwd 不应被当作已成功切换，官方会在 metadata 中报告不一致。[RPC](https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/rpc.md)、[ACP](https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/acp.md)

### 11.4 Node/TypeScript 宿主

官方 RPC 文档建议 Node.js/TypeScript 应用直接使用 `AgentSession`，而不是一定通过子进程 spawn RPC。这样可以在宿主内传递不可序列化的 extension factory，并减少协议层开销；需要进程隔离或跨语言时再使用 RPC。[RPC](https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/rpc.md)

## 12. 安全与治理建议

### 12.1 信任分层

建议把输入分成四级：

1. **控制面 policy**：外部系统固定的 workspace、ref、预算、允许命令和输出 schema。
2. **受信项目规则**：经过审查的 `AGENTS.md`、skill、extension 和项目配置。
3. **待审仓库内容**：源代码、README、issue、commit message、生成文档。
4. **模型生成执行内容**：Python、bash、安装依赖和子 agent 指令。

3 和 4 都不应自动升级为控制面权限。Prime 官方只保证 host bridge、provider credential、session/lifecycle 等职责由 TypeScript host 持有；它没有把仓库 instruction 变成安全 policy。[RLM runtime](https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/rlm-runtime.md)

### 12.2 最小安全配置

- 在外部 container/microVM/OS sandbox 内运行不可信任务；
- 默认不挂载宿主 SSH、cloud credential、生产配置；
- workspace 使用 disposable clone 或只读源 + 可写临时目录；
- 对网络 egress、CPU、内存、进程数、磁盘和时间设上限；
- 生产 provider token 只由外部 runner/publisher 使用；
- 第三方 package、extension、Python skill 先做 source review；
- 使用 `--no-*` 选项显式关闭不需要的 context、skills、extensions 和 tools；
- 把最终结果写成结构化 JSON，并对路径、SHA、状态和 gate 结果做程序化校验。

Prime 官方明确警告 packages、skills、extensions 和 ACP stdio server 的执行权限，因此以上不是额外的“高安全模式”，而是将 Prime Agent 用于不可信输入时的基本边界。[Packages](https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/packages.md)、[Skills](https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/skills.md)、[ACP](https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/acp.md)

## 13. 采用决策：什么情况下值得选 Prime Agent

### 值得优先试用

满足以下条件中的两项或更多时，Prime Agent 的差异化价值通常明显：

- 单个任务经常持续超过一个聊天 turn；
- 需要终端 detach 后继续运行；
- 需要多个子 agent 并行调查；
- 需要 persistent Python state 或实验数据；
- 需要项目专用、可执行的 skills；
- 需要 schedule、heartbeat、goal 或 autonomous continuation；
- 需要 TUI 之外的 JSON/RPC/ACP 集成；
- 需要把经验沉淀为可回滚的 harness state。

### 先选更简单工具

以下情况不必从 Prime Agent 开始：

- 只有一次性文本问答；
- 只需一个很短的代码修改；
- 任务不能接受模型运行 shell/Python；
- 首要要求是强沙箱而不是长期连续性；
- 需要云端多租户 API、跨节点调度和 SLA；
- 结果必须完全确定，且没有足够测试或人工审批。

### 推荐 PoC 验证清单

不要只验证“能不能启动”。至少做以下 8 项：

1. 在 disposable repo 中完成一次多文件修改并通过 gate。
2. 关闭 TUI 后 attach/resume，确认 session、kernel 和 schedule 恢复。
3. 运行 2–4 个 RLM child，验证 child 结果能通过 message/file 回收。
4. 制造 provider 超时、kernel 错误和 child 失败，检查失败传播和清理。
5. 运行 compaction，确认 kernel state、goal 和 child registry 行为符合预期。
6. 以 JSON/RPC/ACP 分别驱动一次任务，验证事件、退出码、取消和并发语义。
7. 在外部 sandbox 中运行一个带恶意脚本的测试仓库，确认宿主文件和 secret 不可达。
8. 测量 token、子 agent 成本、磁盘 artifact、长任务成功率和人工复核时间。

## 14. 最终判断

Prime Agent 最适合被看作：

> 一个可嵌入、可扩展、支持递归分工和持久状态的长期 coding/research 执行 runtime。

它的核心优势不是“单轮回答更聪明”，而是把一个复杂任务变成可持续运行的 session：模型可以用 Python 保存工作状态，用 RLM 分派子任务，用 skills 封装流程，用 daemon 跨终端继续，用 goal/autonomous 控制长任务，用 JSON/RPC/ACP 接入外部系统。[README](https://github.com/PrimeIntellect-ai/prime-agent)、[RLM runtime](https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/rlm-runtime.md)、[Long-running agents](https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/long-running-agents.md)

最佳落地方式是：

```text
外部控制面负责：任务发现、权限、workspace、队列、重试、审计、最终发布
                           │
                           ▼
Prime Agent 负责：理解、执行、递归分工、实验、修复、验证、产出 artifact
                           │
                           ▼
外部系统负责：schema 校验、人工审批、通知、合并、生产变更
```

如果把它当作“长期任务执行器”，它的能力很完整；如果把它误当作“安全沙箱、分布式调度器或不可失败的生产自动化平台”，就会超出官方资料支持的边界。

## 15. 一手来源索引

- [Prime Agent README](https://github.com/PrimeIntellect-ai/prime-agent)
- [Quickstart](https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/quickstart.md)
- [Usage and CLI reference](https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/usage.md)
- [RLM programming model](https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/rlm.md)
- [RLM runtime architecture](https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/rlm-runtime.md)
- [Architecture overview](https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/architecture.md)
- [Daemon architecture](https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/daemon.md)
- [Long-running and background agents](https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/long-running-agents.md)
- [JSON mode](https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/json.md)
- [RPC mode](https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/rpc.md)
- [ACP mode](https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/acp.md)
- [Skills](https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/skills.md)
- [Prime Agent packages](https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/packages.md)
- [Providers](https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/providers.md)
- [Development](https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/development.md)
- [Root development rules](https://github.com/PrimeIntellect-ai/prime-agent/blob/main/AGENTS.md)
- [Changelog](https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/CHANGELOG.md)
- [MIT License](https://github.com/PrimeIntellect-ai/prime-agent/blob/main/LICENSE)
- [Official install script](https://app.primeintellect.ai/prime-agent/install.sh)

