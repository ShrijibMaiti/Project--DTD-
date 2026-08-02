module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  rootDir: ".",
  moduleNameMapper: {
    "^@nestjs/core$": "<rootDir>/node_modules/@nestjs/core",
    "^@nestjs/core/(.*)$": "<rootDir>/node_modules/@nestjs/core/$1",
    "^@nestjs/common$": "<rootDir>/node_modules/@nestjs/common",
    "^@nestjs/common/(.*)$": "<rootDir>/node_modules/@nestjs/common/$1",
    // ORDER MATTERS: chain-sdk before chain, or "@dtd/chain-sdk/anchor"
    // would match the broader "@dtd/chain/(.*)" pattern and resolve to
    // ../chain/-sdk/anchor. Jest applies mappers top-down, first match wins.
    "^@dtd/chain-sdk/(.*)$": "<rootDir>/../chain/sdk/$1",
    "^@dtd/chain/(.*)$": "<rootDir>/../chain/$1",
    "^@dtd/shared/(.*)$": "<rootDir>/../shared/$1",
    "^@dtd/identity/(.*)$": "<rootDir>/../identity/$1",
    "^@dtd/custody/(.*)$": "<rootDir>/../custody/$1",
    "^@dtd/gps/(.*)$": "<rootDir>/../gps/$1",
  },
  testRegex: ".*\\.e2e\\.test\\.ts$",
  setupFiles: ["<rootDir>/tests/jest.setup.ts"],
  forceExit: true,
  testTimeout: 30000,
};
