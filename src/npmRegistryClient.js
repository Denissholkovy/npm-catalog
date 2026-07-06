const https = require('https');

class NpmRegistryClient {
  constructor(userAgent, maxConcurrentRequests) {
    this.userAgent = userAgent || 'npm-catalog-vscode';
    this.maxConcurrentRequests = maxConcurrentRequests || 4;
    this.activeRequests = 0;
    this.pendingQueue = [];
  }

  _runQueued(task) {
    return new Promise((resolve, reject) => {
      const run = () => {
        this.activeRequests++;
        task()
          .then(resolve, reject)
          .finally(() => {
            this.activeRequests--;
            this._drainQueue();
          });
      };
      this.pendingQueue.push(run);
      this._drainQueue();
    });
  }

  _drainQueue() {
    while (this.activeRequests < this.maxConcurrentRequests && this.pendingQueue.length > 0) {
      const run = this.pendingQueue.shift();
      run();
    }
  }

  _getJson(url) {
    return this._runQueued(() => this._rawGetJson(url));
  }

  _rawGetJson(url) {
    return new Promise((resolve, reject) => {
      https
        .get(url, { headers: { 'User-Agent': this.userAgent } }, (res) => {
          let data = '';
          res.on('data', (chunk) => (data += chunk));
          res.on('end', () => {
            if (res.statusCode !== 200) {
              reject(new Error(`Status ${res.statusCode} for ${url}`));
              return;
            }
            try {
              resolve(JSON.parse(data));
            } catch (err) {
              reject(err);
            }
          });
        })
        .on('error', reject);
    });
  }

  async searchPackages(query, size, from, installType) {
    const url =
      `https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(query)}` +
      `&size=${size}&from=${from || 0}` +
      `&popularity=1.0&quality=0.3&maintenance=0.0`;
    const json = await this._getJson(url);

    if (!json || !Array.isArray(json.objects)) {
      throw new Error('Unexpected response from npm registry search API');
    }

    return json.objects
      .filter((entry) => entry && entry.package && entry.package.name)
      .map((entry) => this._toPackageSummary(entry.package, installType));
  }

  _toPackageSummary(pkg, installType) {
    return {
      name: pkg.name,
      description: pkg.description || 'No description available',
      npmUrl: (pkg.links && pkg.links.npm) || `https://www.npmjs.com/package/${pkg.name}`,
      install: this._buildInstallCommand(pkg.name, installType),
      commandType: installType || 'npm',
      version: pkg.version
    };
  }

  _buildInstallCommand(name, installType) {
    switch (installType) {
      case 'npx':
        return `npx ${name}@latest`;
      case 'npm-create': {
        const shortName = name.replace(/^create-/, '');
        return `npm create ${shortName}@latest`;
      }
      default:
        return `npm install ${name}`;
    }
  }

  getPackageMetadata(name) {
    return this._getJson(`https://registry.npmjs.org/${encodeURIComponent(name)}`);
  }

  async getWeeklyDownloads(name) {
    try {
      const data = await this._getJson(
        `https://api.npmjs.org/downloads/point/last-week/${encodeURIComponent(name)}`
      );
      return typeof data.downloads === 'number' ? data.downloads : null;
    } catch {
      return null;
    }
  }

  async getGithubRepo(owner, repo) {
    try {
      return await this._getJson(`https://api.github.com/repos/${owner}/${repo}`);
    } catch {
      return null;
    }
  }
}

module.exports = { NpmRegistryClient };
