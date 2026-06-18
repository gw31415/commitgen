import OpenAI from "@openai/openai";
import Ajv, { type JSONSchemaType } from "ajv";
import { spawn } from "@cross/utils";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

const conventionalCommitTypes = [
  "feat",
  "fix",
  "docs",
  "style",
  "refactor",
  "perf",
  "test",
  "build",
  "ci",
  "chore",
  "revert",
] as const;

/**
 * Conventional Commit type tag.
 */
export type ConventionalCommitType = (typeof conventionalCommitTypes)[number];

/**
 * Represents a commit message following the Conventional Commits specification.
 */
export interface CommitMessage {
  /**
   * The content of the commit message, excluding the Conventional Commit type tag.
   */
  commitMsgContent: string;
  /**
   * The type of the commit, as per Conventional Commits.
   */
  conventionalCommitType: ConventionalCommitType;
}

/**
 * Options for {@link commitgen}.
 */
export interface CommitgenOptions {
  /**
   * The number of commit message candidates to generate.
   */
  count: number;
  /**
   * The current working directory where git commands are executed.
   */
  cwd: string;
  /**
   * The model to use (e.g. `"gpt-4o"` or `"anthropic/claude-sonnet-4"` for OpenRouter).
   */
  model: string;
  /**
   * Optional API key for authentication.
   */
  apiKey?: string;
  /**
   * Base URL for an OpenAI-compatible Chat Completions endpoint.
   *
   * When set, requests are sent to this endpoint instead of OpenAI's default.
   * Example: `"https://openrouter.ai/api/v1"`.
   */
  baseURL?: string;
  /**
   * Maximum character count for each commit message (default: 40).
   */
  maxCharCount?: number;
}

/**
 * Events yielded by {@link commitgen} during generation.
 *
 * - `info`:           Sent once at the start with strategy and diff metadata.
 * - `map_progress`:   (Map-Reduce only) Sent after each chunk is summarized.
 * - `reduce_start`:   (Map-Reduce only) Sent before the reduce/synthesis step.
 * - `result`:         Sent last with the generated commit messages.
 */
export type CommitgenEvent =
  | {
    type: "info";
    diffBytes: number;
    strategy: "inline" | "map-reduce";
    chunkCount: number;
  }
  | { type: "map_progress"; current: number; total: number }
  | { type: "reduce_start" }
  | { type: "result"; messages: CommitMessage[] };

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_MAX_CHAR_COUNT = 40;
/** Per-chunk size for the Map phase (~5K tokens). */
const CHUNK_SIZE_BYTES = 20_000;
/** Diffs at or below this size are sent inline without chunking (~12K tokens). */
const INLINE_THRESHOLD_BYTES = 48_000;
/** Hard upper limit on total diff size. */
const MAX_DIFF_BYTES = 1024 * 1024; // 1 MB

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function byteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

// ---------------------------------------------------------------------------
// Schema & validation
// ---------------------------------------------------------------------------

function commitMessagesSchema(
  { count, maxCharCount }: { count: number; maxCharCount: number },
): JSONSchemaType<CommitMessage[]> {
  return {
    type: "array",
    items: {
      type: "object",
      properties: {
        commitMsgContent: {
          type: "string",
          description:
            `Commit message content, without the Conventional Commit type tag. Max ${maxCharCount} characters.`,
          maxLength: maxCharCount,
        },
        conventionalCommitType: {
          type: "string",
          description: "One of the Conventional Commit types.",
          enum: [...conventionalCommitTypes],
        },
      },
      required: ["commitMsgContent", "conventionalCommitType"],
      additionalProperties: false,
    },
    minItems: count,
  };
}

function validateCommitMessages(
  output: unknown,
  count: number,
  maxCharCount: number,
): CommitMessage[] {
  const ajv = new Ajv.default();
  const validate = ajv.compile(commitMessagesSchema({ count, maxCharCount }));
  if (!validate(output)) {
    throw new Error(
      "Response did not match schema: " + JSON.stringify(validate.errors),
    );
  }
  return (output as CommitMessage[]).slice(0, count);
}

// ---------------------------------------------------------------------------
// Git
// ---------------------------------------------------------------------------

/**
 * Retrieves the staged git diff for the given working directory.
 *
 * Returns `null` when there are no staged changes (other than whitespace).
 *
 * @throws {Error} if git execution fails.
 */
