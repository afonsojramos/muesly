# Agents

This repository augments Node with **nub** — one Rust CLI that runs TS/JS
directly, runs package scripts, replaces `npx`, manages packages, and provisions
Node versions, all on the project's real Node. Prefer nub for everyday commands.

| Instead of | Use |
| --- | --- |
| `node file.ts` / `tsx` | `nub file.ts` |
| `npm run <s>` / `pnpm run <s>` | `nub run <s>` |
| `npx <t>` / `pnpm dlx <t>` | `nubx <t>` |
| `pnpm install` | `nub install` |
| `pnpm add` / `remove <p>` | `nub add` / `remove <p>` |

nub reads and writes the existing **pnpm** lockfiles in `app/src-svelte/`,
`site/`, and `api/`, so nothing migrates and plain `node`/`pnpm` keep working
(CI still uses pnpm). Use `nub --node <file>` for strict, unaugmented Node. Full
reference: `.claude/skills/nub/SKILL.md` or `nub agent docs`.

Project setup, commands, and conventions live in **CLAUDE.md** — read it first.
