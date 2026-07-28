module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  rootDir: ".",
  moduleNameMapper: {
    "^@dtd/chain-sdk/(.*)$": "<rootDir>/../chain/sdk/$1",
  },
  testRegex: ".*\\.e2e\\.test\\.ts$",
  setupFiles: ["<rootDir>/tests/jest.setup.ts"],
  forceExit: true,
  testTimeout: 30000,
};