export async function getStagedDiff(cwd: string): Promise<string | null> {
  const { stdout: diff, code } = await spawn(
    ["git", "diff", "--cached", "--ignore-all-space"],
    undefined,
    cwd,
  ).catch(() => ({ stdout: null, code: 127 } as const));
  if (code !== 0) {
    throw new Error(
      "Execution of git failed. Ensure you have access to git in your PATH and that you are in a git repository.",
    );
  }
  if (!diff.trim()) {
    return null;
  }
  return diff;
}

// ---------------------------------------------------------------------------
// Chunking (for Map-Reduce)
// ---------------------------------------------------------------------------

/**
 * Splits a git diff into chunks suitable for individual summarization.
 *
 * Strategy:
 * 1. Split by file boundary (`diff --git`).
 * 2. If a single file exceeds `maxChunkBytes`, split by lines.
 * 3. Merge adjacent small parts until they approach `maxChunkBytes`.
 */
export function chunkDiff(
  diff: string,
  maxChunkBytes: number = CHUNK_SIZE_BYTES,
): string[] {
  // 1. File-level split
  const fileParts = diff
    .split(/(?=^diff --git )/m)
    .map((s) => s.trim())
    .filter(Boolean);

  // 2. Line-level split for oversized files
  const splitParts: string[] = [];
  for (const part of fileParts) {
    if (byteLength(part) <= maxChunkBytes) {
      splitParts.push(part);
      continue;
    }
    const lines = part.split("\n");
    let buf = "";
    for (const line of lines) {
      const candidate = buf ? buf + "\n" + line : line;
      if (byteLength(candidate) > maxChunkBytes && buf) {
        splitParts.push(buf);
        buf = line;
      } else {
        buf = candidate;
      }
    }
    if (buf.trim()) splitParts.push(buf);
  }

  // 3. Merge small parts
  const chunks: string[] = [];
  let current = "";
  for (const part of splitParts) {
    const candidate = current ? current + "\n" + part : part;
    if (byteLength(candidate) > maxChunkBytes && current) {
      chunks.push(current);
      current = part;
    } else {
      current = candidate;
    }
  }
  if (current.trim()) chunks.push(current);

  return chunks;
}

// ---------------------------------------------------------------------------
// Internal: API helpers
// ---------------------------------------------------------------------------

function createClient(options: CommitgenOptions): OpenAI {
  return new OpenAI({
    apiKey: options.apiKey,
    baseURL: options.baseURL,
  });
}

/**
 * Map phase: summarize a single diff chunk.
 */
async function summarizeChunk(
  client: OpenAI,
  model: string,
  chunk: string,
): Promise<string> {
  const response = await client.chat.completions.create({
    model,
    messages: [
      {
        role: "system",
        content:
          "You are a code change analyzer. Summarize the following git diff chunk concisely. " +
          "Focus on WHAT changed and WHY, not line-by-line details. Keep it under 200 words.",
      },
      {
        role: "user",
        content: "```diff\n" + chunk + "\n```",
      },
    ],
  });
  return response.choices[0]?.message?.content ?? "";
}

/**
 * Generate commit messages via Chat Completions API with function calling.
 *
 * Used for both the inline path (full diff) and the reduce path (combined summaries).
 */
