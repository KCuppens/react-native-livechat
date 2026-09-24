// Resolve the SDK from the monorepo while keeping ONE copy of react / react-native (this app's).
const { getDefaultConfig } = require("expo/metro-config");
const path = require("path");

const projectRoot = __dirname;
const monorepoRoot = path.resolve(projectRoot, "../..");
const config = getDefaultConfig(projectRoot);

config.watchFolders = [monorepoRoot];
config.resolver.nodeModulesPaths = [path.resolve(projectRoot, "node_modules"), path.resolve(monorepoRoot, "node_modules")];
config.resolver.extraNodeModules = {
  react: path.resolve(projectRoot, "node_modules/react"),
  "react-native": path.resolve(projectRoot, "node_modules/react-native"),
  "@react-native-async-storage/async-storage": path.resolve(projectRoot, "node_modules/@react-native-async-storage/async-storage"),
};
config.resolver.blockList = [/packages\/[^/]+\/node_modules\/(react|react-native|@react-native-async-storage)\/.*/];

module.exports = config;
