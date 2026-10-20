const vscode = require('vscode');

const FAVORITES_KEY = 'npmCatalog.favorites';
const HISTORY_KEY = 'npmCatalog.searchHistory';
const HISTORY_LIMIT = 10;

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
    const summary = {
      name: pkg.name,
      description: pkg.description,
      version: pkg.version,
      npmUrl: pkg.npmUrl,
      installType: pkg.installType || 'npm'
    };
    await this.memento.update(FAVORITES_KEY, [...this.getFavorites(), summary]);
    this._onDidChange.fire();
  }

  async removeFavorite(name) {
    await this.memento.update(
      FAVORITES_KEY,
      this.getFavorites().filter((pkg) => pkg.name !== name)
    );
    this._onDidChange.fire();
  }

  getSearchHistory() {
    return this.memento.get(HISTORY_KEY, []);
  }

  async addSearch(term) {
    const next = [term, ...this.getSearchHistory().filter((entry) => entry !== term)];
    await this.memento.update(HISTORY_KEY, next.slice(0, HISTORY_LIMIT));
  }

  async clearSearchHistory() {
    await this.memento.update(HISTORY_KEY, []);
  }
}

module.exports = { UserStore };
