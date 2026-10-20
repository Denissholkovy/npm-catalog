const MANAGERS = ['npm', 'yarn', 'pnpm', 'bun'];

const INSTALL = {
  npm: (name, dev) => `npm install ${dev ? '-D ' : ''}${name}`,
  yarn: (name, dev) => `yarn add ${dev ? '-D ' : ''}${name}`,
  pnpm: (name, dev) => `pnpm add ${dev ? '-D ' : ''}${name}`,
  bun: (name, dev) => `bun add ${dev ? '-d ' : ''}${name}`
};

const EXEC = {
  npm: (name) => `npx ${name}@latest`,
  yarn: (name) => `yarn dlx ${name}@latest`,
  pnpm: (name) => `pnpm dlx ${name}@latest`,
  bun: (name) => `bunx ${name}@latest`
};

const CREATE = {
  npm: (shortName) => `npm create ${shortName}@latest`,
  yarn: (shortName) => `yarn create ${shortName}`,
  pnpm: (shortName) => `pnpm create ${shortName}@latest`,
  bun: (shortName) => `bun create ${shortName}`
};

function isScaffold(installType) {
  return installType === 'npx' || installType === 'npm-create';
}

function buildCommand({ name, installType, manager, dev }) {
  const pm = MANAGERS.includes(manager) ? manager : 'npm';
  switch (installType) {
    case 'npx':
      return EXEC[pm](name);
    case 'npm-create':
      return CREATE[pm](name.replace(/^create-/, ''));
    default:
      return INSTALL[pm](name, Boolean(dev));
  }
}

module.exports = { MANAGERS, buildCommand, isScaffold };
