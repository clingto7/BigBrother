# Big Brother 操作手册（MVP）

本文说明如何配置并运行当前 GitHub-only、commit-oriented 的只读审查版本。

## 当前能力边界

当前版本可以：

- 监控一个或多个 GitHub 仓库，以及每个仓库的多个 branch；
- 发现 branch cursor 之后的每一个 commit；
- 在固定 commit workspace 中检查 commit message、message template、项目策略和 diff；
- 使用一个长期运行的 Prime session 保存仓库级上下文；
- 保存每个已完成 Review record，并将 Prime 批准的 actionable finding 映射到 watched Repository 的 Review finding issue；
- 为每个 commit 发布一个 advisory GitHub Commit Status；
- 在进程重启后从 SQLite state 继续处理未完成 job。

当前版本不会：

- 修改仓库、branch、commit 或 Pull Request 内容；
- 阻止 merge；
- 运行项目代码、测试、构建、脚本或安装依赖；
- 发送 WeChat、Feishu、Bark、ntfy 或 RSS 通知；
- 启用 Prime 原生 RLM/Pi worker。静态 profile 当前使用 `--no-tools`，RLM 要等受限执行环境确定后再开启。

## 1. 前置条件

需要：

- Node.js `>=22.8.0`；
- `git`；
- 一个可访问目标仓库的 GitHub credential；
- 一个可交互运行 Prime 的终端，用于首次 `/login` 和 `/model` 配置。

## 0. 安装命令行入口

按 [README](../README.md) 下载并校验 Release archive，运行其中的
`scripts/install.sh`。脚本把 CLI 链接到 `$HOME/.local/bin/big-brother`；将
`$HOME/.local/bin` 加入 `PATH`，然后运行 `big-brother --version`。开发 checkout
也可直接运行 `sh scripts/install.sh`。

安装 Tab 补全：

```sh
# zsh
mkdir -p "$HOME/.zsh/completions"
big-brother completion zsh > "$HOME/.zsh/completions/_big-brother"
fpath=("$HOME/.zsh/completions" $fpath)
autoload -Uz compinit && compinit

# bash：当前 shell 立即生效；需要持久化时写入 ~/.bashrc
source <(big-brother completion bash)

# fish：当前 shell 立即生效
big-brother completion fish | source
```

之后输入 `big-brother <Tab>`、`big-brother review --<Tab>` 或
`big-brother watch --config <Tab>` 即可看到命令、参数和文件路径提示。

