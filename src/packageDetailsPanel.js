const vscode = require('vscode');

class PackageDetailsPanel {
  static show(pkg, packageService) {
    const panel = new PackageDetailsPanel(pkg, packageService);
    panel._open();
    return panel;
  }

  constructor(pkg, packageService) {
    this.pkg = pkg;
    this.packageService = packageService;
    this.panel = null;
  }

  _open() {
    this.panel = vscode.window.createWebviewPanel(
      'npmPackageDetails',
      this.pkg.name,
      vscode.ViewColumn.One,
      { enableScripts: true }
    );

    this.panel.webview.html = this._renderLoading();
    this.panel.webview.onDidReceiveMessage((message) => this._handleMessage(message));

    this.packageService
      .getPackageDetails(this.pkg.name)
      .then((details) => {
        this.panel.webview.html = this._renderDetails(details);
      })
      .catch((err) => {
        this.panel.webview.html = this._renderDetails({ error: err.message });
      });
  }

  _handleMessage(message) {
    if (message.command === 'install') {
      const terminal =
        vscode.window.activeTerminal || vscode.window.createTerminal('NPM Catalog');
      terminal.show();
      terminal.sendText(this.pkg.install);
    }
  }

  _renderLoading() {
    return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8">
<style>body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 20px; }</style>
</head>
<body>
  <h1>${this.pkg.name}</h1>
  <p>Loading package details…</p>
</body>
</html>`;
  }

  _renderDetails(details) {
    details = details || {};
    const pkg = this.pkg;

    const avatarBlock = details.avatarUrl
      ? `<img src="${details.avatarUrl}" alt="avatar" class="avatar" />`
      : '';

    const statsLine = [
      details.license ? `License: <b>${details.license}</b>` : null,
      typeof details.weeklyDownloads === 'number'
        ? `Weekly downloads: <b>${details.weeklyDownloads.toLocaleString('en-US')}</b>`
        : null,
      typeof details.stars === 'number' ? `⭐ GitHub stars: <b>${details.stars}</b>` : null
    ]
      .filter(Boolean)
      .join(' &nbsp;•&nbsp; ');

    const linksBlock = [
      details.homepage ? `<a href="${details.homepage}" target="_blank">Homepage</a>` : null,
      details.repositoryUrl
        ? `<a href="${details.repositoryUrl}" target="_blank">Repository</a>`
        : null,
      `<a href="${pkg.npmUrl}" target="_blank">npmjs.com</a>`
    ]
      .filter(Boolean)
      .join(' &nbsp;|&nbsp; ');

    const readmeBlock = details.readmeHtml
      ? `<h2 class="section-title">README</h2><div class="readme">${details.readmeHtml}</div>`
      : details.error
      ? `<p class="error">Failed to load full package details: ${details.error}</p>`
      : '';

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<style>${this._styles()}</style>
</head>
<body>
  <div class="header">
    ${avatarBlock}
    <div>
      <h1>${pkg.name}</h1>
      ${pkg.version ? `<div class="version">version ${pkg.version}</div>` : ''}
    </div>
  </div>

  <div class="desc">${pkg.description}</div>
  ${statsLine ? `<div class="stats">${statsLine}</div>` : ''}
  <div class="links">${linksBlock}</div>

  <p>Install command: <code>${pkg.install}</code></p>
  <button id="installBtn">Install</button>

  ${readmeBlock}

  <script>
    const vscode = acquireVsCodeApi();
    document.getElementById('installBtn').addEventListener('click', () => {
      vscode.postMessage({ command: 'install' });
    });
  </script>
</body>
</html>`;
  }

  _styles() {
    return `
  body {
    font-family: var(--vscode-font-family);
    color: var(--vscode-foreground);
    padding: 20px;
    max-width: 800px;
  }
  .header { display: flex; align-items: center; gap: 14px; }
  .avatar { width: 56px; height: 56px; border-radius: 8px; }
  h1 { margin: 0; }
  .version { opacity: 0.6; font-size: 13px; }
  .desc { margin: 16px 0; line-height: 1.5; }
  .stats { opacity: 0.85; margin: 8px 0 16px 0; font-size: 13px; }
  .links { margin-bottom: 16px; }

  code {
    font-family: var(--vscode-editor-font-family, Consolas, monospace);
    background: #1e1e1e;
    color: #9cdcfe;
    padding: 2px 6px;
    border-radius: 4px;
    font-size: 13px;
  }

  pre {
    background: #1e1e1e;
    color: #d4d4d4;
    padding: 14px;
    border-radius: 6px;
    overflow-x: auto;
    font-family: var(--vscode-editor-font-family, Consolas, monospace);
    font-size: 13px;
    line-height: 1.5;
  }
  pre code { background: transparent; color: inherit; padding: 0; }

  .tok-keyword { color: #569cd6; }
  .tok-string { color: #ce9178; }
  .tok-comment { color: #6a9955; font-style: italic; }
  .tok-number { color: #b5cea9; }

  button {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border: none;
    padding: 8px 16px;
    border-radius: 4px;
    cursor: pointer;
    font-size: 14px;
    margin: 10px 0;
  }
  button:hover { background: var(--vscode-button-hoverBackground); }
  a { color: var(--vscode-textLink-foreground); }
  .section-title { border-top: 1px solid var(--vscode-panel-border); padding-top: 16px; margin-top: 24px; }
  .readme img { max-width: 100%; }
  .error { color: var(--vscode-errorForeground); }
`;
  }
}

module.exports = { PackageDetailsPanel };
