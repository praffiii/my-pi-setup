/**
 * Git Conventions Extension
 *
 * AI-driven git operations with big-company conventions baked in:
 * - Conventional commits (feat, fix, chore, docs, refactor, test, style, ci, perf, build)
 * - Prefixed branches (feat/, fix/, chore/, docs/, refactor/)
 * - Safe push/pull/merge with guardrails
 * - Auto-generated PRs via GitHub CLI
 * - Smart .gitignore generation
 *
 * All tools are LLM-callable — just ask the AI to commit, branch, push, etc.
 * and it will follow conventions automatically.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import * as fs from "node:fs";
import * as path from "node:path";

// ============================================================================
// Constants
// ============================================================================

const CONVENTIONAL_TYPES = [
  "feat", "fix", "chore", "docs", "refactor",
  "test", "style", "ci", "perf", "build",
] as const;
type ConventionalType = (typeof CONVENTIONAL_TYPES)[number];

const BRANCH_PREFIXES: Record<string, string> = {
  feat: "feat/",
  fix: "fix/",
  chore: "chore/",
  docs: "docs/",
  refactor: "refactor/",
};

// Words to filter out when generating commit messages
const NOISE_WORDS = new Set([
  "this", "that", "with", "from", "have", "been", "will", "when",
  "then", "also", "just", "only", "some", "more", "less", "they",
  "them", "into", "over", "under", "after", "before", "while",
  "during", "about", "would", "could", "should", "there", "their",
  "which", "other", "being", "much", "such", "many", "does",
]);

// ============================================================================
// Git Execution Helper
// ============================================================================

interface GitResult {
  stdout: string;
  stderr: string;
  code: number;
  ok: boolean;
}

async function git(pi: ExtensionAPI, args: string[], cwd?: string): Promise<GitResult> {
  const result = await pi.exec("git", args, { cwd, timeout: 30000 });
  return {
    stdout: (result.stdout ?? "").trim(),
    stderr: (result.stderr ?? "").trim(),
    code: result.code ?? 1,
    ok: result.code === 0,
  };
}

// ============================================================================
// Repo & Branch Helpers
// ============================================================================

async function ensureRepo(pi: ExtensionAPI, cwd: string): Promise<string | null> {
  const r = await git(pi, ["rev-parse", "--git-dir"], cwd);
  return r.ok ? null : "Not a git repository. Run git_init first.";
}

async function currentBranch(pi: ExtensionAPI, cwd: string): Promise<string> {
  const r = await git(pi, ["branch", "--show-current"], cwd);
  return r.ok ? r.stdout : "unknown";
}

async function hasChanges(pi: ExtensionAPI, cwd: string): Promise<boolean> {
  const r = await git(pi, ["status", "--porcelain"], cwd);
  return r.stdout.length > 0;
}

// ============================================================================
// Convention Engine — Diff Analysis
// ============================================================================

function detectType(diff: string, files: string[]): ConventionalType {
  if (files.length === 0) return "chore";

  const allTest = files.every(
    (f) =>
      f.includes(".test.") || f.includes(".spec.") ||
      f.includes("__tests__") || f.startsWith("test/") || f.startsWith("tests/"),
  );
  if (allTest) return "test";

  const allDocs = files.every(
    (f) => f.endsWith(".md") || f.endsWith(".mdx") || f.endsWith(".rst") || f.endsWith(".txt"),
  );
  if (allDocs) return "docs";

  const allCI = files.every(
    (f) =>
      f.startsWith(".github/") || f.startsWith(".gitlab/") ||
      f === "Jenkinsfile" || f.includes("ci/") || f.includes(".circleci/"),
  );
  if (allCI) return "ci";

  const configFiles = new Set([
    "package.json", "package-lock.json", "yarn.lock", "pnpm-lock.yaml",
    "tsconfig.json", ".eslintrc", ".prettierrc", "Dockerfile", "docker-compose.yml",
    "Makefile", "Cargo.toml", "Cargo.lock", "go.mod", "go.sum",
  ]);
  const allConfig = files.every((f) => configFiles.has(path.basename(f)) || f.startsWith("."));
  if (allConfig) return "chore";

  const lower = diff.toLowerCase();
  if (/(\bfix\b|\bbug\b|\bregression\b|\bhotfix\b|\bpatch\b|\bcrash\b)/.test(lower)) return "fix";
  if (/(\brefactor\b|\brewrite\b|\breorganize\b|\brename\b|\bextract\b|\bcleanup\b|\bsimplify\b)/.test(lower)) return "refactor";
  if (/(\bperformance\b|\boptimize\b|\bspeed\b|\bcache\b|\bperf\b|\bfaster\b)/.test(lower)) return "perf";
  if (/(\bformat\b|\blint\b|\bstyle\b|\bprettier\b|\beslint\b|\bindent)/.test(lower)) return "style";
  if (/(\bbuild\b|\bcompile\b|\bbundle\b|\bwebpack\b|\bvite\b|\broolup\b)/.test(lower)) return "build";

  const additions = (diff.match(/^\+/gm) || []).length;
  const deletions = (diff.match(/^-/gm) || []).length;

  if (additions > deletions * 2) return "feat";
  if (deletions > additions * 1.5) return "chore";

  return "feat";
}

function detectScope(files: string[], cwd: string): string | null {
  const dirs: string[] = [];

  for (const f of files) {
    const rel = path.relative(cwd, f);
    const parts = rel.split(path.sep);
    // Skip common wrapper dirs
    const meaningful = parts[0] === "src" || parts[0] === "lib" || parts[0] === "app"
      ? parts[1]
      : parts[0];
    if (meaningful && meaningful !== "." && !meaningful.startsWith(".")) {
      dirs.push(meaningful);
    }
  }

  if (dirs.length === 0) return null;

  const counts = new Map<string, number>();
  for (const d of dirs) counts.set(d, (counts.get(d) ?? 0) + 1);

  let best = "";
  let bestCount = 0;
  for (const [d, c] of counts) {
    if (c > bestCount) {
      bestCount = c;
      best = d;
    }
  }

  // Only apply scope when a clear majority of files are in one directory
  return bestCount >= files.length * 0.5 && best.length >= 2 ? best : null;
}

function generateMessage(type: ConventionalType, scope: string | null, diff: string, files: string[]): string {
  // Extract meaningful words from the diff content
  const words = diff
    .replace(/^[+\-]{1,3}\s*/gm, "") // strip diff markers
    .replace(/[^a-zA-Z\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 3)
    .filter((w) => !NOISE_WORDS.has(w.toLowerCase()))
    .map((w) => w.toLowerCase());

  const uniqueWords = [...new Set(words)].slice(0, 5);

  // Try to build a meaningful message from file analysis
  if (files.length === 1) {
    const file = path.basename(files[0], path.extname(files[0]));
    const fileWords = file.replace(/[-_.]/g, " ").trim();
    const verb = type === "feat" ? "add" : type;
    return `${verb} ${fileWords.toLowerCase()}`;
  }

  if (files.length <= 3 && uniqueWords.length >= 2) {
    const verb = type === "feat" ? "add" : type;
    return `${verb} ${uniqueWords.slice(0, Math.min(3, uniqueWords.length)).join(" ")}`;
  }

  if (uniqueWords.length >= 2) {
    const verb = type === "feat" ? "add" : type;
    return `${verb} ${uniqueWords.slice(0, 4).join(" ")}`;
  }

  // Fallback: describe by file count and type
  const verb = type === "feat" ? "add changes to" : type;
  const count = files.length;
  return `${verb} ${count} file${count > 1 ? "s" : ""}`;
}