仓库源代码读取和发布使用不同的 credential 引用。发布 credential 同时用于 advisory Commit Status 和 Prime 明确批准的 Review finding issues，因此 fine-grained PAT 需要目标仓库的 `Commit statuses: write` 与 `Issues: write`。后续如果切换回 Check Run，才需要 GitHub App 等 Checks 写入能力。详见 [Create a commit status](https://docs.github.com/en/rest/commits/statuses) 与 [Create an issue](https://docs.github.com/en/rest/issues/issues#create-an-issue)。

Prime runtime 已随项目放在 `runtime/`，不需要先重新构建 Prime。可以先确认：

```sh
./bin/big-brother --version
```

## 2. 创建配置

复制示例：

```sh
mkdir -p "$HOME/.config/big-brother"
cp "$HOME/.local/share/big-brother/releases/big-brother-0.1.0-beta.1/config/big-brother.example.json" \
  "$HOME/.config/big-brother/config.json"
```

配置保存在 release 目录之外。最小配置形状如下：

```json
{
  "pollIntervalMs": 60000,
  "repositories": [
    {
      "repositoryId": "owner/repository",
      "cloneUrl": "git@github.com:owner/repository.git",
      "trackedBranches": ["main"],
      "stateNamespace": "/home/USER/.local/state/big-brother/owner-repository",
      "publishFindingIssues": true,
      "reviewFindingIssueLabels": ["big-brother"],
      "credentials": {
        "githubReadTokenEnv": "GITHUB_TOKEN",
        "githubStatusTokenEnv": "GITHUB_STATUS_TOKEN",
        "gitSshKeyPathEnv": "GITHUB_SSH_KEY_PATH"
      }
    }
  ]
}
```

要点：

- `repositoryId` 必须是 `owner/name`；
- `trackedBranches` 是显式列表，可以列出多个 branch；
- 新增到配置的 branch 第一次看到时只建立当前 head 作为 baseline，不自动回溯历史；
- 同一个 commit 从多个 tracked branch 到达时只审查一次；
- `stateNamespace` 必须对运行进程可读写，SQLite、session 和 workspace 都放在其下；
- `publishFindingIssues` 默认 `true`；设为 `false` 时暂停 GitHub Issue 创建、更新、关闭和待处理请求的重试，但把 Prime 批准的请求保留在 SQLite，重新启用后补发；Commit Status 不受影响；
- `reviewFindingIssueLabels` 是发布到 watched Repository 的 Review finding issue 标签；可以省略或设为空数组；空数组不会关闭 Issue 发布；
- credential 字段写的是环境变量名，不是 token、私钥内容或 API key；
- `cloneUrl` 使用 SSH 时，`gitSshKeyPathEnv` 指向私钥文件路径。CLI 会以 `GIT_SSH_COMMAND` 的方式显式使用它；也可以让运行进程使用已配置的 ssh-agent。
- 配置文件不包含 provider、model 或模型 API key；这些属于 Prime agent 的运行时身份配置。

校验配置：

```sh
big-brother config validate --config "$HOME/.config/big-brother/config.json"
```

## 3. 配置 GitHub credential

以示例配置为例，运行进程需要看到：

```sh
export GITHUB_TOKEN='...'
export GITHUB_STATUS_TOKEN='...'
export GITHUB_SSH_KEY_PATH="$HOME/.ssh/id_ed25519"
```

CLI 每次启动时会自动读取 `~/.config/big-brother/env`（也可以用
`BIG_BROTHER_ENV_FILE` 指定其他路径）。文件只支持简单的 `NAME=value` 或
`export NAME=value` 赋值，不会执行其中的 shell 命令；已经在进程环境中的同名
变量优先。可以把上面的三行放入该文件，并将权限设为 `600`；也可以继续在
启动 watcher 前手动 `source` 它。

`githubReadTokenEnv` 是 GitHub API 读取 branch head/commit range 的 token；公开仓库在功能上可以省略，但未认证 API 配额会按出口 IP 共享（通常每小时 60 次），长期 watcher 或共享出口环境仍应配置只读 token，避免其他用户耗尽配额。它与发布 credential 分开，通常只需目标仓库的 `Contents: read` 和默认的 `Metadata: read`。`githubStatusTokenEnv` 是现有发布 credential：它用于在目标 commit 上创建 advisory Commit Status，启用 `publishFindingIssues` 时也用于在 watched Repository 创建 Prime 批准的 Review finding issue，因此需要 `Commit statuses: write`，启用 Issue 发布时还需要 `Issues: write`。它不需要 `Contents: write`，也不应拥有修改仓库内容的权限。

如果未来需要发布带丰富输出和 annotations 的 Check Run，再配置 GitHub App 的 `Checks: write`；GitHub 的 Checks 总览和具体 endpoint 对 PAT 支持存在不一致，当前 MVP 暂不依赖这条路径。

`gitSshKeyPathEnv` 不是 API token，而是本机私钥文件的路径。私有仓库使用 SSH clone 时才需要它；对应的公钥需要添加到 GitHub 用户 SSH keys 或目标仓库 deploy keys。公钥上传到 GitHub，私钥只留在运行 Big Brother 的机器上。

获取 read PAT 的路径是 GitHub 头像 → Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token；选择目标仓库，在 Repository permissions 中只授予读取所需权限（通常是 `Contents: read`，并保留默认的 `Metadata: read`），生成后只复制一次并作为 `GITHUB_TOKEN` 注入。GitHub 官方建议 fine-grained token 只选择必要仓库和最小权限，详见 [管理 personal access token](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens)。

获取 SSH key 的最小步骤是：

```sh
ssh-keygen -t ed25519 -f "$HOME/.ssh/big-brother-github" -C "big-brother-github"
```

把生成的 `.pub` 文件添加到 GitHub 用户的 SSH keys，或添加为目标仓库的 read-only deploy key，然后设置 `GITHUB_SSH_KEY_PATH` 为不带 `.pub` 的私钥路径。GitHub 的官方 SSH key 流程见[这里](https://docs.github.com/en/authentication/connecting-to-github-with-ssh/adding-a-new-ssh-key-to-your-github-account)。

不要把这些值写入仓库、配置 JSON、`.agents` 或 skill 目录。长期运行时应通过 launchd、systemd、容器 secret 或其他 secret manager 注入，而不是把 token 写进启动脚本。

如果运行机器访问 Prime 或 GitHub 需要 HTTP 代理，也要让 watcher 进程继承代理设置。将 `NODE_USE_ENV_PROXY=1` 与相应的 `HTTPS_PROXY`/`HTTP_PROXY` 放进上述 env 文件；Big Brother launcher 会在 Node 启动时安全加载该文件，使 Node 的原生代理支持及时生效（仅在启动后读取变量太晚）。该能力需要 Node.js `24.0.0+` 或 `22.21.0+`；`NO_PROXY` 可配置直连域名。代理必须是部署者授权且稳定的网络出口。

首次排查建议确认 Git 本身能访问仓库：

```sh
git ls-remote git@github.com:owner/repository.git
```

## 4. 配置 Prime 模型

Big Brother 本身是一个独立的 Prime-derived agent；模型 provider、模型选择和
OAuth/API key 由 Prime 自己保存，不由 Big Brother 的 repository config 管理。
启动交互式 agent（部署时建议显式指定持久化身份目录）：

```sh
BIG_BROTHER_CODING_AGENT_DIR="$HOME/.local/share/big-brother/agent" big-brother agent
```

在 Prime 界面中执行：

```text
/login
/model
```

`/login` 会按 Prime 支持的方式完成 provider 登录或 API key 配置，`/model`
用于选择模型。认证信息会保存到 `.big-brother/agent/`（或
`BIG_BROTHER_CODING_AGENT_DIR` 指定的目录）；watch/review 启动的 Prime RPC
worker 会复用这套身份目录。不要在 `config/big-brother.json` 中添加
`provider`、`model` 或 API key。

注意：`bin/big-brother` 会在启动 CLI 前为该变量设置安装目录内的默认值，
因此服务管理器应直接设置 `BIG_BROTHER_CODING_AGENT_DIR`（systemd 使用
`Environment=BIG_BROTHER_CODING_AGENT_DIR=/absolute/path`），而不是只把它写进
`BIG_BROTHER_ENV_FILE`；已存在的进程环境变量优先于 env 文件。

## 5. 先做一次单 commit 审查

```sh
big-brother review \
  --config "$HOME/.config/big-brother/config.json" \
  --repo owner/repository \
  --commit <40-character-commit-sha>
```

该命令会：

1. 读取配置仓库的第一个 tracked branch；
2. 建立 branch baseline；
3. 将指定 commit 建立为 review job；
4. 固定 workspace 到该 commit；
5. 启动对应仓库的 Prime session；
6. 发布该 commit 的 Big Brother Commit Status；仅当 Prime 输出 actionable `finding_issue_intents` 时，创建或复用对应的 Review finding issue。

Issue 发布失败不会把已完成的 review 改成失败；watch 输出会报告明确错误，
SQLite 会保留待重试请求。下一轮 cycle 会先用 stable finding identity
对 GitHub Issues 做 reconciliation，再决定是否创建或更新，避免不确定请求产生重复 issue。
同一 stable finding 的新证据会更新原 issue；后续 review 不会自动关闭它。
只有 Prime 明确输出 `{"finding_id":"...","action":"resolve"}` 时才会关闭，
之后再次输出 active finding intent 会重新打开同一个 issue。`runRepositoryCycle`
的结果会分别暴露已完成 review、待处理 publication 和失败 publication。

它不会 push，也不会改写仓库。首次使用时建议选择一个已经存在的 commit SHA，并检查 GitHub 上是否出现 `big-brother/review` status。

## 6. 持续监控

先用一次循环验证：

```sh
big-brother watch \
  --config "$HOME/.config/big-brother/config.json" \
  --once
```

然后长期运行：

```sh
big-brother watch --config "$HOME/.config/big-brother/config.json"
```

也可以临时覆盖轮询间隔：

```sh
big-brother watch \
  --config "$HOME/.config/big-brother/config.json" \
  --interval-ms 30000
```

首次 watch 只建立当前 branch head baseline，所以不会因为启动服务而自动审查整个历史。之后 branch 出现新 commit，poller 会沿 commit range 逐个建立 job。

失败的 Review job 保留在 SQLite；watch 不会在下一轮立即重试。每次失败后的等待从 5 分钟起倍增，最长 6 小时，重启后仍生效；成功后清零。主动停止导致的取消不增加等待。`big-brother review --repo ... --commit ...` 是显式单次重试，可立即运行。旧数据库中的失败 job 升级后会先重试一次，再开始退避。
每轮日志的 `review-deferred` 表示当前因退避尚未重试的 job 数量；它不计入本轮的 `failed`。

按 `Ctrl-C` 或发送 `SIGTERM` 停止。重新启动时复用相同 `stateNamespace`，SQLite cursor 和未完成 job 会继续生效；不要为了“重置”而删除 state 目录，除非确认要丢弃审查进度。

每轮 watch 输出中的 `processed` 表示完成的 Review；`publication-retried`、
`publication-pending` 和 `publication-failed` 分别表示 Review finding issue
发布的恢复次数、待处理数量和失败数量。Review 已完成并不等于 GitHub
Issue 发布一定成功：Issues 权限或网络故障只会留下可重试的 publication work，
下一轮或重启后的第一轮会先按 stable finding identity reconciliation，再继续创建、更新、关闭或重新打开同一个 issue。`big-brother/review`
Commit Status 仍会独立发布。

### 分离的监视服务器与被监视仓库

Big Brother 不要求和目标仓库放在同一台机器。长期服务器只需要 Node.js、Git、
Big Brother 安装目录、Prime 身份目录、运行配置/状态，以及访问 GitHub API、
目标仓库 clone URL 和所选 Prime provider 的出站网络。目标仓库代码由 Big Brother
按 commit SHA 拉取到自己的 state/workspace 目录；开发者可以从另一台机器正常
push，watcher 下轮轮询就会发现该 commit。

在长期运行的 Linux 用户账户中，先安装 Node.js `>=22.8.0`、Git 和 npm，并确认服务
账户对 GitHub、Prime provider 均有出站访问。按 README 下载、校验、安装 Release
archive。脚本将 CLI 链接到用户级 `$HOME/.local/bin`，并安装 Prime bundle 的两个
外置依赖；不会创建凭据、登录模型或启用服务。服务定义应使用
`$HOME/.local/bin/big-brother` 的绝对路径，以便升级和回退后自动指向当前版本。

随仓库分发的 Prime `runtime/dist` 已构建，但 CLI 仍有两个外置 npm runtime
依赖（`undici` 和 `@silvia-odwyer/photon-node`）。不要直接在 `runtime/` 执行
`npm install`：该目录继承的源 workspace manifest 含未发布的 `@earendil-works/*`
内部包版本。安装脚本会将外置依赖单独装到服务用户目录，再链接到 runtime；
以下命令仅供手工排障：

```sh
runtime_deps="$HOME/.local/share/big-brother/runtime-deps/0.1.0-beta.1"
mkdir -p "$runtime_deps"
npm install --prefix "$runtime_deps" --no-save --no-package-lock --omit=dev \
  "undici@7.29.0" "@silvia-odwyer/photon-node@0.3.4"
mkdir -p runtime/node_modules/@silvia-odwyer
ln -s "$runtime_deps/node_modules/undici" runtime/node_modules/undici
ln -s "$runtime_deps/node_modules/@silvia-odwyer/photon-node" \
  runtime/node_modules/@silvia-odwyer/photon-node
```

每个版本有独立的外置依赖目录；升级和回退后验证 `big-brother --version`
及 `big-brother agent` 可启动。

按前文配置 GitHub read/status credential 和 Prime `/login`、`/model`。推荐将
`BIG_BROTHER_CODING_AGENT_DIR` 固定到服务账户家目录下的专用持久目录，并确保
只有服务账户可读；不要把交互登录后的 agent 目录放在临时 home 或仓库里。
之后为每个目标仓库创建配置，`stateNamespace` 用服务账户可写的绝对路径，
例如 `/home/bb/.local/state/big-brother/yadig`。这里不需要预先 clone yadig：
Big Brother 会自行按 SHA 创建 review workspace。目标是私有仓库时，仍需单独
配置可用的 GitHub read credential 和 clone 身份（SSH deploy key 或已验证的
Git credential helper）。

配置完成先执行：

```sh
big-brother config validate --config /absolute/path/to/big-brother.json
git ls-remote <configured-clone-url>
big-brother watch --config /absolute/path/to/big-brother.json --once
```

`--once` 首次只建立 branch baseline。确认日志正常后，再按上面的 systemd user
unit 流程启用长期 watcher。若 `watch` 账户退出后服务要继续运行，管理员需为该
账户启用 systemd lingering；检查 `systemctl --user status big-brother-watch` 和
`journalctl --user -u big-brother-watch`。更新版本时先停止 unit，安装并校验
新 archive，重新运行对应安装脚本，再启动 unit；SQLite state 与 agent 身份目录
不要随版本更新删除。

### 真实推送验收

端到端验收不需要把开发机上的工作仓库迁到服务器：先让服务器 watcher 对专用
测试 branch 建立 baseline，再从开发机的干净 clone/worktree 推送一个新 commit。
验证 watcher 发现的 SHA 与本机 push 的 SHA 相同、该 SHA 获得
`big-brother/review` Commit Status，并核对对应 Review 结果/Review finding issue。
验收时使用一次性 `bb-smoke/<日期>` branch，不要在 `main` 上制造测试提交；
不要对用户已有的脏工作树做 checkout、reset 或清理。测试 branch 的保留/删除应
在验收后明确决定。

服务器无法访问 GitHub 或 Prime provider 时，先修复服务器的持久出站网络/代理配置，
并让 systemd 服务显式继承对应代理变量；不要依赖开发机临时 SSH tunnel 作为长期
监视服务的网络路径。验证网络时不要输出或记录 credential 值。

### Development issue 与 Review finding issue

Big Brother 自己的 GitHub 仓库使用 Development issue 记录功能、缺陷和运维工作；本 issue
就是这一类 Development issue。Big Brother 不会把 watched Repository 的审查发现写回这里。

watched Repository 中的 Review finding issue 则是由 Repository Prime 明确批准的、带证据的
审查后续事项。它使用 watched Repository 的 GitHub Issues、Big Brother 的发布标签和 stable
finding identity；clean review、被 Prime 拒绝的 worker assertion 和 non-actionable observation
不会创建 issue。后续 commit 也不会自动关闭 issue，只有 Prime 明确发出 resolve intent 才会关闭。

长期部署时，`watch` 保持为前台进程，由主机服务管理器负责拉起、重启和日志管理。CLI 已提供 macOS `launchd` 与 Linux `systemd` 服务定义渲染；不要让服务文件自行复制轮询逻辑，也不要把 token 写进服务文件。

### 使用平台服务管理器

当前 CLI 已经可以渲染服务定义。它只输出文件，不会自动安装、启动或停止服务；路径必须使用绝对路径。

macOS `launchd`（当前用户的 LaunchAgent）：

```sh
mkdir -p "$HOME/Library/LaunchAgents"
big-brother service render launchd \
  --config "$HOME/.config/big-brother/config.json" \
  --executable "$HOME/.local/bin/big-brother" \
  --working-directory "$HOME" \
  --env-file "$HOME/.config/big-brother/env" \
  > "$HOME/Library/LaunchAgents/com.big-brother.watch.plist"
plutil -lint "$HOME/Library/LaunchAgents/com.big-brother.watch.plist"
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.big-brother.watch.plist"
```

Linux `systemd`（当前用户的 user unit）：

```sh
mkdir -p "$HOME/.config/systemd/user"
big-brother service render systemd \
  --config "$HOME/.config/big-brother/config.json" \
  --executable "$HOME/.local/bin/big-brother" \
  --working-directory "$HOME" \
  --env-file "$HOME/.config/big-brother/env" \
  > "$HOME/.config/systemd/user/big-brother-watch.service"
systemctl --user daemon-reload
systemctl --user enable --now big-brother-watch.service
```

服务管理器负责重启异常退出的前台进程；`SIGTERM` 会交给 Big Brother 处理。要让 VPS 在用户退出后继续运行，还需要按发行版配置 user service 的 lingering。服务定义不会读取或嵌入 token，token 仍由 `BIG_BROTHER_ENV_FILE` 指向的受保护文件提供。

## 7. 常见问题

### 配置有效，但 watch 没有审查任何 commit

这通常是正常的 baseline 行为。查看 branch 当前 head 后，创建并 push 一个新 commit，再运行 `watch --once`。

### GitHub API 能读，但 clone 失败

REST token 不会自动变成 Git credential。检查 `cloneUrl`、SSH key/ssh-agent，或主机上的 Git credential helper。私有仓库尤其要单独验证 `git ls-remote`。

### Commit Status 发布失败

确认 status token 针对目标仓库授权，并具备 `Commit statuses: write`；当前实现会发布 `big-brother/review` 这个固定 context，不会修改源代码。

### Prime 启动失败或没有结果

先运行 `big-brother agent`，确认 `/login` 和 `/model` 已成功；再确认长期运行的 watch 进程使用同一个 `BIG_BROTHER_CODING_AGENT_DIR`。Prime RPC 输出不会把错误伪装成 clean review，失败 job 会保留为 `failed`。

### 想运行测试或安装依赖

当前 MVP 明确不做这些事情。需要先新增受限 execution profile（推荐 OCI/只读 workspace），不能只通过 prompt 要求模型“不要执行”。

## 8. Prime 兼容入口

当前 `bin/big-brother` 是一个分发入口：

- `agent`、`config`、`review`、`watch`、`--help` 进入 Big Brother CLI；
- 其他参数继续进入原来的 Prime-compatible CLI。

推荐使用 Big Brother 的交互式入口完成登录：

```sh
big-brother agent
```

这不会启动仓库 watcher，也不会替代 Pi、Sifu 或 Prime 的独立入口。
