# drawio-desktop-sync

A general-purpose draw.io Desktop fork with self-hosted collaboration and AutoSave.
It works with your diagrams and your server; no company, tenant, diagram or server
address is built into the application.

[Download the Windows installer](https://github.com/p3n1cillin/drawio-desktop-sync/releases/latest).
Run the `-setup.exe` for your Windows account. It registers `.drawio` files and
creates desktop and Start menu shortcuts. The ZIP is an optional portable build.

## Collaboration

- One authoritative diagram and durable edit history on your HTTPS server.
- AutoSave, concurrent shape/property merges, undo and reconnection.
- Live editor avatars, named selection outlines and active-editing indicators.
  Click an avatar to find the person's selected object. Set your display name in
  the three-dot menu.
- Review overlapping property edits and restore an earlier value without losing
  the accepted history. Independent properties merge automatically; this is not
  character-by-character text merging.
- Per-map sharing links, owner-controlled revocation and automatic desktop map
  shortcuts. Room-based shortcuts restore a missing local launch cache.
- Incremental updates, cached server rooms and no repeated diagram cloning or
  serialization during idle sync. Unused server rooms expire from memory.
- Standalone `.drawio` files retain normal draw.io behaviour. Save As creates an
  independent copy. The former OneDrive collaboration transport and shell
  sharing integration have been removed.

Set up your service using the [server guide](src/server/README.md). An owner can
open a diagram and choose **Share** to create its server copy, then copy a link.
Colleagues choose **… → Open shared map**, paste the link once and accept the
server connection. A desktop shortcut is created for subsequent use. The header
reads **Saved to server**. The original imported file is retained as a backup.

People with an edit link can read and edit that map. Display names are labels,
not Microsoft identities. Clients must be able to reach the server. Accepted
edits are durable, and pending published operations have a local outbox; reconnect
before closing to save later unsent changes. Complete offline editing and the
Microsoft Excel coauthoring protocol are not implemented.

## Automatic updates

Installer builds check this fork's stable GitHub releases hourly, download newer
versions in the background and install when the app closes. Help includes
update settings and Restart to Update. Portable builds notify only. Older
`sync.1` through `sync.5` previews need a one-time installer upgrade.

## Saved settings and live configuration

**Extras → Configuration** keeps both the visual Editor controls and JSON.
Apply changes guides, connection behavior, folding, wheel zoom, grid options,
compact mode and other supported runtime options in existing editor windows.
It does not reload the diagram. Startup-only options are saved; the dialog names
those that need a new editor window, instead of requesting a full app restart.
Local file-access approvals and plugin loading still happen at window startup.

Configuration and editor preferences are mirrored to `editor-preferences.json`
in the app's user-data folder, outside the installation directory. They restore
before editor startup if Chromium storage is lost or its origin changes during
an update. Explicit resets are remembered. Native update settings, server setup
and map credentials also remain in the user profile; installers retain them.
The backup copies preference entries, not separate login tokens or diagram drafts.
An explicit Configuration `override` still intentionally overrides user settings.
The shared-map AutoSave choice is remembered per map and installation. Spell
checking, backup and automatic-update switches update existing window menus live.
Updates to application code still take effect after installing and reopening it.

## Build and test

Use Node 24 LTS and clone with submodules. Run `npm ci`, `npm test`,
`npm run test:server-ui` and `npm run build:sync`. The Windows CI checks real
installation, file associations, reinstall and uninstall. A version tag publishes
the tested installer, ZIP, blockmap and `latest.yml` for automatic updates.

The bundled upstream editor keeps its own version; desktop release versions
advance independently. Windows builds are currently unsigned.

## Credits and licence

Based on [jgraph/drawio-desktop](https://github.com/jgraph/drawio-desktop) and the
[draw.io editor](https://github.com/jgraph/drawio). This is an independent fork,
licensed under GPL-3.0-only. See the repository licence and upstream notices.
