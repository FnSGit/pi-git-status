# pi-git-status

> **pi footer 实时 git 状态行扩展** — 在 pi 交互模式 footer 的扩展状态区渲染一行动态 git 状态:`~/path ⎇ main ✗ ↑4 ?2`。实时追踪 agent 实际工作目录(含 worktree)、bash `cd`、外部终端的切分支 / commit。

## 解决什么问题

pi 内置 footer 的 cwd / 分支是 **session 级**的:启动时定格,session 期间 bash 里的 `cd`、外部终端的 `git checkout` 都不会反映。本扩展用一套实时管道补上这块:

```
~/path ⎇ main ✓                  clean
~/path ⎇ main ✗ ↑1↓2 +3 ~2 ?1    dirty + ahead/behind + staged/modified/untracked
~/path                            非 git 目录(仅路径)
```

| 符号 | 含义 |
| --- | --- |
| `⎇ branch` / `⎇ detached` | 当前分支 / detached HEAD |
| `✓` / `✗` | 工作区干净 / 有未提交改动 |
| `↑n` / `↓n` | 领先 / 落后 upstream 的 commit 数 |
| `+n` / `~n` / `?n` | staged / modified / untracked 文件数 |

## 工作机制

状态全部由 `git status --porcelain=v1 -b` 实时推导,不依赖内置 footer 的缓存值。

### 实际工作目录追踪

pi 的 session cwd 不随 bash `cd` 变化(每条命令独立 shell)。本扩展监听 `tool_call` 事件,解析 bash 命令中**最后一个 `cd <字面路径>`**,维护 agent 实际工作目录(`trackedCwd`):

- 解析目标先做 `~` 展开(`path.resolve` 不识别 `~`,会把 `"~/x"` 当相对目录名拼接,导致 footer 路径无限增长)
- 只跟踪 `existsSync` 为真的目录——与 shell 行为一致,`mkdir && cd` 同命令等静态解析不准的场景宁可保持旧值
- 无法静态解析的形式(无参 `cd` / `cd -` / `$VAR` / 反引号)维持现状

### 刷新时机

| 触发 | 覆盖场景 |
| --- | --- |
| `session_start` | 启动 / reload / new / resume / fork,无条件重置追踪起点 |
| `tool_result`(bash) | 会话中的 git add / commit / checkout 立即反映 |
| `turn_start` / `agent_end` | 按 session 身份兜底对齐 |
| `fs.watchFile` 轮询(1s) | `.git/HEAD` / `index` / reftable `tables.list` 的 mtime 变化 → 覆盖外部终端的切分支 / commit |

不用 `fs.watch`:pi 安装版是 Bun 编译,kqueue 对同目录多 watcher 的事件投递不可靠(实测内置分支显示与扩展 watcher 同时失灵)。

### session 绑定

`trackedCwd` 的归属边界是 **sessionId**,不是 cwd——fork / import 出的 session 可与父会话 cwd 相同,按 cwd diff 判断「换没换 session」会漏判,导致 trackedCwd 残留上一个 session 的 `cd` 轨迹(`/resume` 到同 cwd 的 session 后 footer 显示别人的路径)。`sessionId` 每次 `bindExtensions` 必然变化,才是可靠边界。

### worktree

`findGitDir` 解析 `.git` 文件指向的 `worktrees/<name>/` 目录,轮询与 status 执行都在该目录,分支与状态即 worktree 的。

## 安装

### pi(原生扩展)

包内 `package.json` 通过 `pi.extensions` 字段自动声明扩展入口,安装后启用即生效。

**本地路径安装**(开发期,与 `teams-progress` 同款)——在 `~/.pi/agent/settings.json` 的 `packages` 数组加入:

```jsonc
{
  "packages": [
    // ...
    "../../IDE/ai-agent/ai-agent-plugin/git-status"
  ]
}
```

> 路径相对 `~/.pi/agent/`。如改放别处,相应调整。

安装后**务必**从 `~/.pi/agent/extensions/` 移除 `git-status.ts` 单文件,否则目录扫描与 package 声明两路加载重复(监听器 / 定时器 / 状态行翻倍)。

### 从 GitHub 安装

```bash
pi install git:github.com/FnSGit/pi-git-status@v0.1.0
```

或从 [Releases](https://github.com/FnSGit/pi-git-status/releases) 下载 tarball:

```bash
pi install https://github.com/FnSGit/pi-git-status/releases/download/v0.1.0/pi-git-status-0.1.0.tgz
```

## 依赖

- peerDependency:`@earendil-works/pi-coding-agent`(由宿主 pi 提供)
- 运行时依赖:`git` 命令

## License

MIT
