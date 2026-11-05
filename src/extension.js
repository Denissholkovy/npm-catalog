const vscode = require('vscode');
const path = require('path');
const { PackageService } = require('./packageService');
const { ProjectService } = require('./projectService');
const { CatalogViewProvider } = require('./catalogViewProvider');
const { PackageDetailsPanel } = require('./packageDetailsPanel');
const { UserStore } = require('./userStore');
const { buildCommand, buildUpdateCommand, buildBulkUpdateCommand, buildUninstallCommand, isScaffold } = require('./installCommand');
const { LOCKFILES, getWorkspaceFolders, pickWorkspaceFolder, resolveManager, readInstalled } = require('./projectEnv');
const { safeHttpUrl } = require('./htmlUtils');
const { getCheckOnStartup, getShowStatusBar } = require('./settings');

const TERMINAL_NAME = 'NPM Catalog';
const WATCH_DEBOUNCE_MS = 400;
const WATCHED_FILES = `{**/package.json,pnpm-workspace.yaml,lerna.json,${LOCKFILES.map(([file]) => file).join(',')}}`;
const IGNORED_PATH = /[\\/]node_modules[\\/]/;
const STARTUP_CHECK_DELAY_MS = 4000;
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
      update: (name, dev) => this._updateInstalled(name, dev),
      uninstall: (name) => {
        const info = readInstalled()[name];
        this._uninstall(info ? info.path : undefined, name);
      },
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
      update: (folder, names, dev, scope) => this._update(folder, names, dev, scope),
      updateAll: (folder, scope, stats) => this._updateAll(folder, scope, stats),
      runUpdate: (folder, scope, mode, stats) => this._runUpdate(folder, scope, mode, stats),
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
    this._createStatusBar();
    this._scheduleStartupCheck();
  }

  _createStatusBar() {
    this.statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
    this.statusBar.name = 'NPM Catalog: dependency updates';
    this.statusBar.command = 'npmCatalog.showProjectDependencies';
    this.context.subscriptions.push(
      this.statusBar,
      this.viewProvider.onDidChangeSummary((summary) => this._renderStatusBar(summary)),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('npmCatalog.showStatusBar')) this._renderStatusBar(this.viewProvider.summary);
      })
    );
  }

  _renderStatusBar(summary) {
    if (!summary || !getShowStatusBar() || (!summary.outdated && !summary.vulnerable)) {
      this.statusBar.hide();
      return;
    }
    const parts = [];
    if (summary.vulnerable) parts.push(`$(shield) ${summary.vulnerable}`);
    if (summary.outdated) parts.push(`$(arrow-up) ${summary.outdated}`);
    this.statusBar.text = parts.join('  ');
    this.statusBar.tooltip = [
      summary.vulnerable && `${summary.vulnerable} vulnerable`,
      summary.outdated && `${summary.outdated} updates available${summary.major ? ` (${summary.major} major)` : ''}`,
      'Click to review'
    ]
      .filter(Boolean)
      .join(' · ');
    this.statusBar.backgroundColor = summary.vulnerable ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
    this.statusBar.show();
  }

  _scheduleStartupCheck() {
    if (!getCheckOnStartup() || !this.projectService.hasProjects()) return;
    const timer = setTimeout(() => {
      if (this.viewProvider.project.status === 'idle') this.viewProvider.loadProject();
    }, STARTUP_CHECK_DELAY_MS);
    this.context.subscriptions.push({ dispose: () => clearTimeout(timer) });
  }

  _registerCommands() {
    this._registerCommand('npmCatalog.refresh', () => this.viewProvider.refreshAll());

    this._registerCommand('npmCatalog.searchPackages', async () => {
      await vscode.commands.executeCommand('npmCatalogView.focus');
      this.viewProvider.showTab('explore');
      this.viewProvider.focusSearch();
    });

    this._registerCommand('npmCatalog.clearSearch', () => this.viewProvider.clearSearch());

    this._registerCommand('npmCatalog.clearSearchHistory', () => this.userStore.clearSearchHistory());

    this._registerCommand('npmCatalog.showProjectDependencies', async () => {
      await vscode.commands.executeCommand('npmCatalogView.focus');
      this.viewProvider.showTab('updates');
    });

    this._registerCommand('npmCatalog.updateAllDependencies', () => this._updateAllFromPalette());

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
    const scheduleRefresh = (uri) => {
      if (uri && IGNORED_PATH.test(uri.fsPath)) return;
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

  _targetFor(folderPath) {
    const root = getWorkspaceFolders().find(
      (folder) => folderPath === folder.uri.fsPath || folderPath.startsWith(folder.uri.fsPath + path.sep)
    );
    if (!root) return null;
    const relative = path.relative(root.uri.fsPath, folderPath).split(path.sep).join('/');
    return {
      uri: { fsPath: folderPath },
      name: relative ? `${root.name}/${relative}` : root.name,
      manager: resolveManager(root)
    };
  }

  async _resolveFolder(folderPath) {
    if (folderPath) {
      const target = this._targetFor(folderPath);
      if (!target) vscode.window.showWarningMessage('That folder is no longer part of the workspace.');
      return target;
    }
    const folder = await pickWorkspaceFolder();
    if (!folder) {
      vscode.window.showWarningMessage('Open a project folder first.');
      return null;
    }
    return { uri: folder.uri, name: folder.name, manager: resolveManager(folder) };
  }

  async _install(pkg, { dev = false, version, manager } = {}) {
    const scaffold = isScaffold(pkg.installType);
    const target = scaffold ? null : await this._resolveFolder();
    if (!scaffold && !target) return;

    const command = buildCommand({
      name: pkg.name,
      installType: pkg.installType,
      manager: manager || (target ? target.manager : resolveManager()),
      dev,
      version
    });
    this._run(target, command);
  }

  async _update(folderPath, names, dev, scope) {
    const target = await this._resolveFolder(folderPath);
    if (!target) return;
    if (scope === 'workspace' || names.length > 1) {
      this._run(target, buildBulkUpdateCommand({ names, workspaces: scope === 'workspace', manager: target.manager }));
      return;
    }
    const installed = readInstalled();
    const isDev = dev || names.every((name) => installed[name] && installed[name].field === 'devDependencies');
    this._run(target, buildUpdateCommand({ names, manager: target.manager, dev: isDev }));
  }

  _updateInstalled(name, dev) {
    const info = readInstalled()[name];
    if (!info) return this._update(undefined, [name], dev);
    if (info.monorepo) return this._update(info.root, [name], dev, 'workspace');
    return this._update(info.path, [name], dev);
  }

  async _updateAllFromPalette() {
    const data = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'NPM Catalog: checking dependencies…' },
      () => this.viewProvider.ensureProject()
    );
    const workspaces = (data && data.workspaces) || [];
    if (!workspaces.length) {
      vscode.window.showWarningMessage('No package.json found in this workspace.');
      return;
    }
    const workspace =
      workspaces.length === 1
        ? workspaces[0]
        : await vscode.window.showQuickPick(
            workspaces.map((item) => ({ label: item.folderName, description: item.isMonorepo ? `monorepo · ${item.packages.length} packages` : '', item })),
            { placeHolder: 'Which project should be updated?' }
          ).then((choice) => choice && choice.item);
    if (!workspace) return;
    const scope = workspace.isMonorepo ? 'workspace' : 'package';
    this.viewProvider.updateAll(workspace.root, scope);
  }

  async _updateAll(folderPath, scope, stats) {
    if (!stats.outdated) {
      vscode.window.showInformationMessage('All dependencies are already up to date.');
      return;
    }
    const target = await this._resolveFolder(folderPath);
    if (!target) return;
    const workspaces = scope === 'workspace';
    const where = workspaces ? `all packages of ${target.name}` : target.name;
    const command = (options) => buildBulkUpdateCommand({ ...options, workspaces, manager: target.manager });
    const plural = (count) => `${count} package${count === 1 ? '' : 's'}`;

    const choices = [];
    if (stats.vulnerable.length) {
      choices.push({
        label: '$(shield) Fix vulnerable packages',
        description: plural(stats.vulnerable.length),
        detail: command({ names: stats.vulnerable }),
        options: { names: stats.vulnerable }
      });
    }
    choices.push(
      {
        label: '$(check) Safe update — minor & patch',
        description: `up to ${plural(stats.outdated - stats.major)} · keeps major versions`,
        detail: command({ target: 'minor' }),
        options: { target: 'minor' }
      },
      {
        label: '$(rocket) Everything to latest',
        description: `${plural(stats.outdated)}${stats.major ? ` · ${stats.major} major, may need code changes` : ''}`,
        detail: command({}),
        options: {}
      }
    );

    const choice = await vscode.window.showQuickPick(choices, {
      title: `Update dependencies in ${where}`,
      placeHolder: 'Runs npm-check-updates, rewrites package.json ranges, then installs',
      matchOnDescription: true
    });
    if (choice) this._run(target, command(choice.options));
  }

  async _runUpdate(folderPath, scope, mode, stats) {
    const target = await this._resolveFolder(folderPath);
    if (!target) return false;
    const options = { workspaces: scope === 'workspace', manager: target.manager };
    if (mode === 'safe') options.target = 'minor';
    if (mode === 'vulnerable') {
      if (!stats.vulnerable.length) return false;
      options.names = stats.vulnerable;
    }
    if (mode === 'latest' && stats.major) {
      const confirm = await vscode.window.showWarningMessage(
        `Update everything to latest, including ${stats.major} major version${stats.major === 1 ? '' : 's'}?`,
        { modal: true, detail: 'Major versions can contain breaking changes. Check the release notes and run your tests afterwards.' },
        'Update all'
      );
      if (confirm !== 'Update all') return false;
    }
    this._run(target, buildBulkUpdateCommand(options));
    return true;
  }

  async _uninstall(folderPath, name) {
    const target = await this._resolveFolder(folderPath);
    if (!target) return;
    const confirm = await vscode.window.showWarningMessage(
      `Remove ${name} from ${target.name}?`,
      { modal: true, detail: 'The package will be uninstalled and removed from package.json.' },
      'Uninstall'
    );
    if (confirm !== 'Uninstall') return;
    this._run(target, buildUninstallCommand({ names: [name], manager: target.manager }));
  }

  async _openManifest(folderPath) {
    const target = folderPath || (getWorkspaceFolders()[0] && getWorkspaceFolders()[0].uri.fsPath);
    if (!target) return;
    const document = await vscode.workspace.openTextDocument(path.join(target, 'package.json'));
    vscode.window.showTextDocument(document);
  }

  async _initProject() {
    const target = await this._resolveFolder();
    if (!target) return;
    this._run(target, `${target.manager} init${target.manager === 'npm' ? ' -y' : ''}`);
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
