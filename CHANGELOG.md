# Changelog

All notable changes to LAN Vault Bridge are documented in this file.

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
