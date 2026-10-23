(function () {
  const vscode = acquireVsCodeApi();
  const install = document.querySelector('.install');
  const commandEl = document.getElementById('command');
  const commands = install ? JSON.parse(install.dataset.commands || '{}') : {};
  const devCommands = install ? JSON.parse(install.dataset.devCommands || '{}') : {};
  const saved = vscode.getState() || {};
  let manager = saved.manager && commands[saved.manager] ? saved.manager : install ? install.dataset.pm : 'npm';

  function post(message) {
    vscode.postMessage(message);
  }

  function setManager(next) {
    manager = next;
    vscode.setState({ ...(vscode.getState() || {}), manager });
    document.querySelectorAll('.seg[data-pm]').forEach((button) => {
      button.classList.toggle('active', button.dataset.pm === manager);
    });
    if (commandEl) commandEl.textContent = commands[manager];
  }

  function versionCommand(version) {
    const base = commands[manager] || '';
    return `${base}@${version}`;
  }

  function flash(button) {
    const original = button.innerHTML;
    button.innerHTML = '<span class="codicon codicon-check" aria-hidden="true"></span>';
    button.classList.add('done');
    setTimeout(() => {
      button.innerHTML = original;
      button.classList.remove('done');
    }, 1200);
  }

  function selectTab(name) {
    document.querySelectorAll('.tab').forEach((tab) => {
      const active = tab.dataset.tab === name;
      tab.classList.toggle('active', active);
      tab.setAttribute('aria-selected', String(active));
    });
    document.querySelectorAll('.panel').forEach((panel) => {
      panel.classList.toggle('active', panel.dataset.panel === name);
    });
  }

  document.addEventListener('click', (event) => {
    const pm = event.target.closest('.seg[data-pm]');
    if (pm) {
      setManager(pm.dataset.pm);
      return;
    }

    const tab = event.target.closest('.tab[data-tab]');
    if (tab) {
      selectTab(tab.dataset.tab);
      return;
    }

    const button = event.target.closest('[data-command]');
    if (!button) return;
    const command = button.dataset.command;

    switch (command) {
      case 'install':
        post({ command, dev: button.dataset.dev === 'true', version: button.dataset.version, manager });
        break;
      case 'copy':
        post({ command: 'copy', text: commands[manager] });
        flash(button);
        break;
      case 'copy-version':
        post({ command: 'copy', text: versionCommand(button.dataset.version) });
        flash(button);
        break;
      case 'update':
        post({ command, dev: button.dataset.dev === 'true' });
        break;
      case 'open':
        post({ command, name: button.dataset.name });
        break;
      default:
        post({ command });
    }
  });

  document.addEventListener('mouseover', (event) => {
    const segment = event.target.closest('[data-command="install"][data-dev="true"]');
    if (segment && commandEl && devCommands[manager]) commandEl.textContent = devCommands[manager];
  });

  document.addEventListener('mouseout', (event) => {
    const segment = event.target.closest('[data-command="install"][data-dev="true"]');
    if (segment && commandEl) commandEl.textContent = commands[manager];
  });

  const showPre = document.getElementById('showPre');
  if (showPre) {
    showPre.addEventListener('change', () => {
      document.querySelector('table.versions').classList.toggle('hide-pre', !showPre.checked);
    });
  }

  const chart = document.querySelector('.chart');
  if (chart) {
    const series = JSON.parse(chart.dataset.series || '[]');
    const tip = chart.querySelector('.chart-tip');
    const cursor = chart.querySelector('.chart-cursor');
    const svg = chart.querySelector('svg');
    const numbers = new Intl.NumberFormat('en-US');

    svg.addEventListener('mousemove', (event) => {
      const rect = svg.getBoundingClientRect();
      const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
      const index = Math.round(ratio * (series.length - 1));
      const [start, count] = series[index];
      const date = new Date(start).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
      const x = (index / (series.length - 1)) * rect.width;
      tip.textContent = `${numbers.format(count)} · week of ${date}`;
      tip.hidden = false;
      cursor.hidden = false;
      cursor.style.left = `${x}px`;
      const tipWidth = tip.offsetWidth;
      tip.style.left = `${Math.min(Math.max(0, x - tipWidth / 2), rect.width - tipWidth)}px`;
    });

    svg.addEventListener('mouseleave', () => {
      tip.hidden = true;
      cursor.hidden = true;
    });
  }

  window.addEventListener('message', (event) => {
    const message = event.data;
    if (message.type === 'bundle') {
      const min = document.getElementById('bundleMin');
      const gzip = document.getElementById('bundleGzip');
      if (!min || !gzip) return;
      if (message.bundle) {
        min.textContent = message.bundle.min;
        gzip.textContent = message.bundle.gzip;
        min.classList.remove('dim');
        gzip.classList.remove('dim');
        if (message.bundle.treeShakeable) gzip.title = 'Tree-shakeable (ES modules)';
      } else {
        min.textContent = 'unavailable';
        gzip.textContent = 'unavailable';
      }
    } else if (message.type === 'user') {
      const star = document.getElementById('favorite');
      if (star) {
        star.classList.toggle('active', message.favorite);
        star.title = message.favorite ? 'Remove from saved' : 'Save';
        star.innerHTML = `<span class="codicon codicon-${message.favorite ? 'star-full' : 'star-empty'}" aria-hidden="true"></span>`;
      }
      const status = document.getElementById('projectStatus');
      if (status) status.innerHTML = message.projectHtml;
    }
  });

  setManager(manager);
})();
