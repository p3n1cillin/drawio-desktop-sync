# Server collaboration

The server is the authoritative diagram and journal store. Clients receive
incremental updates every second and publish local changes shortly after editing.
Idle sync does not clone or serialize diagrams. The server caches rooms and edit
history, and expires unused rooms after five minutes. Selection and editing
changes are published promptly; a ten-second heartbeat keeps users visible even
during long label edits. The service
does not use OneDrive or Microsoft Graph. Clients need network/VPN access to it.

Run `src/server/server.js` with Node 24 LTS. There are no server npm dependencies.
Set `DRAWIO_SYNC_CONFIG` to a private JSON file:

```json
{
  "directory": "/srv/drawio-sync/data",
  "key": "/srv/drawio-sync/tls/server.key",
  "cert": "/srv/drawio-sync/tls/server.crt",
  "adminToken": "GENERATE-AT-LEAST-32-RANDOM-BYTES-AND-KEEP-PRIVATE",
  "host": "0.0.0.0",
  "port": 9443
}
```

Use TLS with a certificate containing the server's actual DNS name or IP address.
The desktop connection explicitly trusts the supplied server certificate/CA and
still verifies hostname and certificate validity. No global certificate bypass is
used. Give the service account exclusive access to its data and TLS private key.
Run under a service supervisor, with restart and resource limits. Back up the
entire data directory, including access records, to your existing backup system.

On a map owner's PC, place a private `server-setup.json` in the app's user data
directory (`%APPDATA%/drawio-desktop-sync` on Windows):

```json
{"server":"https://diagrams.example.test:9443","ca":"-----BEGIN CERTIFICATE-----\n...\n-----END CERTIFICATE-----\n","adminToken":"YOUR-PRIVATE-ADMIN-TOKEN"}
```

Open a diagram and choose **Share**. The native desktop
confirmation identifies the destination before uploading. The original file is
retained. The new server map opens from a separate local launch cache, and recent
files reopen the server session automatically. A desktop shortcut is created;
it identifies the room and restores a missing launch cache automatically.
AutoSave says **Saved to server**.

Use **Share → Copy shared-map link**. A colleague installs the same release and
chooses **… → Open shared map**, then pastes the link. No server administrator
token is included. Treat links as edit credentials: anyone with one can read and
edit that map. Names are display labels, not authenticated Microsoft identities.
The owner can revoke all existing edit links in **Share**, then issue a new link.
Revocation also disconnects editors using the old credential.

Installer builds check this fork's stable GitHub releases automatically, download
newer versions quietly and install them when the app closes. They never replace
the fork with stock draw.io. Update checks default to hourly; Help includes update
settings and **Restart to Update**. Portable ZIP builds notify instead of changing
their installation. Release versions are independent of the bundled editor's
version, so each desktop update can be detected correctly.

The app keeps pending published operations in a local durable outbox and retries
using the same operation ID. Edits and snapshots are written durably before the
server acknowledges them. If disconnected, the editor shows **Sync paused** and
preserves its modified state; reconnect before closing to save later local edits.
This preview does not provide a complete offline editor or Microsoft's Excel
coauthoring protocol. Different properties merge automatically. Concurrent edits
to one property produce a review notification with both versions; users can keep
the current value or publish the earlier value as a new edit. The journal uses
deterministic Lamport/ID ordering and preserves all accepted operations.

Keep the old file and any old `.collab` folders as migration backups until users
have checked their diagrams. The server does not import or silently reconcile
conflicting old OneDrive rooms. File exports and Save As produce standalone copies.

Run `npm test` and `npm run test:server-ui` to validate the server and desktop,
including missing-cache recovery, idle work, live editing and conflict recovery.
The PEM fixtures under `src/test/fixtures/sync-tls` are public test credentials;
they are never used by the deployed service or included in the Windows package.

## Limits

Shared bases and materialized diagrams are limited to 16 MiB; an operation is
limited to 4 MiB and a room to 10,000 operations. Save an archive and create a new
shared map before reaching the history limit. Stored data and TLS keys belong in
your normal server backup policy. Desktop 32.5.6 clients remain compatible with
the service, but need updating for incremental sync and the review UI.
