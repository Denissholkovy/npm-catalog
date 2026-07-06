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
