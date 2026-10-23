const { getWorkspaceFolders, readProject } = require('./projectEnv');
const semver = require('./semver');

const LATEST_TTL_MS = 30 * 60 * 1000;
const SEVERITY_ORDER = ['critical', 'high', 'moderate', 'low', 'info'];

function severityRank(severity) {
  const index = SEVERITY_ORDER.indexOf(severity);
  return index === -1 ? SEVERITY_ORDER.length : index;
}

function worstSeverity(advisories) {
  return advisories.reduce(
    (worst, advisory) => (worst === null || severityRank(advisory.severity) < severityRank(worst) ? advisory.severity : worst),
    null
  );
}

function toAdvisory(raw) {
  return {
    id: raw.id,
    title: raw.title || 'Security advisory',
    severity: raw.severity || 'info',
    url: raw.url || null,
    vulnerableVersions: raw.vulnerable_versions || null
  };
}

function sortAdvisories(list) {
  return list.map(toAdvisory).sort((a, b) => severityRank(a.severity) - severityRank(b.severity));
}

class ProjectService {
  constructor(client) {
    this.client = client;
    this.latest = new Map();
    this.running = null;
  }

  clear() {
    this.latest.clear();
  }

  hasProjects() {
    return getWorkspaceFolders().some((folder) => readProject(folder));
  }

  scan(onProgress) {
    if (this.running) return this.running;
    this.running = this._scan(onProgress).finally(() => {
      this.running = null;
    });
    return this.running;
  }

  async _scan(onProgress) {
    const projects = getWorkspaceFolders().map(readProject).filter(Boolean);
    const remote = new Map();
    for (const project of projects) {
      for (const dep of project.dependencies) {
        if (!semver.isLocalRange(dep.range)) remote.set(dep.name, null);
      }
    }

    const names = [...remote.keys()];
    let done = 0;
    const report = () => onProgress && onProgress({ done, total: names.length });
    report();

    await Promise.all(
      names.map(async (name) => {
        remote.set(name, await this._latestFor(name));
        done++;
        report();
      })
    );

    const advisories = await this.client.getAdvisories(this._versionsToAudit(projects));

    return {
      auditAvailable: advisories !== null,
      projects: projects.map((project) => this._enrich(project, remote, advisories || {}))
    };
  }

  _versionsToAudit(projects) {
    const versions = {};
    for (const project of projects) {
      for (const dep of project.dependencies) {
        if (semver.isLocalRange(dep.range)) continue;
        const current = dep.installed || semver.minVersion(dep.range);
        if (!current) continue;
        versions[dep.name] = versions[dep.name] || [];
        if (!versions[dep.name].includes(current)) versions[dep.name].push(current);
      }
    }
    return versions;
  }

  async _latestFor(name) {
    const cached = this.latest.get(name);
    if (cached && Date.now() - cached.timestamp < LATEST_TTL_MS) return cached.value;
    try {
      const manifest = await this.client.getLatestManifest(name);
      const value = {
        version: manifest.version || null,
        description: manifest.description || '',
        deprecated: manifest.deprecated ? String(manifest.deprecated) : null
      };
      this.latest.set(name, { timestamp: Date.now(), value });
      return value;
    } catch (err) {
      return { error: err.status === 404 ? 'Not found in the npm registry' : err.message };
    }
  }

  _enrich(project, remote, advisories) {
    const dependencies = project.dependencies.map((dep) => {
      const local = semver.isLocalRange(dep.range);
      const info = remote.get(dep.name) || {};
      const current = dep.installed || semver.minVersion(dep.range);
      const found = (advisories[dep.name] || []).filter((advisory) => advisory && advisory.severity);
      const depAdvisories = sortAdvisories(found);
      return {
        ...dep,
        local,
        current,
        latest: info.version || null,
        description: info.description || '',
        deprecated: info.deprecated || null,
        error: info.error || null,
        update: local ? null : semver.diff(current, info.version),
        missing: !local && !dep.installed,
        advisories: depAdvisories,
        severity: worstSeverity(depAdvisories)
      };
    });

    return {
      ...project,
      dependencies,
      summary: {
        total: dependencies.length,
        outdated: dependencies.filter((dep) => dep.update).length,
        major: dependencies.filter((dep) => dep.update === 'major').length,
        vulnerable: dependencies.filter((dep) => dep.advisories.length).length,
        deprecated: dependencies.filter((dep) => dep.deprecated).length,
        missing: dependencies.filter((dep) => dep.missing).length
      }
    };
  }
}

module.exports = { ProjectService, sortAdvisories, worstSeverity };
