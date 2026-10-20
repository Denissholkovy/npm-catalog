(function () {
  const vscode = acquireVsCodeApi();
  const saved = vscode.getState() || {};
  const ui = {
    group: saved.group || null,
    categoryByGroup: saved.categoryByGroup || {}
  };
  const data = {
    groups: [],
    favorites: [],
    installed: new Set(),
    history: [],
    searchTerm: null,
    searchKey: null
  };
  const states = new Map();
  const FAVORITES_KEY = 'favorites';

  const list = document.getElementById('list');
  const form = document.getElementById('searchForm');
  const input = document.getElementById('searchInput');
  const historyList = document.getElementById('searchHistory');

  function persist() {
    vscode.setState({ group: ui.group, categoryByGroup: ui.categoryByGroup });
  }

  function esc(value) {
    return String(value).replace(/[&<>"']/g, (char) => {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char];
    });
  }

  function chevron(open) {
    return `<span class="chevron${open ? ' open' : ''}" aria-hidden="true">›</span>`;
  }

  const TILE_COLORS = ['blue', 'green', 'orange', 'purple', 'red', 'yellow'];

  function tileColor(name) {
    let hash = 0;
    for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
    return `--vscode-charts-${TILE_COLORS[hash % TILE_COLORS.length]}`;
  }

  function monogram(name) {
    const letters = name.replace(/^@[^/]*\//, '').replace(/[^a-zA-Z0-9]/g, '');
    return (letters.charAt(0) || name.charAt(0) || '?').toUpperCase();
  }

  function cardHtml(pkg, key) {
    const installed = data.installed.has(pkg.name);
    const favorite = data.favorites.some((item) => item.name === pkg.name);
    return `<article class="card" tabindex="0" role="button" style="--tile: var(${tileColor(pkg.name)})" data-key="${esc(key)}" data-name="${esc(pkg.name)}">
      <div class="card-head">
        <span class="tile" aria-hidden="true">${esc(monogram(pkg.name))}</span>
        <div class="card-title">
          <span class="card-name">${esc(pkg.name)}</span>
          <span class="card-meta">
            ${pkg.version ? `<span class="card-version">v${esc(pkg.version)}</span>` : ''}
            ${installed ? '<span class="pill ok">✓ installed</span>' : ''}
          </span>
        </div>
        <button class="btn icon star${favorite ? ' active' : ''}" data-act="favorite" title="${favorite ? 'Remove from favorites' : 'Add to favorites'}" aria-pressed="${favorite}">${favorite ? '★' : '☆'}</button>
      </div>
      <p class="card-desc">${esc(pkg.description || '')}</p>
      <div class="card-actions">
        <button class="btn primary" data-act="install" title="Install into your project">Install</button>
        <button class="btn" data-act="copy" title="Copy install command">Copy command</button>
      </div>
    </article>`;
  }

  function skeletonHtml() {
    return '<div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div>';
  }

  function groupLabel(name) {
    return name.replace(/\s*\(.*?\)\s*/g, '').trim();
  }

  function currentGroup() {
    return data.groups.find((group) => group.name === ui.group) || null;
  }

  function currentCategoryKey(group) {
    const saved = ui.categoryByGroup[group.name];
    const valid = group.categories.some((cat) => cat.key === saved);
    return valid ? saved : group.categories[0].key;
  }

  function categoryBodyHtml(key, emptyMessage) {
    const state = states.get(key);
    if (!state) return skeletonHtml();

    const cards = state.packages.map((pkg) => cardHtml(pkg, key)).join('');
    let footer = '';

    if (state.status === 'loading') {
      footer = state.packages.length ? '<div class="status">Loading…</div>' : skeletonHtml();
    } else if (state.status === 'error') {
      footer = `<div class="error-box">
        <div>Failed to load: ${esc(state.error || 'unknown error')}</div>
        <button class="btn primary" data-act="load-more" data-key="${esc(key)}">Try again</button>
      </div>`;
    } else if (!state.packages.length) {
      footer = `<div class="empty">${esc(emptyMessage || 'No packages found')}</div>`;
    } else if (state.hasMore) {
      footer = `<button class="btn wide" data-act="load-more" data-key="${esc(key)}">Load more</button>`;
    }

    return cards + footer;
  }

  function tabsHtml() {
    const tabs = data.groups.map((group) => {
      const active = group.name === ui.group;
      return `<button class="tab${active ? ' active' : ''}" style="--accent: var(${group.color})" role="tab" aria-selected="${active}" data-act="select-group" data-group="${esc(group.name)}" title="${esc(group.name)}">
        <span aria-hidden="true">${group.icon}</span>${esc(groupLabel(group.name))}
      </button>`;
    });

    if (data.favorites.length || ui.group === FAVORITES_KEY) {
      const active = ui.group === FAVORITES_KEY;
      tabs.unshift(`<button class="tab${active ? ' active' : ''}" style="--accent: var(--vscode-charts-yellow)" role="tab" aria-selected="${active}" data-act="select-group" data-group="${FAVORITES_KEY}">
        <span aria-hidden="true">⭐</span>Favorites<span class="count">${data.favorites.length}</span>
      </button>`);
    }
    return `<nav class="tabs" role="tablist">${tabs.join('')}</nav>`;
  }

  function sectionHeadHtml(title, subtitle, key) {
    const state = key ? states.get(key) : null;
    const refresh =
      state && state.status !== 'loading'
        ? `<button class="btn icon" data-act="refresh-category" data-key="${esc(key)}" title="Reload from npm">↻</button>`
        : '';
    return `<div class="section-head">
      <div class="section-text">
        <div class="section-title">${esc(title)}</div>
        ${subtitle ? `<div class="section-sub">${esc(subtitle)}</div>` : ''}
      </div>
      ${refresh}
    </div>`;
  }

  function countText(key) {
    const state = states.get(key);
    if (!state || !state.packages.length) return '';
    return `${state.packages.length} package${state.packages.length === 1 ? '' : 's'}${state.hasMore ? '+' : ''}`;
  }

  function searchViewHtml() {
    return `<div class="search-banner">
        <span>Results for <b>“${esc(data.searchTerm)}”</b></span>
        <button class="btn" data-act="clear-search">Clear</button>
      </div>
      <div class="cards">${categoryBodyHtml(data.searchKey)}</div>`;
  }

  function favoritesViewHtml() {
    const cards = data.favorites.map((pkg) => cardHtml(pkg, FAVORITES_KEY)).join('');
    return `${sectionHeadHtml('Favorites', `${data.favorites.length} saved`, null)}
      <div class="cards">${cards || '<div class="empty">Tap ☆ on any package to keep it here.</div>'}</div>`;
  }

  function browseViewHtml(group) {
    const key = currentCategoryKey(group);
    const options = group.categories
      .map((cat) => `<option value="${esc(cat.key)}"${cat.key === key ? ' selected' : ''}>${esc(cat.name)}</option>`)
      .join('');
    const category = group.categories.find((cat) => cat.key === key);

    return `<label class="picker" style="--accent: var(${group.color})">
        <span class="picker-label">Category</span>
        <select data-act="select-category" aria-label="Category">${options}</select>
      </label>
      ${sectionHeadHtml(category.name, countText(key), key)}
      <div class="cards">${categoryBodyHtml(key)}</div>`;
  }

  function render() {
    const scroll = document.scrollingElement ? document.scrollingElement.scrollTop : 0;
    let content;

    if (data.searchTerm) {
      content = searchViewHtml();
    } else if (ui.group === FAVORITES_KEY) {
      content = tabsHtml() + favoritesViewHtml();
    } else {
      const group = currentGroup();
      content = group ? tabsHtml() + browseViewHtml(group) : '';
    }

    list.innerHTML = content;
    if (document.scrollingElement) document.scrollingElement.scrollTop = scroll;
    historyList.innerHTML = data.history.map((term) => `<option value="${esc(term)}"></option>`).join('');
  }

  function activeKey() {
    if (data.searchTerm) return data.searchKey;
    const group = currentGroup();
    return group ? currentCategoryKey(group) : null;
  }

  function requestActiveCategory() {
    const key = activeKey();
    if (key && !states.has(key)) vscode.postMessage({ type: 'openCategory', key });
  }

  function handleAction(target) {
    const act = target.dataset.act;
    const card = target.closest('.card');
    const key = target.dataset.key || (card && card.dataset.key);

    switch (act) {
      case 'select-group':
        ui.group = target.dataset.group;
        persist();
        render();
        requestActiveCategory();
        break;
      case 'load-more':
        vscode.postMessage({ type: 'loadMore', key });
        break;
      case 'refresh-category':
        vscode.postMessage({ type: 'refreshCategory', key });
        break;
      case 'clear-search':
        vscode.postMessage({ type: 'clearSearch' });
        break;
      case 'install':
      case 'copy':
        vscode.postMessage({ type: act, key, name: card.dataset.name });
        break;
      case 'favorite':
        vscode.postMessage({ type: 'toggleFavorite', key, name: card.dataset.name });
        break;
    }
  }

  list.addEventListener('change', (event) => {
    const select = event.target.closest('select[data-act="select-category"]');
    const group = currentGroup();
    if (!select || !group) return;
    ui.categoryByGroup[group.name] = select.value;
    persist();
    render();
    requestActiveCategory();
  });

  list.addEventListener('click', (event) => {
    const actionTarget = event.target.closest('[data-act]');
    if (actionTarget) {
      event.stopPropagation();
      handleAction(actionTarget);
      return;
    }
    const card = event.target.closest('.card');
    if (card) {
      vscode.postMessage({ type: 'openPackage', key: card.dataset.key, name: card.dataset.name });
    }
  });

  list.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.target.tagName === 'BUTTON') return;
    const card = event.target.closest('.card');
    if (card) {
      vscode.postMessage({ type: 'openPackage', key: card.dataset.key, name: card.dataset.name });
    }
  });

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const term = input.value.trim();
    if (term) vscode.postMessage({ type: 'search', term });
  });

  input.addEventListener('search', () => {
    if (!input.value && data.searchTerm) vscode.postMessage({ type: 'clearSearch' });
  });

  window.addEventListener('message', (event) => {
    const message = event.data;
    switch (message.type) {
      case 'init':
        states.clear();
        data.groups = message.groups;
        data.favorites = message.favorites;
        data.installed = new Set(message.installed);
        data.history = message.history;
        data.searchTerm = message.searchTerm;
        data.searchKey = message.searchKey;
        if (!data.searchTerm) input.value = '';
        if (!currentGroup() && ui.group !== FAVORITES_KEY) ui.group = data.groups[0] ? data.groups[0].name : null;
        render();
        requestActiveCategory();
        break;
      case 'userdata':
        data.favorites = message.favorites;
        data.installed = new Set(message.installed);
        data.history = message.history;
        render();
        break;
      case 'category':
        states.set(message.key, {
          status: message.status,
          packages: message.packages,
          hasMore: message.hasMore,
          error: message.error
        });
        render();
        break;
      case 'focusSearch':
        input.focus();
        input.select();
        break;
    }
  });

  vscode.postMessage({ type: 'ready' });
})();
