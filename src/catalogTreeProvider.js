const vscode = require('vscode');
const fs = require('fs');
const path = require('path');

class CatalogItem extends vscode.TreeItem {
  constructor(label, collapsibleState, type, payload) {
    super(label, collapsibleState);
    this.type = type;
    this.payload = payload;
    this._configureAppearance();
  }

  _configureAppearance() {
    switch (this.type) {
      case 'group':
        this.contextValue = 'group';
        this.iconPath = new vscode.ThemeIcon('layers');
        break;
      case 'category':
        this.contextValue = 'category';
        this.iconPath = new vscode.ThemeIcon(
          this.payload.groupName === 'Search Results' ? 'search' : 'folder'
        );
        break;
      case 'package':
        this._configureAsPackage();
        break;
      case 'load-more':
        this.contextValue = 'load-more';
        this.iconPath = new vscode.ThemeIcon('cloud-download');
        this.command = {
          command: 'npmCatalog.loadMoreCategory',
          title: 'Load Packages',
          arguments: [this.payload]
        };
        break;
      default:
        this.iconPath = new vscode.ThemeIcon(this.payload.icon || 'info');
    }
  }

  _configureAsPackage() {
    this.contextValue = 'package';
    this.iconPath = new vscode.ThemeIcon('package');
    this.description =
      this.payload.description.length > 60
        ? this.payload.description.slice(0, 60) + '…'
        : this.payload.description;
    this.command = {
      command: 'npmCatalog.showPackageDetails',
      title: 'Show Package Details',
      arguments: [this.payload]
    };
  }
}

class CatalogTreeProvider {
  constructor(context, packageService) {
    this.context = context;
    this.packageService = packageService;
    this._onDidChangeTreeData = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._onDidChangeTreeData.event;
    this.tree = this._loadCategoryTree();
    this._forceRefreshKey = null;
    this._explicitLoadKey = null;
    this._searchTerm = null;
  }

  _loadCategoryTree() {
    const dataPath = path.join(this.context.extensionPath, 'data', 'categoryQueries.json');
    return JSON.parse(fs.readFileSync(dataPath, 'utf8'));
  }

  refreshAll() {
    this.tree = this._loadCategoryTree();
    this._onDidChangeTreeData.fire();
  }

  refreshCategory(groupName, categoryName) {
    this._forceRefreshKey = `${groupName}::${categoryName}`;
    this._onDidChangeTreeData.fire();
  }

  requestLoad(groupName, categoryName) {
    this._explicitLoadKey = `${groupName}::${categoryName}`;
    this._onDidChangeTreeData.fire();
  }

  setSearch(term) {
    this._searchTerm = term;
    this._explicitLoadKey = `Search Results::${term}`;
    this._onDidChangeTreeData.fire();
  }

  clearSearch() {
    this._searchTerm = null;
    this._onDidChangeTreeData.fire();
  }

  hasActiveSearch() {
    return Boolean(this._searchTerm);
  }

  getTreeItem(element) {
    return element;
  }

  async getChildren(element) {
    if (!element) return this._getGroups();
    if (element.type === 'group') return this._getCategories(element);
    if (element.type === 'category') return this._getPackages(element);
    return [];
  }

  _getGroups() {
    const groups = Object.keys(this.tree).map(
      (groupName) =>
        new CatalogItem(groupName, vscode.TreeItemCollapsibleState.Collapsed, 'group', {
          name: groupName
        })
    );

    if (this._searchTerm) {
      const searchItem = new CatalogItem(
        `🔍 "${this._searchTerm}"`,
        vscode.TreeItemCollapsibleState.Expanded,
        'category',
        {
          groupName: 'Search Results',
          name: this._searchTerm,
          query: this._searchTerm,
          installType: 'npm',
          exact: false
        }
      );
      return [searchItem, ...groups];
    }

    return groups;
  }

  _getCategories(groupElement) {
    const groupName = groupElement.payload.name;
    const categories = this.tree[groupName] || {};
    return Object.keys(categories).map((categoryName) => {
      const raw = categories[categoryName];
      const isObjectForm = typeof raw === 'object' && raw !== null;
      const query = isObjectForm ? raw.query : raw;
      const installType = isObjectForm ? raw.installType || 'npm' : 'npm';
      const exact = isObjectForm ? Boolean(raw.exact) : false;

      return new CatalogItem(categoryName, vscode.TreeItemCollapsibleState.Collapsed, 'category', {
        groupName,
        name: categoryName,
        query,
        installType,
        exact
      });
    });
  }

  async _getPackages(categoryElement) {
    const { groupName, name: categoryName, query, installType, exact } = categoryElement.payload;
    const cacheKey = `${groupName}::${categoryName}`;

    const forceRefresh = this._forceRefreshKey === cacheKey;
    const explicitLoad = this._explicitLoadKey === cacheKey;
    if (forceRefresh) this._forceRefreshKey = null;
    if (explicitLoad) this._explicitLoadKey = null;

    const cachedPage = this.packageService.peekCategory(cacheKey);

    if (!cachedPage && !explicitLoad && !forceRefresh) {
      return [this._loadItem(groupName, categoryName, query, installType, 'Click to load packages…')];
    }

    try {
      let page;
      if (exact) {
        page =
          forceRefresh || !cachedPage
            ? await this.packageService.fetchExactPackage(cacheKey, query, installType)
            : cachedPage;
      } else {
        page =
          forceRefresh || !cachedPage
            ? await this.packageService.fetchFirstPage(cacheKey, query, installType)
            : await this.packageService.fetchNextPage(cacheKey, query, installType);
      }

      return this._buildPackageItems(page, groupName, categoryName, query, installType);
    } catch (err) {
      return [this._infoItem(`Failed to load: ${err.message}`, 'error')];
    }
  }

  _buildPackageItems(page, groupName, categoryName, query, installType) {
    if (!page.packages.length) {
      return [this._infoItem('No packages found', 'warning')];
    }

    const items = page.packages.map(
      (pkg) => new CatalogItem(pkg.name, vscode.TreeItemCollapsibleState.None, 'package', pkg)
    );

    if (page.hasMore) {
      items.push(this._loadItem(groupName, categoryName, query, installType, 'Load 20 more…'));
    }

    return items;
  }

  _loadItem(groupName, categoryName, query, installType, label) {
    return new CatalogItem(label, vscode.TreeItemCollapsibleState.None, 'load-more', {
      groupName,
      name: categoryName,
      query,
      installType
    });
  }

  _infoItem(label, icon) {
    return new CatalogItem(label, vscode.TreeItemCollapsibleState.None, 'info', { icon });
  }
}

module.exports = { CatalogItem, CatalogTreeProvider };
