# Big Brother

Big Brother 按 commit 审查指定 GitHub 仓库，在 GitHub 上发布 advisory Commit Status，并为 Prime 明确批准的发现创建 Issue。它不修改被审查仓库的代码，也不阻止合并。首次启动只记录所监控分支的当前 head；之后才审查新 commit。

## 安装

需要 Node.js `>=22.8.0`、Git、npm，以及能访问 GitHub 和所选模型服务的网络。首个预发布版本的 macOS/Linux 安装命令：

```sh
version=0.1.0-beta.1
base="https://github.com/clingto7/BigBrother/releases/download/v$version"
curl -fL "$base/big-brother-$version.tar.gz" -o "big-brother-$version.tar.gz"
curl -fL "$base/big-brother-$version.tar.gz.sha256" -o "big-brother-$version.tar.gz.sha256"
if command -v shasum >/dev/null 2>&1; then shasum -a 256 -c "big-brother-$version.tar.gz.sha256"; else sha256sum -c "big-brother-$version.tar.gz.sha256"; fi
mkdir -p "$HOME/.local/share/big-brother/releases"
tar -xzf "big-brother-$version.tar.gz" -C "$HOME/.local/share/big-brother/releases"
sh "$HOME/.local/share/big-brother/releases/big-brother-$version/scripts/install.sh"
export PATH="$HOME/.local/bin:$PATH"
big-brother --help
```

安装脚本将 Prime bundle 所需的两个 npm 依赖装入该版本的用户目录，并链接 CLI；不会生成 token、登录模型或启动后台服务。升级时安装新版本的 archive 并运行其中的脚本；回退时重新运行旧版本的脚本。配置、SQLite state 和 Prime 登录目录须放在版本目录之外。开发 checkout 可直接运行 `sh scripts/install.sh`。

### 给编码 agent 的复制指令

将以下整段交给可操作本机终端的 agent，并替换仓库与分支；agent 会完成可自动化步骤，凭据由你在本机提供：

> 请在本机安装 Big Brother `v0.1.0-beta.1`，监控 `OWNER/REPO` 的 `main` 分支。先阅读 `https://github.com/clingto7/BigBrother` 的 README 和 `docs/user-guide.md`，下载对应 GitHub Release archive 与 `.sha256`，验证校验和，再解压运行 `scripts/install.sh`。按 README 在 `~/.config/big-brother/config.json` 创建配置，将 state 放在版本目录之外；检查 Node、Git、CLI、配置和目标仓库 clone 连接。说明我需要创建的 GitHub fine-grained PAT 权限；不要索取、打印、提交或在命令参数中传递 token。让我在本机受限环境文件中填写 token，并让我交互运行 `big-brother agent` 完成 `/login` 和 `/model`。得到我确认凭据和模型已配置后，先执行一次 `watch --once`；不要自行启用长期服务、推送测试提交或修改被监控仓库。

## 配置 GitHub 凭据

在 GitHub 的 **Settings → Developer settings → Personal access tokens → Fine-grained tokens** 创建 token。只选择要监控的仓库，授予下列权限：

| 用途 | 配置字段 | 环境变量示例 | 仓库权限 |
| --- | --- | --- | --- |
| 读取 branch 和 commit 范围 | `githubReadTokenEnv` | `GITHUB_TOKEN` | `Contents: read`、默认 `Metadata: read` |
| 发布 Commit Status 和发现 Issue | `githubStatusTokenEnv` | `GITHUB_STATUS_TOKEN` | `Commit statuses: write`；启用 Issue 发布时还需 `Issues: write` |
| 通过 SSH clone 私有仓库 | `gitSshKeyPathEnv` | `GITHUB_SSH_KEY_PATH` | 只读 deploy key 或已有 SSH 身份；此项是私钥**路径**，不是 token |

