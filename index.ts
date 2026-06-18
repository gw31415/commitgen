import OpenAI from "@openai/openai";
import Ajv, { type JSONSchemaType } from "ajv";
import { encoding_for_model, type TiktokenModel } from "tiktoken";
import { spawn } from "@cross/utils";

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
 * Represents a commit message following the Conventional Commits specification.
 */
export interface CommitMessage {
  /**
   * The content of the commit message, excluding the Conventional Commit type tag.
   */
  commitMsgContent: string;
  /**
   * The type of the commit, as per Conventional Commits.
   *
   * - feat:     A new feature
   * - fix:      A bug fix
   * - docs:     Documentation only changes
   * - style:    Changes that do not affect the meaning of the code (white-space, formatting, etc)
   * - refactor: A code change that neither fixes a bug nor adds a feature
   * - perf:     A code change that improves performance
   * - test:     Adding missing tests or correcting existing tests
   * - build:    Changes that affect the build system or external dependencies
   * - ci:       Changes to CI configuration files and scripts
   * - chore:    Other changes that don't modify src or test files
   * - revert:   Reverts a previous commit
   */
  conventionalCommitType: (typeof conventionalCommitTypes)[number];
}

interface Attachments {
  vectorStoreId: string;
  fileId: string;
}

const DEFAULT_MAX_CHAR_COUNT = 40;

const commitMessagesSchema = (
  { count, maxCharCount }: { count: number; maxCharCount: number },
): JSONSchemaType<CommitMessage[]> => ({
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
        enum: conventionalCommitTypes,
      },
    },
    required: ["commitMsgContent", "conventionalCommitType"],
    additionalProperties: false,
  },
  minItems: count,
});

/**
 * Options for generating commit messages using the commitgen function.
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
   * The model to use for commit message generation.
   *
   * When `baseURL` is NOT set: must be an OpenAI Responses-compatible model
   * (e.g. "gpt-4o"). Tokenization uses tiktoken.
   *
   * When `baseURL` IS set: any model name supported by the target provider
   * (e.g. "anthropic/claude-sonnet-4" for OpenRouter).
   */
  model: string;
  /**
   * Optional API key for authentication.
   */
  apiKey?: string;
  /**
   * Base URL for an OpenAI-compatible API endpoint.
   *
   * When set, the Chat Completions API is used instead of the Responses API,
   * enabling support for providers like OpenRouter that do not implement the
   * Responses API. Large diffs are sent inline (no vector store / file upload).
   *
   * Example: "https://openrouter.ai/api/v1"
   */
  baseURL?: string;
  /**
   * The maximum character count for each commit message (default: 40).
   */
  maxCharCount?: number;
}

const inlineDiffTokenLimit = 4096;
const requestDiffSizeLimit = 1024 * 1024; // 1 MB

/**
 * Retrieves the staged git diff for the current working directory.
 *
 * Executes 'git diff --cached --ignore-all-space' to obtain the diff of staged changes.
 * Returns null if there are no staged changes (other than whitespace).
 * Throws an error if git is not accessible or the command fails.
 *
 * @param {string} cwd - The current working directory where git commands are executed.
 * @returns {Promise<string | null>} - A promise that resolves to the staged diff as a string, or null if no staged changes are found.
 * @throws {Error} - Throws if git execution fails.
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

/**
 * Validates commit message candidates against the JSON schema.
 */
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

/**
 * Commit message generation via OpenAI Responses API.
 *
 * Uses tiktoken for token counting and vector stores for large diffs.
 * This is the default path when `baseURL` is not set.
 */
