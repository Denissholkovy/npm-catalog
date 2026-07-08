const vscode = require('vscode');
const { PackageService } = require('./packageService');
const { CatalogTreeProvider } = require('./catalogTreeProvider');
const { PackageDetailsPanel } = require('./packageDetailsPanel');

class ExtensionController {
  constructor(context) {
    this.context = context;
    this.packageService = new PackageService(context);
    this.treeProvider = new CatalogTreeProvider(context, this.packageService);
  }

  activate() {
    const treeView = vscode.window.createTreeView('npmCatalogView', {
      treeDataProvider: this.treeProvider
    });
    this.context.subscriptions.push(treeView);

    this._registerCommand('npmCatalog.showPackageDetails', (pkg) =>
      PackageDetailsPanel.show(pkg, this.packageService)
    );

    this._registerCommand('npmCatalog.refresh', () => this.treeProvider.refreshAll());

    this._registerCommand('npmCatalog.refreshCategory', (item) => {
      if (item && item.payload && item.payload.groupName && item.payload.name) {
        this.treeProvider.refreshCategory(item.payload.groupName, item.payload.name);
      }
    });

    this._registerCommand('npmCatalog.loadMoreCategory', (payload) => {
      if (payload && payload.groupName && payload.name) {
        this.treeProvider.requestLoad(payload.groupName, payload.name);
      }
    });

    this._registerCommand('npmCatalog.searchPackages', async () => {
      const term = await vscode.window.showInputBox({
        placeHolder: 'Search npm packages by name or keyword…',
        prompt: 'Enter a package name or keyword to search'
      });
      if (term && term.trim()) {
        this.treeProvider.setSearch(term.trim());
        vscode.commands.executeCommand('setContext', 'npmCatalog.hasActiveSearch', true);
      }
    });

    this._registerCommand('npmCatalog.clearSearch', () => {
      this.treeProvider.clearSearch();
      vscode.commands.executeCommand('setContext', 'npmCatalog.hasActiveSearch', false);
    });
  }

  _registerCommand(command, handler) {
    this.context.subscriptions.push(vscode.commands.registerCommand(command, handler));
  }
}

function activate(context) {
  const controller = new ExtensionController(context);
  controller.activate();
}

function deactivate() {}

module.exports = { activate, deactivate };
