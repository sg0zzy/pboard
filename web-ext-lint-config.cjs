// Lint-only web-ext config for `npm run lint:firefox` (web-ext lint).
//
// The vendored React chunk (assets/react-*.js, the codeSplitting "react"
// group built from node_modules) contains react-dom's minified setInnerHTML
// helper, which trips addons-linter's UNSAFE_VAR_ASSIGNMENT warning with
// --warnings-as-errors. That is a known false positive on unmodified
// third-party code, so this chunk is skipped by the lint scan only.
//
// Packaging and submission still use web-ext-config.cjs (no react ignore),
// so the chunk is shipped and byte-verified by scripts/verify-package.mjs.
const base = require("./web-ext-config.cjs");

module.exports = {
  ...base,
  ignoreFiles: [...base.ignoreFiles, "assets/react-*.js"],
};