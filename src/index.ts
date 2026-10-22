/**
 * Git worktree status line（实时版）。
 *
 * 在内置 footer 的扩展状态区追加一行自给自足的实时状态：
 *   ~/path ⎇ main ✓                  clean
 *   ~/path ⎇ main ✗ ↑1↓2 +3 ~2 ?1    dirty + ahead/behind + staged/modified/untracked
 *   ~/path                            非 git 目录
 *
 * 为什么自带路径和分支：内置 footer 的 cwd/branch 是 session 级的（启动时定格，
 * 安装版分支刷新也不可靠）；本行全部由实时 git status -b 推导，不依赖内置值。
 *
 * 实际工作目录追踪：
 *   pi 的 session cwd 不随 bash cd 变化（每条命令独立 shell）。本扩展通过
 *   tool_call 事件解析 bash 命令中的最后一个 `cd <字面路径>`，把 agent 实际
 *   工作目录（含 worktree）维护在 trackedCwd。无法静态解析的 cd（无参 /
 *   cd - / 环境变量路径）保持当前值。
 *   解析目标先做 ~ 展开（path.resolve 不识别 ~，会把 "~/x" 当相对目录名拼接，
 *   曾导致 trackedCwd 层层污染、footer 路径无限增长），且只跟踪 existsSync
 *   为真的目录（与 shell 行为一致，mkdir && cd 同命令等场景宁可保持旧值）。
 *
 * 刷新时机：
 *   - session_start：无条件作为当前 session 的追踪起点（重置 + 重建轮询 + 刷新）
 *   - tool_result(bash)：每条 bash 命令后刷新（会话中的 git 操作立即反映）
 *   - turn_start / agent_end：按 session 身份兜底对齐，再刷新
 *   - fs.watchFile 轮询（1s）：HEAD / index mtime 变化 → 刷新，覆盖外部终端的
 *     切分支 / commit。不用 fs.watch：安装版 pi 是 Bun 编译，kqueue 实现对
 *     同目录多 watcher 的事件投递不可靠（实测内置分支显示与扩展 watcher 同时失灵）。
 *
 * session 绑定（2026-10-05 事故修复）：trackedCwd 的归属边界是 sessionId，不是 cwd。
 * fork/import 出的 session 可与父会话 cwd 相同，按 cwd diff 判断「换没换 session」会
 * 漏判，导致 trackedCwd 残留上一个 session 的 cd 轨迹。sessionId 每次
 * bindExtensions 必然变化，才是可靠边界。
 *
 * worktree：findGitDir 解析 .git 文件指向的 worktrees/<name>/ 目录，轮询与
 * status 执行都在该目录，分支与状态即 worktree 的。
 */

import { execFile } from "node:child_process";
import { existsSync, readFileSync, statSync, unwatchFile, watchFile } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const POLL_INTERVAL_MS = 1000;

interface GitStatusInfo {
	clean: boolean;
	branch: string | null;
	detached: boolean;
	ahead: number;
	behind: number;
	staged: number;
	modified: number;
	untracked: number;
}

