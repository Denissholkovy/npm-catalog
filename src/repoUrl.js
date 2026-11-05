function repoUrlOf(repo) {
  if (!repo) return null;
  const url = typeof repo === 'string' ? repo : repo.url;
  return url ? String(url).trim() : null;
}

function normalizeRepoUrl(repo) {
  const url = repoUrlOf(repo);
  if (!url) return null;

  if (/^github:/.test(url)) return `https://github.com/${url.slice('github:'.length)}`;
  if (/^[\w.-]+\/[\w.-]+$/.test(url)) return `https://github.com/${url}`;

  return url
    .replace(/^git\+/, '')
    .replace(/^git@([^:]+):/, 'https://$1/')
    .replace(/^(?:git|ssh):\/\/(?:git@)?/, 'https://')
    .replace(/\.git$/, '');
}

function parseGithubRepo(repo) {
  const normalized = normalizeRepoUrl(repo);
  if (!normalized) return null;
  const match = normalized.match(/^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/#?]+)/);
  if (!match) return null;
  return { owner: match[1], repo: match[2] };
}

function releaseNotesUrl(repo) {
  const github = parseGithubRepo(repo);
  if (github) return `https://github.com/${github.owner}/${github.repo}/releases`;
  return normalizeRepoUrl(repo);
}

module.exports = { normalizeRepoUrl, parseGithubRepo, releaseNotesUrl };
