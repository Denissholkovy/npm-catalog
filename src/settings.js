const vscode = require('vscode');

function config() {
  return vscode.workspace.getConfiguration('npmCatalog');
}

function clamp(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.round(number)));
}

function getPageSize() {
  return clamp(config().get('pageSize'), 5, 50, 20);
}

function getCacheTtlMs() {
  return clamp(config().get('cacheTtlHours'), 0, 24 * 365, 24) * 60 * 60 * 1000;
}

function getPackageManagerSetting() {
  return config().get('packageManager') || 'auto';
}

module.exports = { getPageSize, getCacheTtlMs, getPackageManagerSetting };
