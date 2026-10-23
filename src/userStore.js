const vscode = require('vscode');

const FAVORITES_KEY = 'npmCatalog.favorites';
const HISTORY_KEY = 'npmCatalog.searchHistory';
const RECENT_KEY = 'npmCatalog.recentlyViewed';
const HISTORY_LIMIT = 10;
const RECENT_LIMIT = 15;

const SUMMARY_FIELDS = [
  'name',
  'description',
  'version',
  'npmUrl',
  'installType',
  'weeklyDownloads',
  'license',
  'updated',
  'label'
];

function toSummary(pkg) {
  const summary = {};
  for (const field of SUMMARY_FIELDS) {
    if (pkg[field] !== undefined && pkg[field] !== null) summary[field] = pkg[field];
  }
  summary.installType = pkg.installType || 'npm';
  return summary;
}

class UserStore {
  constructor(context) {
    this.memento = context.globalState;
    this._onDidChange = new vscode.EventEmitter();
    this.onDidChange = this._onDidChange.event;
  }

  getFavorites() {
    return this.memento.get(FAVORITES_KEY, []);
  }

  isFavorite(name) {
    return this.getFavorites().some((pkg) => pkg.name === name);
  }

  async addFavorite(pkg) {
    if (this.isFavorite(pkg.name)) return;
    await this.memento.update(FAVORITES_KEY, [toSummary(pkg), ...this.getFavorites()]);
    this._onDidChange.fire();
  }

  async removeFavorite(name) {
    await this.memento.update(
      FAVORITES_KEY,
      this.getFavorites().filter((pkg) => pkg.name !== name)
    );
    this._onDidChange.fire();
  }

  async toggleFavorite(pkg) {
    if (this.isFavorite(pkg.name)) await this.removeFavorite(pkg.name);
    else await this.addFavorite(pkg);
  }

  getRecent() {
    return this.memento.get(RECENT_KEY, []);
  }

  async addRecent(pkg) {
    const entry = { ...toSummary(pkg), viewedAt: new Date().toISOString() };
    const next = [entry, ...this.getRecent().filter((item) => item.name !== pkg.name)];
    await this.memento.update(RECENT_KEY, next.slice(0, RECENT_LIMIT));
    this._onDidChange.fire();
  }

  async clearRecent() {
    await this.memento.update(RECENT_KEY, []);
    this._onDidChange.fire();
  }

  getSearchHistory() {
    return this.memento.get(HISTORY_KEY, []);
  }

  async addSearch(term) {
    const next = [term, ...this.getSearchHistory().filter((entry) => entry !== term)];
    await this.memento.update(HISTORY_KEY, next.slice(0, HISTORY_LIMIT));
    this._onDidChange.fire();
  }

  async removeSearch(term) {
    await this.memento.update(
      HISTORY_KEY,
      this.getSearchHistory().filter((entry) => entry !== term)
    );
    this._onDidChange.fire();
  }

  async clearSearchHistory() {
    await this.memento.update(HISTORY_KEY, []);
    this._onDidChange.fire();
  }
}

module.exports = { UserStore };
