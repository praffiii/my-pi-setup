/**
 * Credential Guard Extension
 *
 * Prevents the AI agent from reading credential files or running
 * commands that expose secrets. Uses two-tier protection:
 *   Tier 1: Hard block — unambiguous credential files
 *   Tier 2: Ask permission — config files that may contain secrets
 *
 * Also injects guard rules into the system prompt so the model
 * avoids credential files proactively, reducing wasted token calls.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ============================================================================
// Tier 1 Blocklist — Hard Block (unambiguous credential files)
// ============================================================================

const T1_EXTENSIONS = [
  ".pem", ".p12", ".pfx", ".ppk", ".jks", ".p8",
  ".keystore", ".truststore",
];

const T1_BASENAME_EXACT = [
  ".env", ".envrc", ".netrc", "_netrc", ".htpasswd", ".dockercfg",
  ".pgpass", ".s3cfg", ".token", ".vault_pass",
  "id_rsa", "id_ed25519", "id_ecdsa", "id_dsa", "id_ecdsa_sk", "id_ed25519_sk",
  "master.key", "wp-config.php",
  "credentials", "secrets", "password", "api_key", "apikey", "access_key",
  "kubeconfig",
];

const T1_BASENAME_PREFIX = [
  ".env.",        // .env.local, .env.production
  "credentials.", // credentials.yml, credentials.json
  "secrets.",     // secrets.yml, secrets.json
  "password.",    // password.txt
  "api_key.",     // api_key.txt
  "apikey.",      // apikey.json
  "access_key.",  // access_key.txt
  "kubeconfig.",  // kubeconfig.yaml
];

const T1_PATH_SEGMENTS = [
  ".git-credentials",
  ".gem/credentials",
  ".aws/credentials",
  ".config/gcloud",
  "docker/config.json",
  ".kube/config",
  ".pi/settings.json",
];

const T1_GLOB_PATTERNS = [
  "*.tfvars",
  "*.auto.tfvars",
  "*service-account*.json",
  "*vault_pass*",
];

// Files that are explicitly safe to read despite matching blocklist patterns
// .env.example / .env.sample are templates, not real credential files
const ALLOWLIST_BASENAME = [
  ".env.example", ".env.sample", ".env.template", ".env.dist",
];

// ============================================================================
// Tier 2 Blocklist — Ask Permission (config files that may contain secrets)
// ============================================================================

const T2_BASENAME = [
  ".npmrc", ".pypirc", ".my.cnf", ".pg_service.conf",
  "GoogleService-Info.plist", "google-services.json",
];

const T2_EXTENSIONS = [".key"];

const T2_PATH_SEGMENTS = [".terraform/"];

// ============================================================================
// Pattern Matching Helpers
// ============================================================================

function getBasename(filePath: string): string {
  const normalized = filePath.replace(/\\/g, "/");
  const parts = normalized.split("/");
  return parts[parts.length - 1] || normalized;
}

function matchesExtension(filePath: string, exts: string[]): boolean {
  const name = getBasename(filePath);
  return exts.some((ext) => name.endsWith(ext));
}

/** Strict equality only — no prefix matching */
function matchesBasenameExact(filePath: string, names: string[]): boolean {
  const name = getBasename(filePath);
  return names.some((n) => name === n);
}

/** Prefix matching — e.g. ".env." matches ".env.local" */
function matchesBasenamePrefix(filePath: string, prefixes: string[]): boolean {
  const name = getBasename(filePath);
  return prefixes.some((p) => name.startsWith(p));
}

function matchesPathSegment(filePath: string, segments: string[]): boolean {
  const normalized = filePath.replace(/\\/g, "/");
  return segments.some((s) => normalized.includes(s));
}

/** Simple glob matching (supports * wildcards only) */
function matchesGlob(filePath: string, patterns: string[]): boolean {
  const name = getBasename(filePath);
  return patterns.some((p) => {
    const regex = new RegExp(
      "^" + p.replace(/\./g, "\\.").replace(/\*/g, ".*") + "$",
      "i",
    );
    return regex.test(name);
  });
}

// ============================================================================
// Path Classification
// ============================================================================

interface CheckResult {
  blocked: true;
  tier: 1 | 2;
  reason: string;
}

