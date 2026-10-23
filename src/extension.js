const vscode = require('vscode');
const path = require('path');
const { PackageService } = require('./packageService');
const { ProjectService } = require('./projectService');
const { CatalogViewProvider } = require('./catalogViewProvider');
const { PackageDetailsPanel } = require('./packageDetailsPanel');
const { UserStore } = require('./userStore');
const { buildCommand, buildUpdateCommand, buildUninstallCommand, isScaffold } = require('./installCommand');
const { LOCKFILES, getWorkspaceFolders, pickWorkspaceFolder, resolveManager, readInstalled } = require('./projectEnv');
const { safeHttpUrl } = require('./htmlUtils');

const TERMINAL_NAME = 'NPM Catalog';
const WATCH_DEBOUNCE_MS = 400;
const WATCHED_FILES = `{package.json,${LOCKFILES.map(([file]) => file).join(',')}}`;
const PACKAGE_NAME_PATTERN = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;

class ExtensionController {
  constructor(context) {
    this.context = context;
    this.packageService = new PackageService(context);
    this.projectService = new ProjectService(this.packageService.client);
    this.userStore = new UserStore(context);
    this.detailsHandlers = {
      install: (pkg, options) => this._install(pkg, options),
      copy: (text) => this._copyText(text),
      update: (name, dev) => this._update(undefined, [name], dev),
      uninstall: (name) => this._uninstall(undefined, name),
      toggleFavorite: (pkg) => this.userStore.toggleFavorite(pkg),
      isFavorite: (name) => this.userStore.isFavorite(name),
      installedInfo: (name) => readInstalled()[name] || null,
      defaultManager: () => resolveManager(),
      viewed: (pkg) => this.userStore.addRecent(pkg),
      openUrl: (url) => this._openUrl(url)
    };
    this.viewProvider = new CatalogViewProvider(context, this.packageService, this.projectService, this.userStore, {
      showDetails: (pkg) => this._showDetails(pkg),
      install: (pkg, dev) => this._install(pkg, { dev }),
      copy: (pkg, dev) => this._copyText(this._commandFor(pkg, dev)),
      update: (folder, names, dev) => this._update(folder, names, dev),
      uninstall: (folder, name) => this._uninstall(folder, name),
      openManifest: (folder) => this._openManifest(folder),
      initProject: () => this._initProject(),
      openUrl: (url) => this._openUrl(url)
    });
  }

  activate() {
    this.context.subscriptions.push(
      this.packageService.cache,
      vscode.window.registerWebviewViewProvider('npmCatalogView', this.viewProvider, {
        webviewOptions: { retainContextWhenHidden: true }
      }),
      this.userStore.onDidChange(() => {
        this.viewProvider.refreshView();
        if (PackageDetailsPanel.current) PackageDetailsPanel.current.refreshUserState();
      })
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

    this._registerCommand('npmCatalog.showProjectDependencies', async () => {
      await vscode.commands.executeCommand('npmCatalogView.focus');
      this.viewProvider.showTab('project');
    });

    this._registerCommand('npmCatalog.openPackage', async () => {
      const name = await vscode.window.showInputBox({
        title: 'Open npm package',
        prompt: 'Exact package name, e.g. zod or @tanstack/react-query',
        validateInput: (value) => (PACKAGE_NAME_PATTERN.test(value.trim()) ? null : 'Not a valid npm package name')
      });
      if (name) this._showDetails({ name: name.trim(), installType: 'npm', npmUrl: `https://www.npmjs.com/package/${name.trim()}` });
    });
  }

  _registerCommand(command, handler) {
    this.context.subscriptions.push(vscode.commands.registerCommand(command, handler));
  }

  _watchProjectChanges() {
    let timer = null;
    const scheduleRefresh = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        this.viewProvider.onProjectFilesChanged();
        if (PackageDetailsPanel.current) PackageDetailsPanel.current.refreshUserState();
      }, WATCH_DEBOUNCE_MS);
    };

    const watchFolders = () => {
      const watchers = getWorkspaceFolders().map((folder) => {
        const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, WATCHED_FILES));
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

  _showDetails(pkg) {
    PackageDetailsPanel.show(pkg, this.packageService, this.detailsHandlers, this.context.extensionUri);
  }

  _commandFor(pkg, dev) {
    return buildCommand({
      name: pkg.name,
      installType: pkg.installType,
      manager: resolveManager(),
      dev
    });
  }

  async _copyText(text) {
    await vscode.env.clipboard.writeText(text);
    vscode.window.setStatusBarMessage(`$(check) Copied: ${text}`, 2500);
  }

  _folderByPath(folderPath) {
    return getWorkspaceFolders().find((folder) => folder.uri.fsPath === folderPath);
  }

  async _resolveFolder(folderPath) {
    const folder = folderPath ? this._folderByPath(folderPath) : await pickWorkspaceFolder();
    if (!folder) vscode.window.showWarningMessage('Open a project folder first.');
    return folder;
  }

  async _install(pkg, { dev = false, version, manager } = {}) {
    const scaffold = isScaffold(pkg.installType);
    const folder = scaffold ? getWorkspaceFolders()[0] : await this._resolveFolder();
    if (!scaffold && !folder) return;

    const command = buildCommand({
      name: pkg.name,
      installType: pkg.installType,
      manager: manager || resolveManager(folder),
      dev,
      version
    });
    this._run(scaffold ? undefined : folder, command);
  }

  async _update(folderPath, names, dev) {
    const folder = await this._resolveFolder(folderPath);
    if (!folder) return;
    const installed = readInstalled();
    const isDev = dev || names.every((name) => installed[name] && installed[name].field === 'devDependencies');
    this._run(folder, buildUpdateCommand({ names, manager: resolveManager(folder), dev: isDev }));
  }

  async _uninstall(folderPath, name) {
    const folder = await this._resolveFolder(folderPath);
    if (!folder) return;
    const confirm = await vscode.window.showWarningMessage(
      `Remove ${name} from ${folder.name}?`,
      { modal: true, detail: 'The package will be uninstalled and removed from package.json.' },
      'Uninstall'
    );
    if (confirm !== 'Uninstall') return;
    this._run(folder, buildUninstallCommand({ names: [name], manager: resolveManager(folder) }));
  }

  async _openManifest(folderPath) {
    const folder = folderPath ? this._folderByPath(folderPath) : getWorkspaceFolders()[0];
    if (!folder) return;
    const document = await vscode.workspace.openTextDocument(path.join(folder.uri.fsPath, 'package.json'));
    vscode.window.showTextDocument(document);
  }

  async _initProject() {
    const folder = await this._resolveFolder();
    if (!folder) return;
    const manager = resolveManager(folder);
    this._run(folder, `${manager} init${manager === 'npm' ? ' -y' : ''}`);
  }

  _openUrl(url) {
    const safe = safeHttpUrl(url);
    if (safe) vscode.env.openExternal(vscode.Uri.parse(safe));
  }

  _run(folder, command) {
    const terminal = this._terminalFor(folder);
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
