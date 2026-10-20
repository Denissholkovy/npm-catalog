const { NpmRegistryClient } = require('./npmRegistryClient');
const { PackageCache } = require('./cache');
const { MarkdownRenderer } = require('./markdownRenderer');
const { getPageSize, getCacheTtlMs } = require('./settings');

const DETAILS_TTL_MS = 10 * 60 * 1000;
const MAX_KEYWORDS = 8;

class PackageService {
  constructor(context) {
    this.client = new NpmRegistryClient();
    this.cache = new PackageCache(context, getCacheTtlMs);
    this.markdown = new MarkdownRenderer();
    this.inflight = new Map();
    this.detailsCache = new Map();
  }

  getCached(key) {
    return this.cache.get(key);
  }

  invalidate(key) {
    this.cache.delete(key);
  }

  clearAll() {
    this.cache.clear();
    this.detailsCache.clear();
  }

  loadFirstPage(key, spec) {
    return this._dedupe(`first:${key}`, async () => {
      const page = spec.exact ? await this._fetchExact(spec) : await this._fetchSearchPage(spec, 0, []);
      this.cache.set(key, page);
      return page;
    });
  }

  loadNextPage(key, spec) {
    return this._dedupe(`next:${key}`, async () => {
      const existing = this.cache.get(key);
      if (!existing) return this.loadFirstPage(key, spec);
      const page = await this._fetchSearchPage(spec, existing.nextFrom, existing.packages);
      this.cache.set(key, page);
      return page;
    });
  }

  _dedupe(id, task) {
    const running = this.inflight.get(id);
    if (running) return running;
    const promise = task().finally(() => this.inflight.delete(id));
    this.inflight.set(id, promise);
    return promise;
  }

  async _fetchExact(spec) {
    const pkg = await this.client.getExactPackage(spec.query, spec.installType);
    return { packages: [pkg], hasMore: false, nextFrom: 1 };
  }

  async _fetchSearchPage(spec, from, existingPackages) {
    const pageSize = getPageSize();
    const { fetched, packages } = await this.client.searchPackages(
      spec.query,
      pageSize,
      from,
      spec.installType
    );
    const seenNames = new Set(existingPackages.map((pkg) => pkg.name));
    return {
      packages: existingPackages.concat(packages.filter((pkg) => !seenNames.has(pkg.name))),
      hasMore: fetched >= pageSize,
      nextFrom: from + fetched
    };
  }

  async getPackageDetails(name) {
    const cached = this.detailsCache.get(name);
    if (cached && Date.now() - cached.timestamp < DETAILS_TTL_MS) return cached.value;

    const details = await this._loadPackageDetails(name);
    if (!details.error) this.detailsCache.set(name, { timestamp: Date.now(), value: details });
    return details;
  }

  async _loadPackageDetails(name) {
    const details = {
      readmeHtml: '',
      license: null,
      homepage: null,
      repositoryUrl: null,
      avatarUrl: null,
      weeklyDownloads: null,
      stars: null,
      deprecated: null,
      hasTypes: false,
      lastPublish: null,
      versionsCount: null,
      dependenciesCount: null,
      unpackedSize: null,
      keywords: []
    };

    let repo = null;
    try {
      const meta = await this.client.getPackageMetadata(name);
      const latestVersion = meta['dist-tags'] && meta['dist-tags'].latest;
      const versionInfo = (meta.versions && meta.versions[latestVersion]) || {};

      details.readmeHtml = this.markdown.render(meta.readme || versionInfo.readme);
      details.license = this._normalizeLicense(versionInfo.license || meta.license);
      details.homepage = versionInfo.homepage || meta.homepage || null;
      details.deprecated = versionInfo.deprecated || null;
      details.hasTypes = Boolean(versionInfo.types || versionInfo.typings);
      details.lastPublish = (meta.time && meta.time[latestVersion]) || null;
      details.versionsCount = meta.versions ? Object.keys(meta.versions).length : null;
      details.dependenciesCount = Object.keys(versionInfo.dependencies || {}).length;
      details.unpackedSize = (versionInfo.dist && versionInfo.dist.unpackedSize) || null;
      details.keywords = (versionInfo.keywords || meta.keywords || []).slice(0, MAX_KEYWORDS);

      repo = versionInfo.repository || meta.repository;
      details.repositoryUrl = this._normalizeRepoUrl(repo);
    } catch (err) {
      details.error = err.message;
    }

    const githubRepo = this._parseGithubRepo(repo);
    const [weeklyDownloads, ghData] = await Promise.all([
      this.client.getWeeklyDownloads(name),
      githubRepo ? this.client.getGithubRepo(githubRepo.owner, githubRepo.repo) : null
    ]);

    details.weeklyDownloads = weeklyDownloads;
    if (ghData) {
      details.avatarUrl = (ghData.owner && ghData.owner.avatar_url) || null;
      details.stars = typeof ghData.stargazers_count === 'number' ? ghData.stargazers_count : null;
    }

    return details;
  }

  _normalizeLicense(license) {
    if (!license) return null;
    if (typeof license === 'string') return license;
    return license.type || null;
  }

  _repoUrlOf(repo) {
    if (!repo) return null;
    const url = typeof repo === 'string' ? repo : repo.url;
    return url ? String(url).trim() : null;
  }

  _normalizeRepoUrl(repo) {
    const url = this._repoUrlOf(repo);
    if (!url) return null;

    if (/^github:/.test(url)) return `https://github.com/${url.slice('github:'.length)}`;
    if (/^[\w.-]+\/[\w.-]+$/.test(url)) return `https://github.com/${url}`;

    return url
      .replace(/^git\+/, '')
      .replace(/^git@([^:]+):/, 'https://$1/')
      .replace(/^(?:git|ssh):\/\/(?:git@)?/, 'https://')
      .replace(/\.git$/, '');
  }

  _parseGithubRepo(repo) {
    const normalized = this._normalizeRepoUrl(repo);
    if (!normalized) return null;
    const match = normalized.match(/^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/#?]+)/);
    if (!match) return null;
    return { owner: match[1], repo: match[2] };
  }
}

module.exports = { PackageService };
