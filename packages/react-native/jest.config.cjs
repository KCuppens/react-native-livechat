module.exports = {
  preset: "@react-native/jest-preset",
  setupFiles: ["./jest.setup.cjs"],
  transformIgnorePatterns: ["node_modules/(?!(\\.pnpm|react-native|@react-native|@kobecuppens)/)"],
  moduleNameMapper: {
    // Test against workspace sources, not built dist.
    "^@kobecuppens/livechat-core$": "<rootDir>/../core/src/index.ts",
    "^@kobecuppens/livechat-protocol$": "<rootDir>/../protocol/src/index.ts",
    "^@kobecuppens/livechat-protocol/constants$": "<rootDir>/../protocol/src/constants.ts",
    "^@kobecuppens/livechat-react/hooks$": "<rootDir>/../react/src/hooks.ts",
  },
};
