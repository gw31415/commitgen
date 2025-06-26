# `@gw31415/commitgen`
[![JSR](https://jsr.io/badges/@gw31415/commitgen)](https://jsr.io/@gw31415/commitgen)

Generate high-quality Conventional Commit messages for your staged git changes
using OpenAI's API. This Deno module analyzes your staged diff and proposes
commit messages that follow the
[Conventional Commits](https://www.conventionalcommits.org/) specification. It
supports large diffs by leveraging OpenAI vector stores and validates output for
correctness.

---

## Features

- **AI-powered commit message generation** for staged git diffs
- **Conventional Commits** support (feat, fix, docs, etc.)
- **Handles large diffs** via OpenAI vector stores
- **Schema validation** for output

---

## Requirements

- [Git](https://git-scm.com/) (must be in your PATH)
- [OpenAI API key](https://platform.openai.com/)
- Staged changes in a git repository

---

## Usage Example

```ts
import { commitgen } from "jsr:@gw31415/commitgen";

const messages = await commitgen({
  count: 3, // Number of commit message candidates
  cwd: Deno.cwd(), // Path to your git repo
  model: "gpt-4o", // OpenAI model (must match tiktoken)
  apiKey: "sk-xxxxxxxxxxxxxxxxxxxxT3BlbkFJxxxxxxxxxxxxxxxxxxxx", // Default value is process.env['OPENAI_API_KEY'],
});

console.log(messages);
// [
//   { conventionalCommitType: "feat", commitMsgContent: "add user login endpoint" },
//   ...
// ]
```

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