function checkPath(filePath: string): CheckResult | null {
  // --- Allowlist: safe files that look like credential files but aren't ---
  if (matchesBasenameExact(filePath, ALLOWLIST_BASENAME)) {
    return null; // .env.example etc. are safe templates
  }

  // --- Tier 1 checks ---

  if (matchesExtension(filePath, T1_EXTENSIONS)) {
    return { blocked: true, tier: 1, reason: `Credential file: ${filePath}` };
  }
  if (matchesBasenameExact(filePath, T1_BASENAME_EXACT)) {
    return { blocked: true, tier: 1, reason: `Credential file: ${filePath}` };
  }
  if (matchesBasenamePrefix(filePath, T1_BASENAME_PREFIX)) {
    return { blocked: true, tier: 1, reason: `Credential file: ${filePath}` };
  }
  if (matchesPathSegment(filePath, T1_PATH_SEGMENTS)) {
    return { blocked: true, tier: 1, reason: `Credential file: ${filePath}` };
  }
  if (matchesGlob(filePath, T1_GLOB_PATTERNS)) {
    return { blocked: true, tier: 1, reason: `Credential file: ${filePath}` };
  }

  // --- Tier 2 checks ---

  if (matchesBasenameExact(filePath, T2_BASENAME)) {
    return { blocked: true, tier: 2, reason: `Config file may contain credentials: ${filePath}` };
  }
  if (matchesExtension(filePath, T2_EXTENSIONS)) {
    return { blocked: true, tier: 2, reason: `.key file may contain private key: ${filePath}` };
  }
  if (matchesPathSegment(filePath, T2_PATH_SEGMENTS)) {
    return { blocked: true, tier: 2, reason: `Config may contain credentials: ${filePath}` };
  }

  return null;
}

// ============================================================================
// Bash Command Protection
// ============================================================================

/** Regex patterns for bash commands that expose secrets */
const DANGEROUS_BASH_REGEX: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /(?:^|&&|;|\|\||\||\n)\s*env\b/,              label: "env" },
  { pattern: /(?:^|&&|;|\|\||\||\n)\s*printenv\b/,         label: "printenv" },
  { pattern: /(?:^|&&|;|\|\||\||\n)\s*set\s*(?:\||$|&&|;)/, label: "set" },
  { pattern: /\b(?:declare|typeset)\s+-[a-zA-Z]*p\b/,       label: "declare -p" },
  { pattern: /\bexport\s+-[a-zA-Z]*p\b/,                    label: "export -p" },
  {
    // echo $VAR where VAR contains KEY, SECRET, TOKEN, PASSWORD, etc.
    pattern: /\becho\s+\$\{?[A-Z_]*(?:KEY|SECRET|TOKEN|PASSWORD|AUTH|PASS[WD]*|CREDENTIAL|PRIVATE|ENCRYPT)[A-Z_0-9]*\}?\b/i,
    label: "echo $SECRET",
  },
  {
    // source .env or . .env
    pattern: /(?:source\s+\.env\b|(?:^|\s)\.\s+\.env\b)/,
    label: "source .env",
  },
];

/** Returns a reason string if the command is dangerous, null otherwise */
function checkDangerousCommand(command: string): string | null {
  for (const { pattern, label } of DANGEROUS_BASH_REGEX) {
    if (pattern.test(command)) {
      return `bash command exposes secrets: ${label}`;
    }
  }
  return null;
}

/** Check if a bash command reads or writes a protected file (not just mentions it) */
function checkCommandPath(command: string): { tier: 1 | 2; path: string } | null {
  // Only flag file-reading operations: cat, head, tail, less, more, grep,
  // sed, awk, strings, or redirections (>, >>, <). Don't flag find, ls, etc.
  const readOps = /\b(?:cat|head|tail|less|more|grep|sed|awk|strings|sort|uniq|wc)\b/;
  const hasReadOp = readOps.test(command);
  const hasRedirect = /[<>]/.test(command);

  if (!hasReadOp && !hasRedirect) return null;

  const allSegments = [...T1_PATH_SEGMENTS, ...T2_PATH_SEGMENTS];
  for (const segment of allSegments) {
    if (command.includes(segment)) {
      const tier = (T1_PATH_SEGMENTS as readonly string[]).includes(segment) ? 1 : 2;
      return { tier, path: segment };
    }
  }

  // Check basenames after a read operation (e.g., "cat .env")
  const allBasenames = [...T1_BASENAME_EXACT, ...T1_BASENAME_PREFIX.map((p) => p.replace(/\.$/, "")), ...T2_BASENAME];
  for (const name of allBasenames) {
    // Only flag if the filename appears near a read operation, not in -name or --exclude patterns
    const readPattern = new RegExp(
      `(?:cat|head|tail|less|more|grep|sed|awk|strings|[<>])\\s+[^;|&]*${name.replace(/\./g, "\\.")}`,
      "i"
    );
    if (readPattern.test(command)) {
      const tier = [...T1_BASENAME_EXACT, ...T1_BASENAME_PREFIX.map((p) => p.replace(/\.$/, ""))].includes(name) ? 1 : 2;
      return { tier, path: name };
    }
  }

  return null;
}

