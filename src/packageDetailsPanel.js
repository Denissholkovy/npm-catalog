const vscode = require('vscode');
const crypto = require('crypto');
const { escapeText, escapeAttr, safeHttpUrl } = require('./htmlUtils');
const { isScaffold } = require('./installCommand');

const VIEW_TYPE = 'npmPackageDetails';
const ACTIONS = new Set(['install', 'copy']);

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

class PackageDetailsPanel {
  static show(pkg, packageService, handlers) {
    if (PackageDetailsPanel.current) {
      PackageDetailsPanel.current.panel.reveal(undefined, true);
      PackageDetailsPanel.current.update(pkg);
      return PackageDetailsPanel.current;
    }
    PackageDetailsPanel.current = new PackageDetailsPanel(pkg, packageService, handlers);
    return PackageDetailsPanel.current;
  }

  constructor(pkg, packageService, handlers) {
    this.pkg = pkg;
    this.packageService = packageService;
    this.handlers = handlers;
    this.disposed = false;
    this.requestId = 0;

    this.panel = vscode.window.createWebviewPanel(VIEW_TYPE, pkg.name, vscode.ViewColumn.One, {
      enableScripts: true,
      localResourceRoots: []
    });

    this.panel.onDidDispose(() => {
      this.disposed = true;
      if (PackageDetailsPanel.current === this) PackageDetailsPanel.current = null;
    });
    this.panel.webview.onDidReceiveMessage((message) => this._handleMessage(message));

    this.update(pkg);
  }

  async update(pkg) {
    this.pkg = pkg;
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
    this.panel.webview.html = this._renderDetails(details);
  }

  _handleMessage(message) {
    if (!message || !ACTIONS.has(message.command)) return;
    const dev = message.dev === true;
    if (message.command === 'install') this.handlers.install(this.pkg, dev);
    else this.handlers.copy(this.pkg, dev);
  }

