# pi-credential-guard

Prevents the [pi coding agent](https://github.com/earendil-works/pi-mono) from reading credential files or running commands that expose secrets. Hard blocks for unambiguous secrets, permission prompts for borderline configs.

## Why?

AI agents have unrestricted filesystem access — they can `read .env`, `cat *.pem`, or run `env` to dump every secret in the environment. One accidental `pi-share-hf` session could leak real credentials.

This extension acts as a firewall. The agent can't read sensitive files even if it tries, and a terse system prompt stops it from wasting tokens on blocked attempts.

## What It Protects

### Tier 1 — Hard Block

Unambiguous credential files are blocked without question:

- **Environment files:** `.env`, `.env.*`, `.envrc`
- **Private keys:** `*.pem`, `*.p12`, `*.pfx`, `*.ppk`, `*.jks`, `*.p8`
- **SSH keys:** `id_rsa`, `id_ed25519`, `id_ecdsa`, `id_dsa`, `id_ecdsa_sk`, `id_ed25519_sk`
- **Named credential files:** `credentials`, `secrets`, `password`, `api_key`, `apikey`, `access_key`
- **Cloud credentials:** `.aws/credentials`, `.config/gcloud`, `*service-account*.json`
- **Infrastructure:** `*.tfvars`, `.terraform/`, `kubeconfig`, `.kube/config`
- **Auth files:** `.netrc`, `.htpasswd`, `.git-credentials`, `docker/config.json`
- **Framework secrets:** `master.key`, `credentials.yml.enc`, `wp-config.php`
- **Token/password files:** `.token`, `.pgpass`, `.s3cfg`, `.vault_pass`

### Tier 2 — Ask Permission

Config files that *may* contain secrets trigger a prompt:

`.npmrc`, `.pypirc`, `.my.cnf`, `.pg_service.conf`, `*.key`, `.terraform/`, `GoogleService-Info.plist`, `google-services.json`

### Bash Protection

Blocks dangerous commands:

| Command | Reason |
|---------|--------|
| `env`, `printenv` | Dumps all environment variables |
| `set`, `declare -p`, `export -p` | Dumps all shell variables |
| `echo $API_KEY`, `echo $SECRET` | Exposes individual secrets |
| `source .env`, `. .env` | Loads secrets into shell |
| `cat`/`grep`/`head`/`tail` on protected paths | Reads credential files via bash |

### Explicitly Allowed (safe templates)

`.env.example`, `.env.sample`, `.env.template`, `.env.dist` — these are templates without real credentials.

## Install

```bash
pi install github.com/praffiii/my-pi-setup
```

Or manually:

```bash
cp index.ts ~/.pi/agent/extensions/credential-guard.ts
```

Then `/reload` in pi.

## Usage

No configuration needed. The extension loads automatically and injects a guard rule into every system prompt:

> *Credential protection: never read/write .env, *.pem, *.p12, *.jks, id_rsa, credentials, secrets, master.key, or any file named password/api_key/apikey/access_key. Never run env, printenv, set, echo $SECRET, or source .env. Do not retry blocked calls — ask the user for the value instead.*

When the agent tries to read a protected file:

```
[Tier 1] 🔒 Blocked read on credential file: .env
[Tier 2] ⚠️  .npmrc may contain credentials. Allow? [Allow this once] [Deny]
```

## Requirements

- [pi coding agent](https://github.com/earendil-works/pi-mono)

## License

MIT
