# NPM Catalog

Discover, compare and install npm packages without leaving VS Code — and keep
an eye on the dependencies you already have.

## Features

### Discover
- **Curated catalog** — 80+ categories across Frontend, Backend (Node.js),
  Mobile (React Native), Full-Stack, DevOps & Tooling, Utilities, plus a
  **Project Starters** page with one-click `create-*` generators.
- **Rich package cards** — weekly downloads, number of dependent packages,
  last publish date (stale packages are highlighted), license, keywords and a
  popularity bar relative to the list.
- **Live search with autocomplete** — suggestions as you type, recent
  searches, `keywords:` search by clicking any tag. Press `/` to focus search.
- **Sorting and density** — popular, most downloaded, recently updated or
  A–Z; detailed cards or a compact list.

### Package details
- Weekly downloads with a **one-year trend chart** and 4-week growth.
- **Bundle size** (min + gzip), unpacked size, file count, Node engine.
- **TypeScript support** (built-in or `@types/*`), module format
  (ESM / CJS), runtime dependency count.
- **Security advisories** for the latest version, deprecation and archived
  repository warnings, “no releases for N years” notice.
- GitHub stars, forks, open issues and last commit.
- Tabs for **README**, **Versions** (dist-tags, recent releases, install any
  exact version) and **Dependencies** (click to open, peer deps marked
  optional).
- Install commands for **npm, yarn, pnpm and bun** — switch with one click.
- Shows whether the package is already in your project, with Update and
  Uninstall buttons.

### Project
- Scans every `package.json` in the workspace and shows **outdated**
  (major / minor / patch), **vulnerable** and **deprecated** dependencies.
- Update a single package or every outdated package in a section at once.
- Filter and search the dependency list; refreshes automatically when
  `package.json` or a lock file changes.

### Saved
- Star packages to keep them in **Saved**; recently viewed packages are
  remembered too.

## Usage

1. Click the NPM Catalog icon in the activity bar.
2. **Discover** — pick a group and a category, or start typing in the search
   box.
3. Click a card to open its details; use **Install** / **Dev** to add it to
   your project.
4. **Project** — check what is outdated or vulnerable and update it.

Commands (Command Palette → “NPM Catalog”): Search Packages, Open Package by
Name…, Check Project Dependencies, Refresh All Categories, Clear Search
History.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `npmCatalog.pageSize` | `20` | Packages loaded per page |
| `npmCatalog.cacheTtlHours` | `24` | How long category results stay cached |
| `npmCatalog.packageManager` | `auto` | Package manager for commands; `auto` detects it from the lock file |

## Data sources

npm registry and downloads API, GitHub API (repository stats), npm security
advisories, bundlephobia (bundle size) and npms.io (name autocomplete).

## License

MIT. Icons: [Codicons](https://github.com/microsoft/vscode-codicons)
(CC BY 4.0).
