---
name: ai-term-release
description: Project-specific release and CI trigger workflow for ai-term. Use when Codex needs to commit and push ai-term changes, publish or force-update develop/test tags, republish official release tags such as v0.1.0, trigger the GitHub Release workflow, or verify GitHub Actions runs for this repository.
---

# AI Term Release

## Overview

Use this skill for ai-term release plumbing: move local fixes onto `develop`, push a test tag to trigger the Release workflow, republish an official tag, and verify GitHub Actions status.

The repository remote is `origin` at `https://github.com/tf1997/ai-term.git`. The release workflow is `.github/workflows/release.yml` and triggers on any pushed tag (`tags: ['*']`).

## Preflight

Run these checks before changing refs:

```bash
git status --short --branch
git log --oneline --decorate --graph --max-count=8
git remote -v
sed -n '1,80p' .github/workflows/release.yml
```

Confirm the working branch is `develop` for development fixes. If local changes exist, review `git diff --stat` and targeted diffs before committing.

## Validation

For frontend or UI-check changes, run:

```bash
cd frontend && npm run test:ui
```

For Rust/backend changes, run from `src-tauri`:

```bash
cargo fmt
cargo check
cargo test
```

For narrow backend changes, a focused `cargo test domain::connection::sftp` is useful, but run full `cargo test` before release/tag work when feasible.

## Commit And Push Develop

Keep release-fix commits on `develop` unless the user explicitly asks otherwise.

```bash
git add <changed-files>
git commit -m "<type>: <summary>"
git push -u origin develop
```

If `develop` already tracks `origin/develop`, use:

```bash
git push
```

## Test Tag

Use a non-version test tag so it does not look like a real release. Prefer a tag that includes the short commit SHA:

```bash
short_sha="$(git rev-parse --short HEAD)"
test_tag="test-ui-check-${short_sha}"
git tag -f -a "$test_tag" -m "Test release build for ${short_sha}" HEAD
git push origin "+refs/tags/${test_tag}:refs/tags/${test_tag}"
```

If the user asks to rerun the same previous test tag, force-update that exact tag instead:

```bash
git tag -f -a test-ui-check-fefdd09 -m "Test release build" HEAD
git push origin +refs/tags/test-ui-check-fefdd09:refs/tags/test-ui-check-fefdd09
```

## Official Tag

Republishing official tags rewrites remote refs. Do this only when the user explicitly asks to republish a tag.

For the current official tag used by this project:

```bash
git tag -f -a v0.1.0 -m "Release v0.1.0" HEAD
git push origin +refs/tags/v0.1.0:refs/tags/v0.1.0
```

For a new release version:

```bash
git tag -a v0.1.1 -m "Release v0.1.1" HEAD
git push origin refs/tags/v0.1.1
```

## Verify Remote Refs

Check that pushed refs point at the intended commit:

```bash
git rev-parse HEAD
git ls-remote origin refs/heads/develop refs/tags/<tag> 'refs/tags/<tag>^{}'
```

For annotated tags, compare the peeled `^{}` line with `HEAD`.

## Verify GitHub Actions

The machine may not have `gh`. Use GitHub's public API when needed:

```bash
curl -s 'https://api.github.com/repos/tf1997/ai-term/actions/runs?per_page=3&event=push'
```

Report the latest Release run's `html_url`, `head_branch`, `head_sha`, `status`, and `conclusion`. A freshly pushed tag should show `status: in_progress` or `queued`; completed successful runs show `conclusion: success`.