// ============================================================================
// Smart .gitignore Engine
// ============================================================================

function getIgnorePatterns(cwd: string): string[] {
  const patterns: string[] = [];
  const hasFile = (name: string) => fs.existsSync(path.join(cwd, name));

  // Always include: environment files, IDE files, OS files
  patterns.push(
    ".env", ".env.local", ".env.*",
    ".DS_Store", "Thumbs.db",
    "*.swp", "*.swo", "*~",
    ".vscode/", ".idea/",
  );

  // Node.js / JavaScript / TypeScript
  if (hasFile("package.json")) {
    patterns.push("node_modules/", "npm-debug.log*", "yarn-debug.log*", "yarn-error.log*", ".pnpm-debug.log*");
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(cwd, "package.json"), "utf-8"));
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      if (deps?.next) patterns.push(".next/", "out/");
      if (deps?.vite) patterns.push("dist/");
      if (deps?.astro) patterns.push("dist/");
      if (deps?.typescript || deps?.tsup || deps?.tsc) patterns.push("*.tsbuildinfo");
    } catch { /* ignore parse errors */ }
  }

  // Python
  if (hasFile("requirements.txt") || hasFile("pyproject.toml") || hasFile("setup.py") || hasFile("setup.cfg")) {
    patterns.push(
      "__pycache__/", "*.py[cod]", "*$py.class", "*.so",
      ".venv/", "venv/", "env/", "virtualenv/",
      ".Python", "dist/", "build/", "*.egg-info/", "*.egg",
    );
  }

  // Rust
  if (hasFile("Cargo.toml")) {
    patterns.push("target/", "**/*.rs.bk");
  }

  // Go
  if (hasFile("go.mod")) {
    patterns.push("*.exe", "*.exe~", "*.dll", "*.so", "*.dylib", "*.test", "*.out");
  }

  // Ruby
  if (hasFile("Gemfile")) {
    patterns.push("*.gem", "*.rbc", ".bundle/", "vendor/bundle/");
  }

  // Java / Kotlin / Gradle / Maven
  if (
    hasFile("build.gradle") || hasFile("build.gradle.kts") ||
    hasFile("pom.xml") || hasFile("settings.gradle")
  ) {
    patterns.push(
      "*.class", "*.jar", "*.war", "*.nar", "*.ear",
      "build/", ".gradle/", "target/", "out/",
    );
  }

  // C / C++
  if (hasFile("Makefile") || hasFile("CMakeLists.txt")) {
    patterns.push("*.o", "*.obj", "*.exe", "*.out", "*.app", "build/", "cmake-build-*/");
  }

  // Terraform
  if (hasFile("main.tf") || hasFile("terraform.tf")) {
    patterns.push(".terraform/", "*.tfstate", "*.tfstate.*", "*.tfvars");
  }

  // Generic
  patterns.push("*.log", "*.tmp", "coverage/", ".nyc_output/");

  return [...new Set(patterns)];
}

