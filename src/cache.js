const STORE_KEY = 'npmCatalog.cache.v2';
const PERSIST_DELAY_MS = 500;

class PackageCache {
  constructor(context, getTtlMs) {
    this.memento = context.globalState;
    this.getTtlMs = getTtlMs;
    this.entries = this.memento.get(STORE_KEY, {});
    this.persistTimer = null;
  }

  get(key) {
    const entry = this.entries[key];
    if (!entry) return null;
    if (Date.now() - entry.timestamp > this.getTtlMs()) return null;
    return entry.value;
  }

  set(key, value) {
    this.entries[key] = { timestamp: Date.now(), value };
    this._schedulePersist();
  }

  delete(key) {
    delete this.entries[key];
    this._schedulePersist();
  }

  clear() {
    this.entries = {};
    this._schedulePersist();
  }

  flush() {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    return this.memento.update(STORE_KEY, this.entries);
  }

  dispose() {
    return this.flush();
  }

  _schedulePersist() {
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.memento.update(STORE_KEY, this.entries);
    }, PERSIST_DELAY_MS);
  }
}

module.exports = { PackageCache };
