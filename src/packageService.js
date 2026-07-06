const { NpmRegistryClient } = require('./npmRegistryClient');
const { PackageCache } = require('./cache');
const { MarkdownRenderer } = require('./markdownRenderer');

const PAGE_SIZE = 20;

class PackageService {
  constructor(context) {
    this.client = new NpmRegistryClient();
    this.cache = new PackageCache(context);
    this.markdown = new MarkdownRenderer();
  }

  peekCategory(cacheKey) {
    const cached = this.cache.get(cacheKey);
    return cached ? cached.value : null;
  }

  async fetchFirstPage(cacheKey, query) {
    const packages = await this._fetchPageWithRetry(query, 0);
    const page = { packages, hasMore: packages.length === PAGE_SIZE };
    this.cache.set(cacheKey, page);
    return page;
  }

  async fetchNextPage(cacheKey, query) {
    const existing = this.peekCategory(cacheKey);
    const existingPackages = existing ? existing.packages : [];

    const newPackages = await this._fetchPageWithRetry(query, existingPackages.length);

    const seenNames = new Set(existingPackages.map((pkg) => pkg.name));
    const merged = existingPackages.concat(newPackages.filter((pkg) => !seenNames.has(pkg.name)));

    const page = { packages: merged, hasMore: newPackages.length === PAGE_SIZE };
    this.cache.set(cacheKey, page);
    return page;
  }

  async _fetchPageWithRetry(query, from, attempts = 2) {
    let lastError;
    for (let i = 0; i < attempts; i++) {
      try {
        return await this.client.searchPackages(query, PAGE_SIZE, from);
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError;
  }

  async getPackageDetails(name) {
    const details = {
      readmeHtml: '',
      license: null,
      homepage: null,
      repositoryUrl: null,
      avatarUrl: null,
      weeklyDownloads: null,
      stars: null
    };

    try {
      const meta = await this.client.getPackageMetadata(name);
      const latestVersion = meta['dist-tags'] && meta['dist-tags'].latest;
      const versionInfo = (meta.versions && meta.versions[latestVersion]) || {};

      details.readmeHtml = this.markdown.render(meta.readme);
      details.license = versionInfo.license || meta.license || null;
      details.homepage = versionInfo.homepage || meta.homepage || null;

      const repo = versionInfo.repository || meta.repository;
      details.repositoryUrl = this._normalizeRepoUrl(repo);

      const githubRepo = this._parseGithubRepo(repo);
      if (githubRepo) {
        const ghData = await this.client.getGithubRepo(githubRepo.owner, githubRepo.repo);
        if (ghData) {
          details.avatarUrl = ghData.owner && ghData.owner.avatar_url;
          details.stars = ghData.stargazers_count;
        }
      }
    } catch (err) {
      details.error = err.message;
    }

    details.weeklyDownloads = await this.client.getWeeklyDownloads(name);

    return details;
  }

  _normalizeRepoUrl(repo) {
    if (!repo) return null;
    const url = typeof repo === 'string' ? repo : repo.url;
    if (!url) return null;
    return url.replace(/^git\+/, '').replace(/\.git$/, '').replace(/^git:\/\//, 'https://');
  }

  _parseGithubRepo(repo) {
    if (!repo) return null;
    const url = typeof repo === 'string' ? repo : repo.url;
    if (!url || !url.includes('github.com')) return null;
    const match = url.match(/github\.com[/:]([^/]+)\/([^/.]+)/);
    if (!match) return null;
    return { owner: match[1], repo: match[2].replace(/\.git$/, '') };
  }
}

module.exports = { PackageService };
