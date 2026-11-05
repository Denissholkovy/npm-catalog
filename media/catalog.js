(function () {
  const vscode = acquireVsCodeApi();
  const saved = vscode.getState() || {};
  const ui = {
    tab: saved.tab === 'discover' || saved.tab === 'saved' || saved.tab === 'explore' ? 'explore' : 'updates',
    page: saved.tab === 'saved' ? '__saved__' : saved.page || null,
    openGroups: Array.isArray(saved.openGroups) ? saved.openGroups : [],
    sort: saved.sort || 'relevance',
    density: saved.density || 'cards',
    projectFilter: ['security', 'deprecated', 'major', 'minor', 'patch', 'drift'].includes(saved.projectFilter) ? saved.projectFilter : 'all',
    showCurrent: Boolean(saved.showCurrent),
    projectFolder: saved.projectFolder || null,
    showPackages: saved.showPackages !== false,
    projectQuery: ''
  };
  const data = {
    groups: [],
    favorites: [],
    recent: [],
    installed: {},
    history: [],
    searchTerm: null,
    searchKey: null,
    manager: 'npm',
    hasWorkspace: false
  };
  const states = new Map();
  const project = { status: 'idle', data: null, progress: null, error: null };
  const suggest = { open: false, items: [], index: -1, seq: 0, term: '', loading: false };
  const selection = new Set();
  let selectionKey = null;
  let pendingUpdate = false;
  let pendingTimer = null;

  const SUGGEST_DELAY_MS = 220;
  const PENDING_TIMEOUT_MS = 3 * 60 * 1000;
  const TILE_COLORS = ['blue', 'green', 'orange', 'purple', 'red', 'yellow'];
  const SORTS = [
    ['relevance', 'Popular'],
    ['downloads', 'Most downloaded'],
    ['updated', 'Recently updated'],
    ['name', 'Name A–Z']
  ];
  const SAVED_GROUP = '__saved__';
  const UPDATE_GROUPS = [
    { key: 'security', label: 'Security', icon: 'shield', hint: '', match: (dep) => dep.advisories.length > 0 },
    { key: 'deprecated', label: 'Deprecated', icon: 'warning', hint: '', match: (dep) => Boolean(dep.deprecated) },
    { key: 'major', label: 'Major', icon: 'flame', hint: 'May contain breaking changes', match: (dep) => dep.update === 'major' },
    { key: 'minor', label: 'Minor', icon: 'sparkle', hint: '', match: (dep) => dep.update === 'minor' },
    { key: 'patch', label: 'Patch', icon: 'debug', hint: '', match: (dep) => dep.update === 'patch' || dep.update === 'prerelease' },
    { key: 'current', label: 'Up to date', icon: 'pass', hint: '', match: () => true }
  ];
  const FIELD_TAGS = { devDependencies: 'dev', peerDependencies: 'peer', optionalDependencies: 'optional' };

  const list = document.getElementById('list');
  const views = document.getElementById('views');
  const form = document.getElementById('searchForm');
  const input = document.getElementById('searchInput');
  const clearButton = document.getElementById('searchClear');
  const suggestBox = document.getElementById('suggest');
  const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });
  let suggestTimer = null;

  function persist() {
    const { projectQuery, ...rest } = ui;
    vscode.setState(rest);
  }

  function post(message) {
    vscode.postMessage(message);
  }

  function esc(value) {
    return String(value === undefined || value === null ? '' : value).replace(/[&<>"']/g, (char) => {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char];
    });
  }

  function icon(name, extra) {
    return `<span class="codicon codicon-${name}${extra ? ` ${extra}` : ''}" aria-hidden="true"></span>`;
  }

  function formatCount(value) {
    return typeof value === 'number' ? compact.format(value) : null;
  }

  function timeAgo(iso) {
    const time = iso ? new Date(iso).getTime() : NaN;
    if (Number.isNaN(time)) return null;
    const days = Math.floor((Date.now() - time) / 86400000);
    if (days < 1) return 'today';
    if (days < 30) return `${days}d ago`;
    if (days < 365) return `${Math.floor(days / 30)}mo ago`;
    const years = days / 365;
    return `${years < 2 ? years.toFixed(1).replace('.0', '') : Math.floor(years)}y ago`;
  }

  function isStale(iso) {
    const time = iso ? new Date(iso).getTime() : NaN;
    return !Number.isNaN(time) && Date.now() - time > 2 * 365 * 86400000;
  }

  function parseVersion(version) {
    const match = String(version || '').match(/(\d+)\.(\d+)\.(\d+)/);
    return match ? match.slice(1, 4).map(Number) : null;
  }

  function versionDiff(current, latest) {
    const a = parseVersion(current);
    const b = parseVersion(latest);
    if (!a || !b) return null;
    for (let i = 0; i < 3; i++) {
      if (a[i] !== b[i]) return a[i] < b[i] ? ['major', 'minor', 'patch'][i] : null;
    }
    return null;
  }

  function tileColor(name) {
    let hash = 0;
    for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
    return `--vscode-charts-${TILE_COLORS[hash % TILE_COLORS.length]}`;
  }

  function monogram(name) {
    const letters = name.replace(/^@[^/]*\//, '').replace(/[^a-zA-Z0-9]/g, '');
    return (letters.charAt(0) || name.charAt(0) || '?').toUpperCase();
  }

  function scaffoldCommand(pkg) {
    const pm = data.manager;
    if (pkg.installType === 'npm-create') {
      const short = pkg.name.replace(/^create-/, '');
      return { npm: `npm create ${short}@latest`, yarn: `yarn create ${short}`, pnpm: `pnpm create ${short}@latest`, bun: `bun create ${short}` }[pm];
    }
    return { npm: `npx ${pkg.name}@latest`, yarn: `yarn dlx ${pkg.name}@latest`, pnpm: `pnpm dlx ${pkg.name}@latest`, bun: `bunx ${pkg.name}@latest` }[pm];
  }

  function isScaffold(pkg) {
    return pkg.installType === 'npx' || pkg.installType === 'npm-create';
  }

  function isFavorite(name) {
    return data.favorites.some((item) => item.name === name);
  }

  function statHtml(iconName, text, title, extraClass) {
    if (!text) return '';
    return `<span class="stat${extraClass ? ` ${extraClass}` : ''}" title="${esc(title)}">${icon(iconName)}${esc(text)}</span>`;
  }

  function installedChip(pkg) {
    const info = data.installed[pkg.name];
    if (!info) return '';
    const current = info.version || info.range;
    const update = versionDiff(info.version || info.range, pkg.version);
    const title = `In ${info.folder} (${info.field}) · ${info.range}`;
    if (update) {
      return `<span class="chip warn" title="${esc(title)}">${icon('arrow-up')}${esc(current)} → ${esc(pkg.version)}</span>`;
    }
    return `<span class="chip ok" title="${esc(title)}">${icon('check')}Installed${info.version ? ` ${esc(info.version)}` : ''}</span>`;
  }

  function actionsHtml(pkg) {
    if (isScaffold(pkg)) {
      return `<div class="pkg-actions">
        <button class="btn soft" data-act="install" title="Run in a terminal">${icon('terminal')}Run</button>
        <button class="btn icon" data-act="copy" title="Copy command">${icon('copy')}</button>
      </div>`;
    }
    return `<div class="pkg-actions">
      <button class="btn soft" data-act="install" title="Add to dependencies">${icon('add')}Install</button>
      <button class="btn" data-act="install-dev" title="Add to devDependencies">Dev</button>
      <button class="btn icon" data-act="copy" title="Copy install command">${icon('copy')}</button>
    </div>`;
  }

  function popularityBar(pkg, max) {
    if (!max || typeof pkg.weeklyDownloads !== 'number') return '';
    const width = Math.max(3, Math.round(Math.sqrt(pkg.weeklyDownloads / max) * 100));
    return `<div class="pop" title="${esc(formatCount(pkg.weeklyDownloads))} weekly downloads — compared with this list"><span style="width:${width}%"></span></div>`;
  }

  function cardHtml(pkg, key, max) {
    const favorite = isFavorite(pkg.name);
    const stale = isStale(pkg.updated);
    const stats = [
      statHtml('cloud-download', formatCount(pkg.weeklyDownloads) && `${formatCount(pkg.weeklyDownloads)}/wk`, 'Weekly downloads'),
      statHtml('type-hierarchy', formatCount(pkg.dependents), 'Packages that depend on it'),
      statHtml('history', timeAgo(pkg.updated), stale ? 'Not published for over 2 years' : 'Last publish', stale ? 'stale' : ''),
      statHtml('law', pkg.license, 'License')
    ].join('');
    const keywords =
      ui.density === 'cards' && pkg.keywords && pkg.keywords.length
        ? `<div class="keywords">${pkg.keywords
            .slice(0, 3)
            .map((keyword) => `<button class="kw" data-act="keyword" data-keyword="${esc(keyword)}" title="Search keyword">#${esc(keyword)}</button>`)
            .join('')}</div>`
        : '';
    const scaffold = isScaffold(pkg);

    return `<article class="pkg" tabindex="0" style="--tile: var(${tileColor(pkg.name)})" data-key="${esc(key)}" data-name="${esc(pkg.name)}" aria-label="${esc(pkg.name)}">
      <div class="pkg-head">
        <span class="tile" aria-hidden="true">${esc(monogram(pkg.label || pkg.name))}</span>
        <div class="pkg-title">
          <div class="pkg-name-row">
            <span class="pkg-name">${esc(pkg.label || pkg.name)}</span>
            ${pkg.version ? `<span class="ver">${esc(pkg.version)}</span>` : ''}
          </div>
          ${pkg.label ? `<div class="pkg-sub">${esc(pkg.name)}</div>` : ''}
        </div>
        <button class="btn icon star${favorite ? ' active' : ''}" data-act="favorite" title="${favorite ? 'Remove from saved' : 'Save'}" aria-pressed="${favorite}">${icon(favorite ? 'star-full' : 'star-empty')}</button>
      </div>
      <p class="pkg-desc">${esc(pkg.description || '')}</p>
      ${stats ? `<div class="stats">${stats}</div>` : ''}
      ${keywords}
      ${popularityBar(pkg, max)}
      ${scaffold ? `<code class="cmd">${esc(scaffoldCommand(pkg))}</code>` : ''}
      <div class="pkg-foot">
        <div class="pkg-status">${installedChip(pkg)}</div>
        ${actionsHtml(pkg)}
      </div>
    </article>`;
  }

  function skeletonHtml(count) {
    return Array.from({ length: count || 3 }, () => '<div class="skeleton"><i></i><i></i><i></i></div>').join('');
  }

  function sortPackages(packages) {
    const sorted = packages.slice();
    if (ui.sort === 'downloads') sorted.sort((a, b) => (b.weeklyDownloads || 0) - (a.weeklyDownloads || 0));
    else if (ui.sort === 'updated') sorted.sort((a, b) => String(b.updated || '').localeCompare(String(a.updated || '')));
    else if (ui.sort === 'name') sorted.sort((a, b) => a.name.localeCompare(b.name));
    return sorted;
  }

  function cardsHtml(packages, key) {
    const max = packages.length > 1 ? packages.reduce((top, pkg) => Math.max(top, pkg.weeklyDownloads || 0), 0) : 0;
    return packages.map((pkg) => cardHtml(pkg, key, max)).join('');
  }

  function categoryBodyHtml(key) {
    const state = states.get(key);
    if (!state) return skeletonHtml();

    const cards = cardsHtml(sortPackages(state.packages), key);
    let footer = '';

    if (state.status === 'loading') {
      footer = state.packages.length ? `<div class="status">${icon('loading', 'codicon-modifier-spin')}Loading more…</div>` : skeletonHtml();
    } else if (state.status === 'error') {
      footer = `<div class="notice error">
        ${icon('error')}
        <div class="notice-body"><b>Couldn't reach npm</b><span>${esc(state.error || 'Unknown error')}</span></div>
        <button class="btn" data-act="load-more" data-key="${esc(key)}">Retry</button>
      </div>`;
    } else if (!state.packages.length) {
      footer = emptyHtml('search', 'Nothing found', 'Try different words or a package name.');
    } else if (state.hasMore) {
      footer = `<button class="btn wide" data-act="load-more" data-key="${esc(key)}">${icon('chevron-down')}Show more</button>`;
    }

    return `<div class="cards ${esc(ui.density)}">${cards}</div>${footer}`;
  }

  function emptyHtml(iconName, title, text, action) {
    return `<div class="empty">
      <span class="empty-icon">${icon(iconName)}</span>
      <b>${esc(title)}</b>
      ${text ? `<span>${esc(text)}</span>` : ''}
      ${action || ''}
    </div>`;
  }

  function countLabel(state) {
    if (!state || !state.packages.length) return '';
    const shown = state.packages.length;
    if (state.total && state.total > shown) return `${shown} of ${compact.format(state.total)}`;
    return `${shown} package${shown === 1 ? '' : 's'}`;
  }

  function toolbarHtml(key) {
    const state = states.get(key);
    const options = SORTS.map(([value, label]) => `<option value="${value}"${ui.sort === value ? ' selected' : ''}>${label}</option>`).join('');
    const refresh =
      state && state.status !== 'loading'
        ? `<button class="btn icon" data-act="refresh-category" data-key="${esc(key)}" title="Reload from npm">${icon('refresh')}</button>`
        : '';
    const densityNext = ui.density === 'cards' ? 'compact' : 'cards';
    return `<div class="toolbar">
      <label class="select" title="Sort loaded packages">${icon('list-filter')}<select data-act="sort" aria-label="Sort">${options}</select></label>
      <span class="toolbar-count">${esc(countLabel(state))}</span>
      <button class="btn icon" data-act="density" data-density="${densityNext}" title="${densityNext === 'compact' ? 'Compact list' : 'Detailed cards'}">${icon(densityNext === 'compact' ? 'list-flat' : 'list-unordered')}</button>
      ${refresh}
    </div>`;
  }

  function groupLabel(name) {
    return name.replace(/\s*\(.*?\)\s*/g, '').trim();
  }

  function findCategory(key) {
    for (const group of data.groups) {
      const category = group.categories.find((cat) => cat.key === key);
      if (category) return { group, category };
    }
    return null;
  }

  function pageHeadHtml(title, subtitle, extra) {
    return `<div class="page-head">
      <button class="btn icon" data-act="go-home" title="Back to Explore" aria-label="Back to Explore">${icon('arrow-left')}</button>
      <div class="page-title">${subtitle ? `<span>${esc(subtitle)}</span>` : ''}<b>${esc(title)}</b></div>
      ${extra || ''}
    </div>`;
  }

  function navRow({ act, attrs, iconName, color, title, subtitle, count, chevron }) {
    return `<button class="nav-row" data-act="${act}" ${attrs || ''}${color ? ` style="--accent: var(${color})"` : ''}>
      ${iconName ? `<span class="nav-icon">${icon(iconName)}</span>` : ''}
      <span class="nav-text"><span class="nav-title">${esc(title)}</span>${subtitle ? `<span class="nav-sub">${esc(subtitle)}</span>` : ''}</span>
      ${count ? `<span class="count">${count}</span>` : ''}
      ${icon(chevron || 'chevron-right', 'nav-chevron')}
    </button>`;
  }

  function exploreHomeHtml() {
    const saved = navRow({
      act: 'open-page',
      attrs: 'data-page="__saved__"',
      iconName: 'star-full',
      color: '--vscode-charts-yellow',
      title: 'Saved',
      subtitle: data.favorites.length ? 'Your starred packages and recent views' : 'Star a package to keep it here',
      count: data.favorites.length || ''
    });
    const groups = data.groups
      .map((group) => {
        if (group.categories.length === 1) {
          return `<div class="nav-group">${navRow({
            act: 'open-category',
            attrs: `data-key="${esc(group.categories[0].key)}"`,
            iconName: group.icon,
            color: group.color,
            title: groupLabel(group.name),
            subtitle: group.tagline
          })}</div>`;
        }
        const open = ui.openGroups.includes(group.name);
        const items = open
          ? `<div class="nav-items">${group.categories
              .map((cat) => `<button class="nav-item" data-act="open-category" data-key="${esc(cat.key)}"><span class="nav-item-label">${esc(cat.name)}</span>${icon('chevron-right', 'nav-chevron')}</button>`)
              .join('')}</div>`
          : '';
        return `<div class="nav-group${open ? ' open' : ''}">${navRow({
          act: 'toggle-group',
          attrs: `data-group="${esc(group.name)}" aria-expanded="${open}"`,
          iconName: group.icon,
          color: group.color,
          title: groupLabel(group.name),
          subtitle: group.tagline,
          count: group.categories.length,
          chevron: open ? 'chevron-up' : 'chevron-down'
        })}${items}</div>`;
      })
      .join('');
    return `<div class="nav-list">${saved}</div>
      <div class="group-head"><span class="group-title">Browse by category</span></div>
      <div class="nav-list">${groups}</div>`;
  }

  function categoryPageHtml(key) {
    const found = findCategory(key);
    const isAll = found.category.name === 'All starters';
    return `${pageHeadHtml(isAll ? groupLabel(found.group.name) : found.category.name, isAll ? null : groupLabel(found.group.name))}
      ${toolbarHtml(key)}
      ${categoryBodyHtml(key)}`;
  }

  function discoverHtml() {
    if (data.searchTerm) return searchResultsHtml();
    if (!data.groups.length) return skeletonHtml();
    if (ui.page === SAVED_GROUP) return `${pageHeadHtml('Saved', null)}${savedHtml()}`;
    if (ui.page && findCategory(ui.page)) return categoryPageHtml(ui.page);
    return exploreHomeHtml();
  }

  function searchResultsHtml() {
    return `<div class="page-head">
        <button class="btn icon" data-act="clear-search" title="Back to Explore" aria-label="Back to Explore">${icon('arrow-left')}</button>
        <div class="page-title"><span>Search results</span><b>${esc(data.searchTerm)}</b></div>
      </div>
      ${toolbarHtml(data.searchKey)}
      ${categoryBodyHtml(data.searchKey)}`;
  }

  function workspaceList() {
    return (project.data && project.data.workspaces) || [];
  }

  function overviewView(workspace) {
    const root = workspace.packages.find((pkg) => pkg.isRoot) || workspace.packages[0];
    return {
      overview: true,
      workspace,
      scope: 'workspace',
      folder: workspace.root,
      key: `ws:${workspace.root}`,
      name: workspace.name,
      version: root ? root.version : null,
      manager: workspace.manager,
      dependencies: workspace.overview.dependencies,
      summary: workspace.overview.summary
    };
  }

  function packageView(workspace, pkg) {
    return { ...pkg, overview: false, workspace, scope: 'package', key: pkg.folder };
  }

  function selectedView() {
    const workspaces = workspaceList();
    for (const workspace of workspaces) {
      if (workspace.overview && ui.projectFolder === `ws:${workspace.root}`) return overviewView(workspace);
      const pkg = workspace.packages.find((item) => item.folder === ui.projectFolder);
      if (pkg) return packageView(workspace, pkg);
    }
    const first = workspaces[0];
    if (!first) return null;
    return first.overview ? overviewView(first) : packageView(first, first.packages[0]);
  }

  function groupOf(dep) {
    return UPDATE_GROUPS.find((group) => group.match(dep)).key;
  }

  function isUpdatable(dep) {
    return Boolean(dep.update) && !dep.local && dep.field !== 'peerDependencies';
  }

  function countsOf(deps) {
    const counts = { major: 0, minor: 0, patch: 0, current: 0, vulnerable: 0, fixable: [], deprecated: 0 };
    for (const dep of deps) {
      if (dep.local) continue;
      if (dep.update === 'major') counts.major++;
      else if (dep.update === 'minor') counts.minor++;
      else if (dep.update) counts.patch++;
      else counts.current++;
      if (dep.advisories.length) {
        counts.vulnerable++;
        if (isUpdatable(dep)) counts.fixable.push(dep.name);
      }
      if (dep.deprecated) counts.deprecated++;
    }
    counts.outdated = counts.major + counts.minor + counts.patch;
    counts.safe = counts.minor + counts.patch;
    counts.total = counts.outdated + counts.current;
    return counts;
  }

  function badgeCounts(summary) {
    const parts = [];
    if (summary.vulnerable) parts.push(`${summary.vulnerable} vulnerable`);
    if (summary.outdated) parts.push(`${summary.outdated} outdated`);
    return parts.length ? ` · ${parts.join(', ')}` : '';
  }

  function projectPickerHtml(current) {
    const workspaces = workspaceList();
    const total = workspaces.reduce((sum, workspace) => sum + workspace.packages.length, 0);
    if (total < 2) return '';
    const groups = workspaces
      .map((workspace) => {
        const options = [];
        if (workspace.overview) {
          options.push(
            `<option value="ws:${esc(workspace.root)}">Whole monorepo · ${workspace.packages.length} packages${esc(badgeCounts(workspace.overview.summary))}</option>`
          );
        }
        for (const pkg of workspace.packages) {
          options.push(`<option value="${esc(pkg.folder)}">${esc(pkg.folderName)}${pkg.name !== pkg.folderName ? ` — ${esc(pkg.name)}` : ''}${esc(badgeCounts(pkg.summary))}</option>`);
        }
        return workspaces.length > 1 ? `<optgroup label="${esc(workspace.folderName)}">${options.join('')}</optgroup>` : options.join('');
      })
      .join('');
    return `<label class="select wide">${icon(current.overview ? 'repo' : 'folder')}<select data-act="project-folder" aria-label="Project">${groups.replace(
      `value="${esc(current.key)}"`,
      `value="${esc(current.key)}" selected`
    )}</select></label>`;
  }

  function packagesListHtml(current) {
    if (!current.overview) return '';
    const members = current.workspace.packages;
    const open = ui.showPackages !== false;
    const rows = members
      .map((pkg) => {
        const chips = [];
        if (pkg.summary.vulnerable) chips.push(`<span class="chip bad" title="Vulnerable dependencies">${icon('shield')}${pkg.summary.vulnerable}</span>`);
        if (pkg.summary.outdated) chips.push(`<span class="chip warn" title="Outdated dependencies">${icon('arrow-up')}${pkg.summary.outdated}</span>`);
        if (!chips.length) chips.push(`<span class="chip ok" title="Everything up to date">${icon('check')}</span>`);
        return `<div class="ws-pkg" tabindex="0" data-act="select-package" data-folder="${esc(pkg.folder)}" title="${esc(pkg.folder)}" style="--accent: var(${pkg.isRoot ? '--vscode-charts-purple' : '--vscode-charts-blue'})">
          <span class="nav-icon">${icon(pkg.isRoot ? 'root-folder' : 'package')}</span>
          <div class="ws-pkg-main">
            <div class="ws-pkg-name">${esc(pkg.folderName)}</div>
            ${pkg.name !== pkg.folderName ? `<div class="ws-pkg-sub">${esc(pkg.name)}${pkg.version ? ` · ${esc(pkg.version)}` : ''}</div>` : ''}
          </div>
          <div class="ws-pkg-chips">${chips.join('')}</div>
          ${icon('chevron-right', 'nav-chevron')}
        </div>`;
      })
      .join('');
    return `<section class="group-block">
      <button class="group-head toggle-head" data-act="toggle-packages" aria-expanded="${open}">
        ${icon('package', 'group-icon')}<span class="group-title">Workspace packages</span><span class="count">${members.length}</span>
        <span class="group-spacer"></span>${icon(open ? 'chevron-up' : 'chevron-down', 'nav-chevron')}
      </button>
      ${open ? `<div class="ws-list">${rows}</div>` : ''}
    </section>`;
  }

  function checkedLabel() {
    const checkedAt = project.data && project.data.checkedAt;
    const ago = checkedAt ? timeAgo(checkedAt) : null;
    if (!ago) return '';
    return ago === 'today' ? `Checked ${new Date(checkedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : `Checked ${ago}`;
  }

  function heroHtml(current) {
    const counts = countsOf(current.dependencies);
    const segments = [
      ['major', counts.major],
      ['minor', counts.minor],
      ['patch', counts.patch],
      ['current', counts.current]
    ].filter(([, value]) => value > 0);
    const bar = counts.total
      ? `<div class="health-bar" role="img" aria-label="${counts.outdated} of ${counts.total} dependencies can be updated">${segments
          .map(([key, value]) => `<span class="seg-${key}" style="flex:${value}" title="${value} ${key === 'current' ? 'up to date' : key}"></span>`)
          .join('')}</div>`
      : '';
    const legend = [
      ['major', counts.major, 'major'],
      ['minor', counts.minor, 'minor'],
      ['patch', counts.patch, 'patch'],
      ['current', counts.current, 'up to date']
    ]
      .filter(([, value]) => value > 0)
      .map(
        ([key, value, label]) =>
          `<button class="legend${ui.projectFilter === key ? ' active' : ''}" data-act="project-filter" data-filter="${key}"><i class="dot seg-${key}"></i><b>${value}</b> ${label}</button>`
      )
      .join('');
    const alerts = [
      counts.vulnerable
        ? `<button class="alert bad${ui.projectFilter === 'security' ? ' active' : ''}" data-act="project-filter" data-filter="security">${icon('shield')}<b>${counts.vulnerable}</b> vulnerable</button>`
        : '',
      counts.deprecated
        ? `<button class="alert warn${ui.projectFilter === 'deprecated' ? ' active' : ''}" data-act="project-filter" data-filter="deprecated">${icon('warning')}<b>${counts.deprecated}</b> deprecated</button>`
        : '',
      current.overview && current.summary.drift
        ? `<button class="alert warn${ui.projectFilter === 'drift' ? ' active' : ''}" data-act="project-filter" data-filter="drift" title="Same dependency on different versions across packages">${icon('git-compare')}<b>${current.summary.drift}</b> version drift</button>`
        : ''
    ].join('');

    const scopeAttrs = `data-folder="${esc(current.folder)}" data-scope="${current.scope}"`;
    let actions;
    if (pendingUpdate) {
      actions = `<div class="running">${icon('loading', 'codicon-modifier-spin')}<div><b>Updating in the terminal…</b><span>The list refreshes when the lockfile changes.</span></div></div>`;
    } else if (!counts.outdated) {
      actions = '';
    } else {
      const primary = counts.safe
        ? `<button class="btn primary big" data-act="update-mode" data-mode="safe" ${scopeAttrs} title="Minor and patch updates only — keeps every major version">
            ${icon('arrow-up')}<span class="big-label">Safe update<small>minor &amp; patch · no breaking changes</small></span><span class="big-count">${counts.safe}</span>
          </button>`
        : `<button class="btn primary big" data-act="update-mode" data-mode="latest" ${scopeAttrs}>
            ${icon('arrow-up')}<span class="big-label">Update to latest<small>includes major versions</small></span><span class="big-count">${counts.outdated}</span>
          </button>`;
      const secondary = [
        counts.safe && counts.major
          ? `<button class="btn" data-act="update-mode" data-mode="latest" ${scopeAttrs} title="Everything to the newest version, including ${counts.major} major">${icon('flame')}All to latest · ${counts.outdated}</button>`
          : '',
        counts.fixable.length
          ? `<button class="btn danger" data-act="update-mode" data-mode="vulnerable" ${scopeAttrs} title="${esc(counts.fixable.join(', '))}">${icon('shield')}Fix vulnerable · ${counts.fixable.length}</button>`
          : ''
      ].join('');
      actions = `${primary}${secondary ? `<div class="hero-secondary">${secondary}</div>` : ''}`;
    }

    const title = counts.outdated
      ? `<span class="hero-number">${counts.outdated}</span><span class="hero-text">update${counts.outdated === 1 ? '' : 's'} available</span>`
      : `<span class="hero-ok">${icon('pass-filled')}</span><span class="hero-text">All ${counts.total} dependencies are up to date</span>`;

    return `<section class="hero">
      <div class="hero-title">${title}</div>
      ${bar}
      ${legend ? `<div class="legends">${legend}</div>` : ''}
      ${alerts ? `<div class="alerts">${alerts}</div>` : ''}
      ${actions ? `<div class="hero-actions">${actions}</div>` : ''}
    </section>`;
  }

  function updatesHtml() {
    if (!data.hasWorkspace) {
      return emptyHtml('folder-opened', 'No folder open', 'Open a project to see which dependencies can be updated.');
    }
    if (project.status === 'idle' || (project.status === 'loading' && !project.data)) {
      const progress = project.progress;
      const percent = progress && progress.total ? Math.round((progress.done / progress.total) * 100) : 0;
      return `<section class="hero">
          <div class="progress-text">${icon('loading', 'codicon-modifier-spin')}${
            progress && progress.total ? `Checking ${progress.done} of ${progress.total} dependencies…` : 'Reading package.json…'
          }</div>
          <div class="progress"><span style="width:${percent}%"></span></div>
        </section>${skeletonHtml(3)}`;
    }
    if (project.status === 'empty') {
      return emptyHtml(
        'package',
        'No package.json',
        'This workspace has no package.json yet.',
        '<button class="btn primary" data-act="init-project">Create package.json</button>'
      );
    }
    if (project.status === 'error' && !project.data) {
      return `<div class="notice error">${icon('error')}<div class="notice-body"><b>Check failed</b><span>${esc(project.error)}</span></div>
        <button class="btn" data-act="project-refresh">Retry</button></div>`;
    }

    const current = selectedView();
    if (!current) return emptyHtml('package', 'No package.json', '');
    if (selectionKey !== current.key) {
      selection.clear();
      selectionKey = current.key;
    }
    const workspace = current.workspace;
    const subtitle = current.overview
      ? `${workspace.packages.length} packages · ${esc(current.manager)}`
      : workspace.isMonorepo
      ? `${esc(current.folderName)} · ${esc(current.manager)}`
      : esc(current.manager);
    const nested = !current.overview && Boolean(workspace.overview);
    const status = project.status === 'loading' ? `${icon('loading', 'codicon-modifier-spin')}Checking…` : esc(checkedLabel());

    const notes = [
      project.data.auditAvailable ? '' : `<div class="notice">${icon('info')}<div class="notice-body"><span>Security audit is unavailable right now.</span></div></div>`,
      current.summary.missing
        ? `<p class="quiet-note" title="Versions are taken from package.json ranges until you install">${icon('info')}${current.summary.missing} not installed yet — versions are estimated</p>`
        : ''
    ].join('');

    const headActions = `<button class="btn icon" data-act="open-manifest" data-folder="${esc(current.folder)}" title="Open package.json">${icon('go-to-file')}</button>
        <button class="btn icon" data-act="project-refresh" title="Check again">${icon('refresh')}</button>`;
    const head = nested
      ? `<div class="page-head">
          <button class="btn icon" data-act="select-package" data-folder="ws:${esc(workspace.root)}" title="Back to the whole monorepo" aria-label="Back to the whole monorepo">${icon('arrow-left')}</button>
          <div class="page-title"><span>${esc(workspace.name)} · ${esc(current.folderName)}</span><b>${esc(current.name)}</b></div>
          ${headActions}
        </div>`
      : `<div class="page-head root">
          <div class="page-title"><span class="project-sub">${subtitle}${status ? `<span class="checked">${status}</span>` : ''}</span><b>${esc(current.name)}</b></div>
          ${headActions}
        </div>`;

    return `${head}
      ${projectPickerHtml(current)}
      ${heroHtml(current)}
      ${notes}
      ${packagesListHtml(current)}
      <div class="filter-row">
        <div class="mini-search">${icon('filter')}<input id="projectQuery" type="text" placeholder="Filter by name" value="${esc(ui.projectQuery)}" spellcheck="false" aria-label="Filter dependencies"></div>
        ${ui.projectFilter !== 'all' ? `<button class="btn small" data-act="project-filter" data-filter="all">${icon('close')}Show all</button>` : ''}
      </div>
      <div id="projectRows">${projectRowsHtml(current)}</div>
      <div id="selectionBar">${selectionBarHtml(current)}</div>`;
  }

  function matchesFilter(dep) {
    if (ui.projectQuery && !dep.name.toLowerCase().includes(ui.projectQuery.toLowerCase())) return false;
    switch (ui.projectFilter) {
      case 'security':
        return dep.advisories.length > 0;
      case 'deprecated':
        return Boolean(dep.deprecated);
      case 'drift':
        return Boolean(dep.drift);
      case 'major':
      case 'minor':
        return dep.update === ui.projectFilter;
      case 'patch':
        return dep.update === 'patch' || dep.update === 'prerelease';
      case 'current':
        return !dep.update;
      default:
        return true;
    }
  }

  function projectRowsHtml(current) {
    const visible = current.dependencies.filter(matchesFilter);
    const sections = UPDATE_GROUPS.map((group) => {
      const deps = visible.filter((dep) => groupOf(dep) === group.key).sort((a, b) => a.name.localeCompare(b.name));
      if (!deps.length) return '';
      const collapsed = group.key === 'current' && !ui.showCurrent && ui.projectFilter !== 'current' && !ui.projectQuery;
      const updatable = deps.filter(isUpdatable).map((dep) => dep.name);
      const action =
        updatable.length > 1
          ? `<button class="btn small" data-act="update-many" data-folder="${esc(current.folder)}" data-scope="${current.scope}" data-names="${esc(updatable.join(' '))}" title="${esc(updatable.join(', '))}">${icon('arrow-up')}Update ${updatable.length}</button>`
          : '';
      const head = `<${group.key === 'current' ? 'button' : 'div'} class="group-head g-${group.key}${group.key === 'current' ? ' toggle-head' : ''}"${
        group.key === 'current' ? ' data-act="toggle-current"' : ''
      }>
          ${icon(group.icon, 'group-icon')}
          <span class="group-title">${group.label}</span><span class="count">${deps.length}</span>
          ${group.hint ? `<span class="group-hint">${group.hint}</span>` : '<span class="group-spacer"></span>'}
          ${action}${group.key === 'current' ? icon(collapsed ? 'chevron-down' : 'chevron-up', 'nav-chevron') : ''}
        </${group.key === 'current' ? 'button' : 'div'}>`;
      return `<section class="group-block">${head}${collapsed ? '' : `<div class="dep-list">${deps.map((dep) => depRowHtml(dep, current)).join('')}</div>`}</section>`;
    }).join('');
    return sections || emptyHtml('pass', 'Nothing here', ui.projectFilter === 'all' ? 'No dependency matches this name.' : 'Nothing in this filter.');
  }

  function depRowHtml(dep, current) {
    const chips = [];
    if (dep.severity) {
      chips.push(
        `<span class="chip sev-${esc(dep.severity)}" title="${esc(dep.advisories.map((item) => `${item.severity}: ${item.title}`).join('\n'))}">${icon('shield')}${esc(dep.severity)}${
          dep.advisories.length > 1 ? ` ×${dep.advisories.length}` : ''
        }${dep.update ? '' : ' · no fix yet'}</span>`
      );
    }
    if (dep.deprecated) chips.push(`<span class="chip bad" title="${esc(dep.deprecated)}">${icon('warning')}deprecated</span>`);
    if (dep.drift) chips.push(`<span class="chip warn" title="${esc(dep.drift.join('\n'))}">${icon('git-compare')}${dep.drift.length} versions</span>`);
    if (dep.error) chips.push(`<span class="chip muted-chip" title="${esc(dep.error)}">unknown</span>`);

    const tag = FIELD_TAGS[dep.field] ? `<span class="field-tag">${FIELD_TAGS[dep.field]}</span>` : '';
    const version = dep.local
      ? `<span class="muted">${esc(dep.range)}</span>`
      : `<span class="v-current" title="Range in package.json: ${esc(dep.range)}">${esc(dep.current || dep.range)}</span>${
          dep.update ? `${icon('arrow-right', 'arrow')}<span class="v-latest upd-${esc(dep.update)}">${esc(dep.latest)}</span>` : ''
        }${
          current.overview && dep.usages && dep.usages.length > 1
            ? `<span class="usage" title="${esc(dep.usages.map((usage) => `${usage.package}: ${usage.range}`).join('\n'))}">· ${dep.usages.length} packages</span>`
            : ''
        }`;

    const selectable = isUpdatable(dep);
    const checked = selection.has(dep.name);
    const check = selectable
      ? `<button class="check${checked ? ' on' : ''}" role="checkbox" aria-checked="${checked}" aria-label="Select ${esc(dep.name)}" data-act="toggle-select" data-name="${esc(dep.name)}">${checked ? icon('check') : ''}</button>`
      : '<span class="check-spacer"></span>';
    const notes =
      dep.update === 'major' && dep.releasesUrl
        ? `<button class="btn icon" data-act="open-url" data-url="${esc(dep.releasesUrl)}" title="Release notes — check for breaking changes">${icon('book')}</button>`
        : '';
    const update = selectable
      ? `<button class="btn icon" data-act="update-one" data-folder="${esc(current.folder)}" data-scope="${current.scope}" data-name="${esc(dep.name)}" data-dev="${dep.field === 'devDependencies'}" title="${
          current.overview ? `Update to ${esc(dep.latest)} in every package that uses it` : `Update to ${esc(dep.latest)}`
        }">${icon('arrow-up')}</button>`
      : '';
    const uninstall = current.overview
      ? ''
      : `<button class="btn icon" data-act="uninstall" data-folder="${esc(current.folder)}" data-name="${esc(dep.name)}" title="Uninstall">${icon('trash')}</button>`;

    return `<div class="dep${checked ? ' selected' : ''}" tabindex="0" data-act="open-dep" data-name="${esc(dep.name)}" title="${esc(dep.description || dep.name)}">
      ${check}
      <div class="dep-main">
        <div class="dep-line"><span class="dep-name">${esc(dep.name)}</span>${tag}</div>
        <div class="dep-version">${version}</div>
        ${chips.length ? `<div class="dep-chips">${chips.join('')}</div>` : ''}
      </div>
      <div class="dep-actions">${notes}${update}${uninstall}</div>
    </div>`;
  }

  function selectionBarHtml(current) {
    if (!selection.size) return '';
    const names = [...selection];
    return `<div class="selbar">
      <span><b>${names.length}</b> selected</span>
      <button class="btn link" data-act="clear-selection">Clear</button>
      <button class="btn primary" data-act="update-many" data-folder="${esc(current.folder)}" data-scope="${current.scope}" data-names="${esc(names.join(' '))}">${icon('arrow-up')}Update selected</button>
    </div>`;
  }

  function refreshProjectRows() {
    const current = selectedView();
    const rows = document.getElementById('projectRows');
    const bar = document.getElementById('selectionBar');
    if (!current || !rows) return;
    rows.innerHTML = projectRowsHtml(current);
    if (bar) bar.innerHTML = selectionBarHtml(current);
  }

  function savedHtml() {
    const favorites = data.favorites.length
      ? `<div class="cards ${esc(ui.density)}">${cardsHtml(data.favorites, 'favorites')}</div>`
      : emptyHtml('star-empty', 'Nothing saved yet', 'Click the star on any package to keep it here.');
    const recent = data.recent.length
      ? data.recent
          .map(
            (pkg) => `<div class="recent" tabindex="0" data-act="open-recent" data-name="${esc(pkg.name)}">
              <span class="tile small" style="--tile: var(${tileColor(pkg.name)})" aria-hidden="true">${esc(monogram(pkg.name))}</span>
              <div class="recent-main">
                <div class="recent-name">${esc(pkg.name)}</div>
                <div class="recent-desc">${esc(pkg.description || '')}</div>
              </div>
              <span class="muted small">${esc(timeAgo(pkg.viewedAt) || '')}</span>
            </div>`
          )
          .join('')
      : '<p class="muted small pad">Packages you open will show up here.</p>';

    return `<section class="block">${favorites}</section>
      <section class="block">
        <div class="block-head"><span>${icon('history')}Recently viewed</span>${
          data.recent.length ? '<button class="btn link" data-act="clear-recent">Clear</button>' : ''
        }</div>
        ${recent}
      </section>`;
  }

  function viewsHtml() {
    const view = selectedView();
    const counts = view ? countsOf(view.dependencies) : null;
    let badge = '';
    if (counts && counts.vulnerable) badge = `<span class="badge bad" title="${counts.vulnerable} vulnerable">${counts.outdated || counts.vulnerable}</span>`;
    else if (counts && counts.outdated) badge = `<span class="badge accent" title="Updates available">${counts.outdated}</span>`;
    const tabs = [
      ['updates', 'arrow-circle-up', 'Updates', badge],
      ['explore', 'compass', 'Explore', '']
    ];
    return tabs
      .map(([tab, iconName, label, extra]) => {
        const active = ui.tab === tab;
        return `<button class="view view-${tab}${active ? ' active' : ''}" role="tab" aria-selected="${active}" data-act="tab" data-tab="${tab}">${icon(iconName)}<span>${label}</span>${extra}</button>`;
      })
      .join('');
  }

  function render() {
    const scroll = document.scrollingElement ? document.scrollingElement.scrollTop : 0;
    const focusedQuery = document.activeElement && document.activeElement.id === 'projectQuery';
    views.innerHTML = viewsHtml();

    document.body.dataset.tab = ui.tab;
    form.hidden = ui.tab !== 'explore';
    list.innerHTML = ui.tab === 'updates' ? updatesHtml() : discoverHtml();

    if (document.scrollingElement) document.scrollingElement.scrollTop = scroll;
    if (focusedQuery) {
      const query = document.getElementById('projectQuery');
      if (query) {
        query.focus();
        query.setSelectionRange(query.value.length, query.value.length);
      }
    }
    clearButton.hidden = !input.value && !data.searchTerm;
  }

  function activeKey() {
    if (data.searchTerm) return data.searchKey;
    return ui.page && findCategory(ui.page) ? ui.page : null;
  }

  function requestActiveCategory() {
    if (ui.tab !== 'explore') return;
    const key = activeKey();
    if (key && !states.has(key)) post({ type: 'openCategory', key });
  }

  function ensureProject() {
    if (ui.tab === 'updates' && project.status === 'idle' && data.hasWorkspace) {
      project.status = 'loading';
      post({ type: 'loadProject' });
    }
  }

  function setTab(tab) {
    ui.tab = tab;
    persist();
    render();
    requestActiveCategory();
    ensureProject();
  }

  function openPage(page) {
    ui.page = page;
    persist();
    render();
    scrollTop();
  }

  function scrollTop() {
    if (document.scrollingElement) document.scrollingElement.scrollTop = 0;
  }

  function packageAction(type, target, extra) {
    const card = target.closest('[data-name]');
    if (!card) return;
    post({ type, key: card.dataset.key || null, name: card.dataset.name, ...extra });
  }

  function handleAction(target) {
    const act = target.dataset.act;

    switch (act) {
      case 'tab':
        setTab(target.dataset.tab);
        break;
      case 'toggle-group': {
        const name = target.dataset.group;
        ui.openGroups = ui.openGroups.includes(name) ? ui.openGroups.filter((item) => item !== name) : [...ui.openGroups, name];
        persist();
        render();
        break;
      }
      case 'open-category':
        openPage(target.dataset.key);
        requestActiveCategory();
        break;
      case 'open-page':
        openPage(target.dataset.page);
        break;
      case 'go-home':
        openPage(null);
        break;
      case 'density':
        ui.density = target.dataset.density;
        persist();
        render();
        break;
      case 'load-more':
        post({ type: 'loadMore', key: target.dataset.key });
        break;
      case 'refresh-category':
        post({ type: 'refreshCategory', key: target.dataset.key });
        break;
      case 'clear-search':
        input.value = '';
        post({ type: 'clearSearch' });
        break;
      case 'keyword':
        runSearch(`keywords:${target.dataset.keyword}`);
        break;
      case 'install':
        packageAction('install', target, { dev: false });
        break;
      case 'install-dev':
        packageAction('install', target, { dev: true });
        break;
      case 'copy':
        packageAction('copy', target, { dev: false });
        flash(target);
        break;
      case 'favorite':
        packageAction('toggleFavorite', target);
        break;
      case 'open-recent':
      case 'open-dep':
        post({ type: 'openPackage', name: target.dataset.name });
        break;
      case 'clear-recent':
        post({ type: 'clearRecent' });
        break;
      case 'project-refresh':
        project.status = 'loading';
        render();
        post({ type: 'loadProject', force: true });
        break;
      case 'project-filter':
        ui.projectFilter = target.dataset.filter === ui.projectFilter ? 'all' : target.dataset.filter;
        persist();
        render();
        break;
      case 'toggle-current':
        ui.showCurrent = !ui.showCurrent;
        persist();
        refreshProjectRows();
        break;
      case 'toggle-select':
        if (selection.has(target.dataset.name)) selection.delete(target.dataset.name);
        else selection.add(target.dataset.name);
        refreshProjectRows();
        break;
      case 'clear-selection':
        selection.clear();
        refreshProjectRows();
        break;
      case 'update-mode':
        post({ type: 'updateAll', folder: target.dataset.folder, scope: target.dataset.scope, mode: target.dataset.mode });
        break;
      case 'open-url':
        post({ type: 'openUrl', url: target.dataset.url });
        break;
      case 'open-manifest':
        post({ type: 'openManifest', folder: target.dataset.folder });
        break;
      case 'init-project':
        post({ type: 'initProject' });
        break;
      case 'update-one':
        post({ type: 'updateDeps', folder: target.dataset.folder, scope: target.dataset.scope, names: [target.dataset.name], dev: target.dataset.dev === 'true' });
        break;
      case 'update-many':
        post({ type: 'updateDeps', folder: target.dataset.folder, scope: target.dataset.scope, names: target.dataset.names.split(' '), dev: target.dataset.dev === 'true' });
        selection.clear();
        refreshProjectRows();
        break;
      case 'select-package':
        ui.projectFolder = target.dataset.folder;
        if (ui.projectFilter === 'drift' && !ui.projectFolder.startsWith('ws:')) ui.projectFilter = 'all';
        ui.projectQuery = '';
        persist();
        scrollTop();
        render();
        break;
      case 'toggle-packages':
        ui.showPackages = ui.showPackages === false;
        persist();
        render();
        break;
      case 'uninstall':
        post({ type: 'uninstall', folder: target.dataset.folder, name: target.dataset.name });
        break;
    }
  }

  function flash(button) {
    const original = button.innerHTML;
    button.innerHTML = icon('check');
    button.classList.add('done');
    setTimeout(() => {
      button.innerHTML = original;
      button.classList.remove('done');
    }, 1200);
  }

  function openCard(card) {
    post({ type: 'openPackage', key: card.dataset.key, name: card.dataset.name });
  }

  document.addEventListener('click', (event) => {
    const actionTarget = event.target.closest('[data-act]');
    if (actionTarget && !actionTarget.matches('select')) {
      if (actionTarget.closest('#suggest')) return;
      event.stopPropagation();
      handleAction(actionTarget);
      return;
    }
    const card = event.target.closest('.pkg');
    if (card) openCard(card);
  });

  list.addEventListener('change', (event) => {
    const select = event.target.closest('select[data-act]');
    if (!select) return;
    if (select.dataset.act === 'sort') ui.sort = select.value;
    if (select.dataset.act === 'project-folder') {
      ui.projectFolder = select.value;
      if (ui.projectFilter === 'drift' && !select.value.startsWith('ws:')) ui.projectFilter = 'all';
    }
    persist();
    render();
  });

  list.addEventListener('input', (event) => {
    if (event.target.id !== 'projectQuery') return;
    ui.projectQuery = event.target.value;
    refreshProjectRows();
  });

  list.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    if (event.target.tagName === 'BUTTON' || event.target.tagName === 'INPUT' || event.target.tagName === 'SELECT') return;
    const card = event.target.closest('.pkg');
    const row = event.target.closest('.dep, .recent, .ws-pkg');
    if (!card && !row) return;
    event.preventDefault();
    if (card) openCard(card);
    else if (row.classList.contains('ws-pkg')) handleAction(row);
    else post({ type: 'openPackage', name: row.dataset.name });
  });

  function runSearch(term) {
    const value = term.trim();
    if (!value) return;
    input.value = value;
    closeSuggest();
    ui.tab = 'explore';
    persist();
    scrollTop();
    post({ type: 'search', term: value });
  }

  function suggestItems() {
    const term = input.value.trim();
    if (!term) {
      return data.history.map((entry) => ({ kind: 'history', term: entry }));
    }
    const items = [{ kind: 'search', term }];
    for (const pkg of suggest.term === term ? suggest.items : []) items.push({ kind: 'package', pkg });
    return items;
  }

  function renderSuggest() {
    const items = suggestItems();
    if (!suggest.open || !items.length) {
      suggestBox.hidden = true;
      input.setAttribute('aria-expanded', 'false');
      return;
    }
    if (suggest.index >= items.length) suggest.index = items.length - 1;
    const rows = items.map((item, index) => {
      const active = index === suggest.index ? ' active' : '';
      if (item.kind === 'history') {
        return `<div class="sg${active}" role="option" data-index="${index}">
          ${icon('history')}<span class="sg-main">${esc(item.term)}</span>
          <button class="btn icon sg-remove" data-remove="${esc(item.term)}" title="Remove from history">${icon('close')}</button>
        </div>`;
      }
      if (item.kind === 'search') {
        return `<div class="sg${active}" role="option" data-index="${index}">
          ${icon('search')}<span class="sg-main sg-inline">Search for <b>${esc(item.term)}</b></span>
          ${suggest.loading ? icon('loading', 'codicon-modifier-spin muted') : '<kbd>↵</kbd>'}
        </div>`;
      }
      const pkg = item.pkg;
      return `<div class="sg pkg-sg${active}" role="option" data-index="${index}">
        <span class="tile small" style="--tile: var(${tileColor(pkg.name)})" aria-hidden="true">${esc(monogram(pkg.name))}</span>
        <span class="sg-main">
          <span class="sg-name">${esc(pkg.name)} <span class="ver">${esc(pkg.version || '')}</span></span>
          <span class="sg-desc">${esc(pkg.description || '')}</span>
        </span>
        ${typeof pkg.weeklyDownloads === 'number' ? `<span class="muted small">${esc(formatCount(pkg.weeklyDownloads))}/wk</span>` : ''}
      </div>`;
    });
    const footer = !input.value.trim() && data.history.length ? '<div class="sg-foot"><button class="btn link" data-clear-history>Clear history</button></div>' : '';
    suggestBox.innerHTML = `${!input.value.trim() ? '<div class="sg-title">Recent searches</div>' : ''}${rows.join('')}${footer}`;
    suggestBox.hidden = false;
    input.setAttribute('aria-expanded', 'true');
  }

  function openSuggest() {
    suggest.open = true;
    suggest.index = input.value.trim() ? 0 : -1;
    renderSuggest();
  }

  function closeSuggest() {
    suggest.open = false;
    suggest.index = -1;
    renderSuggest();
  }

  function chooseSuggestion(index) {
    const item = suggestItems()[index];
    if (!item) return;
    if (item.kind === 'package') {
      closeSuggest();
      post({ type: 'openPackage', name: item.pkg.name });
      return;
    }
    runSearch(item.term);
  }

  function requestSuggestions() {
    clearTimeout(suggestTimer);
    const term = input.value.trim();
    if (term.length < 2) {
      suggest.loading = false;
      return;
    }
    suggest.loading = true;
    suggestTimer = setTimeout(() => {
      suggest.seq++;
      post({ type: 'suggest', term, seq: suggest.seq });
    }, SUGGEST_DELAY_MS);
  }

  input.addEventListener('focus', openSuggest);
  input.addEventListener('blur', () => setTimeout(closeSuggest, 150));

  input.addEventListener('input', () => {
    clearButton.hidden = !input.value && !data.searchTerm;
    suggest.open = true;
    suggest.index = input.value.trim() ? 0 : -1;
    requestSuggestions();
    renderSuggest();
  });

  input.addEventListener('keydown', (event) => {
    const items = suggestItems();
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!suggest.open) openSuggest();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      suggest.index = Math.max(-1, Math.min(items.length - 1, suggest.index + step));
      renderSuggest();
    } else if (event.key === 'Escape') {
      if (suggest.open && items.length) closeSuggest();
      else if (input.value) {
        input.value = '';
        clearButton.hidden = !data.searchTerm;
      } else if (data.searchTerm) post({ type: 'clearSearch' });
      else input.blur();
    }
  });

  suggestBox.addEventListener('mousedown', (event) => {
    event.preventDefault();
    const remove = event.target.closest('[data-remove]');
    if (remove) {
      post({ type: 'removeSearch', term: remove.dataset.remove });
      return;
    }
    if (event.target.closest('[data-clear-history]')) {
      post({ type: 'clearHistory' });
      return;
    }
    const row = event.target.closest('.sg');
    if (row) chooseSuggestion(Number(row.dataset.index));
  });

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (suggest.open && suggest.index >= 0) chooseSuggestion(suggest.index);
    else runSearch(input.value);
  });

  clearButton.addEventListener('click', () => {
    input.value = '';
    clearButton.hidden = true;
    if (data.searchTerm) post({ type: 'clearSearch' });
    input.focus();
  });

  document.addEventListener('keydown', (event) => {
    const typing = ['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement && document.activeElement.tagName);
    if (event.key === '/' && !typing) {
      event.preventDefault();
      if (ui.tab === 'updates') {
        const query = document.getElementById('projectQuery');
        if (query) query.focus();
        return;
      }
      input.focus();
      input.select();
    }
  });

  window.addEventListener('message', (event) => {
    const message = event.data;
    switch (message.type) {
      case 'init':
        states.clear();
        data.groups = message.groups;
        applyUserData(message);
        data.searchTerm = message.searchTerm;
        data.searchKey = message.searchKey;
        if (data.searchTerm) input.value = data.searchTerm;
        else if (document.activeElement !== input) input.value = '';
        if (ui.page && ui.page !== SAVED_GROUP && !findCategory(ui.page)) ui.page = null;
        render();
        requestActiveCategory();
        ensureProject();
        break;
      case 'userdata':
        applyUserData(message);
        render();
        if (suggest.open) renderSuggest();
        break;
      case 'category':
        states.set(message.key, {
          status: message.status,
          packages: message.packages,
          hasMore: message.hasMore,
          total: message.total,
          error: message.error
        });
        if (ui.tab === 'explore') render();
        break;
      case 'suggestions':
        if (message.seq !== suggest.seq) break;
        suggest.loading = false;
        suggest.term = message.term;
        suggest.items = message.packages;
        renderSuggest();
        break;
      case 'project':
        if (message.status === 'ready') setPending(false, true);
        project.status = message.status;
        project.data = message.data || project.data;
        project.progress = message.progress;
        project.error = message.error;
        render();
        break;
      case 'projectProgress':
        project.progress = message.progress;
        if (ui.tab === 'updates' && !project.data) render();
        break;
      case 'updateStatus':
        setPending(message.running);
        break;
      case 'showTab':
        setTab(message.tab);
        break;
      case 'focusSearch':
        if (ui.tab !== 'explore') setTab('explore');
        input.focus();
        input.select();
        break;
    }
  });

  function setPending(running, silent) {
    clearTimeout(pendingTimer);
    pendingUpdate = Boolean(running);
    if (pendingUpdate) pendingTimer = setTimeout(() => setPending(false), PENDING_TIMEOUT_MS);
    if (!silent && ui.tab === 'updates') render();
  }

  function applyUserData(message) {
    data.favorites = message.favorites;
    data.recent = message.recent;
    data.installed = message.installed || {};
    data.history = message.history;
    data.manager = message.manager || 'npm';
    data.hasWorkspace = Boolean(message.hasWorkspace);
  }

  post({ type: 'ready' });
})();
