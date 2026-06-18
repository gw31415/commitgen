# `@gw31415/commitgen`

[![JSR](https://jsr.io/badges/@gw31415/commitgen)](https://jsr.io/@gw31415/commitgen)

Generate high-quality Conventional Commit messages for your staged git changes
using any OpenAI-compatible Chat Completions API. This Deno module analyzes your
staged diff and proposes commit messages that follow the
[Conventional Commits](https://www.conventionalcommits.org/) specification.

For large diffs, a **Map-Reduce** strategy is used: the diff is chunked by file
boundary, each chunk is summarized individually, and the summaries are synthesized
into final commit messages. This works with any Chat Completions API provider —
no vector store required.

---

## Features

- **AI-powered commit message generation** for staged git diffs
- **Conventional Commits** support (feat, fix, docs, etc.)
- **Map-Reduce** for large diffs (inline for small diffs)
- **Progress reporting** via `AsyncGenerator` events
- **OpenAI-compatible**: works with OpenAI, OpenRouter, and any compatible endpoint
- **Schema validation** for output

---

## Requirements

- [Git](https://git-scm.com/) (must be in your PATH)
- [Deno](https://deno.land/) v2.0+
- Staged changes in a git repository

---

## Usage Example

```ts
import { commitgen } from "jsr:@gw31415/commitgen";

for await (const event of commitgen({
  count: 3,                  // Number of commit message candidates
  cwd: Deno.cwd(),          // Path to your git repo
  model: "gpt-4o",          // Any model name
  apiKey: "sk-xxx...xxxx",  // Default: process.env["OPENAI_API_KEY"]
})) {
  if (event.type === "result") {
    console.log(event.messages);
    // [
    //   { conventionalCommitType: "feat", commitMsgContent: "add user login endpoint" },
    //   ...
    // ]
  } else if (event.type === "map_progress") {
    console.log(`Summarizing chunk ${event.current}/${event.total}...`);
  }
}
```

### OpenRouter

```ts
for await (const event of commitgen({
  count: 5,
  cwd: Deno.cwd(),
  model: "anthropic/claude-sonnet-4",
  baseURL: "https://openrouter.ai/api/v1",
  apiKey: "sk-or-...",
})) {
  if (event.type === "result") {
    console.log(event.messages);
  }
}
```

### Events

| Event | When | Fields |
|---|---|---|
| `info` | Start of generation | `diffBytes`, `strategy` (`"inline"` or `"map-reduce"`), `chunkCount` |
| `map_progress` | After each chunk is summarized (Map-Reduce only) | `current`, `total` |
| `reduce_start` | Before synthesis (Map-Reduce only) | — |
| `result` | Final result | `messages: CommitMessage[]` |

---

## Supported Conventional Commit Types

- `feat`: A new feature
- `fix`: A bug fix
- `docs`: Documentation only changes
- `style`: Changes that do not affect the meaning of the code (white-space,
  formatting, etc)
- `refactor`: A code change that neither fixes a bug nor adds a feature
- `perf`: A code change that improves performance
- `test`: Adding missing tests or correcting existing tests
- `build`: Changes that affect the build system or external dependencies
- `ci`: Changes to CI configuration files and scripts
- `chore`: Other changes that don't modify src or test files
- `revert`: Reverts a previous commit

---

## License

Apache-2.0. See [LICENSE](./LICENSE).
