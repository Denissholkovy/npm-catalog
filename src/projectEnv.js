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

function readInstalledNames() {
  const names = new Set();
  for (const folder of getWorkspaceFolders()) {
    try {
      const raw = fs.readFileSync(path.join(folder.uri.fsPath, 'package.json'), 'utf8');
      const manifest = JSON.parse(raw);
      for (const field of DEPENDENCY_FIELDS) {
        Object.keys(manifest[field] || {}).forEach((name) => names.add(name));
      }
    } catch {
      continue;
    }
  }
  return names;
}

module.exports = { getWorkspaceFolders, pickWorkspaceFolder, resolveManager, readInstalledNames };
