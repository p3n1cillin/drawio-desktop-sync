# Server collaboration

drawio-desktop-sync lets several people edit the same diagram at once, in the
style of Office co-authoring: everyone sees each other's changes within a fraction
of a second, who is in the diagram and where they are working, and can comment,
review changes and restore earlier versions. A small HTTPS service that you host
is the authoritative store. Nothing is sent to a third-party cloud service.

## Features

- **Live co-editing.** Edits are pushed to everyone as soon as the server saves
  them (the server holds a watch request open per editor; there is no polling
  delay). Different properties merge automatically. When two people change the
  same property before seeing each other's change, both are kept and **Review
  changes** lets either person choose the value.
- **Presence.** Avatars of everyone in the diagram, their selection outlined in
  their colour with their name, a note when someone is editing the object you
  selected, and live named mouse pointers. Click an avatar to go to that person.
- **AutoSave.** On by default, like Office. Turn it off to save with Ctrl+S.
- **Version History.** File > Version History (or … > Version history) lists
  versions grouped like Office AutoSave versions, with who edited each one.
  Preview any version, hold Compare to see the current diagram, and Restore. A
  restore is saved as a new edit, so nothing is lost and everyone sees it.
- **Show Changes.** … > Show changes, or right-click shapes > Show changes,
  lists who changed what and when, newest first (for example *Changed text from
  "A" to "B"*), for the whole diagram or the selected shapes. Click a change to go to
  that shape.
- **Comments.** The Comments button opens threaded comments, anchored to shapes
  or to the diagram, with replies, resolve and reopen. People can only edit or delete
  their own comments; the diagram owner can delete any. **@mentions** suggest people
  who have opened the diagram, and the mentioned person gets a notification.
- **Sharing.** **Share** copies a link that lets people either edit or only view
  the diagram, lists the people with access, and lets the owner stop current edit
  or view links (everyone using the old link is disconnected).
- **Identity.** Each desktop labels its user with the signed-in Windows work or
  school account (email address) and the Office user name, falling back to the
  Windows user name. People can set a different display name in … > Your
  display name. These are labels for presence, history, comments and mentions;
  the link is the credential, not a verified Microsoft sign-in.

## Running the service

Run `src/server/server.js` with Node 24 LTS. There are no server npm
dependencies. Set `DRAWIO_SYNC_CONFIG` to a private JSON file:

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
The desktop connection explicitly trusts the supplied server certificate or CA
and still verifies the hostname and certificate validity; no global certificate
bypass is used. Give the service account exclusive access to its data directory
and TLS private key, run it under a service supervisor with restart and resource
limits, and back up the whole data directory (it includes access records and
comments). Clients need network or VPN access to the service. Each open diagram keeps
one HTTPS request waiting on the server, so allow one connection per open diagram.

## Creating and joining diagrams

On the PC of anyone allowed to create shared diagrams, place a private
`server-setup.json` in the app's user data directory
(`%APPDATA%/drawio-desktop-sync` on Windows):

```json
{"server":"https://diagrams.example.test:9443","ca":"-----BEGIN CERTIFICATE-----\n...\n-----END CERTIFICATE-----\n","adminToken":"YOUR-PRIVATE-ADMIN-TOKEN"}
```

Open a diagram and choose **Share**. A native confirmation names the server
before anything is uploaded. The original file is kept; the shared diagram opens
from a separate local copy, recent files reconnect automatically, and a desktop
shortcut is created.

To invite people, choose **Share**, pick *can edit* or *can view*, and **Copy
link**. They install the same release and choose **… > Open shared diagram**, then
paste the link. The administrator token is never included in links. Treat links
like keys. If a shortcut is opened on a PC that has not joined the diagram yet, the
app offers to paste the link instead of failing.

## Reliability

Pending edits are kept in a durable outbox on the PC and retried with the same
operation ID, so a lost response never duplicates an edit; edits the server
refuses (for example after a link is stopped) are not retried. Edits and
snapshots are written durably before the server acknowledges them. If the
connection drops, the editor shows **Sync paused** and keeps its changes;
reconnect before closing to save them. The journal orders edits by server clock
and keeps every accepted edit, which is what Version History and Show Changes
read.

## Performance

- Edits are pushed; while the push connection is healthy the app only checks
  the server every five seconds as a safety net.
- Pointer and selection updates are batched on the server (100 ms) so moving
  the mouse does not wake every desktop for each event.
- Each desktop applies only edits it has not applied yet, and its own edits are
  never replayed. Reopening a diagram starts from that desktop's own saved copy and
  replays only newer edits.
- The server loads a diagram's edit history in parallel batches (a 3,000-edit diagram
  loads in about 0.15 s).

## Limits

Shared bases and materialized diagrams are limited to 16 MiB, an edit to 4 MiB,
a diagram to 10,000 edits and 5,000 comments. Save an archive and create a new shared
diagram before reaching the edit limit. Desktops from before these features still
connect, but need updating for push updates, comments, view links and Version
History; servers from before them still work with new desktops, which fall back
to polling and show which features need a server update.

## Testing

Run `npm test` and `npm run test:server-ui` to validate the server and desktop,
including two real editors syncing over HTTPS, push latency, presence and
pointers, Version History, Show Changes, comments, mentions and view links. The
PEM fixtures under `src/test/fixtures/sync-tls` are public test credentials; they
are never used by the deployed service or included in the Windows package.
