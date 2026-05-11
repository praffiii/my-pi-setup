# my-pi-setup

My personal [pi coding agent](https://github.com/earendil-works/pi-mono) setup — a collection of extensions, skills, and tools I use daily. I'm sharing this so others can grab what's useful, and so I can set up a new machine in one command.

## What's inside

| Package | Description |
|---------|-------------|
| [git-conventions](./packages/git-conventions) | AI-driven git with conventional commits, prefixed branches, safe merges, auto PRs, and smart .gitignore |

More coming as I build them.

## Install everything

```bash
pi install github.com/praffiii/my-pi-setup
```

## Or install just one package

```bash
pi install github.com/praffiii/my-pi-setup/packages/git-conventions
```

## Why this exists

I got tired of AI agents writing commit messages like `"update files"` and pushing directly to `main`. So I built tools that enforce real conventions — the kind you'd see in a serious engineering team.

Everything here is designed to be **agent-first**: the AI calls tools, the tools enforce the rules, and I stay in control.

## License

MIT
