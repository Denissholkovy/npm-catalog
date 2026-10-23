const vscode = require('vscode');
const crypto = require('crypto');
const { escapeText, escapeAttr, safeHttpUrl } = require('./htmlUtils');
const { MANAGERS, buildAllCommands, isScaffold } = require('./installCommand');
const semver = require('./semver');

const VIEW_TYPE = 'npmPackageDetails';
const HISTORY_LIMIT = 20;
const STALE_MS = 2 * 365 * 24 * 60 * 60 * 1000;
const CHART_WIDTH = 300;
const CHART_HEIGHT = 64;

const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });
const full = new Intl.NumberFormat('en-US');

function formatBytes(bytes) {
  if (typeof bytes !== 'number') return null;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(iso) {
  const date = iso ? new Date(iso) : null;
  if (!date || Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

function timeAgo(iso) {
  const time = iso ? new Date(iso).getTime() : NaN;
  if (Number.isNaN(time)) return null;
  const days = Math.floor((Date.now() - time) / 86400000);
  if (days < 1) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days} days ago`;
  if (days < 365) {
    const months = Math.floor(days / 30);
    return `${months} month${months === 1 ? '' : 's'} ago`;
  }
  const years = Math.floor(days / 365);
  return `${years} year${years === 1 ? '' : 's'} ago`;
}

function icon(name) {
  return `<span class="codicon codicon-${name}" aria-hidden="true"></span>`;
}

function externalLink(label, url, iconName) {
  const safe = safeHttpUrl(url);
  if (!safe) return '';
  return `<a class="link" href="${escapeAttr(safe)}" title="${escapeAttr(safe)}">${icon(iconName)}<span>${escapeText(label)}</span></a>`;
}

class PackageDetailsPanel {
  static show(pkg, packageService, handlers, extensionUri) {
    if (PackageDetailsPanel.current) {
      PackageDetailsPanel.current.panel.reveal(undefined, false);
      PackageDetailsPanel.current.navigate(pkg, false);
      return PackageDetailsPanel.current;
    }
    PackageDetailsPanel.current = new PackageDetailsPanel(pkg, packageService, handlers, extensionUri);
    return PackageDetailsPanel.current;
  }

  constructor(pkg, packageService, handlers, extensionUri) {
    this.packageService = packageService;
    this.handlers = handlers;
    this.mediaRoot = vscode.Uri.joinPath(extensionUri, 'media');
    this.disposed = false;
    this.requestId = 0;
    this.history = [];
    this.details = null;

    this.panel = vscode.window.createWebviewPanel(VIEW_TYPE, pkg.name, vscode.ViewColumn.One, {
      enableScripts: true,
      enableFindWidget: true,
      localResourceRoots: [this.mediaRoot]
    });
    this.panel.iconPath = vscode.Uri.joinPath(this.mediaRoot, 'icon.svg');

    this.panel.onDidDispose(() => {
      this.disposed = true;
      if (PackageDetailsPanel.current === this) PackageDetailsPanel.current = null;
    });
    this.panel.webview.onDidReceiveMessage((message) => this._handleMessage(message));

    this.update(pkg);
  }

  navigate(pkg, keepHistory) {
    if (this.pkg && this.pkg.name === pkg.name) return;
    if (keepHistory && this.pkg) {
      this.history.push(this.pkg);
      if (this.history.length > HISTORY_LIMIT) this.history.shift();
    } else if (!keepHistory) {
      this.history = [];
    }
    this.update(pkg);
  }

  async update(pkg) {
    this.pkg = { ...pkg, installType: pkg.installType || 'npm' };
    this.details = null;
    const requestId = ++this.requestId;
    this.panel.title = pkg.name;
    this.panel.webview.html = this._renderLoading();

    let details;
    try {
      details = await this.packageService.getPackageDetails(pkg.name);
    } catch (err) {
      details = { error: err.message };
    }

    if (this.disposed || requestId !== this.requestId) return;
    this.details = details;
    if (details.version && !this.pkg.version) this.pkg.version = details.version;
    if (details.description && !this.pkg.description) this.pkg.description = details.description;
    this.panel.webview.html = this._renderDetails(details);
    this._loadBundleSize(requestId);
  }

  async _loadBundleSize(requestId) {
    if (isScaffold(this.pkg.installType) || !this.details || this.details.error) return;
    const bundle = await this.packageService.getBundleSize(this.pkg.name, this.details.version);
    if (this.disposed || requestId !== this.requestId) return;
    this.panel.webview.postMessage({
      type: 'bundle',
      bundle: bundle && {
        min: formatBytes(bundle.size),
        gzip: formatBytes(bundle.gzip),
        treeShakeable: bundle.treeShakeable
      }
    });
  }

  refreshUserState() {
    if (this.disposed || !this.details) return;
    this.panel.webview.postMessage({
      type: 'user',
      favorite: this.handlers.isFavorite(this.pkg.name),
      projectHtml: this._projectStatusHtml(this.details)
    });
  }

  _handleMessage(message) {
    if (!message || typeof message.command !== 'string') return;
    const name = this.pkg.name;
    switch (message.command) {
      case 'install':
        this.handlers.install(this.pkg, {
          dev: message.dev === true,
          version: typeof message.version === 'string' ? message.version : undefined,
          manager: MANAGERS.includes(message.manager) ? message.manager : undefined
        });
        break;
      case 'copy':
        if (typeof message.text === 'string') this.handlers.copy(message.text);
        break;
      case 'update':
        this.handlers.update(name, message.dev === true);
        break;
      case 'uninstall':
        this.handlers.uninstall(name);
        break;
      case 'favorite':
        this.handlers.toggleFavorite({ ...this.pkg, weeklyDownloads: this.details && this.details.weeklyDownloads });
        break;
      case 'open':
        if (typeof message.name === 'string' && message.name) {
          const pkg = { name: message.name, installType: 'npm', npmUrl: `https://www.npmjs.com/package/${message.name}` };
          this.handlers.viewed(pkg);
          this.navigate(pkg, true);
        }
        break;
      case 'back': {
        const previous = this.history.pop();
        if (previous) this.update(previous);
        break;
      }
      case 'retry':
        this.packageService.detailsCache.delete(name);
        this.update(this.pkg);
        break;
      case 'openUrl':
        this.handlers.openUrl(message.url);
        break;
    }
  }

  _page(body) {
    const webview = this.panel.webview;
    const nonce = crypto.randomBytes(16).toString('base64');
    const uri = (...parts) => webview.asWebviewUri(vscode.Uri.joinPath(this.mediaRoot, ...parts));
    const csp = [
      "default-src 'none'",
      'img-src https: data:',
      `style-src ${webview.cspSource}`,
      `font-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`
    ].join('; ');

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${uri('codicons', 'codicon.css')}">
<link rel="stylesheet" href="${uri('details.css')}">
</head>
<body>
${body}
<script nonce="${nonce}" src="${uri('details.js')}"></script>
</body>
</html>`;
  }

  _topbar() {
    const previous = this.history[this.history.length - 1];
    const back = previous
      ? `<button class="btn ghost" data-command="back" title="Back to ${escapeAttr(previous.name)}">${icon('arrow-left')}<span>${escapeText(previous.name)}</span></button>`
      : '';
    return back ? `<div class="topbar">${back}</div>` : '';
  }

  _renderLoading() {
    return this._page(`${this._topbar()}
  <header class="hero">
    <div class="logo placeholder skeleton-box"></div>
    <div class="hero-main">
      <h1>${escapeText(this.pkg.name)}</h1>
      <p class="desc">${escapeText(this.pkg.description || '')}</p>
      <div class="skeleton short"></div>
    </div>
  </header>
  <div class="layout">
    <main><div class="skeleton"></div><div class="skeleton wide"></div><div class="skeleton"></div><div class="skeleton wide"></div></main>
    <aside><div class="card skeleton-card"></div><div class="card skeleton-card"></div></aside>
  </div>`);
  }

  _renderDetails(details) {
    const pkg = this.pkg;
    if (details.error && !details.version) {
      return this._page(`${this._topbar()}
  <div class="error-state">
    ${icon('error')}
    <h2>Couldn't load ${escapeText(pkg.name)}</h2>
    <p>${escapeText(details.error)}</p>
    <button class="btn primary" data-command="retry">${icon('refresh')}Try again</button>
  </div>`);
    }

    const versions = details.versions || [];
    const dependencyCount = Object.keys(details.dependencies || {}).length;
    const peerCount = Object.keys(details.peerDependencies || {}).length;

    return this._page(`${this._topbar()}
  ${this._hero(details)}
  ${this._alerts(details)}
  <div class="layout">
    <main>
      <nav class="tabs" role="tablist">
        <button class="tab active" role="tab" data-tab="readme">${icon('book')}README</button>
        <button class="tab" role="tab" data-tab="versions">${icon('versions')}Versions<span class="count">${details.versionsCount || versions.length}</span></button>
        <button class="tab" role="tab" data-tab="deps">${icon('type-hierarchy')}Dependencies<span class="count">${dependencyCount + peerCount}</span></button>
      </nav>
      <section class="panel active" data-panel="readme">${this._readme(details)}</section>
      <section class="panel" data-panel="versions">${this._versions(details)}</section>
      <section class="panel" data-panel="deps">${this._dependencies(details)}</section>
    </main>
    <aside>
      ${this._installCard(details)}
      <div id="projectStatus">${this._projectStatusHtml(details)}</div>
      ${this._downloadsCard(details)}
      ${this._factsCard(details)}
      ${this._githubCard(details)}
      ${this._linksCard(details)}
      ${this._peopleCard(details)}
    </aside>
  </div>`);
  }

  _hero(details) {
    const pkg = this.pkg;
    const favorite = this.handlers.isFavorite(pkg.name);
    const logo = details.avatarUrl
      ? `<img src="${escapeAttr(details.avatarUrl)}" alt="" class="logo">`
      : `<div class="logo placeholder">${escapeText(pkg.name.replace(/^@[^/]*\//, '').charAt(0).toUpperCase())}</div>`;

    const scaffold = isScaffold(pkg.installType);
    const badges = [
      details.license ? `<span class="badge" title="License">${icon('law')}${escapeText(details.license)}</span>` : '',
      scaffold ? `<span class="badge" title="Project generator">${icon('rocket')}Project generator</span>` : '',
      scaffold
        ? ''
        : details.types === 'bundled'
        ? `<span class="badge ts" title="Ships its own TypeScript types">${icon('symbol-type-parameter')}TypeScript</span>`
        : details.types
        ? `<span class="badge ts-ext" title="Types available from ${escapeAttr(details.types)}">${icon('symbol-type-parameter')}${escapeText(details.types)}</span>`
        : '<span class="badge dim" title="No type definitions found">No types</span>',
      details.moduleFormat && !scaffold ? `<span class="badge" title="Module format">${icon('symbol-module')}${escapeText(details.moduleFormat)}</span>` : '',
      scaffold ? '' : dependencyBadge(details)
    ].join('');

    return `<header class="hero">
    ${logo}
    <div class="hero-main">
      <div class="title-row">
        <h1>${escapeText(pkg.name)}</h1>
        ${details.version ? `<span class="version">${escapeText(details.version)}</span>` : ''}
        <button class="btn icon star${favorite ? ' active' : ''}" id="favorite" data-command="favorite" title="${favorite ? 'Remove from saved' : 'Save'}">${icon(favorite ? 'star-full' : 'star-empty')}</button>
      </div>
      <p class="desc">${escapeText(details.description || pkg.description || '')}</p>
      <div class="badges">${badges}</div>
      <div class="meta-line">
        ${details.lastPublish ? `<span title="${escapeAttr(formatDate(details.lastPublish))}">${icon('history')}Published ${escapeText(timeAgo(details.lastPublish))}</span>` : ''}
        ${typeof details.weeklyDownloads === 'number' ? `<span>${icon('cloud-download')}${escapeText(compact.format(details.weeklyDownloads))} weekly</span>` : ''}
        ${details.github && typeof details.github.stars === 'number' ? `<span>${icon('star-full')}${escapeText(compact.format(details.github.stars))} stars</span>` : ''}
      </div>
    </div>
  </header>`;
  }

  _alerts(details) {
    const alerts = [];
    if (details.deprecated) {
      alerts.push(`<div class="callout bad">${icon('warning')}<div><b>Deprecated.</b> ${escapeText(details.deprecated)}</div></div>`);
    }
    if (details.advisories && details.advisories.length) {
      const items = details.advisories
        .map(
          (advisory) => `<li><span class="sev sev-${escapeAttr(advisory.severity)}">${escapeText(advisory.severity)}</span>
            ${safeHttpUrl(advisory.url) ? `<a href="${escapeAttr(safeHttpUrl(advisory.url))}">${escapeText(advisory.title)}</a>` : escapeText(advisory.title)}
            ${advisory.vulnerableVersions ? `<code>${escapeText(advisory.vulnerableVersions)}</code>` : ''}</li>`
        )
        .join('');
      alerts.push(`<div class="callout bad">${icon('shield')}<div><b>${details.advisories.length} known vulnerabilit${details.advisories.length === 1 ? 'y' : 'ies'} in ${escapeText(details.version)}</b><ul class="advisories">${items}</ul></div></div>`);
    }
    if (details.github && details.github.archived) {
      alerts.push(`<div class="callout warn">${icon('archive')}<div><b>Repository archived.</b> The source repository is read-only and no longer maintained.</div></div>`);
    }
    const lastPublish = details.lastPublish ? new Date(details.lastPublish).getTime() : NaN;
    if (!details.deprecated && !Number.isNaN(lastPublish) && Date.now() - lastPublish > STALE_MS) {
      alerts.push(`<div class="callout warn">${icon('clock')}<div><b>No releases for ${escapeText(timeAgo(details.lastPublish).replace(' ago', ''))}.</b> Check that it is still maintained before adopting it.</div></div>`);
    }
    return alerts.length ? `<div class="alerts">${alerts.join('')}</div>` : '';
  }

  _installCard(details) {
    const pkg = this.pkg;
    const scaffold = isScaffold(pkg.installType);
    const manager = this.handlers.defaultManager();
    const commands = buildAllCommands({ name: pkg.name, installType: pkg.installType });
    const devCommands = scaffold ? null : buildAllCommands({ name: pkg.name, installType: pkg.installType, dev: true });
    const tabs = MANAGERS.map(
      (pm) => `<button class="seg${pm === manager ? ' active' : ''}" data-pm="${pm}">${pm}</button>`
    ).join('');

    const actions = scaffold
      ? `<button class="btn primary grow" data-command="install">${icon('terminal')}Run in terminal</button>`
      : `<button class="btn primary grow" data-command="install">${icon('add')}Install</button>
         <button class="btn grow" data-command="install" data-dev="true">${icon('tools')}Install as dev</button>`;

    return `<div class="card install" data-commands="${escapeAttr(JSON.stringify(commands))}" data-dev-commands="${escapeAttr(JSON.stringify(devCommands || {}))}" data-pm="${manager}">
      <div class="card-title">${scaffold ? 'Create a project' : 'Install'}</div>
      <div class="segmented" role="tablist">${tabs}</div>
      <div class="command"><code id="command">${escapeText(commands[manager])}</code>
        <button class="btn icon" data-command="copy" title="Copy command">${icon('copy')}</button>
      </div>
      <div class="actions">${actions}</div>
      ${scaffold ? '<p class="hint">Runs an interactive generator. Follow the prompts in the terminal.</p>' : ''}
      ${details.engines && details.engines.node ? `<p class="hint">${icon('info')}Requires Node <code>${escapeText(details.engines.node)}</code></p>` : ''}
    </div>`;
  }

  _projectStatusHtml(details) {
    const info = this.handlers.installedInfo(this.pkg.name);
    if (!info || isScaffold(this.pkg.installType)) return '';
    const current = info.version || semver.minVersion(info.range) || info.range;
    const update = semver.diff(current, details.version);
    const status = update
      ? `<div class="status-line warn">${icon('arrow-up')}<span><b>${escapeText(details.version)}</b> available · ${escapeText(update)} update</span></div>`
      : `<div class="status-line ok">${icon('pass')}<span>Up to date</span></div>`;
    return `<div class="card project">
      <div class="card-title">In your project</div>
      <dl class="facts">
        <dt>Folder</dt><dd>${escapeText(info.folder)}</dd>
        <dt>Section</dt><dd>${escapeText(info.field)}</dd>
        <dt>Range</dt><dd><code>${escapeText(info.range)}</code></dd>
        <dt>Installed</dt><dd>${info.version ? `<code>${escapeText(info.version)}</code>` : '<span class="dim">not in node_modules</span>'}</dd>
      </dl>
      ${status}
      <div class="actions">
        ${update ? `<button class="btn primary grow" data-command="update" data-dev="${info.field === 'devDependencies'}">${icon('arrow-up')}Update to latest</button>` : ''}
        <button class="btn grow" data-command="uninstall">${icon('trash')}Uninstall</button>
      </div>
    </div>`;
  }

  _downloadsCard(details) {
    const weeks = details.downloadWeeks || [];
    if (typeof details.weeklyDownloads !== 'number' && !weeks.length) return '';
    const trend = typeof details.downloadsTrend === 'number' ? details.downloadsTrend : null;
    const trendHtml =
      trend === null
        ? ''
        : `<span class="trend ${trend >= 0 ? 'up' : 'down'}" title="Last 4 weeks vs the 4 weeks before">${icon(trend >= 0 ? 'arrow-up' : 'arrow-down')}${Math.abs(trend * 100).toFixed(trend > -0.1 && trend < 0.1 ? 1 : 0)}%</span>`;
    return `<div class="card">
      <div class="card-title">Weekly downloads</div>
      <div class="big-number">${escapeText(full.format(details.weeklyDownloads || 0))}${trendHtml}</div>
      ${weeks.length > 2 ? this._chart(weeks) : ''}
    </div>`;
  }

  _chart(weeks) {
    const max = Math.max(...weeks.map((week) => week.count), 1);
    const step = CHART_WIDTH / (weeks.length - 1);
    const points = weeks.map((week, index) => [index * step, CHART_HEIGHT - 2 - (week.count / max) * (CHART_HEIGHT - 6)]);
    const line = points.map(([x, y], index) => `${index ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join('');
    const area = `${line}L${CHART_WIDTH},${CHART_HEIGHT}L0,${CHART_HEIGHT}Z`;
    const series = weeks.map((week) => [week.start, week.count]);
    return `<div class="chart" data-series="${escapeAttr(JSON.stringify(series))}">
      <svg viewBox="0 0 ${CHART_WIDTH} ${CHART_HEIGHT}" preserveAspectRatio="none" role="img" aria-label="Weekly downloads over the last year">
        <path class="area" d="${area}"></path>
        <path class="line" d="${line}"></path>
      </svg>
      <div class="chart-cursor" hidden></div>
      <div class="chart-tip" hidden></div>
      <div class="chart-axis"><span>${escapeText(formatDate(weeks[0].start) || '')}</span><span>peak ${escapeText(compact.format(max))}</span><span>now</span></div>
    </div>`;
  }

  _factsCard(details) {
    const scaffold = isScaffold(this.pkg.installType);
    const rows = [
      ['Version', details.version && `<code>${escapeText(details.version)}</code>`],
      ['License', details.license && escapeText(details.license)],
      ['Unpacked size', formatBytes(details.unpackedSize)],
      ['Files', typeof details.fileCount === 'number' && full.format(details.fileCount)],
      scaffold ? null : ['Bundle (min)', '<span id="bundleMin" class="dim">checking…</span>'],
      scaffold ? null : ['Bundle (gzip)', '<span id="bundleGzip" class="dim">checking…</span>'],
      ['Dependencies', String(Object.keys(details.dependencies || {}).length)],
      ['Total versions', typeof details.versionsCount === 'number' && full.format(details.versionsCount)],
      ['Last publish', details.lastPublish && `<span title="${escapeAttr(timeAgo(details.lastPublish))}">${escapeText(formatDate(details.lastPublish))}</span>`],
      ['Created', details.created && `<span title="${escapeAttr(timeAgo(details.created))}">${escapeText(formatDate(details.created))}</span>`],
      ['Node', details.engines && details.engines.node && `<code>${escapeText(details.engines.node)}</code>`]
    ]
      .filter((row) => row && row[1])
      .map(([label, value]) => `<dt>${label}</dt><dd>${value}</dd>`)
      .join('');
    return `<div class="card"><div class="card-title">Package</div><dl class="facts">${rows}</dl></div>`;
  }

  _githubCard(details) {
    const gh = details.github;
    if (!gh) return '';
    const rows = [
      ['Stars', typeof gh.stars === 'number' && full.format(gh.stars)],
      ['Forks', typeof gh.forks === 'number' && full.format(gh.forks)],
      ['Open issues & PRs', typeof gh.issues === 'number' && full.format(gh.issues)],
      ['Last commit', gh.pushedAt && `<span title="${escapeAttr(formatDate(gh.pushedAt))}">${escapeText(timeAgo(gh.pushedAt))}</span>`]
    ]
      .filter((row) => row[1])
      .map(([label, value]) => `<dt>${label}</dt><dd>${value}</dd>`)
      .join('');
    return `<div class="card"><div class="card-title">${icon('github')}GitHub</div><dl class="facts">${rows}</dl></div>`;
  }

  _linksCard(details) {
    const links = [
      externalLink('Homepage', details.homepage, 'globe'),
      externalLink('Repository', details.repositoryUrl, 'repo'),
      externalLink('Issues', details.bugsUrl, 'issues'),
      externalLink('npm', this.pkg.npmUrl || `https://www.npmjs.com/package/${this.pkg.name}`, 'package')
    ].join('');
    return links ? `<div class="card"><div class="card-title">Links</div><div class="links">${links}</div></div>` : '';
  }

  _peopleCard(details) {
    const maintainers = (details.maintainers || []).slice(0, 12);
    const keywords = details.keywords || [];
    if (!maintainers.length && !keywords.length) return '';
    return `<div class="card">
      ${maintainers.length ? `<div class="card-title">Maintainers<span class="count">${details.maintainers.length}</span></div><div class="chips">${maintainers.map((name) => `<span class="chip">${icon('account')}${escapeText(name)}</span>`).join('')}</div>` : ''}
      ${keywords.length ? `<div class="card-title spaced">Keywords</div><div class="chips">${keywords.map((keyword) => `<span class="chip">${escapeText(keyword)}</span>`).join('')}</div>` : ''}
    </div>`;
  }

  _readme(details) {
    if (details.readmeHtml) return `<article class="readme">${details.readmeHtml}</article>`;
    return `<div class="empty">${icon('book')}<p>This package has no README.</p></div>`;
  }

  _versions(details) {
    const tags = Object.entries(details.distTags || {})
      .map(
        ([tag, version]) => `<div class="tag-row"><span class="tag">${escapeText(tag)}</span><code>${escapeText(version)}</code>
        ${this._versionActions(version)}</div>`
      )
      .join('');
    const rows = (details.versions || [])
      .map((item) => {
        const tag = Object.entries(details.distTags || {}).find(([, version]) => version === item.version);
        return `<tr class="${item.prerelease ? 'pre' : ''}${item.deprecated ? ' deprecated' : ''}">
          <td><code>${escapeText(item.version)}</code>${tag ? ` <span class="tag small">${escapeText(tag[0])}</span>` : ''}${item.deprecated ? ' <span class="sev sev-moderate">deprecated</span>' : ''}</td>
          <td class="dim" title="${escapeAttr(formatDate(item.date) || '')}">${escapeText(timeAgo(item.date) || '')}</td>
          <td class="row-actions">${this._versionActions(item.version)}</td>
        </tr>`;
      })
      .join('');
    const hasPre = (details.versions || []).some((item) => item.prerelease);
    return `<div class="section-block">
        <h3>Distribution tags</h3>
        <div class="tags">${tags}</div>
      </div>
      <div class="section-block">
        <div class="section-head">
          <h3>Recent versions</h3>
          ${hasPre ? '<label class="toggle"><input type="checkbox" id="showPre"> Show pre-releases</label>' : ''}
        </div>
        <table class="versions hide-pre"><tbody>${rows}</tbody></table>
        ${details.versionsCount > (details.versions || []).length ? `<p class="hint">Showing the latest ${(details.versions || []).length} of ${details.versionsCount}. ${externalLink('All versions on npm', `https://www.npmjs.com/package/${this.pkg.name}?activeTab=versions`, 'link-external')}</p>` : ''}
      </div>`;
  }

  _versionActions(version) {
    if (isScaffold(this.pkg.installType)) return '';
    return `<span class="inline-actions">
      <button class="btn small" data-command="install" data-version="${escapeAttr(version)}" title="Install this exact version">${icon('cloud-download')}Install</button>
      <button class="btn icon small" data-command="copy-version" data-version="${escapeAttr(version)}" title="Copy install command">${icon('copy')}</button>
    </span>`;
  }

  _dependencies(details) {
    const list = (entries, optional) =>
      entries.length
        ? `<ul class="dep-list">${entries
            .map(
              ([name, range]) => `<li><button class="dep-link" data-command="open" data-name="${escapeAttr(name)}">${escapeText(name)}</button>
              <code>${escapeText(range)}</code>${optional && optional.includes(name) ? '<span class="tag small">optional</span>' : ''}</li>`
            )
            .join('')}</ul>`
        : '<p class="dim">None</p>';
    const deps = Object.entries(details.dependencies || {});
    const peers = Object.entries(details.peerDependencies || {});
    const engines = Object.entries(details.engines || {});
    return `<div class="section-block">
        <h3>Dependencies <span class="count">${deps.length}</span></h3>
        ${deps.length ? '' : '<p class="hint">Zero dependencies — nothing else gets pulled into your node_modules.</p>'}
        ${deps.length ? list(deps) : ''}
      </div>
      <div class="section-block">
        <h3>Peer dependencies <span class="count">${peers.length}</span></h3>
        ${peers.length ? '<p class="hint">You need to install these yourself.</p>' : ''}
        ${list(peers, details.optionalPeers)}
      </div>
      ${engines.length ? `<div class="section-block"><h3>Engines</h3><ul class="dep-list">${engines.map(([name, range]) => `<li><span>${escapeText(name)}</span><code>${escapeText(String(range))}</code></li>`).join('')}</ul></div>` : ''}`;
  }
}

function dependencyBadge(details) {
  const count = Object.keys(details.dependencies || {}).length;
  if (count === 0) return `<span class="badge good" title="No runtime dependencies">${icon('check')}Zero deps</span>`;
  return `<span class="badge" title="Runtime dependencies">${icon('type-hierarchy')}${count} dep${count === 1 ? '' : 's'}</span>`;
}

PackageDetailsPanel.current = null;

module.exports = { PackageDetailsPanel };