  _page(body, nonce) {
    const csp = [
      "default-src 'none'",
      'img-src https: data:',
      `style-src 'nonce-${nonce}'`,
      `script-src 'nonce-${nonce}'`
    ].join('; ');

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style nonce="${nonce}">${this._styles()}</style>
</head>
<body>
${body}
</body>
</html>`;
  }

  _renderLoading() {
    const nonce = crypto.randomBytes(16).toString('base64');
    return this._page(
      `<h1>${escapeText(this.pkg.name)}</h1>
  <div class="skeleton wide"></div>
  <div class="skeleton"></div>
  <div class="skeleton wide"></div>`,
      nonce
    );
  }

  _renderDetails(details) {
    const nonce = crypto.randomBytes(16).toString('base64');
    const pkg = this.pkg;
    const scaffold = isScaffold(pkg.installType);

    const logo = details.avatarUrl
      ? `<img src="${escapeAttr(details.avatarUrl)}" alt="" class="logo">`
      : `<div class="logo placeholder">${escapeText(pkg.name.replace(/^@/, '').charAt(0).toUpperCase())}</div>`;

    const badges = [
      pkg.version ? `<span class="badge primary">v${escapeText(pkg.version)}</span>` : '',
      details.license ? `<span class="badge">${escapeText(details.license)}</span>` : '',
      details.hasTypes ? '<span class="badge">TypeScript</span>' : ''
    ].join('');

    const links = [
      ['Homepage', safeHttpUrl(details.homepage)],
      ['Repository', safeHttpUrl(details.repositoryUrl)],
      ['npm', safeHttpUrl(pkg.npmUrl)]
    ]
      .filter(([, url]) => url)
      .map(
        ([label, url]) =>
          `<a class="link-chip" href="${escapeAttr(url)}" target="_blank" rel="noopener noreferrer">${label} ↗</a>`
      )
      .join('');

    const deprecatedBlock = details.deprecated
      ? `<div class="callout warning"><b>Deprecated.</b> ${escapeText(
          typeof details.deprecated === 'string' ? details.deprecated : 'This version is deprecated.'
        )}</div>`
      : '';

    const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });
    const cards = [
      typeof details.weeklyDownloads === 'number'
        ? [compact.format(details.weeklyDownloads), 'downloads / week']
        : null,
      typeof details.stars === 'number' ? [compact.format(details.stars), 'GitHub stars'] : null,
      formatDate(details.lastPublish) ? [formatDate(details.lastPublish), 'last published'] : null,
      formatBytes(details.unpackedSize) ? [formatBytes(details.unpackedSize), 'unpacked size'] : null,
      typeof details.dependenciesCount === 'number' ? [String(details.dependenciesCount), 'dependencies'] : null,
      typeof details.versionsCount === 'number' ? [String(details.versionsCount), 'versions'] : null
    ]
      .filter(Boolean)
      .map(
        ([value, label]) =>
          `<div class="card"><div class="card-value">${escapeText(value)}</div><div class="card-label">${escapeText(label)}</div></div>`
      )
      .join('');

    const keywords =
      details.keywords && details.keywords.length
        ? `<div class="keywords">${details.keywords
            .map((keyword) => `<span class="chip">${escapeText(keyword)}</span>`)
            .join('')}</div>`
        : '';

    const readmeBlock = details.readmeHtml
      ? `<h2 class="section-title">README</h2><div class="readme">${details.readmeHtml}</div>`
      : details.error
      ? `<div class="callout error">Failed to load full package details: ${escapeText(details.error)}</div>`
      : '';

    const command = this.handlers.command(pkg, false);
    const scaffoldNote = scaffold
      ? '<div class="hint">Runs an interactive generator — follow the prompts in the terminal.</div>'
      : '';
    const actions = scaffold
      ? '<button data-action="install">Run in terminal</button>'
      : `<button data-action="install">Install</button>
         <button data-action="install" data-dev="true" class="secondary">Install as devDependency</button>`;

    return this._page(
      `<header class="hero">
    ${logo}
    <div class="hero-main">
      <div class="title-row"><h1>${escapeText(pkg.name)}</h1>${badges}</div>
      <p class="desc">${escapeText(pkg.description)}</p>
      <div class="link-row">${links}</div>
    </div>
  </header>

  ${deprecatedBlock}

  <section class="install">
    <div class="install-title">${scaffold ? 'Run' : 'Install'}</div>
    <div class="command"><code>${escapeText(command)}</code>
      <button data-action="copy" class="ghost" title="Copy command">Copy</button>
    </div>
    <div class="actions">${actions}</div>
    ${scaffoldNote}
  </section>

  ${cards ? `<section class="cards">${cards}</section>` : ''}
  ${keywords}
  ${readmeBlock}

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    document.querySelectorAll('button[data-action]').forEach((button) => {
      button.addEventListener('click', () => {
        vscode.postMessage({
          command: button.dataset.action,
          dev: button.dataset.dev === 'true'
        });
        if (button.dataset.action === 'copy') {
          const original = button.textContent;
          button.textContent = 'Copied ✓';
          setTimeout(() => (button.textContent = original), 1500);
        }
      });
    });
  </script>`,
      nonce
    );
  }

  _styles() {
    return `
  * { box-sizing: border-box; }
  body {
    font-family: var(--vscode-font-family);
    color: var(--vscode-foreground);
    padding: 28px 32px 48px;
    max-width: 900px;
    margin: 0 auto;
    line-height: 1.55;
  }
  h1 { margin: 0; font-size: 26px; }
  a { color: var(--vscode-textLink-foreground); }

  .hero { display: flex; gap: 18px; align-items: flex-start; }
  .logo { width: 64px; height: 64px; border-radius: 12px; flex: none; object-fit: cover; }
  .logo.placeholder {
    display: flex; align-items: center; justify-content: center;
    font-size: 28px; font-weight: 700;
    background: var(--vscode-badge-background);
    color: var(--vscode-badge-foreground);
  }
  .hero-main { min-width: 0; }
  .title-row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
  .desc { margin: 8px 0 12px; font-size: 14px; opacity: 0.9; }
  .badge {
    border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border));
    border-radius: 999px;
    padding: 1px 10px;
    font-size: 12px;
  }
  .badge.primary {
    background: var(--vscode-badge-background);
    color: var(--vscode-badge-foreground);
    border-color: transparent;
  }
  .link-row { display: flex; flex-wrap: wrap; gap: 8px; }
  .link-chip {
    text-decoration: none;
    border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border));
    border-radius: 6px;
    padding: 3px 10px;
    font-size: 13px;
  }
  .link-chip:hover { background: var(--vscode-toolbar-hoverBackground); }

  .install {
    margin: 24px 0;
    padding: 16px 18px;
    border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border));
    border-radius: 10px;
    background: var(--vscode-editorWidget-background, transparent);
  }
  .install-title { font-size: 12px; text-transform: uppercase; letter-spacing: 0.06em; opacity: 0.65; margin-bottom: 8px; }
  .command {
    display: flex; align-items: center; justify-content: space-between; gap: 12px;
    background: var(--vscode-textCodeBlock-background);
    border-radius: 6px;
    padding: 6px 6px 6px 14px;
  }
  .command code { background: transparent; padding: 0; font-size: 14px; overflow-x: auto; white-space: nowrap; }
  .actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
  .hint { margin-top: 10px; font-size: 13px; opacity: 0.75; }

  button {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border: none;
    padding: 7px 16px;
    border-radius: 4px;
    cursor: pointer;
    font-size: 13px;
    font-family: inherit;
  }
  button:hover { background: var(--vscode-button-hoverBackground); }
  button.secondary {
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
  }
  button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
  button.ghost {
    background: transparent;
    color: var(--vscode-foreground);
    border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border));
    padding: 4px 12px;
  }
  button.ghost:hover { background: var(--vscode-toolbar-hoverBackground); }
  button:focus-visible, a:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }

  .cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 12px; margin-bottom: 20px; }
  .card { border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border)); border-radius: 10px; padding: 12px 14px; }
  .card-value { font-size: 18px; font-weight: 600; }
  .card-label { font-size: 12px; opacity: 0.65; }

  .keywords { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 8px; }
  .chip {
    background: var(--vscode-badge-background);
    color: var(--vscode-badge-foreground);
    border-radius: 10px;
    padding: 1px 9px;
    font-size: 12px;
  }

  .callout {
    border-left: 3px solid var(--vscode-textLink-foreground);
    background: var(--vscode-textBlockQuote-background);
    padding: 10px 14px;
    border-radius: 0 6px 6px 0;
    margin: 16px 0;
  }
  .callout.warning { border-color: var(--vscode-editorWarning-foreground); }
  .callout.error { border-color: var(--vscode-errorForeground); color: var(--vscode-errorForeground); }

  code {
    font-family: var(--vscode-editor-font-family, Consolas, monospace);
    background: var(--vscode-textCodeBlock-background);
    padding: 2px 6px;
    border-radius: 4px;
    font-size: 13px;
  }
  pre {
    background: var(--vscode-textCodeBlock-background);
    padding: 14px;
    border-radius: 8px;
    overflow-x: auto;
    line-height: 1.5;
  }
  pre code { background: transparent; padding: 0; }
  .tok-keyword { color: var(--vscode-symbolIcon-keywordForeground, #569cd6); }
  .tok-string { color: var(--vscode-symbolIcon-stringForeground, #ce9178); }
  .tok-comment { color: var(--vscode-descriptionForeground); font-style: italic; }
  .tok-number { color: var(--vscode-symbolIcon-numberForeground, #b5cea9); }

  .section-title {
    border-top: 1px solid var(--vscode-widget-border, var(--vscode-panel-border));
    padding-top: 20px;
    margin-top: 28px;
  }
  .readme { overflow-wrap: anywhere; }
  .readme img { max-width: 100%; }
  .readme table { border-collapse: collapse; margin: 12px 0; display: block; overflow-x: auto; }
  .readme th, .readme td { border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border)); padding: 4px 10px; text-align: left; }
  .readme blockquote {
    margin: 12px 0;
    padding: 2px 14px;
    border-left: 3px solid var(--vscode-textBlockQuote-border);
    background: var(--vscode-textBlockQuote-background);
  }
  .readme li.depth-1 { margin-left: 18px; }
  .readme li.depth-2 { margin-left: 36px; }
  .readme li.depth-3 { margin-left: 54px; }

  .skeleton {
    height: 14px; width: 50%; margin: 14px 0; border-radius: 4px;
    background: var(--vscode-textBlockQuote-background);
    animation: pulse 1.2s ease-in-out infinite;
  }
  .skeleton.wide { width: 80%; }
  @keyframes pulse { 50% { opacity: 0.4; } }
`;
  }
}

PackageDetailsPanel.current = null;

module.exports = { PackageDetailsPanel };
