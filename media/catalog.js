(function () {
  const vscode = acquireVsCodeApi();
  const saved = vscode.getState() || {};
  const ui = {
    tab: saved.tab || 'discover',
    group: saved.group || null,
    categoryByGroup: saved.categoryByGroup || {},
    sort: saved.sort || 'relevance',
    density: saved.density || 'cards',
    showAllCategories: Boolean(saved.showAllCategories),
    projectFilter: saved.projectFilter || 'all',
    projectFolder: saved.projectFolder || null,
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

  const CATEGORY_PREVIEW = 8;
  const SUGGEST_DELAY_MS = 220;
  const TILE_COLORS = ['blue', 'green', 'orange', 'purple', 'red', 'yellow'];
  const SORTS = [
    ['relevance', 'Popular'],
    ['downloads', 'Most downloaded'],
    ['updated', 'Recently updated'],
    ['name', 'Name A–Z']
  ];
  const PROJECT_FILTERS = [
    ['all', 'All'],
    ['outdated', 'Outdated'],
    ['vulnerable', 'Security'],
    ['deprecated', 'Deprecated']
  ];
  const FIELD_LABELS = {
    dependencies: 'Dependencies',
    devDependencies: 'Dev dependencies',
    peerDependencies: 'Peer dependencies',
    optionalDependencies: 'Optional dependencies'
  };

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

  function popularityBar(pkg, max) {
    if (!max || typeof pkg.weeklyDownloads !== 'number') return '';
    const width = Math.max(3, Math.round(Math.sqrt(pkg.weeklyDownloads / max) * 100));
    return `<div class="pop" title="Popularity relative to this list"><span style="width:${width}%"></span></div>`;
  }

  function actionsHtml(pkg) {
    if (isScaffold(pkg)) {
      return `<div class="pkg-actions">
        <button class="btn primary" data-act="install" title="Run in a terminal">${icon('terminal')}Run</button>
        <button class="btn icon" data-act="copy" title="Copy command">${icon('copy')}</button>
      </div>`;
    }
    return `<div class="pkg-actions">
      <button class="btn primary" data-act="install" title="Add to dependencies">${icon('add')}Install</button>
      <button class="btn" data-act="install-dev" title="Add to devDependencies">Dev</button>
      <button class="btn icon" data-act="copy" title="Copy install command">${icon('copy')}</button>
    </div>`;
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
    const max = packages.reduce((top, pkg) => Math.max(top, pkg.weeklyDownloads || 0), 0);
    return packages.map((pkg) => cardHtml(pkg, key, packages.length > 1 ? max : 0)).join('');
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

  function currentGroup() {
    return data.groups.find((group) => group.name === ui.group) || data.groups[0] || null;
  }

  function currentCategoryKey(group) {
    const savedKey = ui.categoryByGroup[group.name];
    const valid = group.categories.some((cat) => cat.key === savedKey);
    return valid ? savedKey : group.categories[0].key;
  }

  function groupsHtml(activeGroup) {
    return `<div class="groups" role="tablist" aria-label="Groups">${data.groups
      .map((group) => {
        const active = group === activeGroup;
        return `<button class="group${active ? ' active' : ''}" style="--accent: var(${group.color})" role="tab" aria-selected="${active}" data-act="select-group" data-group="${esc(group.name)}" title="${esc(group.tagline || group.name)}">
          ${icon(group.icon)}<span>${esc(groupLabel(group.name))}</span>
        </button>`;
      })
      .join('')}</div>`;
  }

  function categoriesHtml(group, activeKey) {
    if (group.categories.length < 2) return '';
    const activeIndex = group.categories.findIndex((cat) => cat.key === activeKey);
    const collapsed = !ui.showAllCategories && group.categories.length > CATEGORY_PREVIEW + 1;
    const visible = collapsed
      ? group.categories.filter((cat, index) => index < CATEGORY_PREVIEW || index === activeIndex)
      : group.categories;
    const chips = visible.map((cat) => {
      const active = cat.key === activeKey;
      return `<button class="cat${active ? ' active' : ''}" aria-pressed="${active}" data-act="select-category" data-key="${esc(cat.key)}">${esc(cat.name)}</button>`;
    });
    if (group.categories.length > CATEGORY_PREVIEW + 1) {
      chips.push(
        collapsed
          ? `<button class="cat more" data-act="toggle-categories">+${group.categories.length - visible.length} more</button>`
          : '<button class="cat more" data-act="toggle-categories">Show less</button>'
      );
    }
    return `<div class="cats" style="--accent: var(${group.color})">${chips.join('')}</div>`;
  }

  function discoverHtml() {
    if (data.searchTerm) return searchResultsHtml();
    const group = currentGroup();
    if (!group) return skeletonHtml();
    const key = currentCategoryKey(group);
    return `${groupsHtml(group)}
      <p class="tagline">${esc(group.tagline || '')}</p>
      ${categoriesHtml(group, key)}
      ${toolbarHtml(key)}
      ${categoryBodyHtml(key)}`;
  }

  function searchResultsHtml() {
    return `<div class="search-banner">
        <div class="search-banner-text">
          <span class="muted">Results for</span>
          <b>${esc(data.searchTerm)}</b>
        </div>
        <button class="btn" data-act="clear-search">${icon('arrow-left')}Back to catalog</button>
      </div>
      ${toolbarHtml(data.searchKey)}
      ${categoryBodyHtml(data.searchKey)}`;
  }

  function selectedProject() {
    const projects = (project.data && project.data.projects) || [];
    return projects.find((item) => item.folder === ui.projectFolder) || projects[0] || null;
  }

  function projectHtml() {
    if (!data.hasWorkspace) {
      return emptyHtml('folder-opened', 'No folder open', 'Open a project to check its dependencies for updates and vulnerabilities.');
    }
    if (project.status === 'idle' || (project.status === 'loading' && !project.data)) {
      const progress = project.progress;
      const percent = progress && progress.total ? Math.round((progress.done / progress.total) * 100) : 0;
      return `<div class="progress-card">
          <div class="progress-text">${icon('loading', 'codicon-modifier-spin')}${
            progress && progress.total ? `Checking ${progress.done} of ${progress.total} packages…` : 'Reading package.json…'
          }</div>
          <div class="progress"><span style="width:${percent}%"></span></div>
        </div>${skeletonHtml(4)}`;
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

    const current = selectedProject();
    if (!current) return emptyHtml('package', 'No package.json', '');
    const projects = project.data.projects;
    const summary = current.summary;
    const folderPicker =
      projects.length > 1
        ? `<label class="select wide">${icon('folder')}<select data-act="project-folder" aria-label="Project">${projects
            .map((item) => `<option value="${esc(item.folder)}"${item === current ? ' selected' : ''}>${esc(item.folderName)}</option>`)
            .join('')}</select></label>`
        : '';
    const loadingNote = project.status === 'loading' ? `<span class="muted small">${icon('loading', 'codicon-modifier-spin')}Updating…</span>` : '';

    const tiles = [
      ['all', summary.total, 'Packages', ''],
      ['outdated', summary.outdated, 'Outdated', summary.outdated ? 'warn' : 'ok'],
      ['vulnerable', summary.vulnerable, 'Vulnerable', summary.vulnerable ? 'bad' : 'ok'],
      ['deprecated', summary.deprecated, 'Deprecated', summary.deprecated ? 'bad' : 'ok']
    ]
      .map(
        ([filter, value, label, tone]) =>
          `<button class="tile-stat ${tone}${ui.projectFilter === filter ? ' active' : ''}" data-act="project-filter" data-filter="${filter}">
            <span class="tile-value">${value}</span><span class="tile-label">${label}</span>
          </button>`
      )
      .join('');

    const auditNote = project.data.auditAvailable
      ? ''
      : `<div class="notice">${icon('info')}<div class="notice-body"><span>Security audit is unavailable right now.</span></div></div>`;
    const missingNote = summary.missing
      ? `<div class="notice">${icon('warning')}<div class="notice-body"><span>${summary.missing} package${summary.missing === 1 ? ' is' : 's are'} not installed in node_modules.</span></div></div>`
      : '';

    return `<div class="project-head">
        <div class="project-title">
          <b>${esc(current.name)}</b>${current.version ? `<span class="ver">${esc(current.version)}</span>` : ''}
          <span class="muted small">${esc(current.manager)}</span>
          ${loadingNote}
        </div>
        <button class="btn icon" data-act="open-manifest" data-folder="${esc(current.folder)}" title="Open package.json">${icon('go-to-file')}</button>
        <button class="btn icon" data-act="project-refresh" title="Check again">${icon('refresh')}</button>
      </div>
      ${folderPicker}
      <div class="tiles">${tiles}</div>
      ${auditNote}${missingNote}
      <div class="filter-row">
        <div class="mini-search">${icon('filter')}<input id="projectQuery" type="text" placeholder="Filter dependencies" value="${esc(ui.projectQuery)}" spellcheck="false" aria-label="Filter dependencies"></div>
      </div>
      <div id="projectRows">${projectRowsHtml(current)}</div>`;
  }

  function matchesFilter(dep) {
    if (ui.projectQuery && !dep.name.toLowerCase().includes(ui.projectQuery.toLowerCase())) return false;
    if (ui.projectFilter === 'outdated') return Boolean(dep.update);
    if (ui.projectFilter === 'vulnerable') return dep.advisories.length > 0;
    if (ui.projectFilter === 'deprecated') return Boolean(dep.deprecated);
    return true;
  }

  function depRank(dep) {
    if (dep.advisories.length) return 0;
    if (dep.deprecated) return 1;
    if (dep.update === 'major') return 2;
    if (dep.update) return 3;
    return 4;
  }

  function projectRowsHtml(current) {
    const sections = Object.keys(FIELD_LABELS)
      .map((field) => {
        const deps = current.dependencies
          .filter((dep) => dep.field === field && matchesFilter(dep))
          .sort((a, b) => depRank(a) - depRank(b) || a.name.localeCompare(b.name));
        if (!deps.length) return '';
        const outdated = deps.filter((dep) => dep.update && !dep.local).map((dep) => dep.name);
        const updateAll =
          outdated.length > 1 && field !== 'peerDependencies'
            ? `<button class="btn small" data-act="update-many" data-folder="${esc(current.folder)}" data-names="${esc(outdated.join(' '))}" data-dev="${field === 'devDependencies'}" title="${esc(outdated.join(', '))}">${icon('arrow-up')}Update ${outdated.length}</button>`
            : '';
        return `<section class="dep-section">
          <div class="dep-section-head"><span>${FIELD_LABELS[field]}</span><span class="count">${deps.length}</span>${updateAll}</div>
          ${deps.map((dep) => depRowHtml(dep, current)).join('')}
        </section>`;
      })
      .join('');
    return sections || emptyHtml('pass', ui.projectFilter === 'all' ? 'No matches' : 'All clear', ui.projectFilter === 'all' ? '' : 'Nothing in this filter.');
  }

  function depRowHtml(dep, current) {
    const chips = [];
    if (dep.severity) {
      chips.push(
        `<span class="chip sev-${esc(dep.severity)}" title="${esc(dep.advisories.map((item) => `${item.severity}: ${item.title}`).join('\n'))}">${icon('shield')}${esc(dep.severity)}${
          dep.advisories.length > 1 ? ` ×${dep.advisories.length}` : ''
        }</span>`
      );
    }
    if (dep.deprecated) chips.push(`<span class="chip bad" title="${esc(dep.deprecated)}">${icon('warning')}deprecated</span>`);
    if (dep.update) chips.push(`<span class="chip upd-${esc(dep.update)}">${esc(dep.update)}</span>`);
    if (dep.missing) chips.push('<span class="chip muted-chip" title="Not found in node_modules">not installed</span>');
    if (dep.local) chips.push('<span class="chip muted-chip">local</span>');
    if (dep.error) chips.push(`<span class="chip muted-chip" title="${esc(dep.error)}">unknown</span>`);

    const version = dep.local
      ? `<span class="muted">${esc(dep.range)}</span>`
      : `<span class="v-current" title="Range in package.json: ${esc(dep.range)}">${esc(dep.current || dep.range)}</span>${
          dep.update ? `${icon('arrow-right', 'arrow')}<span class="v-latest upd-${esc(dep.update)}">${esc(dep.latest)}</span>` : ''
        }`;

    const update =
      dep.update && dep.field !== 'peerDependencies'
        ? `<button class="btn small" data-act="update-one" data-folder="${esc(current.folder)}" data-name="${esc(dep.name)}" data-dev="${dep.field === 'devDependencies'}" title="Install ${esc(dep.name)}@latest">${icon('arrow-up')}Update</button>`
        : '';

    return `<div class="dep" tabindex="0" data-act="open-dep" data-name="${esc(dep.name)}" title="${esc(dep.description || dep.name)}">
      <div class="dep-main">
        <div class="dep-name">${esc(dep.name)}</div>
        <div class="dep-version">${version}</div>
        ${chips.length ? `<div class="dep-chips">${chips.join('')}</div>` : ''}
      </div>
      <div class="dep-actions">
        ${update}
        <button class="btn icon" data-act="uninstall" data-folder="${esc(current.folder)}" data-name="${esc(dep.name)}" title="Uninstall">${icon('trash')}</button>
      </div>
    </div>`;
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

    return `<section class="block">
        <div class="block-head"><span>${icon('star-full')}Saved</span><span class="count">${data.favorites.length}</span></div>
        ${favorites}
      </section>
      <section class="block">
        <div class="block-head"><span>${icon('history')}Recently viewed</span>${
          data.recent.length ? '<button class="btn link" data-act="clear-recent">Clear</button>' : ''
        }</div>
        ${recent}
      </section>`;
  }

  function viewsHtml() {
    const summary = (selectedProject() || {}).summary;
    let projectBadge = '';
    if (summary && summary.vulnerable) projectBadge = `<span class="badge bad" title="Vulnerable packages">${summary.vulnerable}</span>`;
    else if (summary && summary.outdated) projectBadge = `<span class="badge warn" title="Outdated packages">${summary.outdated}</span>`;
    const tabs = [
      ['discover', 'compass', 'Discover', ''],
      ['project', 'package', 'Project', projectBadge],
      ['saved', 'star-full', 'Saved', data.favorites.length ? `<span class="badge">${data.favorites.length}</span>` : '']
    ];
    return tabs
      .map(([tab, iconName, label, badge]) => {
        const active = ui.tab === tab;
        return `<button class="view${active ? ' active' : ''}" role="tab" aria-selected="${active}" data-act="tab" data-tab="${tab}">${icon(iconName)}<span>${label}</span>${badge}</button>`;
      })
      .join('');
  }

  function render() {
    const scroll = document.scrollingElement ? document.scrollingElement.scrollTop : 0;
    const focusedQuery = document.activeElement && document.activeElement.id === 'projectQuery';
    views.innerHTML = viewsHtml();

    if (ui.tab === 'project') list.innerHTML = projectHtml();
    else if (ui.tab === 'saved') list.innerHTML = savedHtml();
    else list.innerHTML = discoverHtml();

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
    const group = currentGroup();
    return group ? currentCategoryKey(group) : null;
  }

  function requestActiveCategory() {
    if (ui.tab !== 'discover') return;
    const key = activeKey();
    if (key && !states.has(key)) post({ type: 'openCategory', key });
  }

  function ensureProject() {
    if (ui.tab === 'project' && project.status === 'idle' && data.hasWorkspace) {
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
      case 'select-group':
        ui.group = target.dataset.group;
        persist();
        render();
        requestActiveCategory();
        break;
      case 'select-category': {
        const group = currentGroup();
        if (!group) break;
        ui.categoryByGroup[group.name] = target.dataset.key;
        persist();
        render();
        requestActiveCategory();
        break;
      }
      case 'toggle-categories':
        ui.showAllCategories = !ui.showAllCategories;
        persist();
        render();
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
      case 'open-manifest':
        post({ type: 'openManifest', folder: target.dataset.folder });
        break;
      case 'init-project':
        post({ type: 'initProject' });
        break;
      case 'update-one':
        post({ type: 'updateDeps', folder: target.dataset.folder, names: [target.dataset.name], dev: target.dataset.dev === 'true' });
        break;
      case 'update-many':
        post({ type: 'updateDeps', folder: target.dataset.folder, names: target.dataset.names.split(' '), dev: target.dataset.dev === 'true' });
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
    if (select.dataset.act === 'project-folder') ui.projectFolder = select.value;
    persist();
    render();
  });

  list.addEventListener('input', (event) => {
    if (event.target.id !== 'projectQuery') return;
    ui.projectQuery = event.target.value;
    const current = selectedProject();
    const rows = document.getElementById('projectRows');
    if (current && rows) rows.innerHTML = projectRowsHtml(current);
  });

  list.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    if (event.target.tagName === 'BUTTON' || event.target.tagName === 'INPUT' || event.target.tagName === 'SELECT') return;
    const card = event.target.closest('.pkg');
    const row = event.target.closest('.dep, .recent');
    if (!card && !row) return;
    event.preventDefault();
    if (card) openCard(card);
    else post({ type: 'openPackage', name: row.dataset.name });
  });

  function runSearch(term) {
    const value = term.trim();
    if (!value) return;
    input.value = value;
    closeSuggest();
    ui.tab = 'discover';
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
        if (!data.groups.some((group) => group.name === ui.group)) ui.group = data.groups[0] ? data.groups[0].name : null;
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
        if (ui.tab === 'discover') render();
        break;
      case 'suggestions':
        if (message.seq !== suggest.seq) break;
        suggest.loading = false;
        suggest.term = message.term;
        suggest.items = message.packages;
        renderSuggest();
        break;
      case 'project':
        project.status = message.status;
        project.data = message.data || project.data;
        project.progress = message.progress;
        project.error = message.error;
        render();
        break;
      case 'projectProgress':
        project.progress = message.progress;
        if (ui.tab === 'project' && !project.data) render();
        break;
      case 'showTab':
        setTab(message.tab);
        break;
      case 'focusSearch':
        input.focus();
        input.select();
        break;
    }
  });

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
