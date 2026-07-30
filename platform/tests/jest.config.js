module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  rootDir: ".",
  moduleNameMapper: {
    "^@dtd/chain-sdk/(.*)$": "<rootDir>/../chain/sdk/$1",
    "^@dtd/custody/(.*)$": "<rootDir>/../custody/$1",
  },
  // Actual files are platform/tests/bookings.e2e.test.ts and payments.e2e.test.ts
  testRegex: ".*\\.e2e\\.test\\.ts$",
  setupFiles: ["<rootDir>/tests/jest.setup.ts"],
};
