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
// Rich progress output (stderr)
// ---------------------------------------------------------------------------

/** ANSI escape sequences for colored stderr output. */
const c = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
} as const;

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** Formats a byte count as a human-readable string (e.g. `12.3 KB`). */
function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** Renders a compact progress bar string. */
function progressBar(current: number, total: number, width = 10): string {
  const filled = total > 0 ? Math.round((current / total) * width) : 0;
  return `${c.cyan}${"█".repeat(filled)}${c.dim}${
    "░".repeat(width - filled)
  }${c.reset}`;
}

/**
 * Streaming progress display written to stderr.
 *
 * Each visible transition is driven by a {@link CommitgenEvent} yielded from
 * the `commitgen()` async generator, while an animated spinner ticks during the
 * async gaps between yields — making the generator's streaming nature visible.
 *
 * On a non-TTY stderr the animation is suppressed and phase changes are emitted
 * as plain lines instead, so logs stay clean.
 */
class ProgressDisplay {
  private intervalId?: number;
  private frame = 0;
  private spinnerMsg = "";
  private readonly isTTY: boolean;
  private readonly encoder = new TextEncoder();

  constructor() {
    this.isTTY = Deno.stderr.isTerminal();
  }

  private write(msg: string): void {
    Deno.stderr.writeSync(this.encoder.encode(msg));
  }

  private renderSpinner(): void {
    const f = SPINNER_FRAMES[this.frame % SPINNER_FRAMES.length];
    this.write(
      `\r\x1b[K${c.yellow}${f}${c.reset} ${c.dim}${this.spinnerMsg}${c.reset}`,
    );
  }

  /** Prints a persistent line (kept above any running spinner). */
  line(msg: string): void {
    if (this.isTTY && this.intervalId !== undefined) {
      this.write(`\r\x1b[K${msg}\n`);
      this.renderSpinner();
    } else {
      this.write(`${msg}\n`);
    }
  }

  /** Begins an animated spinner (TTY) or emits the message once (non-TTY). */
  startSpinner(msg: string): void {
    this.spinnerMsg = msg;
    if (!this.isTTY) {
      this.write(`${msg}\n`);
      return;
    }
    this.renderSpinner();
    this.intervalId = setInterval(() => {
      this.frame++;
      this.renderSpinner();
    }, 80);
  }

  /** Updates the spinner's label live without breaking the animation. */
  updateSpinner(msg: string): void {
    if (msg === this.spinnerMsg) return;
    this.spinnerMsg = msg;
    if (!this.isTTY) {
      this.write(`${msg}\n`);
      return;
    }
    this.renderSpinner();
  }

  /** Stops the spinner and prints a final success/failure line. */
  finish(success: boolean, msg: string): void {
    if (this.intervalId !== undefined) {
      clearInterval(this.intervalId);
      this.intervalId = undefined;
    }
    if (this.isTTY) this.write(`\r\x1b[K`);
    const icon = success ? `${c.green}✓${c.reset}` : `${c.red}✗${c.reset}`;
    this.write(`${icon} ${msg}\n`);
  }

  /** Stops any running animation; wipes the spinner line on error paths. */
  close(): void {
    if (this.intervalId !== undefined) {
      clearInterval(this.intervalId);
      this.intervalId = undefined;
      if (this.isTTY) this.write(`\r\x1b[K`);
    }
  }
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

    const progress = new ProgressDisplay();
    try {
      for await (const event of commitgen(options)) {
        switch (event.type) {
          case "info": {
            const detail = event.strategy === "map-reduce"
              ? `${event.strategy} · ${event.chunkCount} chunks`
              : event.strategy;
            progress.line(
              `${c.cyan}◆${c.reset} Staged diff ${c.bold}${
                formatBytes(event.diffBytes)
              }${c.reset} ${c.dim}— ${detail}${c.reset}`,
            );
            progress.startSpinner(
              event.strategy === "map-reduce"
                ? `Mapping ${
                  progressBar(0, event.chunkCount)
                } 0/${event.chunkCount}`
                : "Generating commit messages",
            );
            break;
          }
          case "map_progress":
            progress.updateSpinner(
              `Mapping ${
                progressBar(event.current, event.total)
              } ${event.current}/${event.total}`,
            );
            break;
          case "reduce_start":
            progress.updateSpinner("Reducing summaries → commit messages");
            break;
          case "result": {
            const n = event.messages.length;
            progress.finish(
              true,
              `Generated ${c.bold}${n}${c.reset} candidate${
                n === 1 ? "" : "s"
              }`,
            );
            for (const msg of event.messages) {
              console.log(
                `${msg.conventionalCommitType}: ${msg.commitMsgContent}`,
              );
            }
            break;
          }
        }
      }
    } finally {
      progress.close();
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(`${c.red}✗${c.reset} Error: ${message}`);
    Deno.exit(1);
  }
}

if (import.meta.main) {
  main();
}
