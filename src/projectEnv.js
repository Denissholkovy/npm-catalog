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
const MAX_GLOB_DEPTH = 4;

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

function readText(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

function readInstalledVersion(dirs, name) {
  for (const dir of dirs) {
    const manifest = readJson(path.join(dir, 'node_modules', ...name.split('/'), 'package.json'));
    if (manifest && typeof manifest.version === 'string') return manifest.version;
  }
  return null;
}

function readPnpmPatterns(rootPath) {
  const text = readText(path.join(rootPath, 'pnpm-workspace.yaml'));
  if (!text) return null;
  const patterns = [];
  let inPackages = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^packages\s*:/.test(line)) {
      inPackages = true;
      continue;
    }
    if (!inPackages) continue;
    const item = line.match(/^\s*-\s*['"]?([^'"#]+?)['"]?\s*(?:#.*)?$/);
    if (item) patterns.push(item[1].trim());
    else if (/^\S/.test(line)) break;
  }
  return patterns;
}

function detectWorkspacePatterns(rootPath, manifest) {
  const pnpm = readPnpmPatterns(rootPath);
  if (pnpm && pnpm.length) return { tool: 'pnpm workspaces', patterns: pnpm };

  const field = manifest.workspaces;
  const fromField = Array.isArray(field) ? field : field && Array.isArray(field.packages) ? field.packages : null;
  if (fromField && fromField.length) return { tool: 'workspaces', patterns: fromField };

  const lerna = readJson(path.join(rootPath, 'lerna.json'));
  if (lerna) return { tool: 'lerna', patterns: Array.isArray(lerna.packages) ? lerna.packages : ['packages/*'] };

  return null;
}

function listDirectories(dir) {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name !== 'node_modules' && !entry.name.startsWith('.'))
      .map((entry) => path.join(dir, entry.name));
  } catch {
    return [];
  }
}

function descendants(dir, depth) {
  const found = [dir];
  if (depth <= 0) return found;
  for (const child of listDirectories(dir)) found.push(...descendants(child, depth - 1));
  return found;
}

function segmentPattern(segment) {
  const escaped = segment.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]');
  return new RegExp(`^${escaped}$`);
}

function expandPattern(rootPath, pattern) {
  const segments = pattern.replace(/^\.\//, '').replace(/\/+$/, '').split('/').filter(Boolean);
  let current = [rootPath];
  for (const segment of segments) {
    const next = [];
    for (const dir of current) {
      if (segment === '**') next.push(...descendants(dir, MAX_GLOB_DEPTH));
      else if (/[*?]/.test(segment)) {
        const matcher = segmentPattern(segment);
        next.push(...listDirectories(dir).filter((child) => matcher.test(path.basename(child))));
      } else next.push(path.join(dir, segment));
    }
    current = next;
  }
  return current;
}

function expandWorkspaces(rootPath, patterns) {
  const included = new Set();
  const excluded = new Set();
  for (const raw of patterns) {
    const pattern = String(raw).trim();
    const negated = pattern.startsWith('!');
    for (const dir of expandPattern(rootPath, negated ? pattern.slice(1) : pattern)) {
      (negated ? excluded : included).add(path.resolve(dir));
    }
  }
  return [...included]
    .filter((dir) => !excluded.has(dir) && dir !== path.resolve(rootPath) && fs.existsSync(path.join(dir, 'package.json')))
    .sort();
}

function readPackageDir(dir, options) {
  const manifest = options.manifest || readJson(path.join(dir, 'package.json'));
  if (!manifest) return null;
  const lookupDirs = dir === options.rootPath ? [dir] : [dir, options.rootPath];

  const dependencies = [];
  for (const field of DEPENDENCY_FIELDS) {
    for (const [name, range] of Object.entries(manifest[field] || {})) {
      if (dependencies.some((dep) => dep.name === name)) continue;
      dependencies.push({
        name,
        range: String(range),
        field,
        internal: options.internalNames.has(name),
        installed: readInstalledVersion(lookupDirs, name)
      });
    }
  }

  return {
    folder: dir,
    folderName: options.label,
    name: manifest.name || options.label,
    version: manifest.version || null,
    private: Boolean(manifest.private),
    manager: options.manager,
    root: options.rootPath,
    isRoot: dir === options.rootPath,
    dependencies
  };
}

function readWorkspace(folder) {
  const rootPath = folder.uri.fsPath;
  const manifest = readJson(path.join(rootPath, 'package.json'));
  if (!manifest) return null;

  const manager = resolveManager(folder);
  const detected = detectWorkspacePatterns(rootPath, manifest);
  const memberDirs = detected ? expandWorkspaces(rootPath, detected.patterns) : [];
  const members = memberDirs.map((dir) => ({ dir, manifest: readJson(path.join(dir, 'package.json')) })).filter((m) => m.manifest);
  const internalNames = new Set(members.map((member) => member.manifest.name).filter(Boolean));

  const rootLabel = members.length ? `${folder.name} (root)` : folder.name;
  const packages = [readPackageDir(rootPath, { manifest, label: rootLabel, rootPath, manager, internalNames })];
  for (const member of members) {
    const label = path.relative(rootPath, member.dir).split(path.sep).join('/');
    packages.push(readPackageDir(member.dir, { manifest: member.manifest, label, rootPath, manager, internalNames }));
  }

  return {
    root: rootPath,
    name: manifest.name || folder.name,
    folderName: folder.name,
    manager,
    isMonorepo: members.length > 0,
    tool: detected && members.length ? detected.tool : null,
    packages: packages.filter(Boolean)
  };
}

function readWorkspaces() {
  return getWorkspaceFolders().map(readWorkspace).filter(Boolean);
}

function readInstalled() {
  const installed = {};
  for (const workspace of readWorkspaces()) {
    for (const project of workspace.packages) {
      for (const dep of project.dependencies) {
        if (dep.internal) continue;
        const entry = installed[dep.name];
        if (entry) {
          if (!entry.packages.includes(project.folderName)) entry.packages.push(project.folderName);
          continue;
        }
        installed[dep.name] = {
          range: dep.range,
          field: dep.field,
          version: dep.installed,
          folder: project.folderName,
          path: project.folder,
          root: workspace.root,
          monorepo: workspace.isMonorepo,
          packages: [project.folderName]
        };
      }
    }
  }
  return installed;
}

module.exports = {
  LOCKFILES,
  getWorkspaceFolders,
  pickWorkspaceFolder,
  resolveManager,
  readWorkspaces,
  readInstalled
};
