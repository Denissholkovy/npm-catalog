const https = require('https');

const REQUEST_TIMEOUT_MS = 15000;
const MAX_REDIRECTS = 3;
const MAX_ATTEMPTS = 3;
const MAX_RETRY_AFTER_MS = 5000;
const RETRY_BASE_DELAY_MS = 400;
const REDIRECT_STATUSES = [301, 302, 307, 308];
const MAX_CARD_KEYWORDS = 4;

function encodePackageName(name) {
  return String(name).startsWith('@') ? `@${encodeURIComponent(String(name).slice(1))}` : encodeURIComponent(name);
}

function createError(message, retryable, status) {
  const error = new Error(message);
  error.retryable = retryable;
  error.status = status;
  return error;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

  _getJson(url, attempts = MAX_ATTEMPTS, options = {}) {
    return this._requestJson(url, attempts, options);
  }

  _postJson(url, body, attempts = MAX_ATTEMPTS) {
    return this._requestJson(url, attempts, { method: 'POST', body: JSON.stringify(body) });
  }

  async _requestJson(url, attempts, options) {
    let lastError;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        return await this._runQueued(() => this._rawGetJson(url, MAX_REDIRECTS, options));
      } catch (err) {
        lastError = err;
        if (!err.retryable || attempt === attempts) break;
        await delay(Math.max(RETRY_BASE_DELAY_MS * attempt, Math.min(err.retryAfterMs || 0, MAX_RETRY_AFTER_MS)));
      }
    }
    throw lastError;
  }

  _rawGetJson(url, redirectsLeft, options = {}) {
    return new Promise((resolve, reject) => {
      const fail = (err) => {
        const cause = err && err.cause && err.cause.message ? ` (${err.cause.message})` : '';
        reject(err && err.retryable !== undefined ? err : createError(`${err.message}${cause}`, true));
      };

      const headers = { 'User-Agent': this.userAgent, ...(options.headers || {}) };
      if (options.body) {
        headers['Content-Type'] = 'application/json';
        headers['Content-Length'] = Buffer.byteLength(options.body);
      }
      const request = https.request(url, { method: options.method || 'GET', headers }, (res) => {
        try {
          this._handleResponse(url, redirectsLeft, res, resolve, reject, options);
        } catch (err) {
          res.resume();
          fail(createError(`Response handling failed: ${err.message}`, false));
        }
      });

      request.setTimeout(REQUEST_TIMEOUT_MS, () => {
        request.destroy(createError(`Request timed out for ${url}`, true));
      });
      request.on('error', fail);
      request.end(options.body);
    });
  }

  _handleResponse(url, redirectsLeft, res, resolve, reject, options) {
    if (REDIRECT_STATUSES.includes(res.statusCode) && res.headers.location) {
      res.resume();
      if (redirectsLeft <= 0) {
        reject(createError('Too many redirects', false));
        return;
      }
      const next = new URL(res.headers.location, url).toString();
      resolve(this._rawGetJson(next, redirectsLeft - 1, options));
      return;
    }

    const chunks = [];
    res.on('data', (chunk) => chunks.push(chunk));
    res.on('error', (err) => reject(createError(err.message, true)));
    res.on('end', () => {
      if (res.statusCode !== 200) {
        const retryable = res.statusCode >= 500 || res.statusCode === 429;
        const error = createError(`Status ${res.statusCode} for ${url}`, retryable, res.statusCode);
        error.retryAfterMs = Number(res.headers['retry-after']) * 1000 || 0;
        reject(error);
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(createError(`Invalid JSON from ${url}`, false));
      }
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

    return {
      fetched: json.objects.length,
      total: typeof json.total === 'number' ? json.total : null,
      packages: json.objects
        .filter((entry) => entry && entry.package && entry.package.name)
        .map((entry) => this._fromSearchEntry(entry, installType))
    };
  }

  _fromSearchEntry(entry, installType) {
    const pkg = entry.package;
    const links = pkg.links || {};
    const downloads = entry.downloads || {};
    const dependents = Number(entry.dependents);
    return {
      ...this._toPackageSummary(pkg, installType),
      weeklyDownloads: typeof downloads.weekly === 'number' ? downloads.weekly : null,
      monthlyDownloads: typeof downloads.monthly === 'number' ? downloads.monthly : null,
      dependents: Number.isFinite(dependents) ? dependents : null,
      updated: pkg.date || entry.updated || null,
      license: typeof pkg.license === 'string' ? pkg.license : null,
      publisher: (pkg.publisher && pkg.publisher.username) || null,
      maintainers: Array.isArray(pkg.maintainers) ? pkg.maintainers.length : null,
      keywords: Array.isArray(pkg.keywords) ? pkg.keywords.slice(0, MAX_CARD_KEYWORDS) : [],
      repositoryUrl: links.repository || null,
      homepage: links.homepage || null
    };
  }

  _toPackageSummary(pkg, installType) {
    return {
      name: pkg.name,
      description: pkg.description || 'No description available',
      npmUrl: (pkg.links && pkg.links.npm) || `https://www.npmjs.com/package/${pkg.name}`,
      installType: installType || 'npm',
      version: pkg.version
    };
  }

  async getExactPackage(name, installType) {
    const [manifest, weeklyDownloads] = await Promise.all([
      this.getLatestManifest(name),
      this.getWeeklyDownloads(name)
    ]);
    return {
      ...this._toPackageSummary(
        { name: manifest.name || name, description: manifest.description, version: manifest.version },
        installType
      ),
      weeklyDownloads,
      license: typeof manifest.license === 'string' ? manifest.license : null,
      keywords: Array.isArray(manifest.keywords) ? manifest.keywords.slice(0, MAX_CARD_KEYWORDS) : []
    };
  }

  getLatestManifest(name) {
    return this._getJson(`https://registry.npmjs.org/${encodePackageName(name)}/latest`);
  }

  getPackageMetadata(name) {
    return this._getJson(`https://registry.npmjs.org/${encodePackageName(name)}`);
  }

  async packageExists(name) {
    try {
      await this._getJson(`https://registry.npmjs.org/${encodePackageName(name)}/latest`, 1);
      return true;
    } catch {
      return false;
    }
  }

  async getWeeklyDownloads(name) {
    try {
      const data = await this._getJson(
        `https://api.npmjs.org/downloads/point/last-week/${encodeURIComponent(name)}`,
        1
      );
      return typeof data.downloads === 'number' ? data.downloads : null;
    } catch {
      return null;
    }
  }

  async getDownloadsRange(name) {
    try {
      const data = await this._getJson(
        `https://api.npmjs.org/downloads/range/last-year/${encodeURIComponent(name)}`,
        1
      );
      return Array.isArray(data.downloads) ? data.downloads : null;
    } catch {
      return null;
    }
  }

  async getAdvisories(versionsByName) {
    if (!Object.keys(versionsByName).length) return {};
    try {
      const data = await this._postJson('https://registry.npmjs.org/-/npm/v1/security/advisories/bulk', versionsByName, 2);
      return data && typeof data === 'object' ? data : {};
    } catch {
      return null;
    }
  }

  async getBundleSize(name, version) {
    try {
      const spec = version ? `${name}@${version}` : name;
      return await this._getJson(`https://bundlephobia.com/api/size?package=${encodeURIComponent(spec)}`, 1);
    } catch {
      return null;
    }
  }

  async getNameSuggestions(term, size) {
    try {
      const data = await this._getJson(
        `https://api.npms.io/v2/search/suggestions?q=${encodeURIComponent(term)}&size=${size}`,
        1
      );
      return Array.isArray(data)
        ? data
            .filter((entry) => entry && entry.package && entry.package.name)
            .map((entry) => ({
              name: entry.package.name,
              description: entry.package.description || '',
              npmUrl: `https://www.npmjs.com/package/${entry.package.name}`,
              installType: 'npm'
            }))
        : [];
    } catch {
      return [];
    }
  }

  async getGithubRepo(owner, repo) {
    try {
      return await this._getJson(`https://api.github.com/repos/${owner}/${repo}`, 1);
    } catch {
      return null;
    }
  }
}

module.exports = { NpmRegistryClient };
