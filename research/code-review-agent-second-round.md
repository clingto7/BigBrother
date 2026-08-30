# Code-review agent 第二轮调查

调查截止：2026-08-28  
范围：持续跟踪仓库、Pi、Prime Agent、Matt Pocock skills、沙箱、通知与初步分层架构。  
证据规则：关键事实只采用官方文档、官方 API、官方仓库源码/README 或正式规范；“事实”“未发现”“推断/建议”明确分开。

## 0. 先给结论

### 事实

1. “长期运行”与“长期监视仓库”是两个不同职责。Pi 和 Prime 都可以被外部程序唤起；Prime 还提供 daemon-backed session、schedule、heartbeat、goal 和 autonomous continuation。但仓库变更的可靠检测仍应由控制面或机械检查器负责。
2. Pi 是较小的 coding harness，提供 SDK、print/JSON/RPC 等 headless 入口、扩展、skills、context files 与 session persistence。[Pi SDK](https://pi.dev/docs/latest/sdk)、[Pi RPC](https://pi.dev/docs/latest/rpc)、[Pi extensions](https://pi.dev/docs/latest/extensions)、[Pi skills](https://pi.dev/docs/latest/skills)
3. Prime Agent 是建立在 Pi 之上的、带持久 Python REPL、RLM 子 agent、daemon/worker、可持续 harness 状态和长任务能力的 agent runtime。[Prime Agent README](https://github.com/PrimeIntellect-ai/prime-agent)、[Prime architecture](https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/architecture.md)
4. Prime 的 worker/kernel 进程隔离是生命周期与故障隔离，不是安全沙箱；其官方文档明确说模型生成的 Python、bash、skills、extensions 以 worker 的操作系统权限运行，应在外部受限环境中运行不可信代码。[Prime RLM runtime / Trust Boundary](https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/rlm-runtime.md)
5. Docker Sandboxes 的隔离边界是每个 agent 一个 microVM，另有网络、独立 Docker Engine、workspace 和 credential proxy 层；默认 direct mount 仍是读写工作区，`--clone` 才是私有 clone + 主机工作区只读。[Docker Sandboxes](https://docs.docker.com/ai/sandboxes/)、[Docker security model](https://docs.docker.com/ai/sandboxes/security/)、[Docker isolation](https://docs.docker.com/ai/sandboxes/security/isolation/)
6. Matt Pocock skills 当前仓库的安装定位是：Claude Code 使用官方 marketplace 插件；Codex 和其他 agent 使用 skills.sh 将可编辑的 skill 文件复制到项目。当前仓库不是一个已经面向 Pi/Prime 的原生插件。[Matt skills README](https://github.com/mattpocock/skills)、本地项目快照：`/Users/m1zu/ws/matt-skills/README.md`、`/Users/m1zu/ws/matt-skills/.agents/install-block.md`

### 推断/建议

建议把产品定义为：

> 一个由机械控制面可靠发现仓库 revision、为每个 revision 创建隔离 review job、调用可替换 agent runtime 做一次或一组审查、再由 publisher 幂等发布结果的服务。

首选架构是“外部控制面 + Pi runner + 可插拔 Prime runner”，而不是让一个长期驻留的 Prime session 自己 polling。Pi 更适合作为 MVP 的一次性 review 执行器；Prime 适合需要持久上下文、RLM 分解、多轮质量门和长任务连续性的第二阶段。两者都必须放在外部沙箱内。

---

## A. 用户需求边界：仓库跟踪应属于机械控制面

### A.1 推荐生命周期

```text
机械检查器 / webhook receiver
        │ 发现 (provider, repo, ref, head_sha)
        ▼
控制面：去重、游标、租约、队列、重试、状态机
        │ 创建 review job
        ▼
workspace manager：隔离 clone / checkout / diff snapshot
        │ 固定 base_sha 与 head_sha
        ▼
agent runner：Pi 或 Prime，执行一次 review
        │ 结构化 review result
        ▼
publisher：Feishu/WeCom/Bark/ntfy/RSS 等，带 outbox 与幂等
```

### A.2 GitHub

#### 事实

- GitHub push webhook 能告诉接收方 ref、before/after SHA、提交列表等；GitHub 要求 receiver 在 10 秒内返回 2xx，官方建议异步放入队列。[Webhook best practices](https://docs.github.com/en/webhooks/using-webhooks/best-practices-for-using-webhooks)、[Webhook events and payloads](https://docs.github.com/en/webhooks/webhook-events-and-payloads#push)
- 每次 delivery 有 `X-GitHub-Delivery`，GitHub 明确建议用它识别唯一 delivery；redelivery 使用原来的 delivery ID。GitHub 的 delivery 可能乱序。[Webhook best practices](https://docs.github.com/en/webhooks/using-webhooks/best-practices-for-using-webhooks)、[Troubleshooting webhooks](https://docs.github.com/en/enterprise-server@3.22/webhooks/testing-and-troubleshooting-webhooks/troubleshooting-webhooks)
- GitHub 不会自动重新投递失败 delivery；官方建议定期检查失败 delivery 并主动 redeliver。可通过 API redeliver 最近三天的 delivery。[Handling failed deliveries](https://docs.github.com/en/webhooks/using-webhooks/handling-failed-webhook-deliveries)、[Redelivering webhooks](https://docs.github.com/en/webhooks/testing-and-troubleshooting-webhooks/redelivering-webhooks)
- REST Commits API 可取 commit message、作者/提交者、父 commit、verification 等；Compare API 可比较两个 ref/SHA，返回 commits 和 changed files，语义相当于 `git log BASE..HEAD`。[REST commits](https://docs.github.com/en/rest/commits/commits)
- Pull Requests API 有 PR commits、files、reviews、review comments 等接口；PR 的“当前审查”与单独 commit 的审查不是同一数据面。[REST pull requests](https://docs.github.com/en/rest/pulls)

#### 推断/设计含义

- webhook payload 只作为“有候选 revision”的低延迟提示；真正 review 输入应重新通过 API/Git 获取并固定 `base_sha/head_sha`，防止 payload 丢失、乱序或 push 合并。
- GitHub MVP 可只监听 push，配置一个按仓库安装的 GitHub App，读取 metadata、contents、commits、pull requests 所需的最小权限；reviewer 先不写 PR、不 approve、不 merge。
- `job_key = provider + repository_id + ref + head_sha + policy_revision`。同一 SHA 可以因 policy 版本变化重新审查，但相同 key 不应重复生成通知。

### A.3 GitLab

#### 事实

- GitLab 项目 webhook 支持 Push Hook、Merge Request Hook 等事件；receiver 应快速、稳定，否则可能被自动禁用。[Project webhooks](https://docs.gitlab.com/user/project/integrations/webhooks/)、[Webhook events](https://docs.gitlab.com/user/project/integrations/webhook_events/)
- GitLab webhook 提供 `webhook-id`，在重试中保持一致；同时有遗留的 `Idempotency-Key`。可配置 `webhook-signature`（HMAC-SHA256）及 timestamp。[Webhook delivery headers](https://docs.gitlab.com/user/project/integrations/webhooks/#delivery-headers)
- Merge Request API 可以取 MR 信息、commit message，并通过 `/projects/:id/merge_requests/:merge_request_iid/diffs` 或 `raw_diffs` 取 diff；文档明确 diff 有 limits，可能 collapsed/too_large。[Merge requests API](https://docs.gitlab.com/api/merge_requests/)
- GitLab 的 MR diff version 是“每次 push 一个版本”，不是每个 commit 一个版本；默认比较 source branch 最新 push 与 target branch 最新 commit。[Merge request diff versions](https://docs.gitlab.com/user/project/merge_requests/versions/)

#### 推断/设计含义

- GitLab 适合把 push 事件归并成“当前 branch head” review job；如果用户需要逐 commit 审查，应从 commit API/仓库历史补齐，而不能把 MR diff version 当成 commit 粒度。
- `webhook-id` 应进入事件去重表；MR diff 被 API 限制时应退回到受控 clone + Git diff，结果中标注输入来源与是否完整。

### A.4 Bitbucket Cloud

#### 事实

- Bitbucket Cloud webhook 以 HTTP POST 通知订阅事件；Repository 的 `repo:push` 是正式事件，另外有 pullrequest 相关事件。[Webhook module](https://developer.atlassian.com/cloud/bitbucket/modules/webhook/)、[Webhook REST API / hook events](https://developer.atlassian.com/cloud/bitbucket/rest/api-group-webhooks/)
- Atlassian 的 Cloud REST API 文档提供 pull request、commit、diff 等资源接口；webhook 只是通知，不应视为完整变更数据源。[Bitbucket Cloud REST API](https://developer.atlassian.com/cloud/bitbucket/rest/)
- Bitbucket webhook infrastructure 在 2026 年仍有 IP 范围与基础设施变更公告，防火墙 allowlist 不能写死旧范围。[Bitbucket webhook infrastructure update](https://developer.atlassian.com/cloud/bitbucket/bitbucket-webhooks-update/)

#### 未发现/推断

- 在本轮检查的官方资料中，没有找到像 GitHub `X-GitHub-Delivery` 或 GitLab `webhook-id` 那样清楚、稳定的跨重试唯一 ID 规范，也没有找到可直接据此承诺“平台自动重试语义”的统一说明。不要臆造 Bitbucket 的 exactly-once 或 retry contract；应以本地事件 fingerprint、周期性 reconciliation 和 provider adapter 兜底。
- Bitbucket adapter 需要单独验证：事件 header/payload、分页、diff 限制、权限和失败投递行为。它可以作为 provider interface 的第三实现，但不应阻塞 GitHub MVP。

### A.5 机械检查器与一致性状态机

这是基于上述官方接口事实的架构推断：

```text
observed ──> queued ──> workspace_ready ──> reviewing ──> reviewed
    │            │             │               │             │
    └─> ignored  └─> retry     └─> retry        └─> failed    └─> publish_pending ──> published
```

必须有：

- 每个 provider/repository/ref 的 durable cursor；轮询只向前推进 cursor，不依赖 agent 自己记忆“上次看到哪里”。
- event dedupe（delivery ID 或 fingerprint）、job dedupe（head SHA + policy revision）、队列 lease、指数退避、最大重试次数和 dead-letter queue。
- revision 单调性：旧 SHA 的完成结果不能覆盖新 SHA；若 branch force-push，应把它作为新拓扑处理，而不是简单比较时间。
- reconcile 任务：即使 webhook 正常，也定期从 provider API 查询当前 branch head；它是 webhook 丢失、乱序、服务宕机后的最终一致性补偿。
- notification outbox：review result 持久化成功后才入发布队列；发布重试必须使用同一 notification key，避免同一 commit 重复刷屏。

---

## B. Pi：定位与适配边界

### 事实

- Pi 官方将 SDK 定位为以编程方式嵌入 agent、构建自动化 workflow 和自定义 UI；`createAgentSession()` 可接收 cwd、model、resource loader 和 session manager。[Pi SDK](https://pi.dev/docs/latest/sdk)
- Pi RPC 是通过 stdin/stdout 的 JSONL 协议驱动 headless coding agent；支持 `prompt`、状态/命令查询、session 目录等。官方建议 Node/TypeScript 集成优先直接使用 `AgentSession`，而不是一定 spawn 子进程。[Pi RPC](https://pi.dev/docs/latest/rpc)
- Pi 支持 interactive TUI、print、JSON、RPC 和 SDK 等运行方式；RPC/SDK 适合控制面“每个 job 调一次”。[Pi usage](https://pi.dev/docs/latest/usage)、[Pi SDK](https://pi.dev/docs/latest/sdk)
- Pi extension 是 TypeScript 模块，可注册 custom tools、commands、事件处理器、系统提示附加内容和 session 持久状态；资源发现事件可以追加 skill/prompt/theme 路径。[Pi extensions](https://pi.dev/docs/latest/extensions)
- Pi 实现 Agent Skills 标准：skill 是带 `SKILL.md` 的目录；用户级和项目级路径可被发现，skill 描述先进入上下文，完整文件按需加载。[Pi skills](https://pi.dev/docs/latest/skills)
- Pi 支持 context files（包括 AGENTS.md 等）以及可持久 JSONL session；SDK 的 `ResourceLoader` 可以供应 context files、skills、extensions 和 prompt templates，`SessionManager` 可选择内存或持久会话。[Pi SDK](https://pi.dev/docs/latest/sdk)、[Pi sessions](https://pi.dev/docs/latest/sessions)

### 能否由外部控制器触发一次 review

#### 事实

可以。官方 RPC 协议能从外部进程发送一个 prompt；SDK 能在宿主程序内创建 session 并调用 `session.prompt()`。两种方式都能把 cwd 指到固定的 review workspace，并通过显式 resource loader 注入 policy、context 与 skills。[Pi RPC](https://pi.dev/docs/latest/rpc)、[Pi SDK](https://pi.dev/docs/latest/sdk)

#### 推断/建议

- Pi MVP runner 应做到“一 job 一 session 或一 job 一 branch”，输入显式包含 `repo/ref/base_sha/head_sha`、diff 摘要、policy revision、输出 schema 和只读/可执行权限。
- 对批量后台任务，SDK 比 spawn CLI 更容易控制超时、事件、输出和资源加载；对进程隔离更看重时，用 RPC 子进程并由 runner 负责 kill/timeout。
- Pi 的优势是边界清楚、可组合、接入成本较低；它本身不提供 provider webhook、任务队列、通知 outbox 或仓库 reconciliation，这些应留在控制面。

---

## C. Prime Agent：定位、能力与长期 review 适配性

### C.1 官方定位

#### 事实

- Prime README 将其描述为用于 coding workflow 和 long-running autonomous tasks 的 self-improving RLM agent；其核心是把 prompt/context 作为变量、把递归子 agent 当作可编程调用，并通过 Continual Harness 持久化 prompts、memories、skills 与 subagent specifications。[Prime Agent README](https://github.com/PrimeIntellect-ai/prime-agent)
- Prime 明确说明其 agent/TUI 构建在 Pi 之上，并将 Pi 列为 acknowledgements/dependency 方向。[Prime Agent README](https://github.com/PrimeIntellect-ai/prime-agent)

### C.2 daemon、worker、kernel、persistence

#### 事实

- Prime 的 architecture 把 client、supervisor、session worker、AgentSessionRuntime、root session、IPython kernel、子 session 和 storage 分开；client 断开不等于 worker 停止。[Prime architecture](https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/architecture.md)
- daemon-backed worker 负责 root session、scheduler、kernel 和 descendants；transcript 以 JSONL 持久化，session artifacts 可在重启后恢复。[Long-running agents](https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/long-running-agents.md)
- RLM runtime 的 harness state 保存 prompt notes、memories、可复用 skill descriptions、sub-agent specifications 和 refinement events；它不是第二个 execution engine。[RLM runtime](https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/rlm-runtime.md)

### C.3 RLM、subagents、skills、schedule、heartbeat、goal、autonomous

#### 事实

- Prime 的 RLM 可从持久 IPython 中 programmatically spawn child agents；skills 可是普通 Agent Skills markdown，也可以是安装到持久 kernel 的 Python-backed package。[RLM runtime](https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/rlm-runtime.md)、[Prime skills](https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/skills.md)
- Prime 提供三种相关调度面：用户 `/heartbeat`、agent 管理的 `rlm_heartbeat`、以及用户或 automation 使用的 `prime-agent schedule`；schedule 可以是一次性或 cron，文档说 due tick 会先 claim，遗漏 tick 会 coalesce 而非无限堆积。[Long-running agents](https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/long-running-agents.md)
- `/goal` 是可持久目标，记录 token、elapsed time、continuation count；`/autonomous` 是有 continuation/turn/token/wall-clock 限制并可执行 quality gate 的宿主策略。[Long-running agents](https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/long-running-agents.md)
- Prime 有 JSON/RPC headless 入口；RPC 以 stdin/stdout JSONL 传 commands、responses、events，且可用 `prompt` 触发 agent。官方 RPC 文档还说明 schedule/heartbeat 会把 invocation-local RPC session 提升为 resident daemon session。[Prime RPC](https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/rpc.md)

### C.4 是否适合长期 code review runtime

#### 推断

适合，但定位应是“长期 review 工作执行 runtime”，不是“仓库监视器”。

适合的部分：

- 对一个仓库或项目持续积累 review context、policy notes、review heuristics 和子 agent spec；
- 对一次大 diff 做 RLM 分解，例如 standards/spec/security/test 四个独立 reviewer，再由父 session 聚合；
- 在 agent 需要跨多个轮次读取、实验、复核和自我压缩时，用 persistent kernel 和 session artifacts 保留进展；
- 通过 RPC/CLI 被外部控制器唤起，或由控制器向 resident session 发送一条已固定 revision 的 review prompt。

不应承担的部分：

- 不应因 Prime 的 heartbeat/schedule 就让 agent 自己轮询 Git provider；那会把可靠事件摄取、凭据、去重和业务状态混进模型可变行为。
- 不应把 Prime daemon 当成高可用队列。官方文档描述了本机 daemon/worker 的生命周期恢复，但没有因此证明它替代数据库、任务队列、跨节点调度或通知 outbox。
- 不应把 autonomous/goal 的“达到限制”解释为 review 成功；官方明确 quality gate 只检查 gate 验证的内容，达到 limit 不代表任务成功。[Prime README](https://github.com/PrimeIntellect-ai/prime-agent)、[Long-running agents](https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/long-running-agents.md)

### C.5 安全与 managed-runtime 边界

#### 事实

- Prime 官方明确警告：worker/kernel 进程隔离是 lifecycle isolation，不是 security sandbox；模型生成 Python 和 bash 使用 worker OS 权限，已安装的 Python packages、skills、extensions 是 trusted code。[Prime RLM runtime](https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/rlm-runtime.md)、[Prime daemon](https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/daemon.md)
- 官方文档建议对 untrusted workspace 或 generated code 使用 external sandbox/restricted execution environment。[Prime RLM runtime](https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/rlm-runtime.md)
- 本轮检查到的 Prime 官方入口主要是本机 CLI、resident daemon 和 stdin/stdout RPC；没有找到一个可直接当成多租户、远程、认证 API 的官方 managed-runtime 契约。

#### 推断

Prime 不是自身安全边界。若 review 的仓库、commit message、文档、skill 或 extension 可能被不可信作者影响，控制面必须把 Prime 放在外部 sandbox 内；同时应把“来自仓库的 instruction”当作待审文本，而不是自动获得控制面权限的系统政策。

---

## D. Matt Pocock skills：什么才叫“原生支持”

### D.1 事实：当前仓库的安装与运行模型

- Matt 仓库 README 说明：Claude Code 走官方 marketplace 的 managed read-only plugin；Codex/其他 agent 走 `npx skills@latest add mattpocock/skills`，把所选 skill 文件复制到项目；两条路线不应同时安装。[Matt skills README](https://github.com/mattpocock/skills)、本地：`/Users/m1zu/ws/matt-skills/README.md`、`/Users/m1zu/ws/matt-skills/.agents/install-block.md`
- skills 的最小单元是 `SKILL.md`，并通过 frontmatter 的 name/description 等信息被 harness 发现；Matt 仓库还按 user-invoked 与 model-invoked 区分可由谁调用。本地：`/Users/m1zu/ws/matt-skills/.agents/invocation.md`
- `setup-matt-pocock-skills` 是一次性、用户触发的 repo setup；它会记录 issue tracker、triage labels、domain doc layout 到 `docs/agents/`，并在已有 `CLAUDE.md` 或 `AGENTS.md` 中写指针。本地：`/Users/m1zu/ws/matt-skills/skills/engineering/setup-matt-pocock-skills/SKILL.md`、`/Users/m1zu/ws/matt-skills/docs/engineering/setup-matt-pocock-skills.md`
- `code-review` skill 的具体契约是：用户提供 fixed point；执行 `git diff <fixed-point>...HEAD`；识别 spec 与 standards；Standards 和 Spec 两条轴分别由并行 sub-agent 审查；缺失 `docs/agents/issue-tracker.md` 时先要求 setup。本地：`/Users/m1zu/ws/matt-skills/skills/engineering/code-review/SKILL.md`
- 该 skill 不是简单的“读 diff 并给意见”：它假设 harness 能做 sub-agent delegation，并且可以读取项目文档、issue tracker 和 spec 来源。本地：`/Users/m1zu/ws/matt-skills/skills/engineering/code-review/SKILL.md`

### D.2 三种支持级别

这是基于上述事实的产品定义建议：

| 级别 | 含义 | 对本项目的建议 |
|---|---|---|
| 直接加载 | runner 直接按 Agent Skills 规则发现并按原文加载 Matt 的 `SKILL.md`，不复制改写；项目 context files 也按既定路径进入资源加载器 | Pi/Prime 兼容的理想目标，但须先做 harness 行为验证 |
| 适配器 | 保留原始 skill 内容，增加 runtime adapter，将 `/code-review`、sub-agent、issue tracker、session 与输出协议映射到 Pi/Prime | MVP 最现实；适配器应可审计、版本化 |
| policy/context 化 | 把 Matt skill 提炼成不可变 review policy，和仓库 `CONTEXT.md`、ADR、CONTRIBUTING 等作为不同信任级别的 context 输入 | 对无人值守最安全，但不是“原生加载”；适合控制面做 policy pinning |

推荐称谓：

> “原生 Agent Skills 加载 + runtime adapter + pinned project policy”，不要简单宣称“原生支持 Matt skills”。

### D.3 Pi/Prime 兼容边界

#### 事实

- Pi 官方支持 Agent Skills、context files、extensions 和 SDK resource loader，因而具备直接加载 `SKILL.md` 和项目 context 的基础。[Pi skills](https://pi.dev/docs/latest/skills)、[Pi SDK](https://pi.dev/docs/latest/sdk)
- Prime 官方也支持 Agent Skills standard、`.agents/skills` 项目/全局发现，以及 Python-backed skills；但其 skill 还可以拥有持久 kernel 可执行包，安全等级比纯 Markdown 更高风险。[Prime skills](https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/skills.md)
- Matt skills 当前发行入口明确以 Claude plugin 和 skills.sh 为主，README 还写明 native Codex plugin “on the roadmap”；未声明 Pi 或 Prime 为专门的一等发行目标。本地：`/Users/m1zu/ws/matt-skills/README.md`、`/Users/m1zu/ws/matt-skills/.agents/install-block.md`

#### 推断

- Pi：可直接加载 markdown skill 和 context，但 `code-review` 的并行 sub-agent、Skill tool 调用语义、issue tracker 操作和交互式“询问 fixed point”需要 adapter；无人值守场景应在 runner 预先填充 fixed point，禁止 agent 自行扩大范围。
- Prime：Agent Skills 加载更接近“直接支持”，且内置 RLM/subagents 适合 `code-review` 的两轴/多 reviewer 结构；但应把 Matt markdown skill 与 Python-backed executable skill 分开审查和签名，默认不允许仓库提供的 skill 自动获得高权限。
- Matt 的项目文档应分层：`CONTEXT.md`/ADR/CONTRIBUTING 等是 canonical project context 候选；当前 policy snapshot、review schema、允许的 ref/branch 和安全规则属于控制面 immutable policy，不能被仓库 commit 单方面覆盖。

---

## E. 沙箱：生命周期、代码执行、网络/凭据不是一回事

| 层 | 官方事实 | 对本项目含义 |
|---|---|---|
| Docker Engine container | Docker 支持 capability、resource limit、rootless；默认 container 仍与 host 共享 kernel，错误 mounts/capabilities 会减弱隔离。[Docker Engine security](https://docs.docker.com/engine/security/)、[Rootless](https://docs.docker.com/engine/security/rootless/) | 可作为基础隔离，但需非 root、只读/临时工作区、drop capabilities、CPU/memory/pid/time 限制、明确 egress |
| Docker Sandboxes | 每个 agent 在 microVM；独立 kernel、网络、Docker Engine；`--clone` 提供私有 clone；credential proxy 让凭据不进入 VM。[Docker security model](https://docs.docker.com/ai/sandboxes/security/)、[Isolation](https://docs.docker.com/ai/sandboxes/security/isolation/) | 更接近不可信仓库 review 的目标边界；注意默认 direct mount 仍允许 agent 改主机工作区，且本地 stdio MCP 在 host 上运行 |
| Anthropic sandbox-runtime | `srt` 是 OS-level sandbox，macOS 使用 sandbox-exec、Linux 使用 bubblewrap，并通过 proxy 做 network filtering；可配置 denyRead/allowWrite/denyWrite/allowedDomains。[sandbox-runtime README](https://github.com/anthropic-experimental/sandbox-runtime) | 适合包装 Pi/Prime 子进程；是 agent/command 的执行约束，不是仓库协调器或持久 job 队列 |
| Prime daemon/worker | 官方明确仅做 lifecycle/failure containment，不是 security sandbox；同一 OS user 权限。[Prime daemon](https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/daemon.md) | Prime 必须被 Docker/microVM/srt 等外部边界包住 |

### 推荐的信任边界（推断）

1. 控制面 host/service：保存 provider token、队列、cursor、job 状态、notification outbox；不把这些写进仓库 workspace。
2. workspace manager：按 job 创建 disposable clone，固定 commit SHA；默认 agent 只读分析，若需运行测试则在更窄的执行 sandbox 内进行。
3. agent runtime sandbox：Pi/Prime、Git、语言工具、测试进程和仓库均在 VM/container 内；默认 deny write outside workspace/temp，deny access to host SSH/config/secrets，egress 只允许 provider、model API、publisher 的必要域名。
4. publisher boundary：通知 token 与 review 内容分开处理；不要因为 agent 能读仓库就让它直接拿到 Feishu/WeCom/Bark/ntfy secret。由 publisher 读取结构化结果并发送。

注意：只读 review 仍可能执行仓库脚本、解析恶意文档或安装依赖。将“只不写代码”误当成“安全”是不成立的架构推断。

---

## F. 通知通道：单向推送、交互 bot、push、pull feed

| 通道 | 官方能力事实 | 形态与限制 | review 通知优先级 |
|---|---|---|---|
| 企业微信（WeCom）群机器人 | 官方文档的 webhook endpoint 是 `https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=...`，支持 text/markdown 等消息，并警告必须保护 webhook；官方资料列出单机器人 20 条/分钟限制。[企业微信开发者文档](https://developer.work.weixin.qq.com/document/path/91770) | 单向向群推送；webhook 泄露即具备发消息能力；不要把它当个人双向 bot | 团队内网首选之一；需要个人定向/交互时升级为企业应用 API |
| 飞书自定义机器人 | 飞书官方 Developer Guides 提供 custom bot usage guide；自定义机器人以 `open.feishu.cn/open-apis/bot/v2/hook/...` webhook 向群发消息。[飞书 custom bot guide](https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot) | 低成本单向群推送；签名/关键词等安全配置应按官方文档启用；交互式卡片/回调不是单纯 webhook 的同一能力 | 团队通知首选；支持链接到 commit/完整 review 页面 |
| Bark | Bark 官方仓库/文档支持通过 GET/POST（包括 JSON）向 device key 推送 title/subtitle/body/url 等。[Bark tutorial](https://github.com/Finb/Bark/blob/master/docs/en-us/tutorial.md)、[Bark server API](https://github.com/Finb/bark-server/blob/master/docs/API_V2.md) | 面向 iOS 设备的个人 push；key 要保密；不是讨论线程，也不提供项目级协作状态 | 个人紧急/高优先级提醒首选 |
| ntfy | 官方支持 HTTP PUT/POST 发布到 topic；topic 可订阅 JSON/SSE/WebSocket，也可 `poll=1` + `since=` 拉取缓存；可用 basic auth。[ntfy publish](https://docs.ntfy.sh/publish/)、[ntfy subscribe API](https://docs.ntfy.sh/subscribe/api/) | 既可 push 又可 pull；公开 server 上不可猜 topic 名相当于弱 secret，应启用 auth 或自建 server；有 replay/带宽限制 | 个人与自动化都适合；可为每个仓库/分支建 topic，并让控制面记录 message ID |
| RSS 2.0 | RSS 是 XML web syndication format；channel/item 有正式结构。[RSS 2.0 specification](https://www.rssboard.org/rss-specification) | pull feed，不负责即时 push、ack 或可靠送达；客户端自行轮询，需稳定 GUID/pubDate/link 和 feed retention | 作为审计/历史 feed，优先级低于 push；不能单独承担紧急提醒 |

### 推断/建议

- 第一阶段实现 publisher interface：`publish(notification_key, structured_review_summary, links)`，而不是让 agent 直接调用多个 webhook。
- 默认启用：Feishu 或企业微信（二选一团队通道）+ Bark/ntfy（个人通道）+ RSS（可选审计 feed）。
- 通知至少包含：provider/repository、branch/ref、head SHA、作者/committer、commit subject/body 摘要、变更范围、review policy revision、Standards/Spec 结论、严重级别、review URL、是否因 diff 太大/测试未执行而降级。
- 内容应分级：即时消息发摘要和链接；完整 diff/模型长分析放受控存储或 provider review 页面，避免把代码和秘密贴进群聊。
- publisher 需处理 429、超时、非 2xx、大小限制和重复发布；只有持久化 ack 后才把通道状态标记为 published。对于 RSS，使用稳定 `<guid>` = notification key。

---

## G. 现阶段架构判断

### G.1 推荐分层

1. **Control plane**：用户配置仓库、provider、branch/ref、policy revision、通知目标、沙箱 profile；维护 job state/cursor/lease/retry/DLQ/outbox。
2. **Mechanical checker**：优先 webhook receiver，辅以 cron reconciliation；只做签名验证、事件归一化、API 查询、head SHA 发现和 enqueue，不调用 LLM。
3. **Workspace manager**：创建隔离 clone，fetch/checkout 固定 SHA，计算 base/head diff，收集 commit metadata，拒绝秘密文件和越界路径；向 runner 交付不可变 workspace manifest。
4. **Agent runner**：Pi 或 Prime 的一次 review invocation；限制时间/token/子 agent 数；只能读取 manifest 指定的 revision 和 policy/context；输出版本化 JSON review result。
5. **Publisher**：读取持久 review result，渲染各通道摘要，幂等发送，记录每个 channel ack、失败原因和重试次数。
6. **Review policy/context registry**：保存 Matt skill 版本、项目 canonical docs 的 commit SHA、控制面规则和适配器版本；区分 trusted policy 与 repository-provided instructions。

### G.2 Pi、Prime、混合方案

#### 推荐：Pi-first，Prime-ready

- **MVP runner：Pi SDK 或 RPC。** 外部控制器固定 revision 后触发单次审查；显式加载 Matt skills/context；输出结构化结果。理由是 Pi 官方 SDK/RPC 已直接覆盖嵌入式自动化场景，且没有把 agent 自身的长期调度误当成仓库监控。[Pi SDK](https://pi.dev/docs/latest/sdk)、[Pi RPC](https://pi.dev/docs/latest/rpc)
- **第二阶段 runner：Prime。** 当一个 review 需要跨 commit 记忆、RLM 多 reviewer、持续质量门、长时间测试或 resume 时启用 Prime；仍由控制面决定何时触发、何时结束、哪个 SHA 可审查。[Prime long-running agents](https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/long-running-agents.md)
- **接口稳定在 runner contract，而非 runtime。** `ReviewJob -> ReviewResult` 的输入输出、超时、权限、artifact 和 retry 语义统一；Pi 与 Prime 只是实现。

#### 何时直接选 Prime

如果首要目标不是“每个 commit 快速提醒”，而是“一个项目级 reviewer 长期积累 context，定期进行多角度深审，并允许人类随时 attach/inspect”，Prime 更有吸引力。但这会同时引入 persistent kernel、trusted executable skills、daemon 状态恢复和更复杂的安全运营；这些不是免费能力。

#### 不建议的方案

让 Prime heartbeat 每 5 分钟执行 `git pull`、让 agent 自己决定 branch/commit、让 agent 直接持有所有通知 webhook/token。这会把平台可靠性、凭据保护、重复事件和审计问题转移到模型行为，且不能提供 exactly-once 或最终一致性保证。

### G.3 第一版合理边界

- 只支持 GitHub App + 一个或少量仓库；先监听 push，定期 reconciliation。
- 只审查用户配置的 branch；按 head SHA 归并，不自动审查所有 refs。
- 只读 clone；允许有限静态分析/测试，但不允许 push、approve、merge、修改仓库或执行外部副作用。
- Matt 支持先做 markdown skill direct-load + adapter；policy revision 固定到 job，不随 agent session 自行改变。
- 通知先选一个团队 webhook（飞书或企业微信）和一个个人 push（ntfy 或 Bark）；RSS 作为可选历史出口。
- 每次通知链接到完整 review artifact，而不是在即时消息中发送完整 diff。

---

## H. 需要下一轮澄清的问题

### 仓库语义

1. “有 commit 就审查”是逐 commit、每次 push 的最终 head，还是 branch 当前 head 的 debounce 后审查？
2. merge commit、force-push、rebase、tag、删除 branch、批量 push 如何处理？
3. 审查目标是 commit diff、branch diff、PR/MR diff，还是三者都支持？PR/MR 是否需要把 review 写回 provider？
4. 首个 provider 是否明确为 GitHub？是否允许私有 GitLab/Bitbucket Server，而非只支持 Cloud/SaaS？

### policy/context

5. 哪些文件是项目 canonical：Matt setup 生成的 `docs/agents/*`、`CONTEXT.md`、ADR、CLAUDE/AGENTS、CONTRIBUTING、CODEOWNERS、CI config，还是由用户显式 allowlist？
6. 仓库里的 instruction 能否改变 review policy，还是只能作为被审查对象？项目文档变更本身是否触发一次 policy-review？
7. Matt skill 需要保持上游原文可升级，还是允许 fork/patch；是否要把上游 skill commit pin 到每个 job？
8. 缺少 spec 时是否只做 Standards 轴，还是允许从长期 context 推断 Spec 轴，并在通知中明确“推断”？

### 执行与安全

9. 是否允许运行测试、编译、安装依赖、联网访问 package registry？允许哪些域名和最长 CPU/内存/磁盘？
10. 代码是否可能包含商业机密、个人数据、恶意构建脚本或 prompt injection？这决定 Docker container、Docker Sandboxes microVM 或更强隔离的选择。
11. model provider 是哪一个，是否要求完全自托管/不出网？review transcript、diff、通知正文保留多久？
12. Prime 的 persistent session 是按仓库、按 branch、按项目，还是按每次 job；允许的最大 retained context 和成本是多少？

### 通知与运营

13. 用户真正使用的是企业微信还是微信个人号；是否需要个人定向、回复/确认、静默窗口、@成员和升级策略？
14. “commit message 格式正确”由什么规范定义：Conventional Commits、项目自定义正则、Matt skill、还是仓库中的文档？
15. review 失败、沙箱拒绝、token 过期、diff 太大、通知失败是否都要通知？是否需要每日汇总、重复告警抑制和人工 rerun？
16. 控制面部署在哪里，是否有数据库/队列/对象存储/secret manager；是否需要多租户和权限审计？

## 参考资料索引

- Pi：<https://pi.dev/docs/latest/sdk>、<https://pi.dev/docs/latest/rpc>、<https://pi.dev/docs/latest/extensions>、<https://pi.dev/docs/latest/skills>、<https://pi.dev/docs/latest/sessions>
- Prime：<https://github.com/PrimeIntellect-ai/prime-agent>、<https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/architecture.md>、<https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/daemon.md>、<https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/long-running-agents.md>、<https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/rpc.md>、<https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/rlm-runtime.md>、<https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/skills.md>
- GitHub：<https://docs.github.com/en/webhooks/using-webhooks/best-practices-for-using-webhooks>、<https://docs.github.com/en/webhooks/using-webhooks/handling-failed-webhook-deliveries>、<https://docs.github.com/en/rest/commits/commits>、<https://docs.github.com/en/rest/pulls>
- GitLab：<https://docs.gitlab.com/user/project/integrations/webhooks/>、<https://docs.gitlab.com/user/project/integrations/webhook_events/>、<https://docs.gitlab.com/api/merge_requests/>、<https://docs.gitlab.com/user/project/merge_requests/versions/>
- Bitbucket：<https://developer.atlassian.com/cloud/bitbucket/modules/webhook/>、<https://developer.atlassian.com/cloud/bitbucket/rest/api-group-webhooks/>、<https://developer.atlassian.com/cloud/bitbucket/rest/>
- Matt Pocock skills：<https://github.com/mattpocock/skills>；本地官方仓库快照：`/Users/m1zu/ws/matt-skills/`
- 沙箱：<https://docs.docker.com/ai/sandboxes/>、<https://docs.docker.com/ai/sandboxes/security/>、<https://docs.docker.com/engine/security/>、<https://github.com/anthropic-experimental/sandbox-runtime>
- 通知：<https://developer.work.weixin.qq.com/document/path/91770>、<https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot>、<https://github.com/Finb/Bark/blob/master/docs/en-us/tutorial.md>、<https://docs.ntfy.sh/publish/>、<https://docs.ntfy.sh/subscribe/api/>、<https://www.rssboard.org/rss-specification>
