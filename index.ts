import OpenAI from "jsr:@openai/openai";
import Ajv, { type JSONSchemaType } from "npm:ajv";
import { encoding_for_model, type TiktokenModel } from "npm:tiktoken";
import { spawn } from "jsr:@cross/utils";

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

const commitMessagesSchema: (c: number) => JSONSchemaType<CommitMessage[]> = (
  count,
) => ({
  type: "array",
  items: {
    type: "object",
    properties: {
      commitMsgContent: {
        type: "string",
        description:
          "Commit message content, without the Conventional Commit type tag.",
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
   * The model to use for tokenization and OpenAI responses.
   */
  model: TiktokenModel & OpenAI.ResponsesModel;
  /**
   * Optional API key for OpenAI authentication.
   */
  apiKey?: string;
}

const inlineDiffTokenLimit = 4096;
const requestDiffSizeLimit = 1024 * 1024; // 1 MB

/**
 * Generates commit message candidates based on the staged git diff using OpenAI's API.
 * Handles large diffs by uploading them to a vector store if necessary.
 * Validates the output against a JSON schema and cleans up temporary resources.
 *
 * @param {CommitgenOptions} options - The options for commit message generation.
 * @returns {Promise<CommitMessage[]>} - A promise that resolves to an array of commit message candidates.
 * @throws {Error} - Throws if there are no staged changes, the diff is too large, or the OpenAI response is invalid.
 */
export async function commitgen(
  options: CommitgenOptions,
): Promise<CommitMessage[]> {
  const model = options.model;

  function countTokens(text: string): number {
    const enc = encoding_for_model(model);
    try {
      return enc.encode(text).length;
    } finally {
      enc.free();
    }
  }

  // Get staged diff
  const { stdout: diff, code } = await spawn(
    [
      "git",
      "diff",
      "--cached",
      "--ignore-all-space",
    ],
    undefined,
    options.cwd,
  ).catch(() => ({ stdout: null, code: 127 } as const));
  if (code !== 0) {
    throw new Error(
      "Execution of git failed. Ensure you have access to git in your PATH and that you are in a git repository.",
    );
  }
  if (!diff.trim()) {
    throw new Error(
      "No staged changes other than whitespace found. Have you only formatted the code?",
    );
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
          const fileEntry = fileList.data.find((f) =>
            f.id === newAttachments.fileId
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
      "Each commit message MUST represent the COMPLETE of diff.txt by itself. It is not acceptable to mention only part of the change.";

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
          "Propose commit messages for a git diff, separating the conventional commit type and the message content.",
        parameters: {
          type: "object",
          properties: {
            args: commitMessagesSchema(options.count),
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

    const outputs = response.output.filter((i) => i.type === "function_call")
      .map(
        (i) => i.arguments,
      );

    const output = outputs.flatMap((i) => JSON.parse(i)?.args ?? []);

    // Validate output
    const ajv = new Ajv.default();
    const validate = ajv.compile(commitMessagesSchema(options.count));
    if (!validate(output)) {
      throw new Error(
        "OpenAI response did not match schema: " +
          JSON.stringify(validate.errors),
      );
    }

    return output.slice(0, options.count);
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

export default commitgen;
