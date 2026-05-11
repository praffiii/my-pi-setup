# pi-git-conventions

AI-driven git operations for [pi coding agent](https://github.com/earendil-works/pi-mono). The agent handles git for you — with big-company conventions baked in.

## Why?

I got tired of AI agents writing commit messages like `"update files"` and pushing directly to `main`. So I built tools that enforce real conventions — the kind you'd see in a serious engineering team.

Everything here is designed to be **agent-first**: the AI calls tools, the tools enforce the rules, and I stay in control.

Every git operation goes through tools that **enforce**:
- ✅ Conventional commits (`feat(auth): add login form`)
- ✅ Prefixed branches (`feat/`, `fix/`, `chore/`, `docs/`, `refactor/`)
- ✅ Safe pushes (auto upstream, `--force-with-lease`)
- ✅ Proper merge flow (checkout → pull → merge)
- ✅ Auto-generated PRs with conventional titles

## Install

```bash
pi install github.com/praffiii/my-pi-setup
```

Or manually:

```bash
cp index.ts ~/.pi/agent/extensions/git-conventions.ts
```

## Tools

| Tool | Description |
|------|-------------|
| `git_init` | Initialize a git repository |
| `git_status` | Structured status (branch, staged, unstaged, untracked) |
| `git_diff` | Show staged or unstaged changes |
| `git_add` | Stage files or all changes |
| `git_commit` ⭐ | Auto-detect type + scope + message, conventional format |
| `git_branch` | Create branches with auto-prefix |
| `git_push` | Safe push, auto upstream, `--force-with-lease` |
| `git_pull` | Pull with `--rebase`, conflict handling |
| `git_merge` | Full flow: checkout → pull → merge → push |
| `git_create_pr` | GitHub PR via `gh` CLI |
| `git_ignore` | Smart `.gitignore` generation |

## Usage

Just talk to the agent naturally:

```
"commit these changes"
→ Analyzes diff → git_commit → feat(auth): add login form

"push and open a PR"
→ git_push → git_create_pr → PR created with conventional title

"merge feat/login into main"
→ git_merge → checkout main → pull → merge --no-ff → push
```

## Convention Engine

`git_commit` analyzes your diff and auto-detects:

- **Type**: `feat` (new stuff), `fix` (bugs), `docs`, `test`, `refactor`, `chore`, `ci`, `perf`, `build`
- **Scope**: Which directory changed most (e.g., `auth`, `api`, `ui`)
- **Breaking changes**: Detected and marked with `!` → `feat!(auth): drop legacy API`

You can always override: `git_commit` with `type`, `scope`, or `message` params.

## Requirements

- [pi coding agent](https://github.com/earendil-works/pi-mono)
- `git` in PATH
- `gh` CLI (only for `git_create_pr`)

## License

MIT