async function commitgenViaResponses(
  options: CommitgenOptions,
  diff: string,
  maxCharCount: number,
): Promise<CommitMessage[]> {
  // Cast to satisfy tiktoken's TiktokenModel type (only used in this path)
  const model = options.model as TiktokenModel & OpenAI.ResponsesModel;

  function countTokens(text: string): number {
    const enc = encoding_for_model(model);
    try {
      return enc.encode(text).length;
    } finally {
      enc.free();
    }
  }

  const openai = new OpenAI({
    apiKey: options.apiKey,
  });
  let attachments: Attachments | null = null;

  try {
    if (countTokens(diff) > inlineDiffTokenLimit) {
      const size = new TextEncoder().encode(diff).length;
      if (size > requestDiffSizeLimit) {
        throw new Error(
          `Diff size (${size} bytes) exceeds the limit of ${requestDiffSizeLimit} bytes.`,
        );
      }
      try {
        const file = new File([diff], "diff.txt", { type: "text/plain" });
        const uploaded = await openai.files.create({
          file,
          purpose: "user_data",
        });
        const fileId = uploaded.id;

        const vectorStore = await openai.vectorStores.create({
          name: "commitgen-diff",
          expires_after: { anchor: "last_active_at", days: 1 },
        });
        const newAttachments: Attachments = {
          vectorStoreId: vectorStore.id,
          fileId,
        };
        attachments = newAttachments;
        await openai.vectorStores.files.create(newAttachments.vectorStoreId, {
          file_id: newAttachments.fileId,
        });
        // Wait for file indexing to complete
        let fileStatus = "";
        for (let i = 0; i < 20; i++) { // up to ~10 seconds
          const fileList = await openai.vectorStores.files.list(
            newAttachments.vectorStoreId,
          );
          const fileEntry = fileList.data.find(
            (f: { id: string; status?: string }) =>
              f.id === newAttachments.fileId,
          );
          fileStatus = fileEntry?.status || "";
          if (fileStatus === "completed") break;
          if (fileStatus === "failed") {
            throw new Error("File indexing failed in vector store");
          }
          await new Promise((res) => setTimeout(res, 500));
        }
        if (fileStatus !== "completed") {
          throw new Error("File indexing did not complete in time");
        }
      } catch (e) {
        throw new Error(
          "Failed to create vector store or attach file: " +
            (e instanceof Error ? e.message : String(e)),
        );
      }
    }

    // Call Responses API with file_search tool
    const instructions =
      `You are a commit message generator. Given the given diff.txt, propose commit message candidates as function calls.\n` +
      `Each commit message MUST represent the COMPLETE of diff.txt by itself. It is not acceptable to mention only part of the change.\n` +
      `Each commit message MUST be no more than ${maxCharCount} characters (excluding the Conventional Commit type tag).`;

    const tools: OpenAI.Responses.Tool[] = attachments
      ? [{
        type: "file_search",
        vector_store_ids: [attachments.vectorStoreId],
      }]
      : [];
    tools.push(
      {
        type: "function",
        name: "propose_commit_message",
        description:
          `Propose commit messages for a git diff, separating the conventional commit type and the message content. Each message must be no more than ${maxCharCount} characters (excluding the Conventional Commit type tag).`,
        parameters: {
          type: "object",
          properties: {
            args: commitMessagesSchema({ count: options.count, maxCharCount }),
          },
          required: ["args"],
          additionalProperties: false,
        },
        strict: true,
      },
    );

    const response = await openai.responses.create({
      model,
      instructions,
      input:
        `Please analyze the diff.txt and generate ${options.count} commit message candidates.` +
        (attachments ? "" : "\n\n```diff.txt\n" + diff + "\n```"),
      tools,
    });

    const outputs = response.output.filter(
      (i: { type: string; arguments?: string }) => i.type === "function_call",
    ).map(
      (i: { type: string; arguments?: string }) => i.arguments,
    );

    const output = outputs.flatMap((i: string) => JSON.parse(i)?.args ?? []);

    return validateCommitMessages(output, options.count, maxCharCount);
  } finally {
    if (attachments) {
      try {
        await openai.files.delete(attachments.fileId);
      } catch (e) {
        console.error("Failed to delete file:", e);
      }
      try {
        await openai.vectorStores.delete(attachments.vectorStoreId);
      } catch (e) {
        console.error("Failed to delete vector store:", e);
      }
    }
  }
}

/**
 * Commit message generation via Chat Completions API.
 *
 * Used when `baseURL` is set (e.g. for OpenRouter). Sends the diff inline
 * (no vector store / file upload). Uses function calling for structured output
 * with a fallback to parsing JSON content.
 */
async function commitgenViaChatCompletions(
  options: CommitgenOptions,
  diff: string,
  maxCharCount: number,
): Promise<CommitMessage[]> {
  const size = new TextEncoder().encode(diff).length;
  if (size > requestDiffSizeLimit) {
    throw new Error(
      `Diff size (${size} bytes) exceeds the limit of ${requestDiffSizeLimit} bytes.`,
    );
  }

  const openai = new OpenAI({
    apiKey: options.apiKey,
    baseURL: options.baseURL,
  });

  const instructions =
    `You are a commit message generator. Given the following git diff, propose commit message candidates as a function call.\n` +
    `Each commit message MUST represent the COMPLETE change by itself. It is not acceptable to mention only part of the change.\n` +
    `Each commit message MUST be no more than ${maxCharCount} characters (excluding the Conventional Commit type tag).`;

  const response = await openai.chat.completions.create({
    model: options.model,
    messages: [
      { role: "system", content: instructions },
      {
        role: "user",
        content:
          `Please analyze the diff and generate ${options.count} commit message candidates.\n\n` +
          "```diff\n" + diff + "\n```",
      },
    ],
    tools: [{
      type: "function",
      function: {
        name: "propose_commit_message",
        description:
          `Propose commit messages for a git diff, separating the conventional commit type and the message content. Each message must be no more than ${maxCharCount} characters (excluding the Conventional Commit type tag).`,
        parameters: {
          type: "object",
          properties: {
            args: commitMessagesSchema({ count: options.count, maxCharCount }),
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

  // Extract commit messages from function call (or fallback to content)
  let output: unknown;
  const toolCall = choice.message?.tool_calls?.[0];
  if (toolCall?.function?.arguments) {
    const parsed = JSON.parse(toolCall.function.arguments);
    output = parsed?.args ?? parsed;
  } else if (choice.message?.content) {
    // Fallback: try to parse the message content as JSON
    output = JSON.parse(choice.message.content);
  } else {
    throw new Error("No commit message candidates found in the response.");
  }

  return validateCommitMessages(output, options.count, maxCharCount);
}

/**
 * Generates commit message candidates based on the staged git diff.
 *
 * Uses the OpenAI Responses API by default. When `options.baseURL` is set,
 * falls back to the Chat Completions API for compatibility with OpenAI-compatible
 * providers like OpenRouter.
 *
 * @param {CommitgenOptions} options - The options for commit message generation.
 * @returns {Promise<CommitMessage[]>} - A promise that resolves to an array of commit message candidates.
 * @throws {Error} - Throws if there are no staged changes, the diff is too large, or the response is invalid.
 */
export async function commitgen(
  options: CommitgenOptions,
): Promise<CommitMessage[]> {
  const maxCharCount = options.maxCharCount ?? DEFAULT_MAX_CHAR_COUNT;

  // Get staged diff
  const diff = await getStagedDiff(options.cwd);
  if (!diff) {
    throw new Error(
      "No staged changes other than whitespace found. Have you only formatted the code?",
    );
  }

  if (options.baseURL) {
    return commitgenViaChatCompletions(options, diff, maxCharCount);
  }
  return commitgenViaResponses(options, diff, maxCharCount);
}

export default commitgen;
