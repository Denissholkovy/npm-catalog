const vscode = require('vscode');
const fs = require('fs');
const path = require('path');

const TASK_TYPE = 'npmCatalog';
const TASK_SOURCE = 'NPM Catalog';

function readSnapshot(files) {
  const snapshot = new Map();
  for (const file of files) {
    try {
      snapshot.set(file, fs.readFileSync(file));
    } catch {
      snapshot.set(file, null);
    }
  }
  return snapshot;
}

function restoreSnapshot(snapshot) {
  for (const [file, content] of snapshot) {
    try {
      if (content === null) {
        if (fs.existsSync(file)) fs.unlinkSync(file);
      } else if (!fs.existsSync(file) || !fs.readFileSync(file).equals(content)) {
        fs.writeFileSync(file, content);
      }
    } catch {}
  }
}

function changedFiles(snapshot) {
  let changed = 0;
  for (const [file, content] of snapshot) {
    let current = null;
    try {
      current = fs.readFileSync(file);
    } catch {}
    if (content === null ? current !== null : !current || !current.equals(content)) changed += 1;
  }
  return changed;
}

class UpdateRunner {
  constructor() {
    this.running = null;
    this._onDidChangeState = new vscode.EventEmitter();
    this.onDidChangeState = this._onDidChangeState.event;
  }

  get busy() {
    return Boolean(this.running);
  }

  async run({ scope, cwd, title, steps, files }) {
    if (this.running) {
      vscode.window.showWarningMessage('An update is already running. Wait for it to finish first.');
      return { status: 'busy' };
    }
    const snapshot = readSnapshot(files);
    this.running = title;
    this._onDidChangeState.fire(true);
    try {
      for (const step of steps) {
        const exitCode = await this._execute(scope, cwd, `${title}: ${step.label}`, step.command);
        if (exitCode !== 0) {
          const touched = changedFiles(snapshot);
          restoreSnapshot(snapshot);
          return { status: 'failed', step: step.id, exitCode, restored: touched };
        }
      }
      return { status: 'done' };
    } catch (error) {
      restoreSnapshot(snapshot);
      return { status: 'error', message: error && error.message ? error.message : String(error) };
    } finally {
      this.running = null;
      this._onDidChangeState.fire(false);
    }
  }

  async _execute(scope, cwd, name, command) {
    const task = new vscode.Task(
      { type: TASK_TYPE, command },
      scope || vscode.TaskScope.Workspace,
      name,
      TASK_SOURCE,
      new vscode.ShellExecution(command, { cwd })
    );
    task.presentationOptions = {
      reveal: vscode.TaskRevealKind.Always,
      panel: vscode.TaskPanelKind.Shared,
      clear: true,
      showReuseMessage: false,
      echo: true
    };
    task.problemMatchers = [];

    return new Promise((resolve, reject) => {
      let execution = null;
      const subscriptions = [];
      const finish = (code) => {
        subscriptions.forEach((item) => item.dispose());
        resolve(code);
      };
      subscriptions.push(
        vscode.tasks.onDidEndTaskProcess((event) => {
          if (event.execution === execution || (execution === null && event.execution.task.name === name)) {
            finish(typeof event.exitCode === 'number' ? event.exitCode : -1);
          }
        }),
        vscode.tasks.onDidEndTask((event) => {
          if (event.execution === execution) setTimeout(() => finish(-1), 1000);
        })
      );
      vscode.tasks.executeTask(task).then(
        (started) => {
          execution = started;
        },
        (error) => {
          subscriptions.forEach((item) => item.dispose());
          reject(error);
        }
      );
    });
  }
}

function manifestFiles(dirs, lockDirs, lockfiles) {
  const files = new Set();
  for (const dir of dirs) files.add(path.join(dir, 'package.json'));
  for (const dir of lockDirs) for (const lockfile of lockfiles) files.add(path.join(dir, lockfile));
  return [...files];
}

module.exports = { UpdateRunner, TASK_TYPE, manifestFiles };
