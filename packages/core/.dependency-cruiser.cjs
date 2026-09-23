/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'core-must-stay-dependency-free',
      comment:
        'packages/core must have zero runtime dependencies: no NestJS, no ORM, ' +
        'no database driver, no framework of any kind. Node built-ins ' +
        '(dependencyType "core") are the only external imports allowed.',
      severity: 'error',
      from: { path: '^src' },
      to: {
        dependencyTypes: [
          'npm',
          'npm-dev',
          'npm-optional',
          'npm-peer',
          'npm-bundled',
          'npm-no-pkg',
        ],
      },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.json' },
  },
};
