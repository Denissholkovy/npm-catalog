# NPM Catalog

A visual catalog of npm packages grouped by category, right inside VS Code.
Packages are fetched automatically from the npm registry.

## Project Structure

```
npm-catalog/
├── package.json              extension manifest
├── data/categoryQueries.json category tree + npm search queries
├── media/icon.svg            activity bar icon
└── src/
    ├── extension.js           entry point (ExtensionController)
    ├── cache.js                PackageCache — disk cache with TTL
    ├── npmRegistryClient.js    NpmRegistryClient — all HTTP calls (npm, GitHub)
    ├── markdownRenderer.js     MarkdownRenderer — README → HTML, code highlighting
    ├── packageService.js       PackageService — combines client + cache + renderer
    ├── catalogTreeProvider.js  CatalogItem, CatalogTreeProvider — sidebar tree
    └── packageDetailsPanel.js  PackageDetailsPanel — webview details view
```

## Getting Started (Development Mode)

1. Open this folder in VS Code.
2. Press `F5`.
3. In the new "Extension Development Host" window, find the extension icon
   in the activity bar.
4. Click a group (Frontend / Backend), then a category — the extension
   queries npm and shows up to 20 of the most relevant packages.
   Click a package to open a detail view with its README, license,
   download stats, and an "Install" button.

## How Auto-Fetching Works

`data/categoryQueries.json` defines the structure:

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

- Each category maps to an npm search query.
- Queries go to `https://registry.npmjs.org/-/v1/search?text=<query>`.
- Results are cached for 24 hours in the extension's global storage to
  avoid unnecessary requests.
- The refresh button (⟳) at the top of the panel clears the entire cache.
- The inline (⟳) icon next to a category refreshes only that category.

## On-Demand Loading

- Opening a category for the **first time** shows a **"Click to load packages…"**
  item — no network request happens until you click it. This means even if
  VS Code auto-restores previously expanded categories on reload, nothing is
  fetched until you explicitly ask.
- Once loaded, packages are cached indefinitely — reopening the category later
  shows the cached list instantly, no request needed.
- **"Load 20 more…"** at the bottom fetches the next page and appends it.
- The refresh icon (⟳) on a category always fetches page one fresh, discarding
  any additional pages you had loaded.

## Pagination & Popularity

- Each category initially loads the **20 most popular** packages matching its
  query (search results are weighted toward popularity, not just text relevance).
- A **"Load 20 more…"** item appears at the bottom of the list — click it to fetch
  the next 20 and append them to the cached list for that category.
- Refreshing a category (⟳) resets it back to the first page of 20.

## Package Detail View

Clicking a package fetches additional data on demand:

- Full README (rendered with basic markdown formatting and code
  syntax highlighting styled like the VS Code default dark theme)
- License, homepage, and repository links
- Weekly download count
- GitHub avatar and star count (if the repository is hosted on GitHub)

## Adding or Changing Categories

Edit `data/categoryQueries.json` — add a new group or category key with
an npm search query as the value. Example queries:

- `"keywords:security"` — packages tagged with the security keyword
- `"http client"` — free-text search
- `"keywords:orm typescript"` — combined search

Reload the extension (`F5`) after editing to see the changes.

## Limitations

- This is a relevance-based search, not an official npm categorization —
  result quality depends on how well the query is worded.
- The npm registry API doesn't require a key but does have reasonable
  rate limits; caching accounts for this.
- The GitHub API used for avatars/stars is unauthenticated and limited
  to 60 requests/hour per IP — fine for personal use.

## Ideas for Further Improvement

- Search/filter box at the top of the tree.
- "Installed" badge by comparing against the open project's `package.json`.
- Pinned/manually curated packages alongside the automatic results.

## Publishing to the Marketplace

Before your first publish, you need to fill in a few placeholders:

1. **`package.json`** — replace:
   - `"publisher": "Denys-Shovkovyi"` with your actual publisher ID
     (create one at https://marketplace.visualstudio.com/manage — you'll
     need a free Azure DevOps account and a Personal Access Token)
   - `"repository.url"` with your actual GitHub repo URL (or remove the
     `repository` field entirely if you don't have one yet)
2. **`LICENSE`** — replace `Denys Shovkovyi` with your name.
3. Optionally replace `media/marketplace-icon.png` with your own 128×128 logo.

Then:

```bash
npm install -g @vscode/vsce
vsce login Denys-Shovkovyi  
vsce publish
```

`vsce publish` packages and uploads in one step. To just build the `.vsix`
file without publishing (e.g. to test-install locally or share manually):

```bash
vsce package
code --install-extension npm-catalog-0.1.0.vsix
```

Every time you publish an update, bump the `version` in `package.json`
(`vsce publish patch` / `minor` / `major` does this for you automatically).
