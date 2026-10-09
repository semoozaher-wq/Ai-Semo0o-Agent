// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require('eslint/config');
const expoConfig = require("eslint-config-expo/flat");
const globals = require('globals');

module.exports = defineConfig([
  expoConfig,
  {
    ignores: ['dist/*', 'legacy/*', 'node_modules/*', '.expo/*'],
  },
  // ---------------------------------------------------------------------------
  // Node backend + tooling.
  // ---------------------------------------------------------------------------
  // This repository ships BOTH the Expo frontend and a Node.js backend/tooling
  // (backend/, scripts/, execution-core/, phase2-core/, test/, server.js) from
  // the same tree. `eslint-config-expo` only declares browser globals, so every
  // Node file that uses `Buffer`, `__dirname`, `process`, ... was reported as a
  // false `no-undef` error, and the JSON import attributes used by the backend
  // (`import contract from './x.json' with { type: 'json' }`) could not be parsed
  // (the Expo preset pins `ecmaVersion: 2022`).
  //
  // These files never run in a browser, so they are given the real Node globals
  // and the latest ECMAScript syntax. `src/` and `app/` (the React Native app)
  // are intentionally NOT covered — they keep the Expo/browser environment.
  {
    files: ['**/*.mjs', 'server.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.node },
    },
  },
]);
