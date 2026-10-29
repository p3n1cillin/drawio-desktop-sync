# drawio-desktop-sync

A general-purpose draw.io Desktop fork with self-hosted, Office-style co-authoring:
several people edit the same diagram at once with AutoSave, live presence,
comments, Show Changes and Version History. It works with your diagrams and your
server; no company, tenant, diagram or server address is built into the application.

[Download the Windows installer](https://github.com/p3n1cillin/drawio-desktop-sync/releases/latest).
Run the `-setup.exe` for your Windows account. It registers `.drawio` files and
creates desktop and Start menu shortcuts. The ZIP is an optional portable build.

## Collaboration

- **Live co-editing.** One authoritative diagram and durable edit history on your
  HTTPS server. Changes are pushed to everyone in about 0.2 seconds. Independent
  shapes and properties merge automatically; when two people change the same
  property at once, **Review changes** keeps both and lets either choose.
- **AutoSave**, on by default like Office, with undo and automatic reconnection.
  Turn it off to save with Ctrl+S.
- **Presence.** Avatars of everyone in the map, their selections outlined with
  their name, a note when someone is editing the object you selected, and live
  named mouse pointers. Click an avatar to go to that person.
- **Version History** (File › Version History): versions grouped like Office
  AutoSave versions, with who edited each. Preview any version, hold Compare to
  see the current map, and restore it. A restore is saved as a new edit, so
  nothing is lost and everyone sees it.
- **Show Changes** (… › Show changes, or right-click shapes): who changed what and
  when, newest first, for the whole map or the selected shapes. Click a change to
  go to that shape.
- **Comments** on shapes or the map with replies, resolve and reopen, and
  **@mentions** that notify the person mentioned.
- **Sharing.** **Share** copies a link that lets people edit or only view, lists
  the people with access, and lets the owner stop current edit or view links.
- **Names from the signed-in account.** Each person is labelled with their Windows
  work or school account and Office user name, falling back to the Windows user
  name; … › Your display name overrides it. These are labels; the link is the
  credential, not a verified Microsoft sign-in.
- **Fast on large maps.** Each desktop applies only edits it has not seen, reopens
  from its own saved copy, and the server loads thousands of edits in a fraction
  of a second.
- Desktop map shortcuts. A shortcut for a map this PC has not joined offers to
  paste the shared-map link instead of failing. Standalone `.drawio` files keep
  normal draw.io behaviour, and Save As creates an independent copy.

Set up your service using the [server guide](src/server/README.md). An owner opens
a diagram and chooses **Share** to create its server copy, then copies a link.
Colleagues choose **… › Open shared map**, paste the link once and accept the
server connection. A desktop shortcut is created for later use. The header reads
**Saved to server**. The original imported file is kept as a backup.

Treat links like keys: anyone with an edit link can change that map, and anyone
with a view link can read it. Clients must be able to reach the server. Accepted
edits are durable and unsent edits wait in a local outbox; reconnect before
closing to save them. Full offline editing and character-by-character merging of
the same text are not implemented.

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
