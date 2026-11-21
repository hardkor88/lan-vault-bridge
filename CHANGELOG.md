# Changelog

All notable changes to LAN Vault Bridge are documented in this file.

## 1.0.2 — 2026-11-21

### Changed

- Migrated the settings tab to the declarative settings API
  (`getSettingDefinitions()`), so settings appear in Obsidian's settings search.
  `minAppVersion` is now `1.13.0`.
- Replaced `Vault.delete()` with `FileManager.trashFile()` to respect the user's
  deletion preference.

### Fixed

- Removed direct style assignment, `document.createElement` and the deprecated
  `document.execCommand` fallback from clipboard copying.
- Removed unnecessary `TFile` casts; handlers now use `instanceof TFile`.
- Replaced `globalThis` with `window` for popout-window compatibility.
- Removed an unnecessary `ArrayBuffer` assertion in the request body reader.
- Promise rejection reasons are always `Error` instances.
- Invalid-input styling no longer uses `!important`.
- The settings description now reads the actual `vault.configDir` instead of
  hardcoding `.obsidian`.
- `setWarning()` is replaced with `setDestructive()`.

## 1.0.1 — 2026-11-21

### Fixed

- Removed `localStorage` access from automatic language detection; it now uses the
  Obsidian/moment locale and the browser language only.
- Removed `!important` from the invalid-input style; the selector now uses normal
  specificity and a CSS variable.
- Added GitHub artifact attestations for `main.js`, `manifest.json` and `styles.css`
  to the release workflow.
- Documented the two inherent automated-review recommendations: vault enumeration
  is required for manifest reconciliation, and clipboard access happens only on
  explicit user action.

## 1.0.0 — 2026-11-21

### Added

- Bidirectional LAN sync between a desktop server and phone/desktop clients.
- Manifest-based state tracking with SHA-256 content comparison.
- Tombstone protection for deleted files.
- Interactive conflict review with text previews, image previews, word-level diff,
  per-file actions and bulk actions.
- QR pairing and JSON connection-string import.
- Desktop IPv4 discovery, including Tailscale/ZeroTier addresses.
- Bearer-token authorization, CORS, path traversal protection and a configurable
  file size limit.
- English/Russian interface with automatic language detection.
- Destination folder creation for downloaded files.
- Empty-file sync support.
- Debug logging behind a setting; normal operation stays quiet in the console.

### Security

- Bearer token is required for every API request except CORS preflight.
- The server rejects absolute paths, `..` traversal and ignored folders.
- Traffic is HTTP without TLS; the README recommends a trusted LAN or VPN.
