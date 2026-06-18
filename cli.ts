import { commitgen } from "./index.ts";
import { parseArgs } from "@std/cli";
import { parse as parseToml } from "@std/toml";
import { join } from "@std/path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Raw representation of `~/.config/commitgen/config.toml`.
 */
interface ConfigFile {
  /** Default model name. */
  model?: string;
  /** Default number of candidates. */
  count?: number;
  /** API key (stored in plain text — prefer env vars). */
  api_key?: string;
  /** OpenAI-compatible base URL. */
  base_url?: string;
  /** Default max characters per message (excluding type tag). */
  max_chars?: number;
  /** Override which environment variables to read. */
  env?: {
    /** Env var name for API key (default: `OPENAI_API_KEY`). */
    api_key?: string;
    /** Env var name for base URL (default: `OPENAI_BASE_URL`). */
    base_url?: string;
  };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const VERSION = "0.3.0";

const DEFAULT_MODEL = "gpt-5.1-codex-mini";
const DEFAULT_COUNT = 3;
const DEFAULT_MAX_CHARS = 40;
const DEFAULT_API_KEY_ENV = "OPENAI_API_KEY";
const DEFAULT_BASE_URL_ENV = "OPENAI_BASE_URL";

// ---------------------------------------------------------------------------
// Config file
// ---------------------------------------------------------------------------

/**
 * Returns the path to the config file.
 *
 * Respects `XDG_CONFIG_HOME`; falls back to `~/.config/commitgen/config.toml`.
 */
function getConfigPath(): string {
  const xdg = Deno.env.get("XDG_CONFIG_HOME");
  if (xdg) return join(xdg, "commitgen", "config.toml");
  const home = Deno.env.get("HOME");
  if (home) return join(home, ".config", "commitgen", "config.toml");
  return join(".config", "commitgen", "config.toml");
}

/**
 * Loads the config file from disk.
 *
 * Returns `{}` when the file does not exist (not an error).
 * Throws on malformed TOML.
 */
function loadConfig(): ConfigFile {
  const configPath = getConfigPath();
  try {
    const text = Deno.readTextFileSync(configPath);
    return parseToml(text) as unknown as ConfigFile;
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return {};
    throw new Error(
      `Failed to read config file (${configPath}): ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
  }
}

// ---------------------------------------------------------------------------
// Option resolution
// ---------------------------------------------------------------------------

/**
 * Resolves CLI options by merging four layers (highest priority first):
 *
 * 1. CLI flags
 * 2. Environment variables (variable names configurable via `[env]`)
 * 3. Config file (`~/.config/commitgen/config.toml`)
 * 4. Built-in defaults
 */
function resolveOptions(
  args: ReturnType<typeof parseArgs>,
  config: ConfigFile,
) {
  // Determine which env vars to read (configurable via [env] section)
  const apiKeyEnv = config.env?.api_key ?? DEFAULT_API_KEY_ENV;
  const baseURLenv = config.env?.base_url ?? DEFAULT_BASE_URL_ENV;

  // ── Model ──────────────────────────────────────────────────────────────
  const model = args.model ?? config.model ?? DEFAULT_MODEL;

  // ── Count ──────────────────────────────────────────────────────────────
  const count = Number(args.count ?? config.count ?? DEFAULT_COUNT);
  if (!Number.isInteger(count) || count < 1) {
    throw new Error(`count must be a positive integer, got: ${count}`);
  }

  // ── API key ────────────────────────────────────────────────────────────
  const apiKey = args["api-key"] ??
    Deno.env.get(apiKeyEnv) ??
    config.api_key;

  // ── Base URL ───────────────────────────────────────────────────────────
  const baseURL = args["base-url"] ??
    Deno.env.get(baseURLenv) ??
    config.base_url;

  // ── Max chars ──────────────────────────────────────────────────────────
  const maxCharCount = Number(
    args["max-chars"] ?? config.max_chars ?? DEFAULT_MAX_CHARS,
  );
  if (!Number.isInteger(maxCharCount) || maxCharCount < 1) {
    throw new Error(
      `max-chars must be a positive integer, got: ${maxCharCount}`,
    );
  }

  // ── Cwd ────────────────────────────────────────────────────────────────
  const positional = args._ as string[];
  const cwd = positional[0] ?? Deno.cwd();
  if (positional.length > 1) {
    throw new Error(
      `too many positional arguments: expected 0-1, got ${positional.length}`,
    );
  }

  return { model, count, apiKey, baseURL, maxCharCount, cwd };
}

// ---------------------------------------------------------------------------
// Help & version
// ---------------------------------------------------------------------------

function buildHelp(opts: {
  model: string;
  count: number;
  apiKey?: string;
  baseURL?: string;
  maxCharCount: number;
  cwd: string;
}): string {
  const apiKeyDisplay = opts.apiKey ? "set" : "not set";
  const baseURLDisplay = opts.baseURL ?? "not set";
  const lines: string[] = [
    `commitgen v${VERSION} — Conventional Commit message generator`,
    ``,
    `Usage:`,
    `  commitgen [options] [cwd]`,
    ``,
    `Positional:`,
    `  [cwd]                    Git repository path (default: current directory, effective: ${opts.cwd})`,
    ``,
    `Options:`,
    `  -m, --model <model>      Model name (default: ${DEFAULT_MODEL}, effective: ${opts.model})`,
    `  -n, --count <n>          Number of candidates (default: ${DEFAULT_COUNT}, effective: ${opts.count})`,
    `  -k, --api-key <key>      API key (env: ${DEFAULT_API_KEY_ENV}, effective: ${apiKeyDisplay})`,
    `  -u, --base-url <url>     OpenAI-compatible base URL (env: ${DEFAULT_BASE_URL_ENV}, effective: ${baseURLDisplay})`,
    `  -c, --max-chars <n>      Max chars per message, excluding type tag (default: ${DEFAULT_MAX_CHARS}, effective: ${opts.maxCharCount})`,
    `  -h, --help               Show this help message`,
    `  -V, --version            Show version`,
    ``,
    `Priority: CLI flags > environment variables > config file > built-in defaults`,
  ];

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs(Deno.args, {
    string: ["model", "count", "api-key", "base-url", "max-chars"],
    boolean: ["help", "version"],
    alias: {
      m: "model",
      n: "count",
      k: "api-key",
      u: "base-url",
      c: "max-chars",
      h: "help",
      V: "version",
    },
  });

  if (args.help) {
    const config = loadConfig();
    const helpOpts = resolveOptions(args, config);
    console.log(buildHelp(helpOpts));
    return;
  }

  if (args.version) {
    console.log(VERSION);
    return;
  }

  try {
    const config = loadConfig();
    const options = resolveOptions(args, config);

    for await (const event of commitgen(options)) {
      if (event.type === "result") {
        for (const msg of event.messages) {
          console.log(`${msg.conventionalCommitType}: ${msg.commitMsgContent}`);
        }
      }
      // Progress events (info, map_progress, reduce_start) are silently
      // ignored. A progress display will be added in a future version.
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(`Error: ${message}`);
    Deno.exit(1);
  }
}

if (import.meta.main) {
  main();
}
