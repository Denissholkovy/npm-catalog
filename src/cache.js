const fs = require('fs');
const path = require('path');

class PackageCache {
  constructor(context) {
    this.context = context;
    this.filePath = this._resolveFilePath();
  }

  _resolveFilePath() {
    const dir = this.context.globalStorageUri.fsPath;
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    return path.join(dir, 'npm-cache.json');
  }

  _readAll() {
    if (!fs.existsSync(this.filePath)) return {};
    try {
      return JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
    } catch {
      return {};
    }
  }

  _writeAll(data) {
    fs.writeFileSync(this.filePath, JSON.stringify(data, null, 2), 'utf8');
  }

  get(key) {
    return this._readAll()[key] || null;
  }

  set(key, value) {
    const all = this._readAll();
    all[key] = { timestamp: Date.now(), value };
    this._writeAll(all);
  }
}

module.exports = { PackageCache };
