# NPM Catalog

Browse the most popular npm packages by category — Frontend, Backend, Mobile,
and more — without leaving VS Code. No more digging through search results:
open a category, see what's popular, read the README, and install with one
click.

## Features

- **60+ categories** across 6 groups: Frontend, Backend (Node.js), Mobile
  (React Native), Full-Stack Frameworks, DevOps & Tooling, and Shared &
  Utilities.
- **Popularity-ranked results**, fetched live from the npm registry.
- **Nothing loads until you ask** — opening a category shows a single
  "Click to load packages…" prompt, so there's no unnecessary network
  activity, even if VS Code auto-expands previously opened categories.
- **"Load 20 more…"** pagination to keep browsing deeper into a category.
- **Full package details on click**: rendered README (with syntax-highlighted
  code blocks), license, homepage/repository links, weekly download count,
  and GitHub stars/avatar.
- **One-click install** via the integrated terminal.

## Installation

Search for **"NPM Catalog"** in the Extensions view (`Cmd+Shift+X` /
`Ctrl+Shift+X`) and click Install, or install from the
[Marketplace page](https://marketplace.visualstudio.com/items?itemName=Denys-Shovkovyi.npm-catalog).

## Usage

1. Click the NPM Catalog icon in the activity bar.
2. Expand a group (e.g. Frontend), then a category (e.g. State Management).
3. Click **"Click to load packages…"** to fetch the 20 most popular packages
   for that category.
4. Click any package to see its full details — README, license, downloads,
   links — and press **Install** to run `npm install` in your terminal.
5. Need more options? Click **"Load 20 more…"** at the bottom of the list.

## How It Works

- Each category is mapped to an npm search query (see
  `data/categoryQueries.json`). Queries go to the official npm registry
  search API, weighted toward popularity rather than plain text relevance.
- Nothing is fetched automatically — every network request is triggered by
  an explicit click (initial load, "Load more", or the refresh icon).
- Once loaded, results are cached indefinitely in the extension's storage.
  Reopening a category later shows the cached list instantly.
- The refresh icon (⟳) on a category always re-fetches page one, discarding
  any extra pages you'd loaded. The refresh icon at the top of the panel
  does this for every category at once.
- Clicking a package fetches its full README, license, homepage/repository
  links, weekly download count, and GitHub stars/avatar (if hosted on
  GitHub) on demand.

## Customizing Categories

Categories live in `data/categoryQueries.json` — a simple group → category →
npm search query structure:

```json
{
  "Frontend": {
    "State Management": "state management"
  },
  "Backend (Node.js)": {
    "Web Frameworks": "express koa fastify web framework"
  }
}
```

Add a new key to add a category or group, using any of these query styles:

- `"keywords:security"` — packages tagged with an official npm keyword
- `"http client"` — free-text relevance search
- `"keywords:orm typescript"` — combined search

If you're running from source, reload the extension (`F5`) after editing.

## Limitations

- Categories are relevance/popularity-based searches, not an official npm
  taxonomy — result quality depends on how the query is worded.
- The GitHub API used for avatars/stars is unauthenticated and limited to
  60 requests/hour per IP, which is plenty for personal use.

## Roadmap

- Search/filter box at the top of the tree.
- "Installed" badge by comparing against the open project's `package.json`.
- Pinned/manually curated packages alongside the automatic results.

## Contributing

Contributions, category suggestions, and bug reports are welcome — open an
issue or a pull request.

### Project Structure

```
npm-catalog/
├── package.json              extension manifest
├── data/categoryQueries.json category tree + npm search queries
├── media/                    icons (activity bar + Marketplace)
└── src/
    ├── extension.js           entry point (ExtensionController)
    ├── cache.js                PackageCache — disk cache
    ├── npmRegistryClient.js    NpmRegistryClient — all HTTP calls (npm, GitHub)
    ├── markdownRenderer.js     MarkdownRenderer — README → HTML, code highlighting
    ├── packageService.js       PackageService — combines client + cache + renderer
    ├── catalogTreeProvider.js  CatalogItem, CatalogTreeProvider — sidebar tree
    └── packageDetailsPanel.js  PackageDetailsPanel — webview details view
```

### Running from Source

1. Clone the repo and open the folder in VS Code.
2. Press `F5` to launch an Extension Development Host window.
3. The extension icon appears in the activity bar of that window.

## License

MIT — see [LICENSE](LICENSE).