// ============================================================================
// Extension
// ============================================================================

export default function (pi: ExtensionAPI) {

  // ------------------------------------------------------------------
  // Guard: only use git tools when the user explicitly asks
  // ------------------------------------------------------------------
  pi.on("before_agent_start", async (event) => {
    return {
      systemPrompt: event.systemPrompt +
        "\nGit tools (git_init, git_status, git_diff, git_add, git_commit, " +
        "git_branch, git_push, git_pull, git_merge, git_create_pr, git_ignore) " +
        "are available but must NOT be used unless the user explicitly asks you " +
        "to commit, push, branch, or perform any git operation. Never run git " +
        "commands on your own initiative.\n",
    };
  });

  // ================================================================
  // git_init — Initialize a repository
  // ================================================================
  pi.registerTool({
    name: "git_init",
    label: "Git Init",
    description: "Initialize a new git repository in the current working directory.",
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      const check = await git(pi, ["rev-parse", "--git-dir"], ctx.cwd);
      if (check.ok) {
        return { content: [{ type: "text", text: "Already a git repository." }] };
      }

      const r = await git(pi, ["init"], ctx.cwd);
      if (!r.ok) {
        return { content: [{ type: "text", text: `git init failed: ${r.stderr}` }], isError: true };
      }

      return {
        content: [{ type: "text", text: `Initialized empty Git repository in ${ctx.cwd}` }],
        details: { cwd: ctx.cwd },
      };
    },
  });

  // ================================================================
  // git_status — Structured working tree status
  // ================================================================
  pi.registerTool({
    name: "git_status",
    label: "Git Status",
    description: "Show the working tree status. Returns structured data with branch name and categorized file lists.",
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      const repoErr = await ensureRepo(pi, ctx.cwd);
      if (repoErr) return { content: [{ type: "text", text: repoErr }], isError: true };

      const [branch, status] = await Promise.all([
        currentBranch(pi, ctx.cwd),
        git(pi, ["status", "--short", "--branch"], ctx.cwd),
      ]);

      const lines = status.stdout.split("\n").filter(Boolean);
      const branchLine = lines[0]?.replace(/^##\s*/, "") ?? branch;

      const staged: string[] = [];
      const unstaged: string[] = [];
      const untracked: string[] = [];

      for (let i = 1; i < lines.length; i++) {
        const line = lines[i];
        if (line.startsWith("??")) {
          untracked.push(line.slice(3));
        } else {
          if (line[0] !== " ") staged.push(line.slice(3));
          if (line[1] !== " ") unstaged.push(line.slice(3));
        }
      }

      let text = `Branch: ${branchLine}\n`;
      if (staged.length) text += `\nStaged (${staged.length}):\n${staged.map((f) => `  M ${f}`).join("\n")}`;
      if (unstaged.length) text += `\n\nModified (${unstaged.length}):\n${unstaged.map((f) => `  M ${f}`).join("\n")}`;
      if (untracked.length) text += `\n\nUntracked (${untracked.length}):\n${untracked.map((f) => `  ? ${f}`).join("\n")}`;
      if (!staged.length && !unstaged.length && !untracked.length) {
        text += "\nNothing to commit. Working tree clean.";
      }

      return {
        content: [{ type: "text", text: text.trim() }],
        details: { branch: branchLine, staged, unstaged, untracked },
      };
    },
  });

  // ================================================================
  // git_diff — Show staged or unstaged changes
  // ================================================================
  pi.registerTool({
    name: "git_diff",
    label: "Git Diff",
    description: "Show changes between working tree and index (unstaged by default). Use staged=true for staged diff.",
    parameters: Type.Object({
      staged: Type.Optional(Type.Boolean({ description: "Show staged changes instead of unstaged" })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const repoErr = await ensureRepo(pi, ctx.cwd);
      if (repoErr) return { content: [{ type: "text", text: repoErr }], isError: true };

      const args = ["diff", "--stat=120"];
      if (params.staged) args.push("--staged");

      const r = await git(pi, args, ctx.cwd);
      if (!r.ok || !r.stdout) {
        return { content: [{ type: "text", text: "No changes." }] };
      }

      return { content: [{ type: "text", text: r.stdout }] };
    },
  });

  // ================================================================
  // git_add — Stage files
  // ================================================================
  pi.registerTool({
    name: "git_add",
    label: "Git Add",
    description: [
      "Stage files for commit.",
      "Use 'files' to stage specific paths.",
      "Use 'all' to stage everything (git add -A).",
    ].join(" "),
    parameters: Type.Object({
      files: Type.Optional(Type.Array(Type.String(), { description: "Specific file paths to stage" })),
      all: Type.Optional(Type.Boolean({ description: "Stage all changes including untracked files" })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const repoErr = await ensureRepo(pi, ctx.cwd);
      if (repoErr) return { content: [{ type: "text", text: repoErr }], isError: true };

      if (params.all) {
        const r = await git(pi, ["add", "-A"], ctx.cwd);
        if (!r.ok) return { content: [{ type: "text", text: `git add failed: ${r.stderr}` }], isError: true };
        return { content: [{ type: "text", text: "Staged all changes." }] };
      }

      if (params.files && params.files.length > 0) {
        const r = await git(pi, ["add", ...params.files], ctx.cwd);
        if (!r.ok) return { content: [{ type: "text", text: `git add failed: ${r.stderr}` }], isError: true };
        return { content: [{ type: "text", text: `Staged: ${params.files.join(", ")}` }] };
      }

      return { content: [{ type: "text", text: "Specify 'files' or set 'all: true'." }] };
    },
  });

  // ================================================================
  // git_commit ⭐ — Smart conventional commit
  // ================================================================
  pi.registerTool({
    name: "git_commit",
    label: "Git Commit",
    description: [
      "Create a conventional commit with auto-detected type, scope, and message.",
      "If nothing is staged, stages all changes automatically first.",
      "Types: feat, fix, chore, docs, refactor, test, style, ci, perf, build.",
      "Format: type(scope): description",
      "Use 'breaking: true' to mark a breaking change: type!(scope): description.",
      "You can override type, scope, and message if the auto-detection is wrong.",
    ].join(" "),
    parameters: Type.Object({
      type: Type.Optional(Type.String({
        description: "Override the auto-detected commit type",
      })),
      scope: Type.Optional(Type.String({
        description: "Override the auto-detected scope. Use empty string for no scope.",
      })),
      message: Type.Optional(Type.String({
        description: "Override the auto-generated commit message (without type/scope prefix)",
      })),
      body: Type.Optional(Type.String({
        description: "Optional extended commit body",
      })),
      breaking: Type.Optional(Type.Boolean({
        description: "Mark as breaking change. Adds ! after the type.",
      })),
    }),
    async execute(_id, params, _signal, onUpdate, ctx) {
      const repoErr = await ensureRepo(pi, ctx.cwd);
      if (repoErr) return { content: [{ type: "text", text: repoErr }], isError: true };

      // Check staged
      const stagedCheck = await git(pi, ["diff", "--staged", "--name-only"], ctx.cwd);
      const hasStaged = stagedCheck.stdout.length > 0;

      if (!hasStaged) {
        // Check for any changes at all
        const check = await git(pi, ["status", "--porcelain"], ctx.cwd);
        if (!check.stdout.length) {
          return { content: [{ type: "text", text: "Nothing to commit. Working tree clean." }] };
        }
        // Auto-stage everything
        onUpdate?.({ content: [{ type: "text", text: "Staging all changes..." }] });
        await git(pi, ["add", "-A"], ctx.cwd);
      }

      // Get diff for analysis
      const [diffResult, filesResult] = await Promise.all([
        git(pi, ["diff", "--staged"], ctx.cwd),
        git(pi, ["diff", "--staged", "--name-only"], ctx.cwd),
      ]);

      const diff = diffResult.stdout;
      const files = filesResult.stdout.split("\n").filter(Boolean);

      if (files.length === 0) {
        return { content: [{ type: "text", text: "Nothing to commit after staging." }] };
      }

      // Determine type
      let commitType = params.type as ConventionalType | undefined;
      if (!commitType || !(CONVENTIONAL_TYPES as readonly string[]).includes(commitType)) {
        commitType = detectType(diff, files);
      }

      // Determine scope
      let scope: string | null;
      if (params.scope !== undefined) {
        scope = params.scope || null;
      } else {
        scope = detectScope(files, ctx.cwd);
      }

      // Generate message
      let description: string;
      if (params.message) {
        description = params.message.trim();
      } else {
        description = generateMessage(commitType, scope, diff, files);
        // Strip any accidental type prefix from generated message
        const prefixPattern = new RegExp(`^(?:${CONVENTIONAL_TYPES.join("|")})\\s+`, "i");
        description = description.replace(prefixPattern, "");
      }

      // Build final commit message
      const breaking = params.breaking ? "!" : "";
      const scopeStr = scope ? `(${scope})` : "";
      const fullMessage = `${commitType}${breaking}${scopeStr}: ${description}`;

      // Commit
      const commitArgs = ["commit", "-m", fullMessage];
      if (params.body) commitArgs.push("-m", params.body);

      const result = await git(pi, commitArgs, ctx.cwd);
      if (!result.ok) {
        return {
          content: [{ type: "text", text: `Commit failed: ${result.stderr}` }],
          isError: true,
        };
      }

      // Get the commit hash
      const log = await git(pi, ["log", "-1", "--format=%h"], ctx.cwd);
      const hash = log.ok ? log.stdout : "";

      return {
        content: [{ type: "text", text: `${hash ? `${hash} ` : ""}${fullMessage}` }],
        details: {
          hash,
          type: commitType,
          scope,
          message: description,
          body: params.body,
          breaking: !!params.breaking,
          files,
          format: fullMessage,
        },
      };
    },
  });

  // ================================================================
  // git_branch — Create branches with conventional prefixes
  // ================================================================
  pi.registerTool({
    name: "git_branch",
    label: "Git Branch",
    description: [
      "Create and switch to a new branch with proper prefix.",
      "Prefixes: feat/, fix/, chore/, docs/, refactor/.",
      "Prefix is auto-detected from the branch description, or you can specify it.",
      "Branch name is slugified automatically.",
    ].join(" "),
    parameters: Type.Object({
      name: Type.String({
        description: "Branch name (without prefix). Use kebab-case, e.g., 'user-auth' or 'fix-login-bug'.",
      }),
      prefix: Type.Optional(Type.String({
        description: "Branch prefix: feat, fix, chore, docs, refactor. Auto-detected if omitted.",
      })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const repoErr = await ensureRepo(pi, ctx.cwd);
      if (repoErr) return { content: [{ type: "text", text: repoErr }], isError: true };

      // Warn about uncommitted changes
      if (await hasChanges(pi, ctx.cwd)) {
        return {
          content: [{
            type: "text",
            text: "You have uncommitted changes. Commit or stash them before creating a branch.",
          }],
          isError: true,
        };
      }

      // Slugify the name
      let slug = params.name
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, "")
        .trim()
        .replace(/\s+/g, "-")
        .replace(/--+/g, "-");

      // Detect prefix from name or use provided
      let prefix = params.prefix;
      if (!prefix) {
        if (slug.startsWith("feat") || /^(add|create|implement|build)/.test(slug)) prefix = "feat";
        else if (slug.startsWith("fix") || slug.includes("fix-") || /^(bug|patch|hotfix|repair)/.test(slug)) prefix = "fix";
        else if (slug.startsWith("chore") || /^(update-dep|upgrade|bump|config|ci)/.test(slug)) prefix = "chore";
        else if (slug.startsWith("doc") || /^(readme|docs|document)/.test(slug)) prefix = "docs";
        else if (slug.startsWith("refactor") || /^(clean|reorganize|extract|simplify)/.test(slug)) prefix = "refactor";
        else prefix = "feat"; // default
      }

      // Strip prefix from slug if already present
      slug = slug.replace(new RegExp(`^${prefix}[/-]?`), "").replace(/^-+/, "");

      if (!slug) {
        return { content: [{ type: "text", text: "Branch name is empty after processing. Provide a descriptive name." }], isError: true };
      }

      const fullName = `${prefix}/${slug}`;

      // Check existence
      const check = await git(pi, ["branch", "--list", fullName], ctx.cwd);
      if (check.stdout.includes(fullName)) {
        return { content: [{ type: "text", text: `Branch "${fullName}" already exists.` }], isError: true };
      }

      // Warn if on main/master
      const curBranch = await currentBranch(pi, ctx.cwd);
      const isMain = curBranch === "main" || curBranch === "master";

      const r = await git(pi, ["checkout", "-b", fullName], ctx.cwd);
      if (!r.ok) {
        return { content: [{ type: "text", text: `Failed: ${r.stderr}` }], isError: true };
      }

      let msg = `Created and switched to branch: ${fullName}`;
      if (isMain) msg += "\n✓ Good practice: created a branch instead of working on main.";

      return { content: [{ type: "text", text: msg }], details: { branch: fullName, prefix, slug } };
    },
  });

  // ================================================================
  // git_push — Safe push with upstream handling
  // ================================================================
  pi.registerTool({
    name: "git_push",
    label: "Git Push",
    description: [
      "Push commits to remote. Sets upstream automatically on first push.",
      "Uses --force-with-lease for safety when force=true.",
    ].join(" "),
    parameters: Type.Object({
      force: Type.Optional(Type.Boolean({ description: "Force push using --force-with-lease" })),
      remote: Type.Optional(Type.String({ description: "Remote name. Default: origin", default: "origin" })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const repoErr = await ensureRepo(pi, ctx.cwd);
      if (repoErr) return { content: [{ type: "text", text: repoErr }], isError: true };

      const branch = await currentBranch(pi, ctx.cwd);
      const remote = params.remote || "origin";

      // Check remote exists
      const remotes = await git(pi, ["remote"], ctx.cwd);
      if (!remotes.stdout.includes(remote)) {
        return {
          content: [{ type: "text", text: `Remote "${remote}" not found. Add a remote with: git remote add ${remote} <url>` }],
          isError: true,
        };
      }

      const args = ["push"];
      if (params.force) args.push("--force-with-lease");

      const upstream = await git(pi, ["rev-parse", "--abbrev-ref", `${branch}@{upstream}`], ctx.cwd);
      if (!upstream.ok) {
        args.push("--set-upstream", remote, branch);
      } else {
        args.push(remote, branch);
      }

      const r = await git(pi, args, ctx.cwd);
      if (!r.ok) {
        let err = r.stderr;
        if (err.includes("rejected")) {
          err = "Push rejected — the remote has newer commits. Pull first with git_pull.";
        }
        return { content: [{ type: "text", text: `Push failed: ${err}` }], isError: true };
      }

      return { content: [{ type: "text", text: r.stdout || `Pushed ${branch} to ${remote}.` }] };
    },
  });

  // ================================================================
  // git_pull — Pull with rebase
  // ================================================================
  pi.registerTool({
    name: "git_pull",
    label: "Git Pull",
    description: "Pull latest changes from remote using rebase for a clean linear history.",
    parameters: Type.Object({
      remote: Type.Optional(Type.String({ description: "Remote name. Default: origin", default: "origin" })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const repoErr = await ensureRepo(pi, ctx.cwd);
      if (repoErr) return { content: [{ type: "text", text: repoErr }], isError: true };

      const branch = await currentBranch(pi, ctx.cwd);
      const remote = params.remote || "origin";

      const r = await git(pi, ["pull", "--rebase", remote, branch], ctx.cwd);
      if (!r.ok) {
        if (r.stderr.includes("CONFLICT") || r.stdout.includes("CONFLICT")) {
          return {
            content: [{
              type: "text",
              text: [
                "⚠ Merge conflicts detected!",
                "",
                "To resolve:",
                "  1. Fix the conflicted files",
                "  2. git add <resolved-files>",
                "  3. git rebase --continue",
                "",
                "To abort: git rebase --abort",
              ].join("\n"),
            }],
            isError: true,
          };
        }
        return { content: [{ type: "text", text: `Pull failed: ${r.stderr}` }], isError: true };
      }

      return { content: [{ type: "text", text: r.stdout || `Pulled ${branch} from ${remote}. Up to date.` }] };
    },
  });

  // ================================================================
  // git_merge — Full merge flow: checkout → pull → merge
  // ================================================================
  pi.registerTool({
    name: "git_merge",
    label: "Git Merge",
    description: [
      "Full merge flow: checkout target → pull latest → merge source branch.",
      "Uses --no-ff (no fast-forward) to preserve branch history.",
      "Optionally squash-merges or pushes after merging.",
    ].join(" "),
    parameters: Type.Object({
      source: Type.String({ description: "Source branch to merge (the feature/fix branch)" }),
      target: Type.String({ description: "Target branch to merge into (e.g., main, develop)" }),
      squash: Type.Optional(Type.Boolean({ description: "Squash merge instead of regular merge" })),
      push: Type.Optional(Type.Boolean({ description: "Push target branch after merge. Default: true", default: true })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const repoErr = await ensureRepo(pi, ctx.cwd);
      if (repoErr) return { content: [{ type: "text", text: repoErr }], isError: true };

      const originalBranch = await currentBranch(pi, ctx.cwd);

      if (await hasChanges(pi, ctx.cwd)) {
        return {
          content: [{ type: "text", text: "Working tree is dirty. Commit or stash changes before merging." }],
          isError: true,
        };
      }

      const steps: string[] = [];

      // Step 1: Checkout target
      const checkout = await git(pi, ["checkout", params.target], ctx.cwd);
      if (!checkout.ok) {
        return {
          content: [{ type: "text", text: `Failed to checkout ${params.target}: ${checkout.stderr}` }],
          isError: true,
        };
      }
      steps.push(`✓ Checked out ${params.target}`);

      // Step 2: Pull latest
      const pull = await git(pi, ["pull", "--rebase"], ctx.cwd);
      if (!pull.ok) {
        await git(pi, ["checkout", originalBranch], ctx.cwd); // rollback
        return {
          content: [{ type: "text", text: `Failed to pull ${params.target}: ${pull.stderr}` }],
          isError: true,
        };
      }
      steps.push(`✓ Pulled latest ${params.target}`);

      // Step 3: Merge
      const mergeArgs = params.squash ? ["merge", "--squash", params.source] : ["merge", "--no-ff", params.source, "-m", `Merge ${params.source} into ${params.target}`];

      const merge = await git(pi, mergeArgs, ctx.cwd);
      if (!merge.ok) {
        if (merge.stderr.includes("CONFLICT") || merge.stdout.includes("CONFLICT")) {
          steps.push(`✗ Merge conflict between ${params.source} → ${params.target}`);
          steps.push("");
          steps.push("Conflicts detected. Resolve manually:");
          steps.push("  1. Fix the conflicted files");
          steps.push("  2. git add <resolved-files>");
          steps.push("  3. git commit (or git merge --continue)");
          steps.push(`To abort: git merge --abort && git checkout ${originalBranch}`);
          return { content: [{ type: "text", text: steps.join("\n") }], isError: true };
        }
        await git(pi, ["checkout", originalBranch], ctx.cwd); // rollback
        return {
          content: [{ type: "text", text: `Merge failed: ${merge.stderr || merge.stdout}` }],
          isError: true,
        };
      }

      if (params.squash) {
        steps.push(`✓ Squash-merged ${params.source} → ${params.target} (staged, not committed)`);
      } else {
        steps.push(`✓ Merged ${params.source} → ${params.target}`);
      }

      // Step 4: Push (optional)
      if (params.push !== false && !params.squash) {
        const push = await git(pi, ["push"], ctx.cwd);
        steps.push(push.ok ? "✓ Pushed" : `⚠ Push failed: ${push.stderr}`);
      }

      return {
        content: [{ type: "text", text: steps.join("\n") }],
        details: { source: params.source, target: params.target, squash: !!params.squash },
      };
    },
  });

  // ================================================================
  // git_create_pr — GitHub PR with conventional title
  // ================================================================
  pi.registerTool({
    name: "git_create_pr",
    label: "Create PR",
    description: [
      "Create a GitHub Pull Request with conventional title and auto-generated body.",
      "Pushes the branch first if not already pushed.",
      "Title is generated from commits using conventional format.",
      "Requires GitHub CLI (gh) to be installed and authenticated.",
    ].join(" "),
    parameters: Type.Object({
      title: Type.Optional(Type.String({ description: "Override PR title. Auto-generated from commits if omitted." })),
      body: Type.Optional(Type.String({ description: "Override PR body. Auto-generated from commit list if omitted." })),
      base: Type.Optional(Type.String({ description: "Target branch. Default: main", default: "main" })),
      draft: Type.Optional(Type.Boolean({ description: "Create as draft PR" })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const repoErr = await ensureRepo(pi, ctx.cwd);
      if (repoErr) return { content: [{ type: "text", text: repoErr }], isError: true };

      const branch = await currentBranch(pi, ctx.cwd);
      const base = params.base || "main";

      if (branch === base) {
        return {
          content: [{ type: "text", text: `You're on the ${base} branch. Create a feature branch first with git_branch.` }],
          isError: true,
        };
      }

      // Push branch if needed
      const upstream = await git(pi, ["rev-parse", "--abbrev-ref", `${branch}@{upstream}`], ctx.cwd);
      if (!upstream.ok) {
        const push = await git(pi, ["push", "--set-upstream", "origin", branch], ctx.cwd);
        if (!push.ok) {
          return {
            content: [{ type: "text", text: `Failed to push branch: ${push.stderr}` }],
            isError: true,
          };
        }
      }

      // Generate title from commits
      let title = params.title;
      if (!title) {
        const log = await git(pi, ["log", `${base}..HEAD`, "--format=%s", "--no-merges"], ctx.cwd);
        const commits = log.stdout.split("\n").filter(Boolean);
        if (commits.length === 1) {
          title = commits[0];
        } else if (commits.length > 1) {
          // Use the first commit as the PR title base
          title = commits[0];
        } else {
          title = branch.replace(/^[^/]+\//, "").replace(/-/g, " ");
        }
      }

      // Generate body from commits
      let body = params.body;
      if (!body) {
        const log = await git(pi, ["log", `${base}..HEAD`, "--format=- %s", "--no-merges"], ctx.cwd);
        const commitList = log.stdout.trim();
        if (commitList) {
          body = `## Commits\n\n${commitList}`;
        }
      }

      // Create PR via gh CLI
      const ghArgs = ["pr", "create", "--base", base, "--head", branch, "--title", title];
      if (body) ghArgs.push("--body", body);
      if (params.draft) ghArgs.push("--draft");

      const gh = await pi.exec("gh", ghArgs, { cwd: ctx.cwd, timeout: 15000 });
      const ghOk = gh.code === 0;
      const ghOut = (gh.stdout ?? "").trim();
      const ghErr = (gh.stderr ?? "").trim();

      if (!ghOk) {
        // Handle missing gh CLI
        if (ghErr.includes("not found") || ghErr.includes("command not found") || ghErr.includes("ENOENT")) {
          return {
            content: [{
              type: "text",
              text: [
                "⚠ GitHub CLI (gh) is not installed.",
                "Install: https://cli.github.com",
                "",
                "Manual PR details:",
                `  Title:  ${title}`,
                `  Base:   ${base} ← ${branch}`,
                body ? `\n${body}` : "",
              ].join("\n"),
            }],
            isError: true,
          };
        }

        // Handle auth issues
        if (ghErr.includes("auth") || ghErr.includes("login") || ghErr.includes("unauthorized")) {
          return {
            content: [{ type: "text", text: "⚠ Not authenticated with GitHub CLI. Run: gh auth login" }],
            isError: true,
          };
        }

        return {
          content: [{ type: "text", text: `Failed to create PR: ${ghErr || ghOut}` }],
          isError: true,
        };
      }

      return {
        content: [{ type: "text", text: `✅ PR created!\n\n${ghOut}\n\nTitle: ${title}` }],
        details: { url: ghOut, title, base, branch, draft: !!params.draft },
      };
    },
  });

  // ================================================================
  // git_ignore — Smart .gitignore generation
  // ================================================================
  pi.registerTool({
    name: "git_ignore",
    label: "Git Ignore",
    description: [
      "Generate or update .gitignore with smart project-type detection.",
      "Scans for package.json, Cargo.toml, go.mod, pyproject.toml, etc.",
      "to determine which patterns to include.",
      "If .gitignore exists, appends missing patterns only (unless overwrite=true).",
    ].join(" "),
    parameters: Type.Object({
      overwrite: Type.Optional(Type.Boolean({
        description: "Overwrite existing .gitignore instead of appending missing patterns",
      })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const patterns = getIgnorePatterns(ctx.cwd);
      const gitignorePath = path.join(ctx.cwd, ".gitignore");
      const exists = fs.existsSync(gitignorePath);

      if (exists && !params.overwrite) {
        const existing = fs.readFileSync(gitignorePath, "utf-8");
        const existingSet = new Set(
          existing.split("\n").map((l) => l.trim()).filter(Boolean),
        );
        const missing = patterns.filter((p) => !existingSet.has(p));

        if (missing.length === 0) {
          return { content: [{ type: "text", text: ".gitignore is already up to date." }] };
        }

        const append = `\n# Added by git_ignore\n${missing.join("\n")}\n`;
        fs.appendFileSync(gitignorePath, append);

        return {
          content: [{
            type: "text",
            text: `Added ${missing.length} missing pattern(s) to .gitignore:\n${missing.map((p) => `  + ${p}`).join("\n")}`,
          }],
          details: { added: missing, action: "appended" },
        };
      }

      // Create new .gitignore
      const content = [
        "# Generated by git_ignore",
        `# Project: ${path.basename(ctx.cwd)}`,
        `# Generated: ${new Date().toISOString().split("T")[0]}`,
        "",
        ...patterns,
        "",
      ].join("\n");

      fs.writeFileSync(gitignorePath, content, "utf-8");

      return {
        content: [{
          type: "text",
          text: `Generated .gitignore with ${patterns.length} patterns:\n${patterns.map((p) => `  • ${p}`).join("\n")}`,
        }],
        details: { patterns, action: "created", file: gitignorePath },
      };
    },
  });
}
