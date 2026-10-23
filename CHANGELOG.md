# Changelog

## Unreleased

- Redesigned sidebar with Discover / Project / Saved views, VS Code codicons instead of emoji, category chips, sorting and a compact list mode.
- Package cards show weekly downloads, dependents, last publish (stale highlighted), license, keywords and a popularity bar.
- Search autocomplete with package suggestions and editable recent searches; `/` focuses search; clicking a keyword searches it.
- Project Starters are shown on one page with the exact command to run.
- New Project view: outdated (major/minor/patch), vulnerable and deprecated dependencies, per-package and bulk update, uninstall, filter.
- New details panel: two-column layout, npm/yarn/pnpm/bun switcher, one-year download chart with trend, bundle size, TypeScript and module format badges, security advisories, GitHub stats, Versions and Dependencies tabs, navigation between packages with Back.
- New commands: Open Package by Name…, Check Project Dependencies.
- Recently viewed packages.

- Fixed: expanding a cached category no longer silently loads another page.
- Fixed: package details are HTML-escaped and rendered under a strict CSP; README is rendered by a safe Markdown renderer (lists, tables, quotes, images, badges).
- Cache is now in-memory with a TTL (`npmCatalog.cacheTtlHours`) and persisted via globalState.
- Network requests have timeouts, redirect handling and retry with backoff.
- Tree keeps its expanded state, shows loading/error states, version and installed marker.
- New: favorites, search history, package context menu (install, copy command, open on npm).
- New: package manager detection (npm/yarn/pnpm/bun) and dev-dependency install.
- Sidebar is now a card-based webview: real search box on top, group tabs, category dropdown, large clickable package cards with Install / Copy / Favorite buttons, installed marker. Borders follow the VS Code theme.
- Redesigned package details card.
- Details panel is reused, adapts to the light theme and shows more metadata.

## 0.1.0

Initial release.

- Browse npm packages grouped by category across Frontend, Backend (Node.js),
  Mobile (React Native), Full-Stack Frameworks, DevOps & Tooling, and Shared
  & Utilities — 60+ categories in total.
- Packages are fetched live from the npm registry, ranked by popularity.
- On-demand loading — nothing is fetched until you click a category, with
  pagination ("Load 20 more…") for browsing deeper into a category.
- Package detail view with full README (syntax-highlighted code blocks),
  license, homepage/repository links, weekly download count, and GitHub
  stars/avatar.
- One-click install via the integrated terminal.
