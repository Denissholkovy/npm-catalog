const { readWorkspaces } = require('./projectEnv');
const semver = require('./semver');
const { releaseNotesUrl } = require('./repoUrl');

const LATEST_TTL_MS = 30 * 60 * 1000;
const SEVERITY_ORDER = ['critical', 'high', 'moderate', 'low', 'info'];
const FIELD_PRIORITY = ['dependencies', 'optionalDependencies', 'peerDependencies', 'devDependencies'];

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

function isLocal(dep) {
  return dep.internal || semver.isLocalRange(dep.range);
}

function summarize(dependencies) {
  return {
    total: dependencies.length,
    outdated: dependencies.filter((dep) => dep.update).length,
    major: dependencies.filter((dep) => dep.update === 'major').length,
    vulnerable: dependencies.filter((dep) => dep.advisories.length).length,
    deprecated: dependencies.filter((dep) => dep.deprecated).length,
    missing: dependencies.filter((dep) => dep.missing).length
  };
}

function fromAdvisory(advisory) {
  return { ...advisory, vulnerable_versions: advisory.vulnerableVersions };
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
    return readWorkspaces().length > 0;
  }

  scan(onProgress) {
    if (this.running) return this.running;
    this.running = this._scan(onProgress).finally(() => {
      this.running = null;
    });
    return this.running;
  }

  async _scan(onProgress) {
    const workspaces = readWorkspaces();
    const projects = workspaces.flatMap((workspace) => workspace.packages);
    const remote = new Map();
    for (const project of projects) {
      for (const dep of project.dependencies) {
        if (!isLocal(dep)) remote.set(dep.name, null);
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
      checkedAt: new Date().toISOString(),
      auditAvailable: advisories !== null,
      workspaces: workspaces.map((workspace) => {
        const packages = workspace.packages.map((project) => this._enrich(project, remote, advisories || {}));
        return {
          root: workspace.root,
          name: workspace.name,
          folderName: workspace.folderName,
          manager: workspace.manager,
          isMonorepo: workspace.isMonorepo,
          tool: workspace.tool,
          packages,
          overview: workspace.isMonorepo ? this._overview(packages) : null
        };
      })
    };
  }

  _overview(packages) {
    const byName = new Map();
    for (const project of packages) {
      for (const dep of project.dependencies) {
        if (dep.internal) continue;
        const usage = { package: project.folderName, folder: project.folder, range: dep.range, current: dep.current, field: dep.field };
        const existing = byName.get(dep.name);
        if (!existing) {
          byName.set(dep.name, { ...dep, usages: [usage] });
          continue;
        }
        existing.usages.push(usage);
        if (FIELD_PRIORITY.indexOf(dep.field) < FIELD_PRIORITY.indexOf(existing.field)) existing.field = dep.field;
        if (semver.compare(dep.current, existing.current) < 0) {
          existing.current = dep.current;
          existing.update = dep.update;
        }
        existing.missing = existing.missing || dep.missing;
        const known = new Set(existing.advisories.map((advisory) => advisory.id));
        existing.advisories = sortAdvisories([...existing.advisories, ...dep.advisories.filter((advisory) => !known.has(advisory.id))].map(fromAdvisory));
        existing.severity = worstSeverity(existing.advisories);
      }
    }

    const dependencies = [...byName.values()].map((dep) => {
      const ranges = [...new Set(dep.usages.map((usage) => usage.range))];
      return { ...dep, range: ranges.join(' | '), drift: ranges.length > 1 ? ranges : null };
    });
    return { dependencies, summary: { ...summarize(dependencies), drift: dependencies.filter((dep) => dep.drift).length, packages: packages.length } };
  }

  _versionsToAudit(projects) {
    const versions = {};
    for (const project of projects) {
      for (const dep of project.dependencies) {
        if (isLocal(dep)) continue;
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
        deprecated: manifest.deprecated ? String(manifest.deprecated) : null,
        releasesUrl: releaseNotesUrl(manifest.repository)
      };
      this.latest.set(name, { timestamp: Date.now(), value });
      return value;
    } catch (err) {
      return { error: err.status === 404 ? 'Not found in the npm registry' : err.message };
    }
  }

  _enrich(project, remote, advisories) {
    const dependencies = project.dependencies.map((dep) => {
      const local = isLocal(dep);
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
        releasesUrl: info.releasesUrl || null,
        error: info.error || null,
        update: local ? null : semver.diff(current, info.version),
        missing: !local && !dep.installed,
        advisories: depAdvisories,
        severity: worstSeverity(depAdvisories)
      };
    });

    return { ...project, dependencies, summary: summarize(dependencies) };
  }
}

module.exports = { ProjectService, sortAdvisories, worstSeverity };
