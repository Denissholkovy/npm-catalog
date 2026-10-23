const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { readInstalled, resolveManager, getWorkspaceFolders } = require('./projectEnv');

const SEARCH_GROUP = 'Search Results';
const ALL_CATEGORY = '__all__';

const GROUP_STYLES = {
  'Project Starters': ['rocket', '--vscode-charts-orange', 'Scaffold a new app in one command'],
  Frontend: ['browser', '--vscode-charts-blue', 'UI, styling, state, forms, testing'],
  'Backend (Node.js)': ['server', '--vscode-charts-green', 'APIs, databases, auth, queues'],
  'Mobile (React Native)': ['device-mobile', '--vscode-charts-purple', 'Navigation, UI kits, native modules'],
  'Full-Stack Frameworks': ['layers', '--vscode-charts-red', 'Meta-frameworks and SSR'],
  'DevOps & Tooling': ['tools', '--vscode-charts-yellow', 'Monorepos, CI, containers, linting'],
  'Shared & Utilities': ['library', '--vscode-charts-blue', 'HTTP, dates, helpers, validation']
};

function categoryKey(groupName, categoryName) {
  return `${groupName}::${categoryName}`;
}

function normalizeSpec(raw) {
  const isObjectForm = typeof raw === 'object' && raw !== null;
  return {
    query: isObjectForm ? raw.query : raw,
    installType: isObjectForm ? raw.installType || 'npm' : 'npm',
    exact: isObjectForm ? Boolean(raw.exact) : false
  };
}

class CatalogViewProvider {
  constructor(context, packageService, projectService, userStore, actions) {
    this.context = context;
    this.packageService = packageService;
    this.projectService = projectService;
    this.userStore = userStore;
    this.actions = actions;
    this.view = null;
    this.states = new Map();
    this.specs = new Map();
    this.searchTerm = null;
    this.suggestions = [];
    this.project = { status: 'idle', data: null, progress: null, error: null };
    this._loadCategoryTree();
  }

