const { NpmRegistryClient } = require('./npmRegistryClient');
const { PackageCache } = require('./cache');
const { MarkdownRenderer } = require('./markdownRenderer');
const { getPageSize, getCacheTtlMs } = require('./settings');
const { sortAdvisories } = require('./projectService');
const semver = require('./semver');

const DETAILS_TTL_MS = 10 * 60 * 1000;
const SUGGEST_TTL_MS = 5 * 60 * 1000;
const SUGGEST_SIZE = 6;
const MAX_KEYWORDS = 12;
const MAX_VERSIONS = 60;
const TREND_WEEKS = 4;
const MISSING_DAY_THRESHOLD = 1000;

class PackageService {
  constructor(context) {
    this.client = new NpmRegistryClient();
    this.suggestCache = new Map();
    this.bundleCache = new Map();
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
    this.suggestCache.clear();
  }

  loadFirstPage(key, spec) {
    return this._dedupe(`first:${key}`, async () => {
      let page;
      if (spec.exactList) page = await this._fetchExactList(spec);
      else if (spec.exact) page = await this._fetchExact(spec);
      else page = await this._fetchSearchPage(spec, 0, []);
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
    return { packages: [pkg], hasMore: false, nextFrom: 1, total: 1 };
  }

  async _fetchExactList(spec) {
    const results = await Promise.all(
      spec.exactList.map((item) =>
        this.client
          .getExactPackage(item.query, item.installType)
          .then((pkg) => ({ ...pkg, label: item.label }))
          .catch(() => null)
      )
    );
    const packages = results.filter(Boolean);
    if (!packages.length) throw new Error('Could not reach the npm registry');
    return { packages, hasMore: false, nextFrom: packages.length, total: packages.length };
  }

  async suggest(term) {
    const key = term.toLowerCase();
    const cached = this.suggestCache.get(key);
    if (cached && Date.now() - cached.timestamp < SUGGEST_TTL_MS) return cached.value;
    const [names, search] = await Promise.all([
      this.client.getNameSuggestions(term, SUGGEST_SIZE),
      this.client.searchPackages(term, SUGGEST_SIZE * 2, 0, 'npm').catch(() => ({ packages: [] }))
    ]);
    const fresh = new Map(search.packages.map((pkg) => [pkg.name, pkg]));
    const merged = [];
    const add = (pkg) => {
      if (!merged.some((item) => item.name === pkg.name)) merged.push(fresh.get(pkg.name) || pkg);
    };
    const exact = fresh.get(key);
    if (exact) add(exact);
    names.forEach(add);
    search.packages
      .slice()
      .sort((a, b) => (b.weeklyDownloads || 0) - (a.weeklyDownloads || 0))
      .forEach(add);
    const value = merged.slice(0, SUGGEST_SIZE + 2);
    this.suggestCache.set(key, { timestamp: Date.now(), value });
    return value;
  }

  async _fetchSearchPage(spec, from, existingPackages) {
    const pageSize = getPageSize();
    const { fetched, total, packages } = await this.client.searchPackages(
      spec.query,
      pageSize,
      from,
      spec.installType
    );
    const seenNames = new Set(existingPackages.map((pkg) => pkg.name));
    return {
      packages: existingPackages.concat(packages.filter((pkg) => !seenNames.has(pkg.name))),
      hasMore: fetched >= pageSize,
      nextFrom: from + fetched,
      total
    };
  }

  async getPackageDetails(name) {
    const cached = this.detailsCache.get(name);
    if (cached && Date.now() - cached.timestamp < DETAILS_TTL_MS) return cached.value;

    const details = await this._loadPackageDetails(name);
    if (!details.error) this.detailsCache.set(name, { timestamp: Date.now(), value: details });
    return details;
  }

  async getBundleSize(name, version) {
    const key = `${name}@${version || 'latest'}`;
    if (this.bundleCache.has(key)) return this.bundleCache.get(key);
    const data = await this.client.getBundleSize(name, version);
    const value =
      data && typeof data.gzip === 'number'
        ? { size: data.size, gzip: data.gzip, dependencyCount: data.dependencyCount, treeShakeable: Boolean(data.hasJSModule || data.isModuleType) }
        : null;
    if (value) this.bundleCache.set(key, value);
    return value;
  }

  async _loadPackageDetails(name) {
    const details = {
      name,
      version: null,
      description: '',
      readmeHtml: '',
      license: null,
      homepage: null,
      repositoryUrl: null,
      bugsUrl: null,
      avatarUrl: null,
      github: null,
      weeklyDownloads: null,
      downloadsTrend: null,
      downloadWeeks: [],
      deprecated: null,
      types: null,
      moduleFormat: null,
      created: null,
      lastPublish: null,
      versionsCount: null,
      distTags: {},
      versions: [],
      dependencies: {},
      peerDependencies: {},
      optionalPeers: [],
      engines: {},
      unpackedSize: null,
      fileCount: null,
      maintainers: [],
      keywords: [],
      advisories: null
    };

    let repo = null;
    try {
      const meta = await this.client.getPackageMetadata(name);
      const latestVersion = meta['dist-tags'] && meta['dist-tags'].latest;
      const versionInfo = (meta.versions && meta.versions[latestVersion]) || {};
      const time = meta.time || {};

      details.version = latestVersion || null;
      details.description = versionInfo.description || meta.description || '';
      details.readmeHtml = this.markdown.render(meta.readme || versionInfo.readme);
      details.license = this._normalizeLicense(versionInfo.license || meta.license);
      details.homepage = versionInfo.homepage || meta.homepage || null;
      details.bugsUrl = this._bugsUrl(versionInfo.bugs || meta.bugs);
      details.deprecated = versionInfo.deprecated ? String(versionInfo.deprecated) : null;
      details.types =
        (versionInfo.types || versionInfo.typings || this._exportsHaveTypes(versionInfo.exports)) ? 'bundled' : null;
      details.moduleFormat = this._moduleFormat(versionInfo);
      details.created = time.created || null;
      details.lastPublish = time[latestVersion] || null;
      details.versionsCount = meta.versions ? Object.keys(meta.versions).length : null;
      details.distTags = meta['dist-tags'] || {};
      details.versions = this._recentVersions(meta);
      details.dependencies = versionInfo.dependencies || {};
      details.peerDependencies = versionInfo.peerDependencies || {};
      details.optionalPeers = Object.entries(versionInfo.peerDependenciesMeta || {})
        .filter(([, value]) => value && value.optional)
        .map(([peer]) => peer);
      details.engines = typeof versionInfo.engines === 'object' && versionInfo.engines ? versionInfo.engines : {};
      details.unpackedSize = (versionInfo.dist && versionInfo.dist.unpackedSize) || null;
      details.fileCount = (versionInfo.dist && versionInfo.dist.fileCount) || null;
      details.maintainers = (meta.maintainers || versionInfo.maintainers || [])
        .map((person) => (typeof person === 'string' ? person : person && person.name))
        .filter(Boolean);
      details.keywords = (versionInfo.keywords || meta.keywords || []).filter((k) => typeof k === 'string').slice(0, MAX_KEYWORDS);

      repo = versionInfo.repository || meta.repository;
      details.repositoryUrl = this._normalizeRepoUrl(repo);
    } catch (err) {
      details.error = err.status === 404 ? 'Package not found in the npm registry' : err.message;
      return details;
    }

    const githubRepo = this._parseGithubRepo(repo);
    const typesName = this._typesPackageName(name);
    const [range, ghData, advisories, typesExists] = await Promise.all([
      this.client.getDownloadsRange(name),
      githubRepo ? this.client.getGithubRepo(githubRepo.owner, githubRepo.repo) : null,
      details.version ? this.client.getAdvisories({ [name]: [details.version] }) : null,
      !details.types && typesName ? this.client.packageExists(typesName) : false
    ]);

    if (typesExists) details.types = typesName;
    Object.assign(details, this._downloadStats(range));
    if (details.weeklyDownloads === null) details.weeklyDownloads = await this.client.getWeeklyDownloads(name);
    details.advisories = advisories ? sortAdvisories(advisories[name] || []) : null;

    if (ghData) {
      details.avatarUrl = (ghData.owner && ghData.owner.avatar_url) || null;
      details.github = {
        url: ghData.html_url || null,
        stars: typeof ghData.stargazers_count === 'number' ? ghData.stargazers_count : null,
        forks: typeof ghData.forks_count === 'number' ? ghData.forks_count : null,
        issues: typeof ghData.open_issues_count === 'number' ? ghData.open_issues_count : null,
        pushedAt: ghData.pushed_at || null,
        archived: Boolean(ghData.archived)
      };
    }

    return details;
  }

  _downloadStats(daily) {
    if (!daily || !daily.length) return {};
    const weeks = [];
    for (let end = daily.length; end - 7 >= 0; end -= 7) {
      const chunk = daily.slice(end - 7, end);
      weeks.unshift({ start: chunk[0].day, count: this._weekTotal(chunk) });
    }
    if (!weeks.length) return {};
    const sum = (list) => list.reduce((total, week) => total + week.count, 0);
    const recent = sum(weeks.slice(-TREND_WEEKS));
    const previous = sum(weeks.slice(-TREND_WEEKS * 2, -TREND_WEEKS));
    return {
      downloadWeeks: weeks,
      weeklyDownloads: weeks[weeks.length - 1].count,
      downloadsTrend: previous > 0 ? (recent - previous) / previous : null
    };
  }

  _weekTotal(days) {
    const counts = days.map((day) => day.downloads || 0);
    const total = counts.reduce((sum, count) => sum + count, 0);
    const reported = counts.filter((count) => count > 0);
    const average = reported.length ? total / reported.length : 0;
    if (reported.length === counts.length || reported.length < 3 || average < MISSING_DAY_THRESHOLD) return total;
    return Math.round(average * counts.length);
  }

  _recentVersions(meta) {
    const time = meta.time || {};
    return Object.keys(meta.versions || {})
      .map((version) => ({
        version,
        date: time[version] || null,
        deprecated: Boolean(meta.versions[version] && meta.versions[version].deprecated),
        prerelease: semver.isPrerelease(version)
      }))
      .sort((a, b) => (b.date || '').localeCompare(a.date || '') || semver.compare(b.version, a.version))
      .slice(0, MAX_VERSIONS);
  }

  _exportsHaveTypes(exportsField) {
    if (!exportsField || typeof exportsField !== 'object') return false;
    return JSON.stringify(exportsField).includes('"types"');
  }

  _moduleFormat(versionInfo) {
    const serialized = versionInfo.exports && typeof versionInfo.exports === 'object' ? JSON.stringify(versionInfo.exports) : '';
    const esm = versionInfo.type === 'module' || Boolean(versionInfo.module) || serialized.includes('"import"');
    const cjs = versionInfo.type !== 'module' || serialized.includes('"require"');
    if (esm && cjs) return 'ESM + CJS';
    return esm ? 'ESM' : 'CJS';
  }

  _typesPackageName(name) {
    if (name.startsWith('@types/')) return null;
    const bare = name.startsWith('@') ? name.slice(1).replace('/', '__') : name;
    return `@types/${bare}`;
  }

  _bugsUrl(bugs) {
    if (!bugs) return null;
    return typeof bugs === 'string' ? bugs : bugs.url || null;
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
