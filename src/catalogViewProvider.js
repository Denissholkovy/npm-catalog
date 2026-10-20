const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { readInstalledNames } = require('./projectEnv');

const SEARCH_GROUP = 'Search Results';
const FAVORITES_KEY = 'favorites';

const GROUP_STYLES = {
  'Project Starters': ['🚀', '--vscode-charts-orange'],
  Frontend: ['🖥️', '--vscode-charts-blue'],
  'Backend (Node.js)': ['🗄️', '--vscode-charts-green'],
  'Mobile (React Native)': ['📱', '--vscode-charts-purple'],
  'Full-Stack Frameworks': ['🌐', '--vscode-charts-red'],
  'DevOps & Tooling': ['🛠️', '--vscode-charts-yellow'],
  'Shared & Utilities': ['📚', '--vscode-charts-blue']
};

function categoryKey(groupName, categoryName) {
  return `${groupName}::${categoryName}`;
}

class CatalogViewProvider {
  constructor(context, packageService, userStore, actions) {
    this.context = context;
    this.packageService = packageService;
    this.userStore = userStore;
    this.actions = actions;
    this.view = null;
    this.states = new Map();
    this.specs = new Map();
    this.searchTerm = null;
    this._loadCategoryTree();
  }

  _loadCategoryTree() {
    const dataPath = path.join(this.context.extensionPath, 'data', 'categoryQueries.json');
    const tree = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
    this.specs.clear();

    this.groups = Object.keys(tree).map((groupName) => {
      const [icon, color] = GROUP_STYLES[groupName] || ['📦', '--vscode-charts-blue'];
      const categories = Object.keys(tree[groupName]).map((categoryName) => {
        const raw = tree[groupName][categoryName];
        const isObjectForm = typeof raw === 'object' && raw !== null;
        const key = categoryKey(groupName, categoryName);
        this.specs.set(key, {
          query: isObjectForm ? raw.query : raw,
          installType: isObjectForm ? raw.installType || 'npm' : 'npm',
          exact: isObjectForm ? Boolean(raw.exact) : false
        });
        return { key, name: categoryName };
      });
      return { name: groupName, icon, color, categories };
    });
  }

  resolveWebviewView(view) {
    this.view = view;
    const mediaRoot = vscode.Uri.joinPath(this.context.extensionUri, 'media');
    view.webview.options = { enableScripts: true, localResourceRoots: [mediaRoot] };
    view.webview.html = this._html(view.webview, mediaRoot);
    view.webview.onDidReceiveMessage((message) => this._handleMessage(message));
    view.onDidDispose(() => {
      this.view = null;
    });
    this._updateDescription();
  }

