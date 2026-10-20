const https = require('https');

const REQUEST_TIMEOUT_MS = 15000;
const MAX_REDIRECTS = 3;
const MAX_ATTEMPTS = 3;
const MAX_RETRY_AFTER_MS = 5000;
const RETRY_BASE_DELAY_MS = 400;
const REDIRECT_STATUSES = [301, 302, 307, 308];

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

  async _getJson(url, attempts = MAX_ATTEMPTS) {
    let lastError;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        return await this._runQueued(() => this._rawGetJson(url, MAX_REDIRECTS));
      } catch (err) {
        lastError = err;
        if (!err.retryable || attempt === attempts) break;
        await delay(Math.max(RETRY_BASE_DELAY_MS * attempt, Math.min(err.retryAfterMs || 0, MAX_RETRY_AFTER_MS)));
      }
    }
    throw lastError;
  }

  _rawGetJson(url, redirectsLeft) {
    return new Promise((resolve, reject) => {
      const fail = (err) => {
        const cause = err && err.cause && err.cause.message ? ` (${err.cause.message})` : '';
        reject(err && err.retryable !== undefined ? err : createError(`${err.message}${cause}`, true));
      };

      const request = https.get(url, { headers: { 'User-Agent': this.userAgent } }, (res) => {
        try {
          this._handleResponse(url, redirectsLeft, res, resolve, reject);
        } catch (err) {
          res.resume();
          fail(createError(`Response handling failed: ${err.message}`, false));
        }
      });

      request.setTimeout(REQUEST_TIMEOUT_MS, () => {
        request.destroy(createError(`Request timed out for ${url}`, true));
      });
      request.on('error', fail);
    });
  }

  _handleResponse(url, redirectsLeft, res, resolve, reject) {
    if (REDIRECT_STATUSES.includes(res.statusCode) && res.headers.location) {
      res.resume();
      if (redirectsLeft <= 0) {
        reject(createError('Too many redirects', false));
        return;
      }
      const next = new URL(res.headers.location, url).toString();
      resolve(this._rawGetJson(next, redirectsLeft - 1));
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
      packages: json.objects
        .filter((entry) => entry && entry.package && entry.package.name)
        .map((entry) => this._toPackageSummary(entry.package, installType))
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
    const manifest = await this._getJson(`https://registry.npmjs.org/${encodeURIComponent(name)}/latest`);
    return this._toPackageSummary(
      { name: manifest.name || name, description: manifest.description, version: manifest.version },
      installType
    );
  }

  getPackageMetadata(name) {
    return this._getJson(`https://registry.npmjs.org/${encodeURIComponent(name)}`);
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

  async getGithubRepo(owner, repo) {
    try {
      return await this._getJson(`https://api.github.com/repos/${owner}/${repo}`, 1);
    } catch {
      return null;
    }
  }
}

module.exports = { NpmRegistryClient };