// ============================================================================
// System Prompt Injection
// ============================================================================

const SYSTEM_PROMPT_APPENDIX = `
Credential protection: never read/write .env, *.pem, *.p12, *.jks, id_rsa,
credentials, secrets, master.key, or any file named password/api_key/apikey/
access_key. Never run env, printenv, set, echo \$SECRET, or source .env.
Do not retry blocked calls — ask the user for the value instead.`;

// ============================================================================
// Extension Entry Point
// ============================================================================

export default function (pi: ExtensionAPI) {
  // ------------------------------------------------------------------
  // 1. Inject guard rules into every system prompt
  // ------------------------------------------------------------------
  pi.on("before_agent_start", async (event) => {
    return {
      systemPrompt: event.systemPrompt + SYSTEM_PROMPT_APPENDIX,
    };
  });

  // ------------------------------------------------------------------
  // 2. Guard read / write / edit tools
  // ------------------------------------------------------------------
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "read" && event.toolName !== "write" && event.toolName !== "edit") {
      return undefined;
    }

    const filePath = event.input.path as string;
    if (!filePath) return undefined;

    const result = checkPath(filePath);
    if (!result) return undefined;

    // --- Tier 1: Hard block ---
    if (result.tier === 1) {
      if (ctx.hasUI) {
        ctx.ui.notify(`🔒 Blocked ${event.toolName} on credential file: ${filePath}`, "warning");
      }
      return { block: true, reason: `Credential protection: ${result.reason}` };
    }

    // --- Tier 2: Ask permission ---
    if (ctx.hasUI) {
      const choice = await ctx.ui.select(
        `⚠️  ${filePath} may contain credentials.\n\n${result.reason}\n\nAllow this ${event.toolName}?`,
        ["Allow this once", "Deny"],
      );
      if (choice !== "Allow this once") {
        ctx.ui.notify(`Denied ${event.toolName} on: ${filePath}`, "info");
        return { block: true, reason: `Credential protection: user denied access to ${filePath}` };
      }
      ctx.ui.notify(`Allowed ${event.toolName} on: ${filePath}`, "info");
    } else {
      // Non-interactive mode: block by default
      return { block: true, reason: `Credential protection: ${result.reason} (no UI for confirmation)` };
    }

    return undefined;
  });

  // ------------------------------------------------------------------
  // 3. Guard bash tool
  // ------------------------------------------------------------------
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "bash") return undefined;

    const command = event.input.command as string;
    if (!command) return undefined;

    // Check for intrinsically dangerous commands (env, printenv, echo $SECRET, etc.)
    const dangerReason = checkDangerousCommand(command);
    if (dangerReason) {
      if (ctx.hasUI) {
        ctx.ui.notify(`🔒 Blocked dangerous bash command`, "warning");
      }
      return { block: true, reason: `Credential protection: ${dangerReason}` };
    }

    // Check if the command references a protected file path
    const pathMatch = checkCommandPath(command);
    if (!pathMatch) return undefined;

    // --- Tier 1 path in command: Hard block ---
    if (pathMatch.tier === 1) {
      if (ctx.hasUI) {
        ctx.ui.notify(`🔒 Blocked bash accessing credential: ${pathMatch.path}`, "warning");
      }
      return {
        block: true,
        reason: `Credential protection: bash command targets credential file (${pathMatch.path})`,
      };
    }

    // --- Tier 2 path in command: Ask permission ---
    if (ctx.hasUI) {
      const choice = await ctx.ui.select(
        `⚠️  Command may access credential-related path: ${pathMatch.path}\n\nCommand: ${command.slice(0, 100)}\n\nAllow?`,
        ["Allow this once", "Deny"],
      );
      if (choice !== "Allow this once") {
        ctx.ui.notify("Denied bash command", "info");
        return {
          block: true,
          reason: `Credential protection: user denied bash access to ${pathMatch.path}`,
        };
      }
      ctx.ui.notify("Allowed bash command", "info");
    } else {
      return {
        block: true,
        reason: `Credential protection: bash targets ${pathMatch.path} (no UI for confirmation)`,
      };
    }

    return undefined;
  });
}
