const VERSION_PATTERN = /(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/;
const LOCAL_RANGE_PATTERN = /^(?:workspace:|file:|link:|portal:|git\+|git:|github:|https?:|npm:|[\w.-]+\/[\w.-]+(?:#.*)?$)/;

function parse(version) {
  const match = String(version || '').match(VERSION_PATTERN);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] || null,
    raw: match[0]
  };
}

function compare(left, right) {
  const a = typeof left === 'string' ? parse(left) : left;
  const b = typeof right === 'string' ? parse(right) : right;
  if (!a || !b) return 0;
  for (const part of ['major', 'minor', 'patch']) {
    if (a[part] !== b[part]) return a[part] > b[part] ? 1 : -1;
  }
  if (a.prerelease === b.prerelease) return 0;
  if (!a.prerelease) return 1;
  if (!b.prerelease) return -1;
  return a.prerelease > b.prerelease ? 1 : -1;
}

function diff(current, latest) {
  const a = parse(current);
  const b = parse(latest);
  if (!a || !b || compare(a, b) >= 0) return null;
  if (a.major !== b.major) return 'major';
  if (a.minor !== b.minor) return 'minor';
  if (a.patch !== b.patch) return 'patch';
  return 'prerelease';
}

function minVersion(range) {
  const parsed = parse(range);
  return parsed ? parsed.raw : null;
}

function isLocalRange(range) {
  return LOCAL_RANGE_PATTERN.test(String(range || '').trim());
}

function isPrerelease(version) {
  const parsed = parse(version);
  return Boolean(parsed && parsed.prerelease);
}

module.exports = { parse, compare, diff, minVersion, isLocalRange, isPrerelease };