  _html(webview, mediaRoot) {
    const nonce = crypto.randomBytes(16).toString('base64');
    const cssUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'catalog.css'));
    const jsUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'catalog.js'));
    const csp = [
      "default-src 'none'",
      `style-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
      `img-src ${webview.cspSource} https: data:`
    ].join('; ');

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${cssUri}">
</head>
<body>
  <form id="searchForm" class="search" role="search">
    <input id="searchInput" type="search" placeholder="Search npm packages…" list="searchHistory" autocomplete="off" aria-label="Search npm packages">
    <datalist id="searchHistory"></datalist>
  </form>
  <main id="list"></main>
  <script nonce="${nonce}" src="${jsUri}"></script>
</body>
</html>`;
  }

  _post(message) {
    if (this.view) this.view.webview.postMessage(message);
  }

  _updateDescription() {
    if (this.view) this.view.description = this.searchTerm ? `"${this.searchTerm}"` : undefined;
  }

  _snapshot() {
    return {
      type: 'init',
      groups: this.groups,
      favorites: this.userStore.getFavorites(),
      installed: [...readInstalledNames()],
      history: this.userStore.getSearchHistory(),
      searchTerm: this.searchTerm,
      searchKey: this.searchTerm ? categoryKey(SEARCH_GROUP, this.searchTerm) : null
    };
  }

  refreshView() {
    this._post({
      type: 'userdata',
      favorites: this.userStore.getFavorites(),
      installed: [...readInstalledNames()],
      history: this.userStore.getSearchHistory()
    });
  }

  refreshAll() {
    this.packageService.clearAll();
    this.states.clear();
    this._loadCategoryTree();
    this._post(this._snapshot());
  }

  focusSearch() {
    this._post({ type: 'focusSearch' });
  }

  async setSearch(term) {
    const key = categoryKey(SEARCH_GROUP, term);
    this.searchTerm = term;
    this.specs.set(key, { query: term, installType: 'npm', exact: false });
    this._setSearchContext();
    this._updateDescription();
    await this.userStore.addSearch(term);
    this._post(this._snapshot());
    await this._openCategory(key);
  }

  clearSearch() {
    this.searchTerm = null;
    this._setSearchContext();
    this._updateDescription();
    this._post(this._snapshot());
  }

  _setSearchContext() {
    vscode.commands.executeCommand('setContext', 'npmCatalog.hasActiveSearch', Boolean(this.searchTerm));
  }

  _handleMessage(message) {
    if (!message || typeof message.type !== 'string') return;
    const key = typeof message.key === 'string' ? message.key : null;

    switch (message.type) {
      case 'ready':
        this._post(this._snapshot());
        break;
      case 'search':
        if (typeof message.term === 'string' && message.term.trim()) this.setSearch(message.term.trim());
        break;
      case 'clearSearch':
        this.clearSearch();
        break;
      case 'openCategory':
        if (key) this._openCategory(key);
        break;
      case 'loadMore':
        if (key) this._loadMore(key);
        break;
      case 'refreshCategory':
        if (key) this._refreshCategory(key);
        break;
      case 'openPackage':
      case 'install':
      case 'copy':
      case 'toggleFavorite':
        this._handlePackageAction(message.type, key, message.name);
        break;
    }
  }

  _handlePackageAction(type, key, name) {
    const pkg = this._findPackage(key, name);
    if (!pkg) return;
    if (type === 'openPackage') this.actions.showDetails(pkg);
    else if (type === 'install') this.actions.install(pkg);
    else if (type === 'copy') this.actions.copy(pkg);
    else if (this.userStore.isFavorite(pkg.name)) this.userStore.removeFavorite(pkg.name);
    else this.userStore.addFavorite(pkg);
  }

  _findPackage(key, name) {
    const pools = [];
    if (key === FAVORITES_KEY) pools.push(this.userStore.getFavorites());
    else if (this.states.has(key)) pools.push(this.states.get(key).packages);
    pools.push(this.userStore.getFavorites());
    for (const pool of pools) {
      const found = pool.find((pkg) => pkg.name === name);
      if (found) return { ...found, installType: found.installType || 'npm' };
    }
    return null;
  }

  _stateFor(key) {
    let state = this.states.get(key);
    if (!state) {
      const cached = this.packageService.getCached(key);
      state = cached
        ? { status: 'ready', packages: cached.packages, hasMore: cached.hasMore, error: null }
        : { status: 'idle', packages: [], hasMore: false, error: null };
      this.states.set(key, state);
    }
    return state;
  }

  async _openCategory(key) {
    const spec = this.specs.get(key);
    if (!spec) return;
    const state = this._stateFor(key);
    if (state.status === 'idle') await this._run(key, () => this.packageService.loadFirstPage(key, spec));
    else this._sendCategory(key);
  }

  async _loadMore(key) {
    const spec = this.specs.get(key);
    const state = this._stateFor(key);
    if (!spec || state.status === 'loading') return;
    const task = state.packages.length
      ? () => this.packageService.loadNextPage(key, spec)
      : () => this.packageService.loadFirstPage(key, spec);
    await this._run(key, task);
  }

  async _refreshCategory(key) {
    const spec = this.specs.get(key);
    if (!spec) return;
    this.packageService.invalidate(key);
    this.states.delete(key);
    await this._run(key, () => this.packageService.loadFirstPage(key, spec));
  }

  async _run(key, task) {
    const previous = this._stateFor(key);
    this.states.set(key, { ...previous, status: 'loading', error: null });
    this._sendCategory(key);

    try {
      const page = await task();
      this.states.set(key, { status: 'ready', packages: page.packages, hasMore: page.hasMore, error: null });
    } catch (err) {
      this.states.set(key, { ...previous, status: 'error', error: err.message });
    }
    this._sendCategory(key);
  }

  _sendCategory(key) {
    const state = this.states.get(key);
    this._post({ type: 'category', key, ...state });
  }
}

module.exports = { CatalogViewProvider };