async function generateCommitMessages(
  client: OpenAI,
  model: string,
  count: number,
  maxCharCount: number,
  content: string,
  isSummary: boolean,
): Promise<CommitMessage[]> {
  const systemContent = isSummary
    ? "You are a commit message generator. Based on the following summaries of code changes, propose commit message candidates as a function call. " +
      "Each commit message MUST represent the COMPLETE change by itself. It is not acceptable to mention only part of the change. " +
      `Each commit message MUST be no more than ${maxCharCount} characters (excluding the Conventional Commit type tag).`
    : "You are a commit message generator. Given the following git diff, propose commit message candidates as a function call. " +
      "Each commit message MUST represent the COMPLETE change by itself. It is not acceptable to mention only part of the change. " +
      `Each commit message MUST be no more than ${maxCharCount} characters (excluding the Conventional Commit type tag).`;

  const userContent = isSummary
    ? `Please analyze the change summaries and generate ${count} commit message candidates.\n\n${content}`
    : `Please analyze the diff and generate ${count} commit message candidates.\n\n\`\`\`diff\n${content}\n\`\`\``;

  const response = await client.chat.completions.create({
    model,
    messages: [
      { role: "system", content: systemContent },
      { role: "user", content: userContent },
    ],
    tools: [{
      type: "function",
      function: {
        name: "propose_commit_message",
        description:
          `Propose commit messages, separating the conventional commit type and the message content. Each message must be no more than ${maxCharCount} characters (excluding the Conventional Commit type tag).`,
        parameters: {
          type: "object",
          properties: {
            args: commitMessagesSchema({ count, maxCharCount }),
          },
          required: ["args"],
          additionalProperties: false,
        },
      },
    }],
    tool_choice: {
      type: "function",
      function: { name: "propose_commit_message" },
    },
  });

  const choice = response.choices[0];
  if (!choice) {
    throw new Error("No response choices returned.");
  }

  // Extract from function call, fallback to JSON content
  let output: unknown;
  const toolCall = choice.message?.tool_calls?.[0];
  if (toolCall?.function?.arguments) {
    const parsed = JSON.parse(toolCall.function.arguments);
    output = parsed?.args ?? parsed;
  } else if (choice.message?.content) {
    output = JSON.parse(choice.message.content);
  } else {
    throw new Error("No commit message candidates found in the response.");
  }

  return validateCommitMessages(output, count, maxCharCount);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/**
 * Generate commit message candidates from staged git changes.
 *
 * Yields {@link CommitgenEvent} items to report progress.
 * The final event (`type: "result"`) carries the generated messages.
 *
 * **Strategy**:
 * - Small diffs (≤ ~12K tokens / 48 KB) are sent inline in a single request.
 * - Large diffs are processed with Map-Reduce:
 *   1. **Map**: diff is chunked by file, each chunk summarized individually.
 *   2. **Reduce**: summaries are combined and fed to the model for final generation.
 *
 * @example
 * ```ts
 * for await (const event of commitgen({ count: 5, cwd: ".", model: "gpt-4o" })) {
 *   if (event.type === "result") {
 *     console.log(event.messages);
 *   } else {
 *     console.log(`Progress: ${event.type}`);
 *   }
 * }
 * ```
 */
export async function* commitgen(
  options: CommitgenOptions,
): AsyncGenerator<CommitgenEvent> {
  const maxCharCount = options.maxCharCount ?? DEFAULT_MAX_CHAR_COUNT;
  const model = options.model;

  // Get staged diff
  const diff = await getStagedDiff(options.cwd);
  if (!diff) {
    throw new Error(
      "No staged changes other than whitespace found. Have you only formatted the code?",
    );
  }

  const diffBytes = byteLength(diff);
  if (diffBytes > MAX_DIFF_BYTES) {
    throw new Error(
      `Diff size (${diffBytes} bytes) exceeds the limit of ${MAX_DIFF_BYTES} bytes.`,
    );
  }

  const client = createClient(options);

  // ── Inline path (small diff) ──────────────────────────────────────────
  if (diffBytes <= INLINE_THRESHOLD_BYTES) {
    yield {
      type: "info",
      diffBytes,
      strategy: "inline",
      chunkCount: 1,
    };
    const messages = await generateCommitMessages(
      client,
      model,
      options.count,
      maxCharCount,
      diff,
      false,
    );
    yield { type: "result", messages };
    return;
  }

  // ── Map-Reduce path (large diff) ──────────────────────────────────────
  const chunks = chunkDiff(diff);
  yield {
    type: "info",
    diffBytes,
    strategy: "map-reduce",
    chunkCount: chunks.length,
  };

  // Map: summarize each chunk sequentially (for progress visibility)
  const summaries: string[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const summary = await summarizeChunk(client, model, chunks[i]);
    summaries.push(summary);
    yield {
      type: "map_progress",
      current: i + 1,
      total: chunks.length,
    };
  }

  // Reduce: synthesize commit messages from summaries
  yield { type: "reduce_start" };
  const combinedSummary = summaries
    .map((s, i) => `## Part ${i + 1}\n${s}`)
    .join("\n\n");
  const messages = await generateCommitMessages(
    client,
    model,
    options.count,
    maxCharCount,
    combinedSummary,
    true,
  );
  yield { type: "result", messages };
}

export default commitgen;
