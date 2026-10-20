# Changelog

## Unreleased

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
