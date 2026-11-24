# Submitting LAN Vault Bridge to the Obsidian community directory

This file is a checklist for the repository owner. It is intentionally not part of
the plugin bundle.

## 1. Publish the repository

Create a **public** repository at `https://github.com/hardkor88/lan-vault-bridge`
and push the contents of this folder:

```bash
git init
git add .
git commit -m "Release 1.1.0"
git branch -M main
git remote add origin https://github.com/hardkor88/lan-vault-bridge.git
git push -u origin main
```

The repository root must contain:

- `manifest.json`
- `README.md`
- `LICENSE`

`main.js` is a build artifact and is intentionally ignored by `.gitignore`; it is
attached to the GitHub Release by the workflow.

## 2. Create the release

The tag must exactly match `version` in `manifest.json` — `1.1.0`, without a `v`
prefix.

```bash
git tag 1.1.0
git push origin 1.1.0
```

If an earlier version is already published, commit the 1.1.0 changes, push them to
`main`, then create the `1.1.0` tag. The review dashboard will pick up the new
release with the “Check for new releases” button.

The workflow in `.github/workflows/release.yml` runs on the tag, verifies the tag
against the manifest, builds the plugin and creates a GitHub Release with these
assets:

- `main.js`
- `manifest.json`
- `styles.css`

After the workflow finishes, open the release and confirm that it is **not** a
draft and **not** a pre-release.

You can also create the release manually: run `npm ci && npm run build`, then
create a release for tag `1.1.0` and attach the three files above.

## 3. Submit the plugin entry

1. Fork [`obsidianmd/obsidian-releases`](https://github.com/obsidianmd/obsidian-releases).
2. Open `community-plugins.json` and add this object at the end of the array:

```json
  {
    "id": "lan-vault-bridge",
    "name": "LAN Vault Bridge",
    "author": "hardkor88",
    "description": "Sync your vault bidirectionally over the local network with tombstone protection and conflict resolution.",
    "repo": "hardkor88/lan-vault-bridge"
  }
```

3. Commit with a message such as `Add plugin: LAN Vault Bridge`.
4. Open a pull request against `obsidianmd/obsidian-releases:master`.
5. Fill in the PR template and mention:
   - the build and typecheck pass; the API, manifest, diff, upload/download and
     tombstone flows were smoke-tested against a fake vault;
   - the mobile UI still needs a real-device test before you submit;
   - `isDesktopOnly: false`; Node modules are loaded lazily only in the desktop branch;
   - `Vault.adapter` is used only for the plugin manifest, while user files go through
     the Vault API;
   - the release assets and tag match `manifest.json`.

## 4. Pre-submission checklist

- [ ] `manifest.json` id is unique: `lan-vault-bridge` (checked against the directory).
- [ ] Name does not contain “Obsidian”: “LAN Vault Bridge”.
- [ ] Description is 250 characters or fewer, ends with a period and starts with a verb.
- [ ] `version` is `1.1.0`; release tag is `1.1.0`.
- [ ] `minAppVersion` is justified: `1.13.0` (declarative settings).
- [ ] `author` is a person/nickname, `authorUrl` points to GitHub.
- [ ] `LICENSE` (MIT) exists in the repository root.
- [ ] `README.md` has install, usage, privacy, security and limitations sections.
- [ ] No template code, no `innerHTML`/`outerHTML`/`insertAdjacentHTML`.
- [ ] No `console.log` in normal operation; diagnostic output is behind “Debug logging”.
- [ ] Command IDs do not repeat the plugin id (`sync-now`, `ping-server`, ...).
- [ ] Settings and commands use sentence case; all settings headings use `.setHeading()`.
- [ ] Mobile: the plugin loads, opens settings and syncs as a client.
- [ ] Release assets: `main.js`, `manifest.json`, `styles.css`; release is public.

## 5. If the reviewer asks about Node.js

`isDesktopOnly` is `false` because the plugin has a working mobile client. The only
Node modules are `http` and `os`; they are loaded through `window.require` inside
`if (Platform.isDesktop)` branches. On mobile those branches are never executed, and
the client uses Obsidian `requestUrl` only. The desktop server is the only part that
needs Node.

## 6. Automated review recommendations

The review bot may show these as “Recommendation” (not failures). What was done in
1.0.1/1.0.2/1.1.0:

- **Local Storage** — removed. Automatic language detection now uses the
  Obsidian/moment locale and the browser language only.
- **CSS `!important`** — removed; the invalid-input rule now uses normal selector
  specificity and `var(--text-error)`.
- **Missing artifact attestations** — the workflow now runs
  `actions/attest-build-provenance@v2` for `main.js`, `manifest.json` and
  `styles.css` before creating the release.
- **Declarative settings / deprecated `display()`** — the settings tab now implements
  `getSettingDefinitions()`; `display()` is removed and `minAppVersion` is `1.13.0`.
- **`Vault.delete()`** — replaced with `FileManager.trashFile()` to respect the
  user's deletion preference.
- **`TFile` casts / `globalThis` / direct styles / `execCommand`** — removed or
  replaced with `instanceof TFile`, `window`, CSS classes and `navigator.clipboard`.
- **`setWarning()`** — replaced with `setDestructive()`.
- **Vault Enumeration** — inherent to a sync plugin. The manifest needs a complete
  list of vault paths; the list is sent only to the paired desktop, never to the
  author or a third party.
- **Clipboard Access** — only on explicit user action: paste import, copy token,
  copy connection string. No background reads or writes.

These last two are expected for this plugin; mention them in the PR so the reviewer
does not treat them as hidden behavior.

## 7. If the reviewer asks about `Vault.adapter`

The manifest lives in `.obsidian/plugins/lan-vault-bridge/sync-manifest.json`. It is
plugin data outside the vault index, so the plugin uses `vault.adapter` for that one
file (the same mechanism `saveData` uses). All user notes and attachments are read,
created and modified through the Vault API, and removed through
`FileManager.trashFile()` so the user's deletion preference is respected.
