const { getDefaultConfig } = require('expo/metro-config');

// Expo 会自动识别 pnpm monorepo。
module.exports = getDefaultConfig(__dirname);
