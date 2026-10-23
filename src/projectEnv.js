const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { getPackageManagerSetting } = require('./settings');

const LOCKFILES = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['bun.lockb', 'bun'],
  ['bun.lock', 'bun'],
  ['package-lock.json', 'npm']
];

const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];

function getWorkspaceFolders() {
  return vscode.workspace.workspaceFolders || [];
}

async function pickWorkspaceFolder() {
  const folders = getWorkspaceFolders();
  if (folders.length === 0) return undefined;
  if (folders.length === 1) return folders[0];
  return vscode.window.showWorkspaceFolderPick({ placeHolder: 'Select the project to install into' });
}

function detectManager(folderPath) {
  for (const [file, manager] of LOCKFILES) {
    if (fs.existsSync(path.join(folderPath, file))) return manager;
  }
  return 'npm';
}

function resolveManager(folder) {
  const setting = getPackageManagerSetting();
  if (setting !== 'auto') return setting;
  const target = folder || getWorkspaceFolders()[0];
  return target ? detectManager(target.uri.fsPath) : 'npm';
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function readInstalledVersion(folderPath, name) {
  const manifest = readJson(path.join(folderPath, 'node_modules', ...name.split('/'), 'package.json'));
  return manifest && typeof manifest.version === 'string' ? manifest.version : null;
}

function readProject(folder) {
  const folderPath = folder.uri.fsPath;
  const manifest = readJson(path.join(folderPath, 'package.json'));
  if (!manifest) return null;

  const dependencies = [];
  for (const field of DEPENDENCY_FIELDS) {
    for (const [name, range] of Object.entries(manifest[field] || {})) {
      if (dependencies.some((dep) => dep.name === name)) continue;
      dependencies.push({
        name,
        range: String(range),
        field,
        installed: readInstalledVersion(folderPath, name)
      });
    }
  }

  return {
    folder: folderPath,
    folderName: folder.name,
    name: manifest.name || folder.name,
    version: manifest.version || null,
    manager: resolveManager(folder),
    dependencies
  };
}

function readInstalled() {
  const installed = {};
  for (const folder of getWorkspaceFolders()) {
    const project = readProject(folder);
    if (!project) continue;
    for (const dep of project.dependencies) {
      if (installed[dep.name]) continue;
      installed[dep.name] = { range: dep.range, field: dep.field, version: dep.installed, folder: project.folderName };
    }
  }
  return installed;
}

module.exports = {
  LOCKFILES,
  getWorkspaceFolders,
  pickWorkspaceFolder,
  resolveManager,
  readProject,
  readInstalled
};
