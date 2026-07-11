---
module: System
date: 2026-06-20
problem_type: build_error
component: development_workflow
symptoms:
  - "sh: 1: vite: not found during tauri-action beforeBuildCommand"
  - "beforeBuildCommand `pnpm -C src-svelte build` failed with exit code 1"
  - "All platforms fail at the 'Build with Tauri' step after Rust finishes compiling"
  - "Recurred in a second workflow that had its own copy of the install step"
root_cause: incomplete_setup
resolution_type: workflow_improvement
severity: high
tags: [tauri, sveltekit, pnpm, monorepo, github-actions, ci, vite]
---

# Troubleshooting: CI Tauri build fails with `vite: not found` (frontend deps never installed)

## Problem
Every CI Tauri build failed at the `Build with Tauri` step with `sh: vite: not found`. The repo has **two independent pnpm projects** (`app/` and `app/src-svelte/`), each with its own `pnpm-lock.yaml`. CI only ran `pnpm install` in `app/`, so the SvelteKit frontend's dependencies (including `vite`) were never installed, and Tauri's `beforeBuildCommand` (`pnpm -C src-svelte build`) had no `vite` to run.

## Environment
- Module: System-wide (GitHub Actions CI)
- Stack: Tauri 2 + SvelteKit (Svelte 5) + pnpm; `tauri-apps/tauri-action`
- Affected Component: `.github/workflows/build.yml` (reusable build) and `.github/workflows/release.yml` (standalone `build-linux` job)
- Date: 2026-06-20

## Symptoms
- `sh: 1: vite: not found` (Linux) / `sh: vite: command not found` (macOS) in the `Build with Tauri` step log.
- `Running beforeBuildCommand 'pnpm -C src-svelte build'` immediately followed by `vite build` then the not-found error.
- Failure happens **after** Rust fully compiles, so each run wastes ~3-10 min before failing.
- Identical failure recurred later in `release.yml`'s `build-linux` job, which had its own copy of the install step.

## What Didn't Work

**Attempted diagnosis 1:** Assumed a platform-specific toolchain problem because all 4 matrix platforms failed.
- **Why it wasn't it:** they all failed at the *same* step (`Build with Tauri`) with the *same* `vite` error, which points at the shared frontend build, not anything per-platform.

**Confirmation step:** Built the frontend locally with `pnpm -C src-svelte build`.
- It **succeeded locally**, because `app/src-svelte/node_modules` already existed on the dev machine. That proved the gap was CI-only: CI never installed `src-svelte`.

## Solution

Install **both** pnpm projects in the CI install step, mirroring the documented local command (`pnpm install && pnpm -C src-svelte install`).

**Code change** (`.github/workflows/build.yml`):
```yaml
# Before (broken):
- name: Install app dependencies
  run: |
    cd app
    pnpm install

# After (fixed):
- name: Install app dependencies
  run: |
    cd app
    # src-svelte is a separate pnpm project; install it too or `vite` is
    # missing when tauri-action runs `pnpm -C src-svelte build`.
    pnpm install
    pnpm -C src-svelte install
```

The fix had to be applied **twice**: once in the reusable `build.yml` (commit `81b83af`), then again in `release.yml`'s standalone `build-linux` job, which has its own install step (commit `9b0aa14`). The recurrence is the real lesson, see Prevention.

## Why This Works
1. **Root cause:** `app/` and `app/src-svelte/` are two separate pnpm projects. There is no `pnpm-workspace.yaml` linking them, and `src-svelte` has its own `package.json` + `pnpm-lock.yaml`. `pnpm install` run in `app/` installs only `app/`'s dependencies, not `src-svelte`'s.
2. **Why `vite` specifically:** `vite` is a `devDependency` of `src-svelte`. Until `src-svelte` is installed, `app/src-svelte/node_modules/.bin/vite` does not exist.
3. **Why it surfaced so late:** Tauri runs `beforeBuildCommand` (`pnpm -C src-svelte build` → `vite build`) part-way through the bundle step, after the Rust crate compiles. So the build burns the full Rust compile before failing on the missing frontend tool.
4. **Why it worked locally but not in CI:** local dev machines have `src-svelte/node_modules` from a prior manual `pnpm -C src-svelte install`; CI starts clean.

## Prevention
- **Any** CI/build path that triggers the frontend build must install both projects. Treat `pnpm install && pnpm -C src-svelte install` (from `CLAUDE.md`) as the canonical install for this repo.
- **When duplicating or consolidating build workflows, audit every job that builds the app for the dual install.** This bug recurred precisely because one workflow (`release.yml`'s `build-linux`) reimplemented the install step instead of calling the shared `build.yml`. Prefer thin callers of the reusable workflow so the install lives in one place.
- Catch early: grep workflows for an install step that runs `pnpm install` without a following `pnpm -C src-svelte install`.
- This was one of several latent CI bugs exposed by the first real workflow run (the repo had never run CI before). Related siblings from the same hardening pass: a pnpm major-version mismatch (CI pinned pnpm 8 against `lockfileVersion 9.0` lockfiles) and a macOS empty-`APPLE_CERTIFICATE` regression from collapsing signed/unsigned build steps into one.

## Related Issues
No related solution docs yet. Same CI-hardening session also fixed (not separately documented): pnpm 8 → 10 to match v9 lockfiles, and splitting the Tauri build into signed/unsigned steps so an empty `APPLE_CERTIFICATE` no longer triggers a `security import` failure on unsigned macOS builds.