两个 PAT 可以合并，但分开更易限制权限。公开仓库可省略读取 token；长期运行仍建议配置，以免共享未认证 API 限额。发布 token 不需要 `Contents: write`。GitHub 权限依据：[Commit Status API](https://docs.github.com/en/rest/commits/statuses)、[Issues API](https://docs.github.com/en/rest/issues/issues)、[PAT 指南](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens)。

把 token 放入 `~/.config/big-brother/env`，权限设为 `600`，不要写入仓库、聊天或 shell 历史：

```sh
mkdir -p "$HOME/.config/big-brother"
chmod 700 "$HOME/.config/big-brother"
touch "$HOME/.config/big-brother/env"
chmod 600 "$HOME/.config/big-brother/env"
# 用本机编辑器在 env 中填写以下三行；不要把真实 token 发给 agent。
# GITHUB_TOKEN=...
# GITHUB_STATUS_TOKEN=...
# GITHUB_SSH_KEY_PATH=/absolute/path/to/read-only-key
```

`GITHUB_SSH_KEY_PATH` 仅在使用专用 SSH 私钥时需要。已有可用的 SSH agent 时可从配置中删去 `gitSshKeyPathEnv`。Git clone 使用 SSH 身份，PAT 只供 GitHub API 使用。

## 配置仓库与模型

复制示例到版本目录之外，修改仓库名、分支、clone URL 和持久状态路径：

```sh
mkdir -p "$HOME/.config/big-brother"
cp "$HOME/.local/share/big-brother/releases/big-brother-0.1.0-beta.1/config/big-brother.example.json" \
  "$HOME/.config/big-brother/config.json"
```

不要在 JSON 中写入 token。`stateNamespace` 建议使用绝对路径，如 `$HOME/.local/state/big-brother/my-repo` 展开后的路径。`reviewFindingIssueLabels` 中的标签应已存在于目标仓库；不需要标签时设为 `[]`。

### 当前配置项

| 配置 | 作用 | 默认值 |
| --- | --- | --- |
| `pollIntervalMs` | 每轮检查 GitHub 的间隔，至少 1000 毫秒；`watch --interval-ms` 可临时覆盖 | 60000 毫秒 |
| `repositories[]` | 要监控的 GitHub 仓库列表 | 必填，至少一个 |
| `repositoryId` | 每个仓库的 `owner/name` 标识 | 必填 |
| `cloneUrl` | 审查 workspace 使用的 Git clone 地址 | 必填 |
| `trackedBranches` | 明确监控的分支；新分支首次只建立基线 | 必填，至少一个 |
| `stateNamespace` | SQLite、Prime session 和 workspace 的持久目录 | 必填 |
| `publishFindingIssues` | 是否向 GitHub 写入发现 Issue；关闭期间仍保存待发布请求，重开后补发 | `true` |
| `reviewFindingIssueLabels` | 创建发现 Issue 时附加的标签；`[]` 表示无标签，**不表示关闭 Issue 发布** | `[]` |
| `credentials.githubReadTokenEnv` | GitHub 读取 token 的环境变量名 | 可省略；公开仓库可匿名读取 |
| `credentials.githubStatusTokenEnv` | Commit Status 与发现 Issue 共用的发布 token 环境变量名 | 可省略；实际发布通常需要配置 |
| `credentials.gitSshKeyPathEnv` | SSH 私钥路径的环境变量名 | 可省略，使用已有 SSH 身份 |

部署在本机还是远程服务器，由**在哪台机器运行 `big-brother watch`** 决定；同一份配置格式适用。长期运行可选 systemd 或 launchd，命令见[操作手册](docs/user-guide.md)。`watch --once` 只运行一轮；模型与登录通过 `big-brother agent` 设置，不在仓库 JSON 中配置。

`publishFindingIssues: false` 暂停新 Issue 的创建、更新、关闭及既有待处理请求的重试；审查仍记录 Prime 批准的请求，改回 `true` 后从 SQLite 补发。Commit Status 仍照常发布。当前没有关闭 Commit Status 的开关：它是首版的主要结果入口；关闭它需要先提供用户可查看、可补发的本地结果入口。不要靠删掉 token 关闭发布。

```sh
big-brother config validate --config "$HOME/.config/big-brother/config.json"
git ls-remote git@github.com:OWNER/REPO.git
BIG_BROTHER_CODING_AGENT_DIR="$HOME/.local/share/big-brother/agent" big-brother agent
```

在 agent 界面执行 `/login`、`/model`。模型凭据与 GitHub token 分开保存。长期运行时使用同一个 `BIG_BROTHER_CODING_AGENT_DIR`。

## 首次运行

```sh
BIG_BROTHER_CODING_AGENT_DIR="$HOME/.local/share/big-brother/agent" \
  big-brother watch --config "$HOME/.config/big-brother/config.json" --once
```

首次 `watch --once` 只建立分支基线。确认正常后，按[完整操作手册](docs/user-guide.md)配置 systemd 或 launchd 长期运行。要验证完整链路，基线建立后从测试分支推送新 commit，检查 `big-brother/review` Status 和可能产生的 Issue。

配置细节、代理、服务管理与故障排查见[操作手册](docs/user-guide.md)。

Big Brother 本体采用 [MIT 许可证](LICENSE)；随包 Prime 代码的声明见 [第三方许可](THIRD_PARTY_NOTICES.md)。

遇到安装或审查问题，可在 [Big Brother Issues](https://github.com/clingto7/BigBrother/issues) 提交反馈，附上版本、操作系统、复现步骤和脱敏日志；不要附 token、私钥或模型凭据。