  _loadCategoryTree() {
    const dataPath = path.join(this.context.extensionPath, 'data', 'categoryQueries.json');
    const tree = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
    this.specs.clear();

    this.groups = Object.keys(tree).map((groupName) => {
      const [icon, color, tagline] = GROUP_STYLES[groupName] || ['package', '--vscode-charts-blue', ''];
      const entries = Object.entries(tree[groupName]).map(([name, raw]) => [name, normalizeSpec(raw)]);
      const allExact = entries.length > 1 && entries.every(([, spec]) => spec.exact);

      let categories;
      if (allExact) {
        const key = categoryKey(groupName, ALL_CATEGORY);
        this.specs.set(key, {
          exactList: entries.map(([label, spec]) => ({ label, query: spec.query, installType: spec.installType }))
        });
        categories = [{ key, name: 'All starters' }];
      } else {
        categories = entries.map(([name, spec]) => {
          const key = categoryKey(groupName, name);
          this.specs.set(key, spec);
          return { key, name };
        });
      }
      return { name: groupName, icon, color, tagline, categories };
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
    const uri = (...parts) => webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, ...parts));
    const csp = [
      "default-src 'none'",
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `font-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
      `img-src ${webview.cspSource} https: data:`
    ].join('; ');

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${uri('codicons', 'codicon.css')}">
<link rel="stylesheet" href="${uri('catalog.css')}">
</head>
<body>
  <header class="top">
    <form id="searchForm" class="search" role="search" autocomplete="off">
      <span class="codicon codicon-search search-icon" aria-hidden="true"></span>
      <input id="searchInput" type="text" placeholder="Search npm packages" aria-label="Search npm packages" aria-autocomplete="list" aria-controls="suggest" spellcheck="false">
      <kbd class="search-hint" aria-hidden="true">/</kbd>
      <button id="searchClear" class="search-clear" type="button" title="Clear search" aria-label="Clear search" hidden><span class="codicon codicon-close"></span></button>
      <div id="suggest" class="suggest" role="listbox" hidden></div>
    </form>
    <nav id="views" class="views" role="tablist"></nav>
  </header>
  <main id="list"></main>
  <script nonce="${nonce}" src="${uri('catalog.js')}"></script>
</body>
</html>`;
  }

  _post(message) {
    if (this.view) this.view.webview.postMessage(message);
  }

  _updateDescription() {
    if (this.view) this.view.description = this.searchTerm ? `"${this.searchTerm}"` : undefined;
  }

  _userData() {
    return {
      favorites: this.userStore.getFavorites(),
      recent: this.userStore.getRecent(),
      installed: readInstalled(),
      history: this.userStore.getSearchHistory(),
      manager: resolveManager(),
      hasWorkspace: getWorkspaceFolders().length > 0
    };
  }

  _snapshot() {
    return {
      type: 'init',
      groups: this.groups,
      ...this._userData(),
      searchTerm: this.searchTerm,
      searchKey: this.searchTerm ? categoryKey(SEARCH_GROUP, this.searchTerm) : null
    };
  }

  refreshView() {
    this._post({ type: 'userdata', ...this._userData() });
  }

  onProjectFilesChanged() {
    this.refreshView();
    if (this.project.status !== 'idle') this.loadProject();
  }

  refreshAll() {
    this.packageService.clearAll();
    this.projectService.clear();
    this.states.clear();
    this._loadCategoryTree();
    this._post(this._snapshot());
    if (this.project.status !== 'idle') this.loadProject();
  }

  focusSearch() {
    this._post({ type: 'focusSearch' });
  }

  showTab(tab) {
    this._post({ type: 'showTab', tab });
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

  async loadProject() {
    if (!this.projectService.hasProjects()) {
      this.project = { status: 'empty', data: null, progress: null, error: null };
      this._sendProject();
      return;
    }
    this.project = { ...this.project, status: 'loading', progress: null, error: null };
    this._sendProject();
    try {
      const data = await this.projectService.scan((progress) => {
        this.project.progress = progress;
        this._post({ type: 'projectProgress', progress });
      });
      this.project = { status: 'ready', data, progress: null, error: null };
    } catch (err) {
      this.project = { ...this.project, status: 'error', error: err.message };
    }
    this._sendProject();
  }

  _sendProject() {
    this._post({ type: 'project', ...this.project });
  }

  _handleMessage(message) {
    if (!message || typeof message.type !== 'string') return;
    const key = typeof message.key === 'string' ? message.key : null;
    const name = typeof message.name === 'string' ? message.name : null;

    switch (message.type) {
      case 'ready':
        this._post(this._snapshot());
        if (this.project.status !== 'idle') this._sendProject();
        break;
      case 'search':
        if (typeof message.term === 'string' && message.term.trim()) this.setSearch(message.term.trim());
        break;
      case 'clearSearch':
        this.clearSearch();
        break;
      case 'suggest':
        this._suggest(message.term, message.seq);
        break;
      case 'removeSearch':
        if (typeof message.term === 'string') this.userStore.removeSearch(message.term);
        break;
      case 'clearHistory':
        this.userStore.clearSearchHistory();
        break;
      case 'clearRecent':
        this.userStore.clearRecent();
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
      case 'loadProject':
        if (message.force) this.projectService.clear();
        this.loadProject();
        break;
      case 'updateDeps':
        if (Array.isArray(message.names) && message.names.length) {
          this.actions.update(message.folder, message.names.filter((item) => typeof item === 'string'), message.dev === true);
        }
        break;
      case 'uninstall':
        if (name) this.actions.uninstall(message.folder, name);
        break;
      case 'openManifest':
        this.actions.openManifest(message.folder);
        break;
      case 'initProject':
        this.actions.initProject();
        break;
      case 'openUrl':
        this.actions.openUrl(message.url);
        break;
      case 'openPackage':
      case 'install':
      case 'copy':
      case 'toggleFavorite':
        if (name) this._handlePackageAction(message.type, key, name, message.dev === true);
        break;
    }
  }

  async _suggest(term, seq) {
    if (typeof term !== 'string' || term.trim().length < 2) return;
    try {
      const packages = await this.packageService.suggest(term.trim());
      this.suggestions = packages;
      this._post({ type: 'suggestions', seq, term, packages });
    } catch {
      this._post({ type: 'suggestions', seq, term, packages: [] });
    }
  }

  _handlePackageAction(type, key, name, dev) {
    const pkg = this._findPackage(key, name);
    if (type === 'openPackage') {
      this.userStore.addRecent(pkg);
      this.actions.showDetails(pkg);
    } else if (type === 'install') this.actions.install(pkg, dev);
    else if (type === 'copy') this.actions.copy(pkg, dev);
    else this.userStore.toggleFavorite(pkg);
  }

  _findPackage(key, name) {
    const pools = [];
    if (key && this.states.has(key)) pools.push(this.states.get(key).packages);
    pools.push(this.userStore.getFavorites(), this.userStore.getRecent(), this.suggestions);
    for (const state of this.states.values()) pools.push(state.packages);
    for (const pool of pools) {
      const found = pool.find((pkg) => pkg.name === name);
      if (found) return { ...found, installType: found.installType || 'npm' };
    }
    return this._projectPackage(name);
  }

  _projectPackage(name) {
    const projects = (this.project.data && this.project.data.projects) || [];
    for (const project of projects) {
      const dep = project.dependencies.find((item) => item.name === name);
      if (dep) {
        return { name, description: dep.description, version: dep.latest || dep.current, installType: 'npm', npmUrl: `https://www.npmjs.com/package/${name}` };
      }
    }
    return { name, description: '', installType: 'npm', npmUrl: `https://www.npmjs.com/package/${name}` };
  }

  _stateFor(key) {
    let state = this.states.get(key);
    if (!state) {
      const cached = this.packageService.getCached(key);
      state = cached
        ? { status: 'ready', packages: cached.packages, hasMore: cached.hasMore, total: cached.total, error: null }
        : { status: 'idle', packages: [], hasMore: false, total: null, error: null };
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
      this.states.set(key, { status: 'ready', packages: page.packages, hasMore: page.hasMore, total: page.total, error: null });
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
