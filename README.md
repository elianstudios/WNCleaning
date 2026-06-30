# WNCleaning

A local-first disk inventory + backup dashboard for macOS. Scan your drives, browse and filter their contents, build deduplicated backup plans across multiple drives, and copy everything into one consolidated archive — with drive-swap prompts when you only have one USB slot to spare.

Runs entirely on your machine. No cloud, no telemetry, no dependencies beyond Node.

![macOS](https://img.shields.io/badge/macOS-required-blue) ![Node 18+](https://img.shields.io/badge/Node-18%2B-green) ![No dependencies](https://img.shields.io/badge/dependencies-zero-brightgreen)

---

## What you can do with it

- **Scan a drive** to inventory every file (name, path, size, modified-date, extension).
- **Browse and filter** scans with a rich filter set: name, path, top folder, extension, category, age bucket, size range, modified dates, path depth, duplicates.
- **Multi-scan view**: tick several scans at once to see a unified file table across drives.
- **Run a real-time scan** with pause / resume / cancel, and watch progress live.
- **Detect duplicates** by name+size+extension, highlight them, and either show only duplicates or hide all but the shortest-path copy.
- **Get a breakdown**: total size by category (image / video / audio / document / archive / code), by age, top extensions, top folders, and the largest individual files.
- **Build a copy plan**: deduplicated union of files across one or more selected scans, with full audit of which copy "won" and which were skipped as duplicates.
- **Run a copy plan**: copies files to any destination drive or folder, drive-by-drive. If the source drive isn't plugged in, it prompts you to swap. Resumable across reloads and server restarts.
- **One-slot workflows**: plug a drive → scan → eject → plug the next, all guided. Then copy a deduplicated backup onto one destination drive.
- **Send files to Trash** (the *only* deletion action in the app) with triple confirmation. Files go to macOS Trash, restorable until you empty it.
- **Trash retention log**: configurable audit window (forever / 30 days / 24 hours) of what you've sent to Trash per scan.
- **Reveal in Finder**: double-click any row to jump to the file in Finder.

---

## Read-only guarantee (the safety story)

This tool is **read-only on your scanned drives** by default. The only operations it ever performs on disks outside the project folder are:

1. **Read** (`readdir`, `lstat`, file copy reads) during scan + copy.
2. **Move to Trash** via Finder's AppleScript when you explicitly send a file to Trash (triple-confirm gated; files are restorable from Trash bin).
3. **Copy** files to a destination you explicitly chose.

It will never:
- Modify, overwrite, or delete files on your source drives.
- Write anything outside the project folder, except the destination folder you pick for a copy.
- Touch hidden system paths like `/System`, `/private/var/vm`, `.Spotlight-V100`, `.Trashes`, etc.
- Follow symlinks during scans.

A runtime guard (`assertInsideProject` in `server.js`) physically refuses any project write whose resolved path falls outside the project root. The trash endpoint refuses paths inside the project folder, paths at `/` or volume roots, and uses Finder's "move to trash" — never `rm`.

---

## Requirements

- macOS (uses `/Volumes`, `diskutil`, `osascript`, Finder integration)
- Node.js 18 or newer
- A few free MB of disk for scan sidecars (text JSON files in `scans/`)

That's it. No npm install. No build step.

---

## Setup

```bash
git clone <this-repo> wncleaning
cd wncleaning
node server.js
```

The server prints `WNCleaning dashboard: http://localhost:7777` and auto-opens your browser there.

Or use the helper script if you have it:

```bash
./WNCleaning.command
```

To stop the server, hit `Ctrl+C` in the terminal.

---

## First time — quick start

1. **Open the dashboard.** You'll see the list of volumes in the sidebar.
2. **Click "Scan"** next to any volume. A progress panel shows live file/dir counts and the current directory being walked.
3. When the scan finishes, the **Files** panel populates with every file from that volume.
4. **Use the Filters panel** to narrow what you see — type in "Name contains", pick a category (Image / Video / Audio / …), set an age bucket, etc.
5. The **Breakdown panel** below the filters shows totals by category, age, top extensions, top folders, and the largest individual files.

That's enough to get value. The next sections cover the more advanced features.

---

## Concepts

### Scan

A static snapshot of every file in a folder tree. Stored as:

- `scan_<name>_<timestamp>.header.json` — totals + metadata
- `scan_<name>_<timestamp>.ndjson` — one line per file
- `scan_<name>_<timestamp>.errors.ndjson` — paths the scan couldn't read (usually permissions)
- `scan_<name>_<timestamp>.pending-trash.json` — audit log of files you sent to Trash from this scan

Scans are immutable on disk. To refresh a scan after deleting files, hit the **↻** button next to it (re-checks only the pending-trash entries) or just run a fresh scan on the same volume.

### Filter

Live filter on the currently-loaded file list. Combines multiple criteria (name + path + extension + size + age + category + depth + duplicate flags). The filter doesn't change the underlying scan — it just narrows what you see and act on.

### Plan

A reusable artifact describing **what** to copy and **where**. Stored on disk so it survives reloads and restarts. Two flavors:

- **Working plan** — always present, always default. Acts as your live staging area. Add files via the "+ Add filtered" / "+ Add checked" buttons in the Files panel.
- **Saved plans** — built from a full-disk merge (the "Build copy plan from selected scans" button) or by hitting "Save as…" on the Working plan.

Each plan owns its own settings:

- **Destination** — any volume or folder picked via Browse…
- **Layout** — `mirrored` (preserves drive + path structure under `<dest>/<DriveName>/<path>`) or `flat` (one folder, auto-renames on collisions)
- **Dest mode** — `additive` (skip existing — safest), `overwrite`, or `fresh` (refuse if destination not empty)
- **Tie-break** — when the same file exists on multiple drives, which copy wins: first-scanned / newest / oldest / shortest-path / largest

### Run

Executes a plan. Groups its entries by source drive (volume UUID), copies all files from currently-mounted sources, and prompts you to plug in any missing drive. Pause / resume / cancel supported. Resumable: re-running a plan picks up where it left off (already-copied entries are marked and skipped).

A floating run panel (bottom-left) shows live progress: files done, bytes done, MB/s, current file, current drive. The swap modal pops up when the next drive is needed — verified by volume UUID before continuing, so plugging the wrong drive won't fool it.

---

## The "perfect backup" wizard

Click the **🛟 Create perfect backup** button in the header. A guided four-step workflow:

1. **Sources** — tick existing scans or plug & scan new drives one at a time. After each scan you can eject the drive and plug the next.
2. **Destination** — pick the drive or folder where the backup will land.
3. **Review** — see totals (unique files, total size, duplicates collapsed, source-errors) and verify-sources warnings (files missing on disk since the scan).
4. **Run** — the wizard hands off to the standard run flow with swap prompts.

Designed for the "I have 5 drives but only one USB port" workflow.

---

## Filtering deep dive

The Filters panel exposes:

| Filter | What it does |
|--------|--------------|
| Name contains | Substring match on filename |
| Path contains | Substring match on full path |
| Top folder | Group selector (auto-populated from depth-3 paths) |
| Extensions | Multi-select; auto-narrows when Category is set |
| Min/Max size | `1MB`, `2.5GB`, `1024`, etc. |
| Modified after/before | Date range on mtime |
| Age bucket | Today / This week / This month / This year / Older / Ancient (>5y) |
| Category | Image / Video / Audio / Document / Archive / Code / Binary / Other (derived from extension) |
| Min/Max depth | Path depth (number of `/` segments) |
| Show only duplicates | Files matching another on size+name+ext |
| Hide duplicates | Keeps shortest-path copy of each group |

Click "Clear filters" to reset.

---

## Trash + retention log

The **only** action in the app that touches files on your scanned drives. Triple-confirmation gated:

1. Tick rows in the Files panel → click **🗑 Send checked to Trash**.
2. First confirm: "Send N files to Trash?" with the first few paths shown.
3. Second confirm: "Really? This cannot be undone from inside the app."
4. After move-to-Trash: third dialog explains the next steps (empty Trash from Finder, click ↻ to refresh the scan).

Files are moved to macOS Trash via Finder's AppleScript — restorable from the Trash bin until you empty it.

Each trash action is logged per-scan in `<scan>.pending-trash.json`. Retention configurable via the **Trash log** dropdown in the header:

- **Forever** — keep the full audit trail (default)
- **30 days** — auto-prune entries older than 30 days
- **24 hours** — auto-prune entries older than 24 hours

When you click **↻ Update** on a scan, the dashboard re-checks each pending path:
- File actually gone (you emptied Trash) → entry removed from the scan, ndjson rewritten, totals updated.
- File still present (you restored it from Trash) → entry flipped to `restored`, badge shown in green, dropped from the log on the next Update.

---

## Layout and UX

The dashboard is a uniform panel system:

- Click any panel header to **collapse** it.
- Drag the bottom edge of a panel to **resize** it. State persists per panel.
- Drag the vertical bar between sidebar and main area to **resize the sidebar**. Double-click to reset.
- Click the sidebar's **◀** button to collapse it to a 44px strip.
- Drag the right edge of any column header to **resize columns**. Double-click to reset.
- Header buttons: **Expand all** (open every panel, scroll the main area) / **Reset layout** (clear all persisted sizes + states).

---

## Project structure

```
WNCleaning/
├── README.md           ← you are here
├── PLAN.md             ← older planning notes
├── server.js           ← local HTTP server + scan/copy engine
├── index.html          ← single-page dashboard (HTML/CSS/JS in one file)
├── WNCleaning.command  ← double-clickable shell launcher
└── scans/              ← generated; one set of files per scan + plans + settings
    ├── scan_*.header.json
    ├── scan_*.ndjson
    ├── scan_*.errors.ndjson
    ├── scan_*.pending-trash.json
    ├── working.plan.json
    ├── working.entries.ndjson
    ├── plan_*.plan.json
    ├── plan_*.entries.ndjson
    └── wn-settings.json
```

---

## HTTP API (for the curious / for automation)

All endpoints are local-only (bound to `127.0.0.1:7777`).

### Volumes & scans
- `GET /api/volumes` — list mountable sources
- `GET /api/scans` — list saved scan headers
- `POST /api/scan` `{path, skipTimeMachine}` — start a scan
- `POST /api/scan/pause | /resume | /cancel`
- `GET /api/active-scan`
- `POST /api/scans/delete` `{file}` — delete a scan (header + ndjson + errors + pending-trash)
- `POST /api/scan/update` `{scanFile}` — re-check pending-trash entries, prune ndjson if files actually gone

### Plans
- `GET /api/plans` — list saved plans
- `GET /api/plan/working` — get or create the Working plan
- `POST /api/plan/build` `{sourceScans, destination, layout, tieBreak, destMode}` — full-merge plan from scans
- `POST /api/plan/add | /remove | /clear`
- `POST /api/plan/update-settings`
- `POST /api/plan/save-as` `{planFile, name}`
- `POST /api/plan/delete`
- `GET /api/plan/entries?file=&limit=`
- `POST /api/plan/verify-sources` `{planFile}`

### Plan runs (executor)
- `POST /api/plan/run` `{planFile}` — start
- `GET /api/plan/run/status` — live state
- `POST /api/plan/run/pause | /resume | /cancel`
- `POST /api/plan/run/swap-ready | /skip-drive`

### File actions
- `POST /api/file/reveal` `{path}` — `open -R` in Finder
- `POST /api/file/trash` `{paths, scanFile}` — move to Trash via AppleScript
- `POST /api/choose-folder` — native Finder folder picker
- `POST /api/eject` `{path}` — `diskutil eject`

### Settings & trash log
- `GET/POST /api/settings` — `{trashRetention}`
- `GET /api/scan/pending-trash?file=`
- `POST /api/scan/set-trash-retention` `{scanFile, retentionOverride}`

---

## Roadmap & ideas

These are explored but not built. Pick what's interesting; they're all genuinely useful next steps.

### Visualization
- **Folder graph** (2D, SVG) — each folder a node sized by total bytes, edges between siblings and duplicates. Click to filter the table. Reveals structure across drives at a glance.
- **Folder treemap** (2D, canvas) — squares sized by bytes, nested by parent. Drill-down by click. Single most useful at-a-glance visualization for "where is my disk space."
- **3D map view** (Three.js via CDN) — three options to consider:
  - *Three-axis folder map*: X = age, Y = size, Z = type-concentration. Clusters of "old big videos" or "recent code" become spatially obvious.
  - *Drive constellation*: spheres per drive, lines weighted by duplicate counts between them. Shows your backup topology.
  - *Time tunnel*: depth = mtime, X/Y = folder. Fly through your file history.

### Smart workflows
- **Filter-as-recipe plans** — save a plan with a filter spec instead of frozen entries. Re-running re-derives the entry list against the latest scans. Enables "nightly photo backup" style automation.
- **Backup wizard with branches** — single "Backup something" button that asks: everything dedup'd / files matching a filter / specific files I'll pick / continue an existing plan. Replaces the current split between "Perfect backup" and "Build copy plan."
- **Project detection rules** — auto-tag folders by signature files (`.als` → Ableton, `.xcodeproj` → Xcode, `package.json` → Node, `.git` → repo, many `.jpg` from one date range → photo shoot). Group + filter by detected project type.

### Scanning
- **Quick refresh** per scan — lstat each path in the existing ndjson, prune what's gone, refresh changed mtimes/sizes. Much faster than a full rescan.
- **Delta scan** — readdir + diff against the previous ndjson. Finds new files and removed files, without rewriting the whole list.
- **Content-hash dedup** (optional pass) — for any size+name+ext bucket with >1 file, compute SHA1 of first/last 64KB + size. Eliminates the rare false positives the fast dedup might hit.

### UX polish
- **First-run onboarding card** — one-time tooltip or banner pointing at the backup button, dismissed forever after one click.
- **Per-scan retention override** — already supported on the server (`/api/scan/set-trash-retention`); needs a sidebar UI affordance.
- **Plan "open in view"** — load a plan's entries as a virtual scan so you can filter and edit them in the main table. Server already supports this via `/api/plan/entries`; UI not wired.

### Power tools
- **Diff two scans** — see what changed between scans of the same drive over time.
- **Re-scan all** — kick off fresh scans on every currently-mounted volume in one click.
- **Export filtered set** — dump the current filtered table to CSV / JSON for use outside the dashboard.

---

## Troubleshooting

**"Browse… → Folder pick failed: HTTP 404"** — the running server doesn't have the endpoint yet. Restart: `pkill -f "node server.js" && node server.js`. This happens after pulling new code.

**Scan shows lots of errors** — usually permission denied. Give your terminal "Full Disk Access" in *System Settings → Privacy & Security → Full Disk Access*, then re-scan.

**Drive swap modal won't continue** — the modal verifies the plugged-in drive's UUID against what the plan expects. Make sure you plugged the *exact* drive named in the modal. If you don't have that drive available, use **Skip drive** to mark its entries and continue with the rest.

**Plan "Run" disabled** — set a destination first. Pick a volume or click **Browse…**.

**Trashed files reappear after Update** — that means the files still exist on disk. You probably either restored them from Trash or didn't empty the Trash. The badge will flip to green ↩ "restored"; click ↻ again to acknowledge.

**Column widths look weird after pulling new code** — column-width localStorage has a version key. New columns trigger an auto-reset on next load. If you still see issues, click **Reset layout** in the header.

---

## License

MIT. See LICENSE if present, otherwise consider it MIT.

---

## Acknowledgments

Built incrementally as a real-world tool for organizing scattered drives. No frameworks, no build, no dependencies — just HTML, CSS, JS, and Node's standard library. The whole thing fits in two files plus a small JSON sidecar per scan.
