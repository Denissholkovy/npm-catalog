const MANAGERS = ['npm', 'yarn', 'pnpm', 'bun'];

const INSTALL = {
  npm: (spec, dev) => `npm install ${dev ? '-D ' : ''}${spec}`,
  yarn: (spec, dev) => `yarn add ${dev ? '-D ' : ''}${spec}`,
  pnpm: (spec, dev) => `pnpm add ${dev ? '-D ' : ''}${spec}`,
  bun: (spec, dev) => `bun add ${dev ? '-d ' : ''}${spec}`
};

const UNINSTALL = {
  npm: (names) => `npm uninstall ${names}`,
  yarn: (names) => `yarn remove ${names}`,
  pnpm: (names) => `pnpm remove ${names}`,
  bun: (names) => `bun remove ${names}`
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

function managerOf(manager) {
  return MANAGERS.includes(manager) ? manager : 'npm';
}

function isScaffold(installType) {
  return installType === 'npx' || installType === 'npm-create';
}

function buildCommand({ name, installType, manager, dev, version }) {
  const pm = managerOf(manager);
  switch (installType) {
    case 'npx':
      return EXEC[pm](name);
    case 'npm-create':
      return CREATE[pm](name.replace(/^create-/, ''));
    default:
      return INSTALL[pm](version ? `${name}@${version}` : name, Boolean(dev));
  }
}

function buildUpdateCommand({ names, manager, dev }) {
  const pm = managerOf(manager);
  return INSTALL[pm](names.map((name) => `${name}@latest`).join(' '), Boolean(dev));
}

function buildUninstallCommand({ names, manager }) {
  return UNINSTALL[managerOf(manager)](names.join(' '));
}

function buildAllCommands(options) {
  const commands = {};
  for (const manager of MANAGERS) commands[manager] = buildCommand({ ...options, manager });
  return commands;
}

module.exports = {
  MANAGERS,
  buildCommand,
  buildUpdateCommand,
  buildUninstallCommand,
  buildAllCommands,
  isScaffold
};