/** Walk up from cwd to find the real gitDir (handles worktrees where .git is a file). */
function findGitDir(cwd: string): string | null {
	let dir = cwd;
	for (;;) {
		const gitPath = join(dir, ".git");
		try {
			const stat = statSync(gitPath);
			if (stat.isFile()) {
				const content = readFileSync(gitPath, "utf8").trim();
				if (!content.startsWith("gitdir: ")) return null;
				const gitDir = resolve(dir, content.slice(8).trim());
				return existsSync(join(gitDir, "HEAD")) ? gitDir : null;
			}
			if (stat.isDirectory()) {
				return existsSync(join(gitPath, "HEAD")) ? gitPath : null;
			}
		} catch {
			// no .git here, keep walking up
		}
		const parent = dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

/** Resolve the shared git dir (worktree gitDir points at the main repo via commondir). */
function commonGitDir(gitDir: string): string {
	const commondirPath = join(gitDir, "commondir");
	if (existsSync(commondirPath)) {
		try {
			return resolve(gitDir, readFileSync(commondirPath, "utf8").trim());
		} catch {
			// fall through
		}
	}
	return gitDir;
}

function parseStatus(output: string): GitStatusInfo {
	let branch: string | null = null;
	let detached = false;
	let ahead = 0;
	let behind = 0;
	let staged = 0;
	let modified = 0;
	let untracked = 0;

	const lines = output.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (i === 0 && line.startsWith("## ")) {
			const head = line.slice(3);
			if (head.startsWith("HEAD (no branch)")) {
				detached = true;
			} else if (head.startsWith("No commits yet on ")) {
				branch = head.slice("No commits yet on ".length);
			} else {
				const dot = head.indexOf("...");
				branch = dot > 0 ? head.slice(0, dot) : head || null;
			}
			const bracket = line.match(/\[([^[\]]*)\]/);
			if (bracket) {
				for (const part of bracket[1].split(",")) {
					const [key, value] = part.trim().split(" ");
					const n = Number(value);
					if (key === "ahead" && Number.isFinite(n)) ahead = n;
					else if (key === "behind" && Number.isFinite(n)) behind = n;
				}
			}
			continue;
		}
		if (line.length < 2) continue;
		if (line.startsWith("??")) {
			untracked++;
			continue;
		}
		if (line[0] !== " ") staged++;
		if (line[1] !== " ") modified++;
	}

	return {
		clean: staged + modified + untracked === 0,
		branch,
		detached,
		ahead,
		behind,
		staged,
		modified,
		untracked,
	};
}

/** 非 git 目录的占位状态：render 按 !branch && !detached 只显示路径 */
const NOT_A_REPO: GitStatusInfo = {
	clean: true,
	branch: null,
	detached: false,
	ahead: 0,
	behind: 0,
	staged: 0,
	modified: 0,
	untracked: 0,
};

function collectStatus(cwd: string): Promise<GitStatusInfo | null> {
	return new Promise((resolvePromise) => {
		execFile(
			"git",
			["--no-optional-locks", "status", "--porcelain=v1", "-b"],
			{ cwd, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 },
			(error, stdout, stderr) => {
				if (!error) {
					resolvePromise(parseStatus(stdout));
					return;
				}
				// 非 git 目录（git 退出 128 + "not a git repository"）：按设计显示纯路径，
				// 其余错误（目录不存在 ENOENT、git 未安装等）返回 null 隐藏整行
				if (error.code === 128 && /not a git repository/i.test(String(stderr))) {
					resolvePromise(NOT_A_REPO);
					return;
				}
				resolvePromise(null);
			},
		);
	});
}

/**
 * 提取命令串中最后一个 cd 的目标（字面路径）。
 * 无法静态解析的形式（无参 cd、cd -、$VAR、反引号）返回 null 维持现状。
 */
function extractCdTarget(command: string): string | null {
	const re = /\bcd\s+(?:"([^"]+)"|'([^']+)'|([^;&|\s]+))/g;
	let last: string | null = null;
	for (const m of command.matchAll(re)) {
		const target = m[1] ?? m[2] ?? m[3];
		if (target && target !== "-" && !target.includes("$")) last = target;
	}
	return last;
}

/**
 * 展开 shell 风格的 ~ 前缀。path.resolve 不识别 ~，会把 "~/x" 当成相对目录名
 * 拼到当前路径后面（pi 核心工具走的 resolvePath 有 expandTilde，这里自己解析必须补上）。
 * 只处理 ~ 与 ~/ 两种形式（~user 极罕见，不处理，交给 existsSync 防护兜底）。
 */
function expandTilde(target: string): string {
	const home = process.env.HOME || process.env.USERPROFILE;
	if (!home) return target;
	if (target === "~") return home;
	if (target.startsWith(`~${sep}`)) return join(home, target.slice(2));
	return target;
}

