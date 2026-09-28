# Symlinkr

Symlinkr links gitignored local files from a repo’s main Git checkout into another worktree of the same repo, so a new branch keeps `.env` and similar files.

## When it runs

Herdr runs Symlinkr on `worktree.created` and `worktree.opened`. You can also run it from the workspace action **Link worktree resources** (`symlinkr.link`). The same work is done by:

```bash
node bin/symlinkr.js --dest <worktree>
```

## Install and local development

While you work on this checkout, point Herdr at it with:

```bash
herdr plugin link <checkout>
```

To install from this repository once it is the source you want to use:

```bash
herdr plugin install afshimono/symlinkr
```

## What gets linked

Today Symlinkr links `.env`, `.env.local`, and files whose names match `.env.*.local`. It looks for them at the worktree root and beside a project marker (a file that activates a rule in that directory). It does not link `.env.development`, `.env.production`, `.env.test`, or `.envrc`.

## How linking and skips work

A path is linked only when it exists in the main checkout, is missing in the destination worktree, and is gitignored in that worktree. If the destination already has a real file or directory at that path, Symlinkr leaves it alone. If there is already a symlink that points at the same file as the main checkout, it is left alone; if the symlink points somewhere else, it is left alone too. Symlinkr never links the main checkout to itself.

If the destination is the main checkout, stdout is only `skip . self`. If `.symlinkr.toml` sets `enabled = false`, stdout is only `skip . disabled`. In both cases, candidates such as `.env` are not listed. Only after those checks does Symlinkr print one line per candidate on stdout: `link <path>` or `skip <path> <reason>`. It never prints file contents.

## Configuration

Symlinkr reads `.symlinkr.toml` in the main checkout. If that file is missing, the built-in rules above are used.

`exclude` matches a full relative path from the repo root—a pattern like `node_modules` does not match `packages/web/node_modules`.

```toml
enabled = true
extra = ["secrets/local.json"]
exclude = [".env.local"]
```

- `enabled` — turn linking off without removing the plugin.
- `extra` — additional gitignored paths to link (root-relative).
- `exclude` — paths the built-in and extra rules must not link.

## Platforms

Symlinkr supports Linux and macOS.

## Development

Requires Node 20 or newer. There is no install step beyond cloning the repo. Run the test suite with:

```bash
node --test
```

This plugin was created using Herdr.
