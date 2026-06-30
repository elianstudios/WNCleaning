#!/usr/bin/env node
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const PORT = 7777;
const ROOT = path.resolve(__dirname);
const SCANS_DIR = path.join(ROOT, 'scans');
if (!fs.existsSync(SCANS_DIR)) fs.mkdirSync(SCANS_DIR, { recursive: true });

// READ-ONLY GUARANTEE
// The scanner only writes inside the project folder (ROOT). Every write path is
// resolved and verified to live under ROOT. If anything ever tries to write
// outside, we throw and refuse. There is no delete, rename, or overwrite of any
// file on any scanned disk — only readdir/lstat (read-only syscalls) are used
// during a scan.
function assertInsideProject(targetPath) {
  const resolved = path.resolve(targetPath);
  const rel = path.relative(ROOT, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Refusing to write outside project root: ${resolved}`);
  }
  return resolved;
}

function safeWriteScan(filename, json) {
  const target = assertInsideProject(path.join(SCANS_DIR, filename));
  // Atomic write: write to .tmp then rename so the dashboard never reads
  // a half-written file mid-flush.
  const tmp = target + '.tmp';
  fs.writeFileSync(tmp, json);
  fs.renameSync(tmp, target);
  return target;
}

let activeScan = null;
let scanControl = { paused: false, cancelled: false };
const planJobs = new Map(); // planId → { status, progress, error }
let activePlanRun = null;   // { runId, planFile, state, ... }
let planRunControl = { paused: false, cancelled: false, swapReady: false, skipDrive: false };

function getVolumeUUID(volumePath) {
  // macOS diskutil exposes Volume UUID — survives unplug/replug, unlike mount path.
  try {
    const out = execSync(`diskutil info ${JSON.stringify(volumePath)} 2>/dev/null`, { encoding: 'utf8', timeout: 3000 });
    const m = out.match(/Volume UUID:\s+([A-F0-9-]+)/i);
    if (m) return m[1];
  } catch {}
  return null;
}
function getVolumeMeta(volumePath) {
  return {
    uuid: getVolumeUUID(volumePath),
    name: path.basename(volumePath) || volumePath,
  };
}
function listVolumes() {
  const vols = [];
  vols.push({ name: `Home (${os.userInfo().username})`, path: os.homedir(), uuid: null });
  vols.push({ name: 'Root /', path: '/', uuid: null });
  try {
    const entries = fs.readdirSync('/Volumes', { withFileTypes: true });
    for (const e of entries) {
      if (!e.isDirectory() && !e.isSymbolicLink()) continue;
      const p = path.join('/Volumes', e.name);
      vols.push({ name: e.name, path: p, uuid: getVolumeUUID(p) });
    }
  } catch {}
  return vols;
}

function safeStat(p) {
  try { return fs.lstatSync(p); } catch { return null; }
}

async function scan(rootPath, opts = {}) {
  const { onHeaderFlush, ndjsonStream, errorsStream, flushIntervalMs = 1000, skipTimeMachine = true, control } = opts;
  // No in-memory file array — every record is appended to ndjsonStream
  // and forgotten. Only counters + errors-sample stay in RAM.
  const errors = [];
  let errorCount = 0;
  let fileCount = 0;
  let dirCount = 0;
  let totalBytes = 0;
  let currentDir = rootPath;
  const start = Date.now();
  let lastFlush = 0;
  let pausedMs = 0;
  let currentPauseStart = 0;

  const skipDirs = new Set([
    '/System', '/private/var/vm', '/private/var/db',
    '/.Spotlight-V100', '/.Trashes', '/.fseventsd',
  ]);

  function header(done) {
    return {
      root: rootPath,
      scannedAt: new Date().toISOString(),
      durationMs: Date.now() - start - pausedMs - (currentPauseStart ? Date.now() - currentPauseStart : 0),
      fileCount,
      dirCount,
      totalBytes,
      currentDir,
      done: !!done,
      paused: !!(control && control.paused),
      cancelled: !!(control && control.cancelled),
      errorCount,
      errorsSample: errors.slice(0, 50),
    };
  }

  function pushError(rec) {
    errorCount++;
    if (errors.length < 50) errors.push(rec);
    if (errorsStream) errorsStream.write(JSON.stringify(rec) + '\n');
  }

  async function maybeFlush(force) {
    if (!onHeaderFlush) return;
    const now = Date.now();
    if (!force && now - lastFlush < flushIntervalMs) return;
    lastFlush = now;
    await onHeaderFlush(header(false));
  }

  const queue = [rootPath];
  let yieldCounter = 0;

  while (queue.length) {
    if (control && control.cancelled) break;
    if (control && control.paused) {
      // Idle loop while paused — keep flushing so the dashboard sees "paused" status.
      // Track paused wall time so it doesn't count toward scan duration.
      currentPauseStart = Date.now();
      while (control.paused && !control.cancelled) {
        await maybeFlush(true);
        await new Promise(r => setTimeout(r, 500));
      }
      pausedMs += Date.now() - currentPauseStart;
      currentPauseStart = 0;
      if (control.cancelled) break;
    }
    const dir = queue.shift();
    dirCount++;
    currentDir = dir;
    await maybeFlush();

    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      pushError({ path: dir, error: e.code || e.message });
      continue;
    }

    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (skipDirs.has(full)) continue;
      if (e.name.startsWith('.Spotlight') || e.name === '.Trashes' || e.name === '.fseventsd') continue;
      if (skipTimeMachine && e.isDirectory() && (
        e.name === 'Backups.backupdb' ||
        e.name === '.MobileBackups' ||
        e.name === '.TimeMachine' ||
        e.name === 'Time Machine Backups' ||
        e.name === '.com.apple.TimeMachine.supported' ||
        e.name === '.com.apple.timemachine.donotpresent' ||
        e.name === '.com.apple.timemachine.supported'
      )) continue;

      if (e.isDirectory()) {
        queue.push(full);
      } else if (e.isFile()) {
        let st;
        try { st = fs.lstatSync(full); }
        catch (err) {
          pushError({ path: full, error: err.code || err.message });
          continue;
        }
        const ext = path.extname(e.name).toLowerCase().replace('.', '');
        const rec = {
          name: e.name,
          path: full,
          size: st.size,
          mtime: Math.floor(st.mtimeMs),
          ext,
        };
        if (ndjsonStream) ndjsonStream.write(JSON.stringify(rec) + '\n');
        fileCount++;
        totalBytes += st.size;
      }
    }

    if (++yieldCounter % 5 === 0) {
      await new Promise(r => setImmediate(r));
    }
  }

  return header(true);
}

// ============================================================
// PLAN BUILDER — dedupe across scans, produce a copy plan.
// Phase 1 of the multi-drive backup workflow.
// ============================================================

function readNdjson(file) {
  const out = [];
  const fullPath = path.join(SCANS_DIR, file);
  try {
    const text = fs.readFileSync(fullPath, 'utf8');
    const lines = text.split('\n');
    for (const l of lines) {
      if (!l) continue;
      try { out.push(JSON.parse(l)); } catch {}
    }
  } catch {}
  return out;
}
function readJson(file) {
  try { return JSON.parse(fs.readFileSync(path.join(SCANS_DIR, file), 'utf8')); }
  catch { return null; }
}

function sanitizeForPath(name) {
  // Replace characters that break on common destination filesystems.
  return String(name).replace(/[/\\:*?"<>|]+/g, '_').trim() || 'unknown';
}

function dupeKey(rec) {
  // Fast dedup: size + name + ext.
  return `${rec.size}::${rec.name}::${rec.ext || ''}`;
}

function tieBreakWinner(a, b, mode) {
  // Returns true if `a` beats `b`.
  switch (mode) {
    case 'newest': return (a.mtime || 0) > (b.mtime || 0);
    case 'oldest': return (a.mtime || 0) < (b.mtime || 0);
    case 'shortestPath': return (a.path || '').length < (b.path || '').length;
    case 'largest': return (a.size || 0) > (b.size || 0);
    case 'firstScanned':
    default:
      // a.__scanOrder < b.__scanOrder means a came from an earlier-scanned source.
      return (a.__scanOrder || 0) < (b.__scanOrder || 0);
  }
}

// ============================================================
// PROJECT DETECTION + PROJECT-LEVEL DEDUP
// ============================================================

function globToRegExp(glob) {
  // Minimal glob: * matches any chars except /, ? one char, {a,b} alternation.
  let re = '^';
  let i = 0;
  while (i < glob.length) {
    const c = glob[i];
    if (c === '*') { re += '[^/]*'; i++; }
    else if (c === '?') { re += '[^/]'; i++; }
    else if (c === '{') {
      const end = glob.indexOf('}', i);
      if (end === -1) { re += '\\{'; i++; }
      else {
        const opts = glob.slice(i + 1, end).split(',').map(s => s.trim());
        re += '(?:' + opts.map(o => o.replace(/[.+^$()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')).join('|') + ')';
        i = end + 1;
      }
    } else if (/[.+^$()|[\]\\]/.test(c)) { re += '\\' + c; i++; }
    else { re += c; i++; }
  }
  re += '$';
  return new RegExp(re, 'i');
}
function makeGlobMatcher(glob) {
  const re = globToRegExp(glob);
  return (s) => re.test(s);
}

function evaluateRule(expr, folder) {
  // folder: { name, depth, immediateFiles: [name], immediateDirs: [name], allFilesByExt: {ext:count}, totalFilesByPattern: cache }
  if (!expr) return false;
  switch (expr.op) {
    case 'and':
      return (expr.items || []).every(e => evaluateRule(e, folder));
    case 'or':
      return (expr.items || []).some(e => evaluateRule(e, folder));
    case 'not':
      return !evaluateRule(expr.expr, folder);
    case 'file': {
      const m = makeGlobMatcher(expr.glob || '');
      return folder.immediateFiles.some(n => m(n));
    }
    case 'dir': {
      const m = makeGlobMatcher(expr.glob || '');
      return folder.immediateDirs.some(n => m(n));
    }
    case 'count': {
      const m = makeGlobMatcher(expr.glob || '');
      const want = expr.min || 1;
      // Count across the folder's entire subtree (files recorded for this root).
      let n = 0;
      for (const name of folder.subtreeFileNames) { if (m(name)) { n++; if (n >= want) return true; } }
      return n >= want;
    }
    case 'name': {
      const m = makeGlobMatcher(expr.glob || '');
      return m(folder.name);
    }
    case 'depth':
      return folder.depth >= (expr.min || 0);
    default:
      return false;
  }
}

function detectProjectsInScan({ records, root, driveName, rules, opaquePaths, detectNested }) {
  // For each folder in this scan, compute its immediate-children + subtree fingerprints,
  // then evaluate each rule. Returns: { projects: [...], fileToProject: Map<srcPath, projectId> }.
  const opaqueSet = new Set(opaquePaths);
  const isOpaqueSeg = (seg) => opaqueSet.has(seg);
  // Build a folder tree from the file list.
  const folders = new Map(); // absPath → { name, depth, parent, immediateFiles:Set, immediateDirs:Set, subtreeFileNames:[], subtreeFiles:[{relPath,size}] }
  function ensureFolder(absPath, depth, parent) {
    if (folders.has(absPath)) return folders.get(absPath);
    const f = {
      absPath, name: path.basename(absPath) || absPath,
      depth, parent,
      immediateFiles: new Set(),
      immediateDirs: new Set(),
      subtreeFileNames: [],
      subtreeFiles: [], // {relPath, size}
      hasOpaqueSeg: parent ? parent.hasOpaqueSeg : false,
    };
    if (opaqueSet.has(f.name)) f.hasOpaqueSeg = true;
    folders.set(absPath, f);
    return f;
  }
  // Root folder (scan root).
  const rootDepth = root.split('/').filter(Boolean).length;
  const rootFolder = ensureFolder(root, rootDepth, null);

  // Walk every file → register it with each ancestor.
  for (const rec of records) {
    if (!rec.path) continue;
    const segs = rec.path.split('/').filter(Boolean);
    // Build folder chain from root depth onwards.
    let cur = rootFolder;
    let curPath = root;
    for (let i = rootDepth; i < segs.length - 1; i++) {
      const seg = segs[i];
      curPath = curPath === '/' ? '/' + seg : curPath + '/' + seg;
      const child = ensureFolder(curPath, i + 1, cur);
      cur.immediateDirs.add(seg);
      cur = child;
    }
    const fname = segs[segs.length - 1];
    cur.immediateFiles.add(fname);
    // Record file in this folder + all ancestors' subtree.
    let walker = cur;
    while (walker) {
      walker.subtreeFileNames.push(fname);
      walker.subtreeFiles.push({
        absPath: rec.path, size: rec.size || 0,
        relPath: rec.path.slice(walker.absPath.length + 1),
      });
      walker = walker.parent;
    }
  }

  // Convert sets to arrays for evaluator.
  for (const f of folders.values()) {
    f.immediateFiles = [...f.immediateFiles];
    f.immediateDirs = [...f.immediateDirs];
  }

  // Evaluate rules per folder. Skip folders inside opaque paths (so node_modules/foo
  // doesn't get matched as a Node project because of its own package.json).
  const matchesByFolder = new Map(); // absPath → matched rule
  for (const folder of folders.values()) {
    if (folder.hasOpaqueSeg) continue;
    if (folder === rootFolder) continue; // don't claim the entire volume as one project
    for (const rule of rules) {
      if (evaluateRule(rule.expr, folder)) {
        matchesByFolder.set(folder.absPath, rule);
        break;
      }
    }
  }

  // Outermost-wins (unless detectNested): if an ancestor also matched, drop this match.
  const projects = [];
  for (const [absPath, rule] of matchesByFolder) {
    let parent = folders.get(absPath).parent;
    let hasAncestorMatch = false;
    while (parent) {
      if (matchesByFolder.has(parent.absPath)) { hasAncestorMatch = true; break; }
      parent = parent.parent;
    }
    if (!detectNested && hasAncestorMatch) continue;
    const f = folders.get(absPath);
    // Build signature: sorted "<relPath>:<size>" but excluding files inside any opaque segment.
    const sigItems = [];
    for (const sf of f.subtreeFiles) {
      const segs = sf.relPath.split('/');
      if (segs.some(s => isOpaqueSeg(s))) continue;
      sigItems.push(`${sf.relPath}:${sf.size}`);
    }
    sigItems.sort();
    projects.push({
      id: `${driveName || 'drive'}::${absPath}`,
      root: absPath,
      driveName,
      ruleId: rule.id, ruleName: rule.name, ruleColor: rule.color,
      fileCount: f.subtreeFiles.length,
      totalBytes: f.subtreeFiles.reduce((s, x) => s + (x.size || 0), 0),
      signatureItems: sigItems,
      files: f.subtreeFiles.map(x => ({ absPath: x.absPath, size: x.size })),
    });
  }
  return { projects };
}

function jaccard(aItems, bItems) {
  // Both arrays are sorted. Merge-walk for set ops.
  let i = 0, j = 0, inter = 0, uni = 0;
  while (i < aItems.length && j < bItems.length) {
    if (aItems[i] === bItems[j]) { inter++; uni++; i++; j++; }
    else if (aItems[i] < bItems[j]) { uni++; i++; }
    else { uni++; j++; }
  }
  uni += (aItems.length - i) + (bItems.length - j);
  return uni === 0 ? 0 : inter / uni;
}

function groupProjectsBySimilarity(projects, threshold) {
  // Union-find on projects where similarity >= threshold.
  const parent = new Array(projects.length); for (let i = 0; i < parent.length; i++) parent[i] = i;
  function find(x) { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; }
  function union(a, b) { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb; }
  // Bucket by ruleId AND nearby fileCount so we only compare plausible candidates.
  const buckets = new Map(); // `${ruleId}:bucket` → indices
  for (let i = 0; i < projects.length; i++) {
    const p = projects[i];
    // bucket by file count rounded to nearest 10%, so very different sizes never compared.
    const k = `${p.ruleId}:${Math.round(Math.log2(Math.max(1, p.fileCount)))}`;
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(i);
  }
  for (const indices of buckets.values()) {
    for (let a = 0; a < indices.length; a++) {
      for (let b = a + 1; b < indices.length; b++) {
        const ia = indices[a], ib = indices[b];
        if (find(ia) === find(ib)) continue;
        const sim = jaccard(projects[ia].signatureItems, projects[ib].signatureItems);
        if (sim >= threshold) union(ia, ib);
      }
    }
  }
  const groups = new Map();
  for (let i = 0; i < projects.length; i++) {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(i);
  }
  return [...groups.values()];
}

async function buildPlan(opts) {
  const {
    planId,
    sourceScans, // array of header.json file names, in user-specified order
    destination,
    layout = 'mirrored', // 'mirrored' | 'flat'
    tieBreak = 'firstScanned',
    destMode = 'additive', // 'additive' | 'overwrite' | 'fresh'
    projectDedupOverride = null, // null = use global settings; or {enabled, similarityThreshold, ...}
  } = opts;
  const settings = readSettings();
  const projCfg = { ...(settings.projectDedup || {}), ...(projectDedupOverride || {}) };

  const job = planJobs.get(planId);
  function setProgress(p) { if (job) job.progress = { ...(job.progress||{}), ...p }; }
  setProgress({ phase: 'reading-sources', filesRead: 0, totalSources: sourceScans.length });

  // 1. Read all source ndjson files and tag each record with its scan order + drive name.
  const sources = [];
  for (let i = 0; i < sourceScans.length; i++) {
    const headerFile = sourceScans[i];
    const header = readJson(headerFile);
    if (!header) { setProgress({ phase: 'reading-sources', warn: `Missing scan ${headerFile}` }); continue; }
    const ndjsonFile = header.ndjson || headerFile.replace('.header.json', '.ndjson');
    const driveName = header.volumeName || sanitizeForPath(path.basename(header.root || `drive_${i}`));
    const volumeUUID = header.volumeUUID || null;
    sources.push({
      headerFile, header, ndjsonFile, driveName, volumeUUID,
      root: header.root, scanOrder: i,
    });
    setProgress({ phase: 'reading-sources', filesRead: i + 1 });
  }

  // 2a. Load all records from all sources first (tagged with source meta).
  setProgress({ phase: 'loading-files' });
  const recordsPerSource = new Map(); // headerFile → [recs]
  for (const src of sources) {
    const ndjsonPath = path.join(SCANS_DIR, src.ndjsonFile);
    let text; try { text = fs.readFileSync(ndjsonPath, 'utf8'); } catch { continue; }
    const recs = [];
    let pos = 0, processed = 0;
    while (pos < text.length) {
      const nl = text.indexOf('\n', pos);
      const end = nl === -1 ? text.length : nl;
      const line = text.slice(pos, end);
      pos = end + 1;
      if (!line) continue;
      let rec;
      try { rec = JSON.parse(line); } catch { continue; }
      rec.__scanOrder = src.scanOrder;
      rec.__driveName = src.driveName;
      rec.__volumeUUID = src.volumeUUID;
      recs.push(rec);
      if (++processed % 50000 === 0) {
        setProgress({ phase: 'loading-files', processed });
        await new Promise(r => setImmediate(r));
      }
    }
    recordsPerSource.set(src.headerFile, recs);
  }

  // 2b. Project detection per source (if enabled).
  const allProjects = [];        // flat list across all sources
  const fileToProject = new Map();  // srcPath → project obj
  const projectLosersFileEntries = []; // accumulated for the entries file
  let projectsByRule = {};       // {ruleName: {kept, collapsed, total}}
  if (projCfg.enabled) {
    setProgress({ phase: 'detecting-projects' });
    for (const src of sources) {
      const recs = recordsPerSource.get(src.headerFile) || [];
      const { projects } = detectProjectsInScan({
        records: recs,
        root: src.root,
        driveName: src.driveName,
        rules: projCfg.rules || BUILTIN_PROJECT_RULES,
        opaquePaths: projCfg.opaquePaths || DEFAULT_OPAQUE_PATHS,
        detectNested: !!projCfg.detectNested,
      });
      for (const p of projects) {
        // Tag scan order on each project for tie-break.
        p.__scanOrder = src.scanOrder;
        p.__volumeUUID = src.volumeUUID;
        p.scanRoot = src.root;
        allProjects.push(p);
        for (const f of p.files) fileToProject.set(f.absPath, p);
      }
      await new Promise(r => setImmediate(r));
    }
    setProgress({ phase: 'deduping-projects', total: allProjects.length });
    const groups = groupProjectsBySimilarity(allProjects, projCfg.similarityThreshold || 0.9);
    for (const idxs of groups) {
      // Sort by tie-break and pick the winner.
      idxs.sort((a, b) => {
        const A = allProjects[a], B = allProjects[b];
        // Reuse the same tie-break semantics, mapped onto project metadata.
        switch (tieBreak) {
          case 'newest':       return (B.fileCount + (B.totalBytes || 0)) - (A.fileCount + (A.totalBytes || 0));
          case 'oldest':       return (A.fileCount + (A.totalBytes || 0)) - (B.fileCount + (B.totalBytes || 0));
          case 'shortestPath': return (A.root.length - B.root.length) || A.root.localeCompare(B.root);
          case 'largest':      return (B.totalBytes || 0) - (A.totalBytes || 0);
          case 'firstScanned':
          default:             return (A.__scanOrder || 0) - (B.__scanOrder || 0);
        }
      });
      const winnerProj = allProjects[idxs[0]];
      winnerProj.__winner = true;
      for (let k = 1; k < idxs.length; k++) {
        const loser = allProjects[idxs[k]];
        loser.__winner = false;
        loser.__winnerProjectRoot = winnerProj.root;
        loser.__winnerDrive = winnerProj.driveName;
        // Track per-rule stats.
        const key = winnerProj.ruleName;
        projectsByRule[key] = projectsByRule[key] || { kept: 0, collapsed: 0 };
        projectsByRule[key].collapsed++;
      }
      projectsByRule[winnerProj.ruleName] = projectsByRule[winnerProj.ruleName] || { kept: 0, collapsed: 0 };
      projectsByRule[winnerProj.ruleName].kept++;
    }
  }

  // 2c. File-level dedup over files NOT inside any project.
  setProgress({ phase: 'deduping' });
  const winners = new Map();
  const losers = new Map();
  let processedFiles = 0;
  for (const recs of recordsPerSource.values()) {
    for (const rec of recs) {
      // If this file is inside a project, skip file-level dedup — handled by project pass.
      if (fileToProject.has(rec.path)) continue;
      const key = dupeKey(rec);
      const cur = winners.get(key);
      if (!cur) winners.set(key, rec);
      else if (tieBreakWinner(rec, cur, tieBreak)) {
        const list = losers.get(key) || []; list.push(cur); losers.set(key, list);
        winners.set(key, rec);
      } else {
        const list = losers.get(key) || []; list.push(rec); losers.set(key, list);
      }
      if (++processedFiles % 50000 === 0) {
        setProgress({ phase: 'deduping', processed: processedFiles });
        await new Promise(r => setImmediate(r));
      }
    }
  }

  // 3. Read scan-time errors and add them as 'source-error' entries.
  const errorEntries = [];
  for (const src of sources) {
    const errorsFile = src.header.errors;
    if (!errorsFile) continue;
    for (const errRec of readNdjson(errorsFile)) {
      errorEntries.push({
        srcPath: errRec.path,
        srcVolumeUUID: src.volumeUUID,
        driveName: src.driveName,
        error: errRec.error,
        status: 'source-error',
      });
    }
  }

  // 4. Build entries (project winners + file winners + losers as skipped-*) and totals.
  setProgress({ phase: 'building-entries' });
  let totalFiles = 0, totalBytes = 0;
  const entries = [];

  // 4a. Project entries first (winners' files become 'pending'; losers' files become
  // 'skipped-project-duplicate' with a winnerProjectRoot reference).
  for (const proj of allProjects) {
    if (proj.__winner) {
      // Each file inside the winning project becomes a pending entry.
      const projDriveRoot = sources.find(s => s.scanOrder === proj.__scanOrder)?.root || proj.scanRoot;
      for (const f of proj.files) {
        let dstRelPath;
        if (layout === 'flat') {
          dstRelPath = path.basename(f.absPath);
        } else {
          let rel = f.absPath.startsWith(projDriveRoot)
            ? f.absPath.slice(projDriveRoot.length).replace(/^\/+/, '')
            : f.absPath.replace(/^\/+/, '');
          dstRelPath = path.join(sanitizeForPath(proj.driveName), rel);
        }
        entries.push({
          srcPath: f.absPath,
          srcVolumeUUID: proj.__volumeUUID,
          driveName: proj.driveName,
          dstRelPath,
          size: f.size, mtime: 0,
          ext: path.extname(f.absPath).toLowerCase().replace('.', ''),
          dupeKey: `project::${proj.id}`,
          status: 'pending',
          projectRoot: proj.root,
          projectRule: proj.ruleName,
        });
        totalFiles++;
        totalBytes += f.size || 0;
      }
    } else {
      // Loser project: every file becomes a skipped-project-duplicate entry.
      for (const f of proj.files) {
        entries.push({
          srcPath: f.absPath,
          srcVolumeUUID: proj.__volumeUUID,
          driveName: proj.driveName,
          size: f.size, mtime: 0,
          ext: path.extname(f.absPath).toLowerCase().replace('.', ''),
          dupeKey: `project::${proj.id}`,
          status: 'skipped-project-duplicate',
          projectRoot: proj.root,
          projectRule: proj.ruleName,
          winnerProjectRoot: proj.__winnerProjectRoot,
          winnerDrive: proj.__winnerDrive,
        });
      }
    }
  }

  // 4b. File-level winners + losers (loose files outside any project).
  for (const [key, w] of winners) {
    let dstRelPath;
    if (layout === 'flat') {
      dstRelPath = w.name; // collisions handled at copy time
    } else {
      // Mirrored: <DriveName>/<path relative to drive root>.
      const driveRoot = sources.find(s => s.scanOrder === w.__scanOrder).root;
      let rel = w.path.startsWith(driveRoot)
        ? w.path.slice(driveRoot.length).replace(/^\/+/, '')
        : w.path.replace(/^\/+/, '');
      dstRelPath = path.join(sanitizeForPath(w.__driveName), rel);
    }
    entries.push({
      srcPath: w.path,
      srcVolumeUUID: w.__volumeUUID,
      driveName: w.__driveName,
      dstRelPath,
      size: w.size,
      mtime: w.mtime,
      ext: w.ext,
      dupeKey: key,
      status: 'pending',
    });
    totalFiles++;
    totalBytes += w.size || 0;
    const lst = losers.get(key);
    if (lst) {
      for (const l of lst) {
        entries.push({
          srcPath: l.path,
          srcVolumeUUID: l.__volumeUUID,
          driveName: l.__driveName,
          size: l.size,
          mtime: l.mtime,
          ext: l.ext,
          dupeKey: key,
          status: 'skipped-duplicate',
          winnerPath: w.path,
        });
      }
    }
  }
  for (const e of errorEntries) entries.push(e);

  // 5. Sort entries by drive then by srcPath so the executor can process drive-by-drive.
  entries.sort((a, b) => {
    const da = a.driveName || ''; const db = b.driveName || '';
    if (da !== db) return da.localeCompare(db);
    return (a.srcPath || '').localeCompare(b.srcPath || '');
  });

  // 6. Write the plan files.
  setProgress({ phase: 'writing' });
  const entriesFile = `${planId}.entries.ndjson`;
  const planFile = `${planId}.plan.json`;
  const entriesPath = assertInsideProject(path.join(SCANS_DIR, entriesFile));
  const planPath = assertInsideProject(path.join(SCANS_DIR, planFile));
  const entriesStream = fs.createWriteStream(entriesPath);
  for (const e of entries) entriesStream.write(JSON.stringify(e) + '\n');
  await new Promise(r => entriesStream.end(r));

  const winnerCount = totalFiles;
  const loserCount = entries.filter(e => e.status === 'skipped-duplicate').length;
  const projectLoserCount = entries.filter(e => e.status === 'skipped-project-duplicate').length;
  const projectsKept = allProjects.filter(p => p.__winner).length;
  const projectsCollapsed = allProjects.length - projectsKept;
  const planHeader = {
    id: planId,
    createdAt: new Date().toISOString(),
    sources: sources.map(s => ({
      scan: s.headerFile, ndjson: s.ndjsonFile,
      volumeUUID: s.volumeUUID, driveName: s.driveName, root: s.root,
    })),
    destination, layout, dedup: 'fast', tieBreak, destMode,
    projectDedup: projCfg.enabled ? {
      enabled: true,
      similarityThreshold: projCfg.similarityThreshold,
      projectsKept, projectsCollapsed,
      byRule: projectsByRule,
    } : { enabled: false },
    totalFiles: winnerCount,
    totalBytes,
    duplicatesCollapsed: loserCount,
    projectDuplicatesCollapsed: projectLoserCount,
    errorCount: errorEntries.length,
    entriesFile,
    status: 'ready',
  };
  fs.writeFileSync(planPath, JSON.stringify(planHeader, null, 2));
  setProgress({ phase: 'done',
    totalFiles: winnerCount, totalBytes,
    duplicatesCollapsed: loserCount,
    projectDuplicatesCollapsed: projectLoserCount,
    projectsKept, projectsCollapsed,
    errorCount: errorEntries.length });
  if (job) job.status = 'done';
  return planHeader;
}

// ============================================================
// PLAN MUTATION — add / remove / clear / settings / save-as.
// Unifies the old "basket" concept with full-merge plans.
// ============================================================

const WORKING_PLAN_ID = 'working';
const WORKING_PLAN_FILE = 'working.plan.json';
const WORKING_ENTRIES_FILE = 'working.entries.ndjson';

function planPaths(planFile) {
  if (!planFile || typeof planFile !== 'string') throw new Error('planFile required');
  if (planFile.includes('/') || planFile.includes('..')) throw new Error('Invalid planFile');
  if (!planFile.endsWith('.plan.json')) throw new Error('Not a plan file');
  const stem = planFile.replace('.plan.json', '');
  return {
    header: assertInsideProject(path.join(SCANS_DIR, planFile)),
    entries: assertInsideProject(path.join(SCANS_DIR, stem + '.entries.ndjson')),
    entriesName: stem + '.entries.ndjson',
  };
}

function readPlanHeader(planFile) {
  const p = planPaths(planFile);
  try { return JSON.parse(fs.readFileSync(p.header, 'utf8')); }
  catch { return null; }
}

function writePlanHeader(planFile, header) {
  const p = planPaths(planFile);
  fs.writeFileSync(p.header, JSON.stringify(header, null, 2));
}

function readPlanEntries(planFile) {
  const p = planPaths(planFile);
  const out = [];
  try {
    const text = fs.readFileSync(p.entries, 'utf8');
    for (const line of text.split('\n')) {
      if (!line) continue;
      try { out.push(JSON.parse(line)); } catch {}
    }
  } catch {}
  return out;
}

function writePlanEntries(planFile, entries) {
  const p = planPaths(planFile);
  fs.writeFileSync(p.entries, entries.map(e => JSON.stringify(e)).join('\n') + (entries.length ? '\n' : ''));
}

function appendPlanEntries(planFile, entries) {
  const p = planPaths(planFile);
  fs.appendFileSync(p.entries, entries.map(e => JSON.stringify(e)).join('\n') + (entries.length ? '\n' : ''));
}

// ============================================================
// SETTINGS — global app prefs (currently: trash retention).
// ============================================================

const SETTINGS_FILE = path.join(SCANS_DIR, 'wn-settings.json');

// Built-in project-detection rules. Each has a boolean expression evaluated
// against a folder's immediate-child name list. Rules are AND/OR/NOT/groups.
// Expression node shapes:
//   { op: 'file', glob }                — folder contains a file matching glob
//   { op: 'dir', glob }                 — folder contains a child dir matching glob
//   { op: 'count', glob, min }          — folder has >= min files matching glob (recursive)
//   { op: 'name', glob }                — folder's own basename matches glob
//   { op: 'depth', min }                — folder depth >= min (segments)
//   { op: 'and', items: [...] }
//   { op: 'or', items: [...] }
//   { op: 'not', expr }
const BUILTIN_PROJECT_RULES = [
  { id: 'git',    name: 'Git repo',         color: 'green',
    expr: { op: 'dir', glob: '.git' } },
  { id: 'node',   name: 'Node project',     color: 'yellow',
    expr: { op: 'and', items: [
      { op: 'or', items: [
        { op: 'file', glob: 'package.json' },
        { op: 'file', glob: 'yarn.lock' },
        { op: 'file', glob: 'pnpm-lock.yaml' },
      ] },
      { op: 'not', expr: { op: 'name', glob: 'node_modules' } },
    ] } },
  { id: 'xcode',  name: 'Xcode project',    color: 'blue',
    expr: { op: 'or', items: [
      { op: 'dir', glob: '*.xcodeproj' },
      { op: 'dir', glob: '*.xcworkspace' },
    ] } },
  { id: 'rust',   name: 'Rust project',     color: 'orange',
    expr: { op: 'file', glob: 'Cargo.toml' } },
  { id: 'python', name: 'Python project',   color: 'purple',
    expr: { op: 'or', items: [
      { op: 'file', glob: 'pyproject.toml' },
      { op: 'file', glob: 'setup.py' },
      { op: 'file', glob: 'Pipfile' },
      { op: 'file', glob: 'requirements.txt' },
    ] } },
  { id: 'ableton', name: 'Ableton session', color: 'pink',
    expr: { op: 'count', glob: '*.als', min: 1 } },
  { id: 'photoshoot', name: 'Photo shoot',  color: 'teal',
    expr: { op: 'and', items: [
      { op: 'count', glob: '*.{jpg,jpeg,raw,heic,nef,cr2,arw,dng}', min: 30 },
      { op: 'depth', min: 3 },
    ] } },
  { id: 'video',  name: 'Video project',    color: 'red',
    expr: { op: 'or', items: [
      { op: 'file', glob: '*.prproj' },
      { op: 'file', glob: '*.aep' },
      { op: 'dir',  glob: '*.fcpxbundle' },
      { op: 'file', glob: '*.fcpxml' },
    ] } },
];
const DEFAULT_OPAQUE_PATHS = [
  'node_modules', '.git', 'dist', 'build', 'target', 'out',
  '.next', '.nuxt', '.cache', '.parcel-cache',
  'Pods', 'vendor', '.bundle',
  '__pycache__', '.pytest_cache', '.venv', 'venv',
];

function defaultSettings() {
  return {
    trashRetention: 'forever',
    projectDedup: {
      enabled: true,
      similarityThreshold: 0.9,
      detectNested: false,
      rules: BUILTIN_PROJECT_RULES,
      opaquePaths: DEFAULT_OPAQUE_PATHS,
    },
  };
}

function readSettings() {
  try {
    const parsed = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    // Migrate older files that didn't have projectDedup.
    const def = defaultSettings();
    if (!parsed.projectDedup) parsed.projectDedup = def.projectDedup;
    return parsed;
  } catch { return defaultSettings(); }
}
function writeSettings(s) {
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(s, null, 2));
}
function retentionMs(label) {
  if (label === '24h') return 24 * 3600 * 1000;
  if (label === '30d') return 30 * 24 * 3600 * 1000;
  return null; // forever
}
function pruneTrashLog(data, scanLevelOverride) {
  const global = readSettings();
  const effective = scanLevelOverride || data.retentionOverride || global.trashRetention || 'forever';
  const ms = retentionMs(effective);
  if (!ms) return { data, pruned: 0 }; // forever
  const cutoff = Date.now() - ms;
  const before = data.entries.length;
  data.entries = data.entries.filter(e => {
    const t = e.queuedAt ? new Date(e.queuedAt).getTime() : 0;
    return t >= cutoff;
  });
  return { data, pruned: before - data.entries.length };
}

function ensureWorkingPlan() {
  if (!fs.existsSync(path.join(SCANS_DIR, WORKING_PLAN_FILE))) {
    const header = {
      id: WORKING_PLAN_ID,
      kind: 'working',
      name: 'Working plan',
      createdAt: new Date().toISOString(),
      sources: [],
      destination: '',
      layout: 'mirrored',
      dedup: 'fast',
      tieBreak: 'firstScanned',
      destMode: 'additive',
      totalFiles: 0,
      totalBytes: 0,
      duplicatesCollapsed: 0,
      errorCount: 0,
      entriesFile: WORKING_ENTRIES_FILE,
      status: 'ready',
    };
    writePlanHeader(WORKING_PLAN_FILE, header);
    writePlanEntries(WORKING_PLAN_FILE, []);
  }
  return readPlanHeader(WORKING_PLAN_FILE);
}

function recomputePlanTotals(planFile) {
  const entries = readPlanEntries(planFile);
  let totalFiles = 0, totalBytes = 0, dupes = 0, errs = 0;
  for (const e of entries) {
    if (e.status === 'pending' || e.status === 'copied') {
      totalFiles++;
      totalBytes += e.size || 0;
    } else if (e.status === 'skipped-duplicate') dupes++;
    else if (e.status === 'source-error') errs++;
  }
  const header = readPlanHeader(planFile) || {};
  header.totalFiles = totalFiles;
  header.totalBytes = totalBytes;
  header.duplicatesCollapsed = dupes;
  header.errorCount = errs;
  writePlanHeader(planFile, header);
  return header;
}

// ============================================================
// PLAN EXECUTOR (Phase 3) — copy a plan's pending entries to
// the destination, drive-by-drive, with swap prompts.
// ============================================================

// ============================================================
// FILE ACTIONS — reveal in Finder, send to Trash (restorable).
// These are the ONLY endpoints in the whole app that can move
// files on disk. Every other operation is read-only or copy-only.
// ============================================================

function assertSafeSourcePath(p) {
  if (!p || typeof p !== 'string') throw new Error('Path required');
  const abs = path.resolve(p);
  if (abs === '/' || abs === '') throw new Error('Refusing path: root');
  if (abs.startsWith(ROOT)) throw new Error('Refusing path: inside project folder');
  // Refuse exact volume roots: /Volumes/Foo with no trailing path.
  const m = abs.match(/^\/Volumes\/[^/]+$/);
  if (m) throw new Error('Refusing path: volume root');
  if (!fs.existsSync(abs)) throw new Error('Path does not exist');
  return abs;
}

function volumePathOf(abs) {
  // Return the /Volumes/<name> prefix if applicable, else null (home/system path).
  const m = abs.match(/^(\/Volumes\/[^/]+)\//);
  return m ? m[1] : null;
}

function isVolumeMounted(volPath) {
  if (!volPath) return true; // home / system paths
  try { return fs.statSync(volPath).isDirectory(); } catch { return false; }
}

function revealInFinder(absPath) {
  // `open -R` selects the file in Finder.
  execSync(`open -R ${JSON.stringify(absPath)}`, { timeout: 5000 });
}

function moveToTrash(absPath) {
  // AppleScript -> Finder -> "move to trash". Restorable from Trash bin.
  // We escape the path for AppleScript by using a POSIX file reference.
  const escaped = absPath.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const script = `tell application "Finder" to delete (POSIX file "${escaped}" as alias)`;
  execSync(`osascript -e ${JSON.stringify(script)}`, { timeout: 15000 });
}

// pendingTrash sidecar: <scan_stem>.pending-trash.json — survives reload/restart.
function pendingTrashPath(scanFile) {
  if (!scanFile || typeof scanFile !== 'string' || scanFile.includes('/') || scanFile.includes('..')) {
    throw new Error('Invalid scan file');
  }
  if (!scanFile.endsWith('.header.json')) throw new Error('Not a scan header file');
  const stem = scanFile.replace('.header.json', '');
  return assertInsideProject(path.join(SCANS_DIR, stem + '.pending-trash.json'));
}
function readPendingTrash(scanFile) {
  try { return JSON.parse(fs.readFileSync(pendingTrashPath(scanFile), 'utf8')); }
  catch { return { entries: [] }; }
}
function writePendingTrash(scanFile, data) {
  fs.writeFileSync(pendingTrashPath(scanFile), JSON.stringify(data, null, 2));
}
function appendPendingTrash(scanFile, items) {
  const data = readPendingTrash(scanFile);
  const seen = new Set(data.entries.map(e => e.path));
  for (const it of items) {
    if (seen.has(it.path)) continue;
    data.entries.push({ ...it, queuedAt: new Date().toISOString(), status: 'trashed' });
    seen.add(it.path);
  }
  writePendingTrash(scanFile, data);
  return data;
}

function listMountedVolumes() {
  // Returns [{path, name, uuid}].
  const out = [];
  out.push({ path: os.homedir(), name: `Home`, uuid: null });
  try {
    for (const e of fs.readdirSync('/Volumes', { withFileTypes: true })) {
      if (!e.isDirectory() && !e.isSymbolicLink()) continue;
      const p = path.join('/Volumes', e.name);
      out.push({ path: p, name: e.name, uuid: getVolumeUUID(p) });
    }
  } catch {}
  return out;
}

function findMountedVolume(uuid, driveName) {
  const mounts = listMountedVolumes();
  if (uuid) {
    const byUUID = mounts.find(m => m.uuid && m.uuid.toLowerCase() === uuid.toLowerCase());
    if (byUUID) return byUUID;
  }
  if (driveName) {
    // Exact match.
    const byName = mounts.find(m => m.name === driveName);
    if (byName) return byName;
    // Case-insensitive match.
    const byNameCI = mounts.find(m => m.name.toLowerCase() === driveName.toLowerCase());
    if (byNameCI) return byNameCI;
    // macOS auto-rename: drive was scanned as "Foo", currently mounted as "Foo 1", "Foo 2", etc.
    // Match if a mounted volume's name starts with the scan-time name followed by a space.
    const byPrefix = mounts.find(m =>
      m.name.toLowerCase().startsWith(driveName.toLowerCase() + ' ') ||
      driveName.toLowerCase().startsWith(m.name.toLowerCase() + ' ')
    );
    if (byPrefix) return byPrefix;
  }
  return null;
}

function getDriveFreeBytes(volPath) {
  try {
    const out = execSync(`df -k ${JSON.stringify(volPath)}`, { encoding: 'utf8', timeout: 3000 });
    const lines = out.trim().split('\n');
    if (lines.length < 2) return null;
    const cols = lines[lines.length - 1].split(/\s+/);
    // df -k: Filesystem 1024-blocks Used Available Capacity Mounted_on
    // Available is column 3 (0-indexed) on macOS.
    const availKB = parseInt(cols[3], 10);
    if (!isFinite(availKB)) return null;
    return availKB * 1024;
  } catch { return null; }
}

function planFreshDestinationOK(destination) {
  try {
    const entries = fs.readdirSync(destination).filter(n => !n.startsWith('.'));
    return entries.length === 0;
  } catch { return false; }
}

function ensureDirSync(p) {
  fs.mkdirSync(p, { recursive: true });
}

function resolveDestinationPath(destinationRoot, entry, planHeader, usedNames) {
  // Returns the absolute destination path for this entry.
  const layout = planHeader.layout || 'mirrored';
  const driveName = entry.driveName ? sanitizeForPath(entry.driveName) : 'unknown_drive';
  if (layout === 'flat') {
    const base = entry.name || path.basename(entry.srcPath);
    let candidate = path.join(destinationRoot, base);
    if (usedNames.has(candidate) || fs.existsSync(candidate)) {
      const ext = path.extname(base);
      const stem = path.basename(base, ext);
      let n = 2;
      while (true) {
        candidate = path.join(destinationRoot, `${stem} (${n})${ext}`);
        if (!usedNames.has(candidate) && !fs.existsSync(candidate)) break;
        n++;
      }
    }
    usedNames.add(candidate);
    return candidate;
  }
  // Mirrored.
  if (entry.dstRelPath) {
    return path.join(destinationRoot, entry.dstRelPath);
  }
  // No precomputed rel path (manual add) — use <DriveName>/<basename>.
  return path.join(destinationRoot, driveName, entry.name || path.basename(entry.srcPath));
}

function rewriteEntriesAtomically(planFile, entries) {
  // Write all entries to a temp file then rename — never half-written for the dashboard.
  const p = planPaths(planFile);
  const tmp = p.entries + '.tmp';
  fs.writeFileSync(tmp, entries.map(e => JSON.stringify(e)).join('\n') + (entries.length ? '\n' : ''));
  fs.renameSync(tmp, p.entries);
}

async function runPlan(opts) {
  const { runId, planFile } = opts;
  const planHeader = readPlanHeader(planFile);
  if (!planHeader) throw new Error('Plan not found');
  const destinationRoot = planHeader.destination;
  if (!destinationRoot) throw new Error('Plan has no destination set');

  // Safety: refuse to write outside an existing directory, refuse "/", refuse project root.
  const destAbs = path.resolve(destinationRoot);
  if (destAbs === '/' || destAbs.startsWith(ROOT)) {
    throw new Error('Destination not allowed (cannot be / or inside the project folder).');
  }
  if (!fs.existsSync(destAbs) || !fs.statSync(destAbs).isDirectory()) {
    throw new Error('Destination does not exist or is not a directory.');
  }
  if (planHeader.destMode === 'fresh' && !planFreshDestinationOK(destAbs)) {
    throw new Error('Destination is not empty (destMode = fresh).');
  }

  const entries = readPlanEntries(planFile);
  const pendingEntries = entries.filter(e => e.status === 'pending');

  // Free-space check (1 GB safety margin).
  const remainingBytes = pendingEntries.reduce((s, e) => s + (e.size || 0), 0);
  const freeBytes = getDriveFreeBytes(destAbs);
  if (freeBytes !== null && freeBytes < remainingBytes + 1024 * 1024 * 1024) {
    throw new Error(`Destination has ${(freeBytes / 1e9).toFixed(2)} GB free but plan needs ${(remainingBytes / 1e9).toFixed(2)} GB.`);
  }

  // Group pending entries by source drive (UUID first, fall back to driveName).
  // Entries whose srcPath isn't on /Volumes/<X>/... live on the boot disk (home/system) and
  // never need a swap — group them under a sentinel key so they're treated as always-mounted.
  const groups = new Map(); // key → { uuid, driveName, isInternal, entries: [] }
  function classify(e) {
    const p = e.srcPath || '';
    const isInternal = !p.startsWith('/Volumes/');
    if (isInternal) {
      return { key: 'internal', uuid: null, driveName: 'Internal', isInternal: true };
    }
    if (e.srcVolumeUUID) {
      return { key: e.srcVolumeUUID, uuid: e.srcVolumeUUID, driveName: e.driveName || null, isInternal: false };
    }
    // Fall back to drive name derived from /Volumes/<name>/...
    const m = p.match(/^\/Volumes\/([^/]+)/);
    const drv = e.driveName || (m ? m[1] : 'unknown');
    return { key: `name:${drv}`, uuid: null, driveName: drv, isInternal: false };
  }
  for (const e of pendingEntries) {
    const cls = classify(e);
    if (!groups.has(cls.key)) groups.set(cls.key, { uuid: cls.uuid, driveName: cls.driveName, isInternal: cls.isInternal, entries: [] });
    groups.get(cls.key).entries.push(e);
  }
  const groupKeys = [...groups.keys()];

  activePlanRun = {
    runId, planFile, destination: destAbs,
    state: 'running',
    startedAt: Date.now(),
    totalFiles: pendingEntries.length,
    totalBytes: remainingBytes,
    copiedFiles: 0, copiedBytes: 0,
    skippedFiles: 0, failedFiles: 0,
    currentDrive: null, currentFile: null,
    awaitingSwap: null, // { uuid, driveName, expectedUUID }
    error: null,
    groupsTotal: groupKeys.length,
    groupsDone: 0,
  };
  planRunControl = { paused: false, cancelled: false, swapReady: false, skipDrive: false };

  const usedFlatNames = new Set();

  // Track in-memory copy of entries so we can mutate statuses and rewrite ndjson periodically.
  const entryById = new Map();
  for (const e of entries) entryById.set(e.srcPath, e);
  let dirtyCount = 0;
  let lastFlush = Date.now();
  async function flushIfNeeded(force) {
    const now = Date.now();
    if (!force && dirtyCount < 200 && now - lastFlush < 4000) return;
    rewriteEntriesAtomically(planFile, [...entryById.values()]);
    recomputePlanTotals(planFile);
    dirtyCount = 0; lastFlush = now;
  }

  function setState(s) { if (activePlanRun) activePlanRun.state = s; }

  try {
    for (const key of groupKeys) {
      if (planRunControl.cancelled) break;
      const grp = groups.get(key);
      // Find the mounted volume for this group.
      activePlanRun.currentDrive = { uuid: grp.uuid, driveName: grp.driveName };
      // Internal (boot disk / home / system) entries are always reachable — no swap.
      let mount = grp.isInternal
        ? { path: '/', name: 'Internal', uuid: null }
        : findMountedVolume(grp.uuid, grp.driveName);
      // If not present, ask for a swap.
      while (!mount && !planRunControl.cancelled) {
        planRunControl.skipDrive = false;
        planRunControl.swapReady = false;
        planRunControl.swapManualMount = null;
        activePlanRun.awaitingSwap = { uuid: grp.uuid, driveName: grp.driveName };
        setState('awaiting-swap');
        // Block until user signals swap-ready, skip-drive, or cancel.
        while (!planRunControl.swapReady && !planRunControl.skipDrive && !planRunControl.cancelled) {
          await new Promise(r => setTimeout(r, 500));
        }
        if (planRunControl.cancelled) break;
        if (planRunControl.skipDrive) {
          // Mark all entries in this group as skipped-volume-unavailable.
          for (const e of grp.entries) {
            const live = entryById.get(e.srcPath);
            if (live) { live.status = 'skipped-volume-unavailable'; dirtyCount++; }
          }
          await flushIfNeeded(true);
          break;
        }
        // If the user picked a specific mount in the modal, trust it.
        if (planRunControl.swapManualMount) {
          const p = planRunControl.swapManualMount;
          mount = { path: p, name: path.basename(p), uuid: getVolumeUUID(p) };
          planRunControl.swapManualMount = null;
          break;
        }
        mount = findMountedVolume(grp.uuid, grp.driveName);
        if (!mount) {
          // Brief pause and re-check, but stay in awaiting-swap state.
          await new Promise(r => setTimeout(r, 1500));
        }
      }
      if (planRunControl.cancelled) break;
      if (planRunControl.skipDrive) {
        planRunControl.skipDrive = false;
        activePlanRun.groupsDone++;
        continue;
      }

      activePlanRun.awaitingSwap = null;
      setState('running');
      const sourceRoot = mount.path;
      // Translate srcPath if the volume re-mounted at a different path than scan time.
      // For internal entries the path is absolute and never needs translation.
      const scanRoot = !grp.isInternal && grp.entries[0] && grp.entries[0].srcPath
        ? '/Volumes/' + (grp.driveName || '')
        : null;

      activePlanRun.currentDrive = { uuid: mount.uuid, driveName: mount.name, mountPath: sourceRoot };

      for (const e of grp.entries) {
        if (planRunControl.cancelled) break;
        // Honor pause.
        while (planRunControl.paused && !planRunControl.cancelled) {
          setState('paused');
          await new Promise(r => setTimeout(r, 500));
        }
        if (planRunControl.cancelled) break;
        setState('running');

        // Translate source path if volume name shifted on remount.
        let srcAbs = e.srcPath;
        if (scanRoot && srcAbs.startsWith(scanRoot) && sourceRoot !== scanRoot) {
          srcAbs = sourceRoot + srcAbs.slice(scanRoot.length);
        }

        activePlanRun.currentFile = srcAbs;

        const live = entryById.get(e.srcPath);
        if (!live) continue;

        if (!fs.existsSync(srcAbs)) {
          live.status = 'source-missing'; dirtyCount++;
          activePlanRun.failedFiles++;
          await flushIfNeeded();
          continue;
        }

        // Compute destination path per layout.
        const dstAbs = resolveDestinationPath(destAbs, e, planHeader, usedFlatNames);
        if (dstAbs === destAbs || dstAbs.startsWith(ROOT)) {
          live.status = 'failed'; live.error = 'unsafe-destination'; dirtyCount++;
          activePlanRun.failedFiles++;
          await flushIfNeeded();
          continue;
        }

        // Ensure destination dir.
        try { ensureDirSync(path.dirname(dstAbs)); }
        catch (err) {
          live.status = 'failed'; live.error = 'mkdir:' + err.code; dirtyCount++;
          activePlanRun.failedFiles++;
          await flushIfNeeded();
          continue;
        }

        // Copy according to destMode.
        try {
          const destExists = fs.existsSync(dstAbs);
          if (destExists && planHeader.destMode === 'additive') {
            live.status = 'skipped-exists'; dirtyCount++;
            activePlanRun.skippedFiles++;
            await flushIfNeeded();
            continue;
          }
          if (destExists && planHeader.destMode === 'overwrite') {
            fs.copyFileSync(srcAbs, dstAbs); // overwrite
          } else {
            // additive (no dst) or fresh: use COPYFILE_EXCL to never overwrite even on race.
            fs.copyFileSync(srcAbs, dstAbs, fs.constants.COPYFILE_EXCL);
          }
          live.status = 'copied'; live.copiedAt = Date.now(); dirtyCount++;
          activePlanRun.copiedFiles++;
          activePlanRun.copiedBytes += live.size || 0;
        } catch (err) {
          live.status = 'failed'; live.error = err.code || err.message; dirtyCount++;
          activePlanRun.failedFiles++;
        }
        await flushIfNeeded();
      }
      activePlanRun.groupsDone++;
    }
  } finally {
    await flushIfNeeded(true);
    if (planRunControl.cancelled) setState('cancelled');
    else setState('done');
    activePlanRun.finishedAt = Date.now();
  }
}

function sendJSON(res, status, body) {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(json),
  });
  res.end(json);
}

function sendFile(res, filePath, contentType, range) {
  let data;
  try {
    data = fs.readFileSync(filePath);
  } catch (err) {
    res.writeHead(404); res.end('Not found'); return;
  }
  if (range) {
    const m = /^bytes=(\d+)-(\d*)$/.exec(range);
    if (m) {
      const start = +m[1];
      const end = m[2] ? +m[2] : data.length - 1;
      if (start >= data.length) {
        res.writeHead(200, {
          'Content-Type': contentType,
          'Content-Length': 0,
          'Cache-Control': 'no-store',
        });
        return res.end();
      }
      const slice = data.slice(start, end + 1);
      res.writeHead(206, {
        'Content-Type': contentType,
        'Content-Length': slice.length,
        'Content-Range': `bytes ${start}-${start + slice.length - 1}/${data.length}`,
        'Cache-Control': 'no-store',
      });
      return res.end(slice);
    }
  }
  res.writeHead(200, {
    'Content-Type': contentType,
    'Content-Length': data.length,
    'Cache-Control': 'no-store, no-cache, must-revalidate',
  });
  res.end(data);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === '/') {
    return sendFile(res, path.join(ROOT, 'index.html'), 'text/html; charset=utf-8');
  }
  if (url.pathname === '/api/volumes') {
    return sendJSON(res, 200, { volumes: listVolumes() });
  }
  if (url.pathname === '/api/scans') {
    try {
      const files = fs.readdirSync(SCANS_DIR)
        .filter(f => f.endsWith('.header.json'))
        .map(f => {
          const st = fs.statSync(path.join(SCANS_DIR, f));
          const ndjson = f.replace('.header.json', '.ndjson');
          let ndjsonSize = 0;
          try { ndjsonSize = fs.statSync(path.join(SCANS_DIR, ndjson)).size; } catch {}
          return { file: f, size: st.size + ndjsonSize, mtime: st.mtimeMs, ndjson };
        })
        .sort((a, b) => b.mtime - a.mtime);
      return sendJSON(res, 200, { scans: files });
    } catch (e) {
      return sendJSON(res, 500, { error: e.message });
    }
  }
  if (url.pathname.startsWith('/scans/')) {
    const name = path.basename(url.pathname);
    return sendFile(res, path.join(SCANS_DIR, name), 'application/json; charset=utf-8', req.headers.range);
  }
  if (url.pathname === '/api/scan' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { path: target, skipTimeMachine = true } = JSON.parse(body || '{}');
        if (!target || !fs.existsSync(target)) {
          return sendJSON(res, 400, { error: 'Invalid path' });
        }
        if (activeScan && !activeScan.done) {
          return sendJSON(res, 409, { error: 'A scan is already running', file: activeScan.file });
        }
        const safeName = target.replace(/[^a-z0-9]+/gi, '_').replace(/^_|_$/g, '') || 'root';
        const stem = `scan_${safeName}_${Date.now()}`;
        const headerFile = `${stem}.header.json`;
        const ndjsonFile = `${stem}.ndjson`;
        const errorsFile = `${stem}.errors.ndjson`;
        const ndjsonPath = assertInsideProject(path.join(SCANS_DIR, ndjsonFile));
        const errorsPath = assertInsideProject(path.join(SCANS_DIR, errorsFile));
        activeScan = { file: headerFile, ndjson: ndjsonFile, errors: errorsFile, root: target, done: false };
        scanControl = { paused: false, cancelled: false };
        // Capture volume identity so the plan executor can prompt for the right drive later,
        // even after it's been unplugged and re-mounted (UUID survives, mount path doesn't).
        const volMeta = getVolumeMeta(target);
        safeWriteScan(headerFile, JSON.stringify({
          root: target, scannedAt: new Date().toISOString(),
          durationMs: 0, fileCount: 0, dirCount: 0, currentDir: target,
          done: false, errorCount: 0, ndjson: ndjsonFile, errors: errorsFile,
          volumeUUID: volMeta.uuid, volumeName: volMeta.name,
        }));
        // Open append streams. Truncate first.
        fs.writeFileSync(ndjsonPath, '');
        fs.writeFileSync(errorsPath, '');
        const ndjsonStream = fs.createWriteStream(ndjsonPath, { flags: 'a' });
        const errorsStream = fs.createWriteStream(errorsPath, { flags: 'a' });
        sendJSON(res, 200, { file: headerFile, ndjson: ndjsonFile, errors: errorsFile, root: target });

        // Fire-and-forget background scan.
        (async () => {
          try {
            const result = await scan(target, {
              flushIntervalMs: 1000,
              ndjsonStream,
              errorsStream,
              skipTimeMachine,
              control: scanControl,
              onHeaderFlush: h => {
                h.ndjson = ndjsonFile;
                h.errors = errorsFile;
                h.volumeUUID = volMeta.uuid;
                h.volumeName = volMeta.name;
                try { safeWriteScan(headerFile, JSON.stringify(h)); }
                catch (err) { console.error('[header flush]', err.message); }
              },
            });
            await new Promise(r => ndjsonStream.end(r));
            await new Promise(r => errorsStream.end(r));
            result.ndjson = ndjsonFile;
            result.errors = errorsFile;
            result.volumeUUID = volMeta.uuid;
            result.volumeName = volMeta.name;
            safeWriteScan(headerFile, JSON.stringify(result));
            activeScan = { file: headerFile, ndjson: ndjsonFile, errors: errorsFile, root: target, done: true };
          } catch (e) {
            console.error('[scan]', e.message);
            try { ndjsonStream.end(); } catch {}
            try { errorsStream.end(); } catch {}
            activeScan = { file: headerFile, ndjson: ndjsonFile, errors: errorsFile, root: target, done: true, error: e.message };
          }
        })();
      } catch (e) {
        sendJSON(res, 500, { error: e.message });
      }
    });
    return;
  }
  if (url.pathname === '/api/eject' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { path: p } = JSON.parse(body || '{}');
        if (!p || typeof p !== 'string') return sendJSON(res, 400, { error: 'path required' });
        if (!p.startsWith('/Volumes/')) return sendJSON(res, 400, { error: 'Refusing to eject non-/Volumes path' });
        if (p === '/' || p === '/Volumes') return sendJSON(res, 400, { error: 'Refusing root' });
        execSync(`diskutil eject ${JSON.stringify(p)}`, { timeout: 30000 });
        return sendJSON(res, 200, { ok: true });
      } catch (e) { return sendJSON(res, 500, { error: e.message }); }
    });
    return;
  }
  if (url.pathname === '/api/plan/verify-sources' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { planFile } = JSON.parse(body || '{}');
        if (!planFile) return sendJSON(res, 400, { error: 'planFile required' });
        const entries = readPlanEntries(planFile);
        const pending = entries.filter(e => e.status === 'pending');
        // Group by source drive name (UUID-less entries lump under driveName).
        const byDrive = new Map();
        let missing = 0, ok = 0, driveOffline = 0;
        for (const e of pending) {
          const drv = e.driveName || 'Internal';
          if (!byDrive.has(drv)) byDrive.set(drv, { drive: drv, uuid: e.srcVolumeUUID || null, missing: 0, ok: 0, driveOffline: 0, total: 0 });
          const row = byDrive.get(drv); row.total++;
          const vol = e.srcPath && e.srcPath.startsWith('/Volumes/')
            ? '/' + e.srcPath.split('/').slice(1, 3).join('/') : null;
          if (vol && !isVolumeMounted(vol)) {
            row.driveOffline++; driveOffline++; continue;
          }
          if (fs.existsSync(e.srcPath)) { row.ok++; ok++; }
          else { row.missing++; missing++; }
        }
        return sendJSON(res, 200, {
          totalPending: pending.length, ok, missing, driveOffline,
          perDrive: [...byDrive.values()],
        });
      } catch (e) { sendJSON(res, 500, { error: e.message }); }
    });
    return;
  }
  if (url.pathname === '/api/choose-folder' && req.method === 'POST') {
    // Opens a native macOS Finder folder picker. Blocks until user picks or cancels.
    try {
      // The 'with prompt' wording shows up in the picker title bar.
      const script = `POSIX path of (choose folder with prompt "Choose copy destination")`;
      const out = execSync(`osascript -e ${JSON.stringify(script)}`, { encoding: 'utf8', timeout: 600000 });
      const chosen = (out || '').trim().replace(/\/$/, '');
      if (!chosen) return sendJSON(res, 200, { cancelled: true });
      return sendJSON(res, 200, { path: chosen });
    } catch (e) {
      // User cancel returns non-zero exit; treat as cancellation, not error.
      if (/User canceled|User cancelled|-128/.test(e.message)) {
        return sendJSON(res, 200, { cancelled: true });
      }
      return sendJSON(res, 500, { error: e.message });
    }
    return;
  }
  if (url.pathname === '/api/file/reveal' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { path: p } = JSON.parse(body || '{}');
        const abs = path.resolve(p || '');
        const vol = volumePathOf(abs);
        if (vol && !isVolumeMounted(vol)) {
          return sendJSON(res, 409, { error: 'drive-not-mounted', volume: vol });
        }
        const safe = assertSafeSourcePath(p);
        revealInFinder(safe);
        return sendJSON(res, 200, { ok: true });
      } catch (e) {
        sendJSON(res, 400, { error: e.message });
      }
    });
    return;
  }
  if (url.pathname === '/api/file/trash' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { paths: ps, scanFile } = JSON.parse(body || '{}');
        if (!Array.isArray(ps) || !ps.length) return sendJSON(res, 400, { error: 'paths[] required' });
        if (!scanFile) return sendJSON(res, 400, { error: 'scanFile required' });
        const result = { trashed: [], errors: [] };
        for (const p of ps) {
          try {
            const abs = path.resolve(p);
            const vol = volumePathOf(abs);
            if (vol && !isVolumeMounted(vol)) {
              result.errors.push({ path: p, error: 'drive-not-mounted' });
              continue;
            }
            const safe = assertSafeSourcePath(p);
            moveToTrash(safe);
            result.trashed.push(safe);
          } catch (err) {
            result.errors.push({ path: p, error: err.message });
          }
        }
        if (result.trashed.length) {
          appendPendingTrash(scanFile, result.trashed.map(pp => ({ path: pp })));
        }
        return sendJSON(res, 200, result);
      } catch (e) {
        sendJSON(res, 500, { error: e.message });
      }
    });
    return;
  }
  if (url.pathname === '/api/scan/pending-trash' && req.method === 'GET') {
    const scanFile = url.searchParams.get('file');
    if (!scanFile) return sendJSON(res, 400, { error: 'file required' });
    try {
      const data = readPendingTrash(scanFile);
      const { data: kept, pruned } = pruneTrashLog(data);
      if (pruned > 0) writePendingTrash(scanFile, kept);
      return sendJSON(res, 200, kept);
    }
    catch (e) { return sendJSON(res, 400, { error: e.message }); }
  }
  if (url.pathname === '/api/settings' && req.method === 'GET') {
    return sendJSON(res, 200, readSettings());
  }
  if (url.pathname === '/api/settings' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const incoming = JSON.parse(body || '{}');
        const cur = readSettings();
        const next = { ...cur, ...incoming };
        if (next.trashRetention && !['forever','24h','30d'].includes(next.trashRetention)) {
          return sendJSON(res, 400, { error: 'Invalid trashRetention' });
        }
        writeSettings(next);
        return sendJSON(res, 200, next);
      } catch (e) { sendJSON(res, 500, { error: e.message }); }
    });
    return;
  }
  if (url.pathname === '/api/settings/project-rules/reset' && req.method === 'POST') {
    try {
      const cur = readSettings();
      cur.projectDedup = defaultSettings().projectDedup;
      writeSettings(cur);
      return sendJSON(res, 200, cur);
    } catch (e) { return sendJSON(res, 500, { error: e.message }); }
  }
  if (url.pathname === '/api/scan/set-trash-retention' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { scanFile, retentionOverride } = JSON.parse(body || '{}');
        if (!scanFile) return sendJSON(res, 400, { error: 'scanFile required' });
        if (retentionOverride && !['forever','24h','30d'].includes(retentionOverride)) {
          return sendJSON(res, 400, { error: 'Invalid retentionOverride' });
        }
        const data = readPendingTrash(scanFile);
        if (retentionOverride) data.retentionOverride = retentionOverride;
        else delete data.retentionOverride;
        writePendingTrash(scanFile, data);
        return sendJSON(res, 200, { ok: true, retentionOverride: data.retentionOverride || null });
      } catch (e) { sendJSON(res, 500, { error: e.message }); }
    });
    return;
  }
  if (url.pathname === '/api/scan/update' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { scanFile } = JSON.parse(body || '{}');
        if (!scanFile) return sendJSON(res, 400, { error: 'scanFile required' });
        const header = readJson(scanFile);
        if (!header) return sendJSON(res, 404, { error: 'Scan not found' });
        const data = readPendingTrash(scanFile);
        // Pre-prune by retention so this Update also enforces the window.
        const { pruned: retentionPruned } = pruneTrashLog(data);

        // Check each pending path on disk.
        const reallyGone = new Set();
        const restoredNow = [];
        const acknowledgeRestoredPaths = new Set();
        let checked = 0;
        for (const e of data.entries) {
          checked++;
          // If this entry was already in 'restored' status before this Update,
          // the user has acknowledged the restore — drop it from the active log.
          if (e.status === 'restored') {
            acknowledgeRestoredPaths.add(e.path);
            continue;
          }
          if (e.status === 'deleted') { reallyGone.add(e.path); continue; }
          const vol = volumePathOf(e.path);
          if (vol && !isVolumeMounted(vol)) {
            // Can't tell yet — leave alone.
            continue;
          }
          if (fs.existsSync(e.path)) {
            // Still present — user restored from Trash this cycle.
            e.status = 'restored';
            restoredNow.push(e.path);
          } else {
            e.status = 'deleted';
            reallyGone.add(e.path);
          }
        }

        // Rewrite ndjson without the really-gone entries.
        const ndjsonFile = header.ndjson || scanFile.replace('.header.json', '.ndjson');
        const ndjsonPath = path.join(SCANS_DIR, ndjsonFile);
        let removed = 0;
        let newFileCount = 0;
        let newTotalBytes = 0;
        if (reallyGone.size && fs.existsSync(ndjsonPath)) {
          const tmp = ndjsonPath + '.tmp';
          const text = fs.readFileSync(ndjsonPath, 'utf8');
          const out = [];
          let pos = 0;
          while (pos < text.length) {
            const nl = text.indexOf('\n', pos);
            const end = nl === -1 ? text.length : nl;
            const line = text.slice(pos, end);
            pos = end + 1;
            if (!line) continue;
            try {
              const rec = JSON.parse(line);
              if (reallyGone.has(rec.path)) { removed++; continue; }
              newFileCount++;
              newTotalBytes += rec.size || 0;
              out.push(line);
            } catch {}
          }
          fs.writeFileSync(tmp, out.join('\n') + (out.length ? '\n' : ''));
          fs.renameSync(tmp, ndjsonPath);
          // Update scan header totals.
          header.fileCount = newFileCount;
          header.totalBytes = newTotalBytes;
          safeWriteScan(scanFile, JSON.stringify(header));
        }

        // Drop deleted (gone) entries AND restored-acked entries from the active log.
        const remaining = data.entries.filter(e =>
          e.status !== 'deleted' && !acknowledgeRestoredPaths.has(e.path)
        );
        writePendingTrash(scanFile, { ...data, entries: remaining });

        return sendJSON(res, 200, {
          checked, removed, restored: restoredNow.length,
          restoredAcked: acknowledgeRestoredPaths.size,
          retentionPruned,
          stillPending: remaining.filter(e => e.status === 'trashed').length,
        });
      } catch (e) {
        sendJSON(res, 500, { error: e.message });
      }
    });
    return;
  }
  if (url.pathname === '/api/scans/delete' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { file } = JSON.parse(body || '{}');
        if (!file || typeof file !== 'string' || file.includes('/') || file.includes('\\') || file.includes('..')) {
          return sendJSON(res, 400, { error: 'Invalid file name' });
        }
        if (!file.endsWith('.header.json')) {
          return sendJSON(res, 400, { error: 'Only header files can be specified' });
        }
        if (activeScan && !activeScan.done && activeScan.file === file) {
          return sendJSON(res, 409, { error: 'Cannot delete a scan that is still running' });
        }
        const stem = file.replace('.header.json', '');
        const targets = [
          path.join(SCANS_DIR, file),
          path.join(SCANS_DIR, stem + '.ndjson'),
          path.join(SCANS_DIR, stem + '.errors.ndjson'),
          path.join(SCANS_DIR, stem + '.pending-trash.json'),
        ];
        const deleted = [];
        for (const t of targets) {
          try {
            assertInsideProject(t);
            if (fs.existsSync(t)) { fs.unlinkSync(t); deleted.push(path.basename(t)); }
          } catch (err) {
            return sendJSON(res, 500, { error: err.message });
          }
        }
        return sendJSON(res, 200, { deleted });
      } catch (e) {
        sendJSON(res, 500, { error: e.message });
      }
    });
    return;
  }
  if (url.pathname === '/api/active-scan') {
    return sendJSON(res, 200, activeScan || { file: null, done: true });
  }
  if (url.pathname === '/api/scan/pause' && req.method === 'POST') {
    if (!activeScan || activeScan.done) return sendJSON(res, 400, { error: 'No active scan' });
    scanControl.paused = true;
    return sendJSON(res, 200, { ok: true, paused: true });
  }
  if (url.pathname === '/api/scan/resume' && req.method === 'POST') {
    if (!activeScan || activeScan.done) return sendJSON(res, 400, { error: 'No active scan' });
    scanControl.paused = false;
    return sendJSON(res, 200, { ok: true, paused: false });
  }
  if (url.pathname === '/api/scan/cancel' && req.method === 'POST') {
    if (!activeScan || activeScan.done) return sendJSON(res, 400, { error: 'No active scan' });
    scanControl.cancelled = true;
    scanControl.paused = false;
    return sendJSON(res, 200, { ok: true, cancelled: true });
  }
  if (url.pathname === '/api/plans' && req.method === 'GET') {
    try {
      const files = fs.readdirSync(SCANS_DIR)
        .filter(f => f.endsWith('.plan.json'))
        .map(f => {
          const st = fs.statSync(path.join(SCANS_DIR, f));
          let header = null;
          try { header = JSON.parse(fs.readFileSync(path.join(SCANS_DIR, f), 'utf8')); } catch {}
          return { file: f, mtime: st.mtimeMs, size: st.size, header };
        })
        .sort((a, b) => b.mtime - a.mtime);
      return sendJSON(res, 200, { plans: files });
    } catch (e) {
      return sendJSON(res, 500, { error: e.message });
    }
  }
  if (url.pathname === '/api/plan/build' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const { sourceScans, destination, layout, tieBreak, destMode } = JSON.parse(body || '{}');
        if (!Array.isArray(sourceScans) || sourceScans.length === 0) {
          return sendJSON(res, 400, { error: 'No source scans specified' });
        }
        if (!destination || typeof destination !== 'string') {
          return sendJSON(res, 400, { error: 'Destination required' });
        }
        const planId = `plan_${Date.now()}`;
        planJobs.set(planId, { status: 'running', progress: { phase: 'starting' } });
        sendJSON(res, 200, { planId });
        // Run in background; client polls /api/plan/status.
        (async () => {
          try {
            await buildPlan({ planId, sourceScans, destination, layout, tieBreak, destMode });
          } catch (e) {
            console.error('[plan build]', e);
            const job = planJobs.get(planId);
            if (job) { job.status = 'failed'; job.error = e.message; }
          }
        })();
      } catch (e) {
        sendJSON(res, 500, { error: e.message });
      }
    });
    return;
  }
  if (url.pathname === '/api/plan/status') {
    const planId = url.searchParams.get('id');
    if (!planId) return sendJSON(res, 400, { error: 'id required' });
    const job = planJobs.get(planId);
    if (!job) return sendJSON(res, 404, { error: 'No such job' });
    return sendJSON(res, 200, job);
  }
  if (url.pathname === '/api/plan/delete' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { file } = JSON.parse(body || '{}');
        if (!file || typeof file !== 'string' || file.includes('/') || file.includes('..')) {
          return sendJSON(res, 400, { error: 'Invalid file' });
        }
        if (!file.endsWith('.plan.json')) return sendJSON(res, 400, { error: 'Not a plan file' });
        const stem = file.replace('.plan.json', '');
        const targets = [
          path.join(SCANS_DIR, file),
          path.join(SCANS_DIR, stem + '.entries.ndjson'),
        ];
        for (const t of targets) {
          assertInsideProject(t);
          if (fs.existsSync(t)) fs.unlinkSync(t);
        }
        return sendJSON(res, 200, { ok: true });
      } catch (e) {
        sendJSON(res, 500, { error: e.message });
      }
    });
    return;
  }
  if (url.pathname === '/api/plan/working' && req.method === 'GET') {
    try {
      const header = ensureWorkingPlan();
      return sendJSON(res, 200, { plan: header });
    } catch (e) { return sendJSON(res, 500, { error: e.message }); }
  }
  if (url.pathname === '/api/plan/add' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { planFile, entries: incoming } = JSON.parse(body || '{}');
        if (!Array.isArray(incoming)) return sendJSON(res, 400, { error: 'entries[] required' });
        const target = planFile || WORKING_PLAN_FILE;
        if (target === WORKING_PLAN_FILE) ensureWorkingPlan();
        if (!readPlanHeader(target)) return sendJSON(res, 404, { error: 'Plan not found' });
        const existing = readPlanEntries(target);
        const seen = new Set(existing.map(e => e.srcPath));
        const toAppend = [];
        let skipped = 0;
        for (const inc of incoming) {
          if (!inc || !inc.srcPath) continue;
          if (seen.has(inc.srcPath)) { skipped++; continue; }
          seen.add(inc.srcPath);
          toAppend.push({
            srcPath: inc.srcPath,
            srcVolumeUUID: inc.srcVolumeUUID || null,
            driveName: inc.driveName || null,
            dstRelPath: inc.dstRelPath || null,
            size: inc.size || 0,
            mtime: inc.mtime || 0,
            ext: inc.ext || '',
            name: inc.name || path.basename(inc.srcPath),
            dupeKey: 'manual::' + inc.srcPath,
            status: 'pending',
          });
        }
        if (toAppend.length) appendPlanEntries(target, toAppend);
        const header = recomputePlanTotals(target);
        return sendJSON(res, 200, { added: toAppend.length, skipped, total: header.totalFiles });
      } catch (e) { sendJSON(res, 500, { error: e.message }); }
    });
    return;
  }
  if (url.pathname === '/api/plan/remove' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { planFile, srcPaths } = JSON.parse(body || '{}');
        if (!Array.isArray(srcPaths)) return sendJSON(res, 400, { error: 'srcPaths[] required' });
        const target = planFile || WORKING_PLAN_FILE;
        if (!readPlanHeader(target)) return sendJSON(res, 404, { error: 'Plan not found' });
        const drop = new Set(srcPaths);
        const kept = readPlanEntries(target).filter(e => !drop.has(e.srcPath));
        writePlanEntries(target, kept);
        const header = recomputePlanTotals(target);
        return sendJSON(res, 200, { removed: srcPaths.length, total: header.totalFiles });
      } catch (e) { sendJSON(res, 500, { error: e.message }); }
    });
    return;
  }
  if (url.pathname === '/api/plan/clear' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { planFile } = JSON.parse(body || '{}');
        const target = planFile || WORKING_PLAN_FILE;
        if (!readPlanHeader(target)) return sendJSON(res, 404, { error: 'Plan not found' });
        writePlanEntries(target, []);
        const header = recomputePlanTotals(target);
        return sendJSON(res, 200, { ok: true, total: header.totalFiles });
      } catch (e) { sendJSON(res, 500, { error: e.message }); }
    });
    return;
  }
  if (url.pathname === '/api/plan/update-settings' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { planFile, destination, layout, tieBreak, destMode, name } = JSON.parse(body || '{}');
        const target = planFile || WORKING_PLAN_FILE;
        const header = readPlanHeader(target);
        if (!header) return sendJSON(res, 404, { error: 'Plan not found' });
        if (typeof destination === 'string') header.destination = destination;
        if (typeof layout === 'string') header.layout = layout;
        if (typeof tieBreak === 'string') header.tieBreak = tieBreak;
        if (typeof destMode === 'string') header.destMode = destMode;
        if (typeof name === 'string') header.name = name;
        writePlanHeader(target, header);
        return sendJSON(res, 200, { plan: header });
      } catch (e) { sendJSON(res, 500, { error: e.message }); }
    });
    return;
  }
  if (url.pathname === '/api/plan/save-as' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { planFile, name } = JSON.parse(body || '{}');
        const target = planFile || WORKING_PLAN_FILE;
        const srcHeader = readPlanHeader(target);
        if (!srcHeader) return sendJSON(res, 404, { error: 'Plan not found' });
        const safeName = (name || 'plan').replace(/[^a-z0-9_-]+/gi, '_').slice(0, 60) || 'plan';
        const id = `plan_${safeName}_${Date.now()}`;
        const newPlanFile = `${id}.plan.json`;
        const newEntriesFile = `${id}.entries.ndjson`;
        const entries = readPlanEntries(target);
        // Reset run-only statuses so the saved copy starts fresh.
        const cleanEntries = entries.map(e => ({
          ...e,
          status: e.status === 'skipped-duplicate' || e.status === 'source-error' ? e.status : 'pending',
        }));
        fs.writeFileSync(
          path.join(SCANS_DIR, newEntriesFile),
          cleanEntries.map(e => JSON.stringify(e)).join('\n') + (cleanEntries.length ? '\n' : '')
        );
        const newHeader = {
          ...srcHeader,
          id,
          kind: 'saved',
          name: name || id,
          createdAt: new Date().toISOString(),
          entriesFile: newEntriesFile,
        };
        fs.writeFileSync(path.join(SCANS_DIR, newPlanFile), JSON.stringify(newHeader, null, 2));
        recomputePlanTotals(newPlanFile);
        return sendJSON(res, 200, { plan: readPlanHeader(newPlanFile), planFile: newPlanFile });
      } catch (e) { sendJSON(res, 500, { error: e.message }); }
    });
    return;
  }
  if (url.pathname === '/api/plan/entries' && req.method === 'GET') {
    try {
      const planFile = url.searchParams.get('file') || WORKING_PLAN_FILE;
      const limit = Math.min(parseInt(url.searchParams.get('limit') || '0', 10) || 0, 50000);
      let entries = readPlanEntries(planFile);
      if (limit) entries = entries.slice(0, limit);
      return sendJSON(res, 200, { entries });
    } catch (e) { return sendJSON(res, 500, { error: e.message }); }
  }
  if (url.pathname === '/api/plan/stats' && req.method === 'GET') {
    // Cheap-ish status counts (we still parse the ndjson, but only to bucket statuses).
    try {
      const planFile = url.searchParams.get('file') || WORKING_PLAN_FILE;
      const entries = readPlanEntries(planFile);
      const counts = {};
      for (const e of entries) {
        const s = e.status || 'unknown';
        counts[s] = (counts[s] || 0) + 1;
      }
      return sendJSON(res, 200, { total: entries.length, counts });
    } catch (e) { return sendJSON(res, 500, { error: e.message }); }
  }
  if (url.pathname === '/api/plan/reset' && req.method === 'POST') {
    // Flip all non-pending, non-skipped-duplicate, non-source-error entries back to pending
    // so the plan can be re-run from scratch.
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { planFile, only } = JSON.parse(body || '{}');
        if (!planFile) return sendJSON(res, 400, { error: 'planFile required' });
        const entries = readPlanEntries(planFile);
        const RESETTABLE = new Set(only && only.length
          ? only
          : ['copied','failed','skipped-exists','skipped-volume-unavailable','source-missing']);
        let flipped = 0;
        for (const e of entries) {
          if (RESETTABLE.has(e.status)) { e.status = 'pending'; delete e.copiedAt; delete e.error; flipped++; }
        }
        writePlanEntries(planFile, entries);
        recomputePlanTotals(planFile);
        return sendJSON(res, 200, { flipped, total: entries.length });
      } catch (e) { sendJSON(res, 500, { error: e.message }); }
    });
    return;
  }
  if (url.pathname === '/api/plan/run' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { planFile } = JSON.parse(body || '{}');
        if (!planFile) return sendJSON(res, 400, { error: 'planFile required' });
        if (activePlanRun && activePlanRun.state !== 'done' && activePlanRun.state !== 'cancelled') {
          return sendJSON(res, 409, { error: 'A plan run is already in progress', runId: activePlanRun.runId });
        }
        const runId = 'run_' + Date.now();
        sendJSON(res, 200, { runId });
        (async () => {
          try { await runPlan({ runId, planFile }); }
          catch (e) {
            console.error('[plan run]', e);
            if (activePlanRun) { activePlanRun.error = e.message; activePlanRun.state = 'failed'; }
          }
        })();
      } catch (e) { sendJSON(res, 500, { error: e.message }); }
    });
    return;
  }
  if (url.pathname === '/api/plan/run/status') {
    if (!activePlanRun) return sendJSON(res, 200, { active: false });
    return sendJSON(res, 200, { active: true, ...activePlanRun, mountedVolumes: listMountedVolumes() });
  }
  if (url.pathname === '/api/plan/run/pause' && req.method === 'POST') {
    if (!activePlanRun) return sendJSON(res, 400, { error: 'No active run' });
    planRunControl.paused = true;
    return sendJSON(res, 200, { ok: true });
  }
  if (url.pathname === '/api/plan/run/resume' && req.method === 'POST') {
    if (!activePlanRun) return sendJSON(res, 400, { error: 'No active run' });
    planRunControl.paused = false;
    return sendJSON(res, 200, { ok: true });
  }
  if (url.pathname === '/api/plan/run/cancel' && req.method === 'POST') {
    if (!activePlanRun) return sendJSON(res, 400, { error: 'No active run' });
    planRunControl.cancelled = true;
    planRunControl.paused = false;
    return sendJSON(res, 200, { ok: true });
  }
  if (url.pathname === '/api/plan/run/swap-ready' && req.method === 'POST') {
    if (!activePlanRun) return sendJSON(res, 400, { error: 'No active run' });
    planRunControl.swapReady = true;
    return sendJSON(res, 200, { ok: true });
  }
  if (url.pathname === '/api/plan/run/swap-resolve' && req.method === 'POST') {
    // Force-resolve a swap by pointing at a specific currently-mounted volume.
    // Useful when the auto-match fails (no UUID + renamed drive).
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { mountPath } = JSON.parse(body || '{}');
        if (!activePlanRun) return sendJSON(res, 400, { error: 'No active run' });
        if (!mountPath || !mountPath.startsWith('/Volumes/')) {
          return sendJSON(res, 400, { error: 'mountPath must be under /Volumes/' });
        }
        if (!fs.existsSync(mountPath)) return sendJSON(res, 400, { error: 'Mount path does not exist' });
        planRunControl.swapManualMount = mountPath;
        planRunControl.swapReady = true;
        return sendJSON(res, 200, { ok: true });
      } catch (e) { sendJSON(res, 500, { error: e.message }); }
    });
    return;
  }
  if (url.pathname === '/api/plan/run/skip-drive' && req.method === 'POST') {
    if (!activePlanRun) return sendJSON(res, 400, { error: 'No active run' });
    planRunControl.skipDrive = true;
    return sendJSON(res, 200, { ok: true });
  }
  if (url.pathname === '/api/copy' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { files: srcFiles, destination } = JSON.parse(body || '{}');
        if (!Array.isArray(srcFiles) || srcFiles.length === 0) {
          return sendJSON(res, 400, { error: 'No files provided' });
        }
        if (!destination || typeof destination !== 'string') {
          return sendJSON(res, 400, { error: 'No destination provided' });
        }
        const destAbs = path.resolve(destination);
        if (!fs.existsSync(destAbs) || !fs.statSync(destAbs).isDirectory()) {
          return sendJSON(res, 400, { error: 'Destination is not an existing directory' });
        }
        // Safety: refuse to copy into the project folder, into "/", or into any source path.
        if (destAbs === '/' || destAbs.startsWith(ROOT)) {
          return sendJSON(res, 400, { error: 'Destination not allowed' });
        }
        const report = { copied: 0, skipped: 0, errors: [], totalBytes: 0 };
        for (const src of srcFiles) {
          try {
            if (!fs.existsSync(src)) { report.errors.push({ src, error: 'source missing' }); continue; }
            const base = path.basename(src);
            const dst = path.join(destAbs, base);
            if (fs.existsSync(dst)) { report.skipped++; continue; }
            // COPYFILE_EXCL ensures we never overwrite even on race.
            fs.copyFileSync(src, dst, fs.constants.COPYFILE_EXCL);
            const st = fs.statSync(dst);
            report.totalBytes += st.size;
            report.copied++;
          } catch (err) {
            report.errors.push({ src, error: err.code || err.message });
          }
        }
        sendJSON(res, 200, report);
      } catch (e) {
        sendJSON(res, 500, { error: e.message });
      }
    });
    return;
  }

  res.writeHead(404); res.end('Not found');
});

try { ensureWorkingPlan(); } catch (e) { console.error('[ensureWorkingPlan]', e.message); }

server.listen(PORT, '127.0.0.1', () => {
  console.log(`WNCleaning dashboard: http://localhost:${PORT}`);
  try { execSync(`open http://localhost:${PORT}`); } catch {}
});