function formatCwdLabel(cwd: string): string {
	const home = process.env.HOME || process.env.USERPROFILE;
	if (!home) return cwd;
	return cwd === home ? "~" : cwd.startsWith(`${home}${sep}`) ? `~${cwd.slice(home.length)}` : cwd;
}

/**
 * session 身份锚点：cwd 不足以识别 session。
 *
 * fork/import 出来的 session 可与父会话 cwd 完全相同（`SessionManager.forkFrom` 把源
 * 条目灌进 targetCwd 的新 session，cwd == 父会话），此时按 cwd diff 判断「换没换
 * session」会永远返回未变，trackedCwd 残留上一个 session 的 bash cd 轨迹，footer
 * 显示别人的路径与分支（2026-10-05 事故：/resume 到同 cwd 的 session 后 footer 不跟随）。
 * sessionId 每次 bindExtensions 必然变化，才是可靠的 session 边界。
 *
 * session_start 每次 AgentSession.bindExtensions 都会 emit（startup / reload / new /
 * resume / fork 全走这条路），且早于任何 turn_start，因此初始化只放在这里。
 */
function sessionKey(ctx: ExtensionContext): string {
	return ctx.sessionManager.getSessionId();
}

export default function (pi: ExtensionAPI) {
	let savedCtx: ExtensionContext | null = null;
	// 已应用追踪状态的 session 身份。用于识别「同一 session 内的 cwd 变化」与「换了 session」。
	let appliedSessionKey: string | null = null;
	let sessionCwd: string | null = null; // pi 的 session cwd（启动/ resume 时确定）
	let trackedCwd: string | null = null; // bash cd 追踪出的实际工作目录
	let pollTargets: Array<{
		path: string;
		listener: (curr: { mtimeMs: number; size: number }, prev: { mtimeMs: number; size: number }) => void;
	}> = [];
	let inFlight = false;
	let pending = false;

	function clearPollers(): void {
		for (const t of pollTargets) unwatchFile(t.path, t.listener);
		pollTargets = [];
	}

	function setupPollers(gitDir: string): void {
		clearPollers();
		// HEAD：分支切换；index：git add/reset/commit 等。worktree 的两个文件都在其 gitDir 下。
		// reftable 仓库切分支更新 <commonGitDir>/reftable/tables.list，一并轮询。
		const paths = [join(gitDir, "HEAD"), join(gitDir, "index")];
		const tablesList = join(commonGitDir(gitDir), "reftable", "tables.list");
		if (existsSync(tablesList)) paths.push(tablesList);
		for (const path of paths) {
			const listener = (curr: { mtimeMs: number; size: number }, prev: { mtimeMs: number; size: number }): void => {
				if (curr.mtimeMs !== prev.mtimeMs || curr.size !== prev.size) void refresh();
			};
			try {
				watchFile(path, { interval: POLL_INTERVAL_MS }, listener);
				pollTargets.push({ path, listener });
			} catch {
				// 轮询不可用时退化为仅事件兜底刷新
			}
		}
	}

	/** trackedCwd 变化后重建：gitDir 解析 + 轮询目标 + 立即刷新 */
	async function rebuildTracking(): Promise<void> {
		if (!trackedCwd) return;
		const gitDir = findGitDir(trackedCwd);
		if (gitDir) {
			setupPollers(gitDir);
		} else {
			clearPollers();
		}
		await refresh();
	}

	function render(info: GitStatusInfo, cwd: string): string | undefined {
		if (!savedCtx?.hasUI) return undefined;
		const theme = savedCtx.ui.theme;
		const parts: string[] = [theme.fg("dim", formatCwdLabel(cwd))];
		if (!info.branch && !info.detached) return parts.join(" ");
		parts.push(theme.fg("accent", info.detached ? "⎇ detached" : `⎇ ${info.branch}`));
		if (info.clean) {
			parts.push(theme.fg("success", "✓"));
		} else {
			parts.push(theme.fg("warning", "✗"));
		}
		if (info.ahead) parts.push(theme.fg("accent", `↑${info.ahead}`));
		if (info.behind) parts.push(theme.fg("accent", `↓${info.behind}`));
		if (info.staged) parts.push(theme.fg("success", `+${info.staged}`));
		if (info.modified) parts.push(theme.fg("warning", `~${info.modified}`));
		if (info.untracked) parts.push(theme.fg("dim", `?${info.untracked}`));
		return parts.join(" ");
	}

	async function refresh(): Promise<void> {
		if (!savedCtx?.hasUI || !trackedCwd) return;
		if (inFlight) {
			pending = true;
			return;
		}
		inFlight = true;
		try {
			const cwd = trackedCwd;
			const info = await collectStatus(cwd);
			if (!savedCtx.hasUI || trackedCwd !== cwd) return; // 追踪目录已变，丢弃过期结果
			savedCtx.ui.setStatus("git-status", info ? render(info, cwd) : undefined);
		} finally {
			inFlight = false;
			if (pending) {
				pending = false;
				void refresh();
			}
		}
	}

	/** 同步 session cwd；同一 session 内 cwd 真变时重置 bash cd 追踪 */
	function syncSessionCwd(ctx: ExtensionContext): boolean {
		savedCtx = ctx;

		// 换了 session（含 cwd 恰好相同的 fork/import）：无条件回到该 session 的根 cwd，
		// 丢弃上一个 session 的 cd 轨迹。这一条即修复本体。
		const key = sessionKey(ctx);
		if (key !== appliedSessionKey) {
			appliedSessionKey = key;
			sessionCwd = ctx.cwd;
			trackedCwd = ctx.cwd;
			void rebuildTracking();
			return true;
		}

		// 同一 session 内 cwd 变化（pi 侧暂无此路径；保留兜底，成本一次字符串比较）
		if (ctx.cwd !== sessionCwd) {
			sessionCwd = ctx.cwd;
			trackedCwd = ctx.cwd;
			void rebuildTracking();
			return true;
		}

		return false;
	}

	pi.on("session_start", async (_event, ctx) => {
		// 无条件作为当前 session 的追踪起点：重置 tracker、重建轮询、立即刷新。
		// 不先调 syncSessionCwd——它靠 diff 判断是否变化，而这次的 ctx.cwd 恰好等于
		// appliedSessionKey 对应值时不做任何事，session_start 的语义就丢了。
		savedCtx = ctx;
		appliedSessionKey = sessionKey(ctx);
		sessionCwd = ctx.cwd;
		trackedCwd = ctx.cwd;
		await rebuildTracking();
	});

	// 解析 bash 命令中的 cd，追踪 agent 实际工作目录
	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "bash") return;
		savedCtx = ctx;
		const command = (event.input as { command?: unknown }).command;
		if (typeof command !== "string") return;
		const target = extractCdTarget(command);
		if (!target || !trackedCwd) return;
		const next = resolve(trackedCwd, expandTilde(target));
		// 只跟踪真实存在的目录：与 shell 行为一致（cd 对不存在目录不生效），
		// 防止 mkdir -p && cd 同命令等静态解析不准的场景污染 trackedCwd
		if (next !== trackedCwd && existsSync(next)) {
			trackedCwd = next;
			await rebuildTracking();
		}
	});

	// 每条 bash 命令后刷新（agent 的 git add/commit/checkout 立即反映）
	pi.on("tool_result", async (event, ctx) => {
		if (event.toolName !== "bash") return;
		savedCtx = ctx;
		await refresh();
	});

	pi.on("turn_start", async (_event, ctx) => {
		// 兜底：session_start 之外的路径换了 session（防御性，正常不会到达）
		syncSessionCwd(ctx);
		await refresh();
	});

	pi.on("agent_end", async (_event, ctx) => {
		syncSessionCwd(ctx);
		await refresh();
	});

	pi.on("session_shutdown", async () => {
		clearPollers();
	});
}
