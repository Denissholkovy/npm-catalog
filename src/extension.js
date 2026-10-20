const vscode = require('vscode');
const { PackageService } = require('./packageService');
const { CatalogViewProvider } = require('./catalogViewProvider');
const { PackageDetailsPanel } = require('./packageDetailsPanel');
const { UserStore } = require('./userStore');
const { buildCommand, isScaffold } = require('./installCommand');
const { getWorkspaceFolders, pickWorkspaceFolder, resolveManager } = require('./projectEnv');

const TERMINAL_NAME = 'NPM Catalog';
const WATCH_DEBOUNCE_MS = 300;

class ExtensionController {
  constructor(context) {
    this.context = context;
    this.packageService = new PackageService(context);
    this.userStore = new UserStore(context);
    this.packageHandlers = {
      install: (pkg, dev) => this._install(pkg, dev),
      copy: (pkg, dev) => this._copyCommand(pkg, dev),
      command: (pkg, dev) => this._commandFor(pkg, dev)
    };
    this.viewProvider = new CatalogViewProvider(context, this.packageService, this.userStore, {
      showDetails: (pkg) => PackageDetailsPanel.show(pkg, this.packageService, this.packageHandlers),
      install: (pkg) => this._installInteractive(pkg),
      copy: (pkg) => this._copyCommand(pkg, false)
    });
  }

  activate() {
    this.context.subscriptions.push(
      this.packageService.cache,
      vscode.window.registerWebviewViewProvider('npmCatalogView', this.viewProvider, {
        webviewOptions: { retainContextWhenHidden: true }
      }),
      this.userStore.onDidChange(() => this.viewProvider.refreshView())
    );

    this._registerCommands();
    this._watchProjectChanges();
  }

  _registerCommands() {
    this._registerCommand('npmCatalog.refresh', () => this.viewProvider.refreshAll());

    this._registerCommand('npmCatalog.searchPackages', async () => {
      await vscode.commands.executeCommand('npmCatalogView.focus');
      this.viewProvider.focusSearch();
    });

    this._registerCommand('npmCatalog.clearSearch', () => this.viewProvider.clearSearch());

    this._registerCommand('npmCatalog.clearSearchHistory', () => this.userStore.clearSearchHistory());
  }

  _registerCommand(command, handler) {
    this.context.subscriptions.push(vscode.commands.registerCommand(command, handler));
  }

  _watchProjectChanges() {
    let timer = null;
    const scheduleRefresh = () => {
      clearTimeout(timer);
      timer = setTimeout(() => this.viewProvider.refreshView(), WATCH_DEBOUNCE_MS);
    };

    const watchFolders = () => {
      const watchers = getWorkspaceFolders().map((folder) => {
        const watcher = vscode.workspace.createFileSystemWatcher(
          new vscode.RelativePattern(folder, 'package.json')
        );
        watcher.onDidChange(scheduleRefresh);
        watcher.onDidCreate(scheduleRefresh);
        watcher.onDidDelete(scheduleRefresh);
        return watcher;
      });
      return vscode.Disposable.from(...watchers);
    };

    let current = watchFolders();
    this.context.subscriptions.push(
      { dispose: () => current.dispose() },
      { dispose: () => clearTimeout(timer) },
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        current.dispose();
        current = watchFolders();
        scheduleRefresh();
      })
    );
  }

  _commandFor(pkg, dev) {
    return buildCommand({
      name: pkg.name,
      installType: pkg.installType,
      manager: resolveManager(),
      dev
    });
  }

  async _copyCommand(pkg, dev) {
    await vscode.env.clipboard.writeText(this._commandFor(pkg, dev));
    vscode.window.setStatusBarMessage('Command copied to clipboard', 2500);
  }

  async _installInteractive(pkg) {

    let dev = false;
    if (!isScaffold(pkg.installType)) {
      const choice = await vscode.window.showQuickPick(
        [
          { label: 'Dependency', dev: false },
          { label: 'Dev dependency', dev: true }
        ],
        { placeHolder: `Install ${pkg.name} as…` }
      );
      if (!choice) return;
      dev = choice.dev;
    }
    await this._install(pkg, dev);
  }

  async _install(pkg, dev) {
    const scaffold = isScaffold(pkg.installType);
    let folder;

    if (scaffold) {
      folder = getWorkspaceFolders()[0];
    } else {
      folder = await pickWorkspaceFolder();
      if (!folder) {
        vscode.window.showWarningMessage('Open a project folder to install packages into it.');
        return;
      }
    }

    const command = buildCommand({
      name: pkg.name,
      installType: pkg.installType,
      manager: resolveManager(folder),
      dev
    });

    const terminal = this._terminalFor(scaffold ? undefined : folder);
    terminal.show();
    terminal.sendText(command);
  }

  _terminalFor(folder) {
    const cwd = folder ? folder.uri.fsPath : undefined;
    const name = folder ? `${TERMINAL_NAME}: ${folder.name}` : TERMINAL_NAME;
    const existing = vscode.window.terminals.find(
      (terminal) => terminal.name === name && terminal.exitStatus === undefined
    );
    return existing || vscode.window.createTerminal({ name, cwd });
  }
}

function activate(context) {
  const controller = new ExtensionController(context);
  controller.activate();
}

function deactivate() {}

module.exports = { activate, deactivate };
