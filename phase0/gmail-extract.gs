/**
 * Phase 0 extraction for pro@agency.example — exports the entire mailbox as
 * structured JSON to a Drive folder, for offline triage-pattern analysis.
 *
 * Design (stratified sample + snapshot-then-walk):
 *   1. SCAN: build a SAMPLE manifest instead of enumerating all 425K+
 *      threads — up to SAMPLE_PER_LABEL threads per user label plus
 *      SAMPLE_UNLABELED unlabeled ones, spread across SAMPLE_WINDOWS date
 *      windows over the last SAMPLE_MONTHS months (mail here is seasonal,
 *      so time spread matters). Saved as ids-*.json in the Drive folder.
 *      Also snapshots the account's Gmail filters to filters-*.json.
 *   2. WALK: process that frozen ID list by index — each thread is fetched
 *      directly by ID, so mail arriving/moving during the hours-long walk
 *      cannot shift, hide, or reorder anything.
 *
 * Work happens in chunks that stop before Apps Script's 6-minute limit; a
 * self-installed trigger re-runs every 10 minutes until done. State only
 * advances after a successful write, so crashes/retries can produce
 * duplicate records but never missed ones — dedupe offline by threadId
 * (keep the newest copy of each).
 *
 * Usage:
 *   1. Select the function `start` in the toolbar and click Run. Authorize
 *      when prompted. That is the only manual step.
 *   2. Watch progress under "Executions" (left sidebar), or run `status`.
 *   3. Finished when the Drive folder contains summary.json. If ERROR.txt
 *      appears instead, the run halted on an unrecoverable problem — read
 *      the file for what and why.
 *   4. To start over: run `reset`, then `start`. A fresh Drive folder is
 *      created each time; old folders are never touched.
 *
 * Expectations:
 *   - The sampling scan finishes in minutes; the walk (one Gmail API call
 *     per thread) finishes in roughly 1-2 hours and does NOT consume the
 *     built-in GmailApp service's small daily quota. Occasional failed
 *     executions are safe: the trigger simply retries, and no state is
 *     lost.
 *
 * Requires the Gmail API advanced service (Services → + → Gmail API).
 */

// ── Config ──────────────────────────────────────────────────────────────
const OUTPUT_FOLDER = 'pro-inbox-extract';
const BODY_CHARS = 1500; // plain-text chars of the first message; 0 = omit bodies
const OLDEST_DATE = ''; // 'yyyy/mm/dd' to cap how far back to go; '' = all history
// Stratified sampling scope (the mailbox holds 425K+ threads; we sample):
const SAMPLE_MONTHS = 24; // how far back the sample reaches
const SAMPLE_WINDOWS = 8; // equal date windows across that span (seasonality)
const SAMPLE_PER_LABEL = 400; // max threads sampled per user label
const SAMPLE_UNLABELED = 1000; // threads sampled that carry no user label
const MAX_RUNTIME_MS = 4 * 60 * 1000; // stop chunk well before the 6-min kill
const TRIGGER_MINUTES = 10; // valid values: 1, 5, 10, 15, 30
const MAX_OUTBOUND_SCAN = 200; // per-thread cap on messages examined
const MAX_SCANS = 4; // scan passes before finishing regardless
// Addresses that count as "us" when detecting delegation forwards. Add any
// other aliases of this mailbox here. (processing@agency.example is deliberately NOT
// listed — it is a separate mailbox, so its messages are inbound senders.)
const OWN_ADDRESSES = ['pro@agency.example'];

// Error triage for per-thread failures during the walk:
//   systemic (quota / rate limit / server trouble) → abort the chunk
//     unpersisted; the trigger retries later. Matches Google's documented
//     transient strings ("Server error occurred...", "Service unavailable:
//     Gmail", "Service invoked too many times...").
//   thread-local (oversize/corrupt content) → record a stub, move on.
//   unknown → retry across chunks; a thread failing 3 times is condemned to
//     a stub so one poison thread can never wedge the walk.
const SYSTEMIC_ERR = /invoked too many times|quota|rate ?limit|limit exceeded|temporar|backend|internal error|serv(?:er|ice) error|unavailable|not available|try again|sorry/i;
const THREAD_LOCAL_ERR = /argument too large|too large|invalid argument|cannot read|typeerror|of undefined|of null|was not found|not found/i;

// ── Entry points ────────────────────────────────────────────────────────
function start() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(0)) return; // another execution is already running
  try {
    const props = PropertiesService.getScriptProperties();
    if (!props.getProperty('phase')) initState_(props);
    if (props.getProperty('done') === 'true') {
      removeTriggers_(); // in case a crash orphaned the trigger earlier
      console.log('Extraction already complete. Run reset() to start over.');
      return;
    }
    ensureTrigger_();
    if (props.getProperty('phase') === 'scan') scanChunk_(props);
    else walkChunk_(props);
  } finally {
    lock.releaseLock();
  }
}

function status() {
  const p = PropertiesService.getScriptProperties();
  const triggers = ScriptApp.getProjectTriggers().filter(function (t) {
    return t.getHandlerFunction() === 'start';
  }).length;
  console.log(JSON.stringify({
    done: p.getProperty('done') || 'not started',
    phase: p.getProperty('phase') || null,
    threadsProcessed: p.getProperty('walkIndex') || '0',
    extractFilesWritten: p.getProperty('fileIndex') || '0',
    scanPassesCompleted: p.getProperty('scansDone') || '0',
    stubbedThreads: JSON.parse(p.getProperty('stubbedIds') || '[]').length,
    activeTriggers: triggers, // 1 while running; 0 after finish
  }, null, 2));
}

function reset() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5 * 60 * 1000)) {
    console.log('A chunk is still running; try reset() again in a few minutes.');
    return;
  }
  try {
    removeTriggers_();
    PropertiesService.getScriptProperties().deleteAllProperties();
    console.log('State cleared. The next start() begins fresh and writes to a ' +
      'NEW Drive folder; previous folders are untouched.');
  } finally {
    lock.releaseLock();
  }
}

// ── Diagnostics ─────────────────────────────────────────────────────────
/**
 * Read-only probe of the mailbox and extraction state — touches nothing.
 * Requires the Gmail API advanced service: editor left bar → Services → +
 * → "Gmail API" → Add (identifier "Gmail", v1). Then select `diagnose` in
 * the toolbar, Run (re-authorize if prompted), and share the log output.
 */
function diagnose() {
  const props = PropertiesService.getScriptProperties();
  const out = {
    state: {
      phase: props.getProperty('phase'),
      sampleTask: props.getProperty('sampleTask'),
      walkIndex: props.getProperty('walkIndex'),
      scansDone: props.getProperty('scansDone'),
      idFileCount: props.getProperty('idFileCount'),
    },
    uniqueIdsEnumerated: loadIdArray_(outputFolder_(props)).length,
    userLabelCount: GmailApp.getUserLabels().length,
    threadCounts: {},
  };
  const queries = {
    scanQuery: query_(),
    defaultScope: '',
    chatsOnly: 'in:chats',
    labeled: 'has:userlabels',
    labeledRecent2y: 'has:userlabels newer_than:2y',
    recent1y: 'newer_than:1y',
    recent2y: 'newer_than:2y',
  };
  Object.keys(queries).forEach(function (k) {
    out.threadCounts[k] = countThreads_(queries[k]);
  });
  console.log(JSON.stringify(out, null, 2));
}

/**
 * Second diagnostic round — exact numbers from Gmail's own counters, no
 * paging: profile totals, per-label thread counts (the taxonomy volume
 * table), the filter list (existing auto-routing rules; full copy saved to
 * the Drive folder as filters-*.json), and a per-year volume histogram.
 * Read-only apart from the filters file. Run like diagnose.
 */
function diagnose2() {
  const out = { profile: null, labels: [], filterCount: null, yearCounts: {} };

  const prof = Gmail.Users.getProfile('me');
  out.profile = {
    emailAddress: prof.emailAddress,
    messagesTotal: prof.messagesTotal,
    threadsTotal: prof.threadsTotal,
  };

  const labels = Gmail.Users.Labels.list('me').labels || [];
  labels.forEach(function (l) {
    if (l.type !== 'user') return;
    const d = Gmail.Users.Labels.get('me', l.id);
    out.labels.push({ name: d.name, threads: d.threadsTotal, messages: d.messagesTotal });
  });
  out.labels.sort(function (a, b) { return b.threads - a.threads; });

  try {
    const filters = Gmail.Users.Settings.Filters.list('me').filter || [];
    out.filterCount = filters.length;
    outputFolder_(PropertiesService.getScriptProperties())
      .createFile('filters-' + Date.now() + '.json', JSON.stringify(filters, null, 2));
  } catch (e) {
    out.filterCount = 'error: ' + String(e);
  }

  for (let y = 2026; y >= 2018; y--) {
    out.yearCounts[y] = countThreads_('after:' + y + '/01/01 before:' + (y + 1) + '/01/01');
  }

  console.log(JSON.stringify(out, null, 2));
}

/**
 * One-thread probe of body extraction: dumps the payload part tree of the
 * first 3 manifest threads and what apiBody_ returns for each. Run after
 * pasting a fix and share the log before re-walking.
 */
function debugBody() {
  console.log('debugBody v3 — raw-data instrumentation'); // proves this paste is live
  const props = PropertiesService.getScriptProperties();
  const ids = loadIdArray_(outputFolder_(props));
  for (let k = 0; k < Math.min(3, ids.length); k++) {
    const t = Gmail.Users.Threads.get('me', ids[k], { format: 'full' });
    const m = (t.messages || [])[0] || {};
    const raw = firstDataPart_(m.payload);
    console.log(JSON.stringify({
      threadId: ids[k],
      subject: apiHeader_(m, 'Subject').slice(0, 60),
      rawDataPrefix: raw ? String(raw).slice(0, 80) : null,
      rawLen: raw ? String(raw).length : 0,
      rawHasWhitespace: raw ? /\s/.test(String(raw)) : null,
      extractedBody: apiBody_(m.payload).slice(0, 200),
    }, null, 2));
  }
}

function firstDataPart_(p) {
  if (!p) return null;
  if (p.body && p.body.data && !p.filename) return p.body.data;
  const parts = p.parts || [];
  for (let i = 0; i < parts.length; i++) {
    const r = firstDataPart_(parts[i]);
    if (r) return r;
  }
  return null;
}

function describePart_(p, depth) {
  if (!p || depth > 4) return null;
  const d = {
    mimeType: p.mimeType,
    filename: p.filename || '',
    hasData: !!(p.body && p.body.data),
    dataLen: p.body && p.body.data ? String(p.body.data).length : 0,
  };
  if (p.parts) {
    d.parts = p.parts.slice(0, 6).map(function (x) { return describePart_(x, depth + 1); });
  }
  return d;
}

/**
 * Re-run the WALK over the existing manifest (e.g., after a bug fix)
 * without re-sampling. Old extract files stay in place; re-walked records
 * land in NEW files that supersede them offline (dedupe keeps the newest
 * copy of each threadId). After running this, run start() once.
 */
function rewalk() {
  const props = PropertiesService.getScriptProperties();
  const folder = outputFolder_(props);
  const it = folder.getFilesByName('summary.json');
  while (it.hasNext()) it.next().setTrashed(true); // finish_ writes a fresh one
  props.setProperties({
    walkIndex: '0',
    phase: 'walk',
    done: 'false',
    stubbedIds: '[]',
    failCounts: '{}',
  });
  props.deleteProperty('walkStall');
  console.log('Walk reset over ' + loadIdArray_(folder).length +
    ' manifest threads. Run start() to begin.');
}

// Exact thread count via Gmail API pageToken paging, capped at 25 pages
// (12,500 threads) so the probe stays fast. Also validates that pageToken
// pagination works on this mailbox — the likely replacement for the
// offset-based scan that stalled at depth.
function countThreads_(q) {
  try {
    let count = 0;
    let pageToken = null;
    for (let page = 0; page < 25; page++) {
      const params = { maxResults: 500 };
      if (q) params.q = q;
      if (pageToken) params.pageToken = pageToken;
      const res = Gmail.Users.Threads.list('me', params);
      count += (res.threads || []).length;
      pageToken = res.nextPageToken;
      if (!pageToken) return String(count);
    }
    return count + '+ (probe capped)';
  } catch (e) {
    return 'error: ' + String(e);
  }
}

// ── Core ────────────────────────────────────────────────────────────────
function initState_(props) {
  props.setProperties({
    phase: 'scan',
    sampleTask: '0',
    newFound: '0',
    idFileCount: '0',
    scansDone: '0',
    walkIndex: '0',
    fileIndex: '0',
    failCounts: '{}',
    stubbedIds: '[]',
    done: 'false',
  });
  outputFolder_(props); // create the folder now and pin its ID
}

// Gmail's default search scope (everything except Spam and Trash, including
// Archive, Sent, and Drafts) is what we want; the explicit operators pin
// that intent and cancel out to default scope.
function query_() {
  let q = 'in:anywhere -in:spam -in:trash';
  if (OLDEST_DATE) q += ' after:' + OLDEST_DATE;
  return q;
}

/**
 * SCAN phase (stratified sampling): one task = one (stratum × date-window)
 * Threads.list call via the Gmail API advanced service — labelIds instead
 * of label-name queries (no quoting issues), tiny result pages (no deep
 * offsets, which is what stalled the full-enumeration design at 156K).
 * The task list is deterministic from a label snapshot taken on the first
 * chunk, so progress is resumable by a single index. The `known` set is
 * rebuilt from the durable ids-*.json files each chunk, making the scan
 * idempotent across crashes.
 */
function scanChunk_(props) {
  const t0 = Date.now();
  const folder = outputFolder_(props);
  const known = {};
  loadIdArray_(folder).forEach(function (id) { known[id] = true; });
  const walked = parseInt(props.getProperty('walkIndex'), 10);
  if (Object.keys(known).length < walked) {
    return fatal_(props, 'ID manifest shrank below walkIndex (' +
      Object.keys(known).length + ' < ' + walked +
      ') — was a Drive file or the output folder deleted mid-run?');
  }

  // Stall guard first, before ANY Gmail call (matching the walk's
  // bump-at-entry discipline), so even a wedged label-snapshot fetch
  // eventually escalates instead of retrying silently forever. Clearing the
  // counter on fatal gives a later manual start() a fresh budget.
  if (bumpStall_(props, 'scanStall', props.getProperty('sampleTask') || 'init') >= 18) {
    props.deleteProperty('scanStall');
    return fatal_(props, 'Sampling made no progress past task ' +
      (props.getProperty('sampleTask') || '(init)') + ' across many chunks.');
  }

  let labels = JSON.parse(props.getProperty('sampleLabels') || 'null');
  if (!labels) {
    const ls = Gmail.Users.Labels.list('me').labels || [];
    labels = ls.filter(function (l) { return l.type === 'user'; })
      .map(function (l) { return { i: l.id, n: l.name }; });
    labels.sort(function (a, b) { return a.n < b.n ? -1 : 1; }); // deterministic order
    props.setProperties({
      sampleLabels: JSON.stringify(labels),
      sampleAnchor: String(Date.now()),
      sampleTask: '0',
    });
  }
  const anchorMs = parseInt(props.getProperty('sampleAnchor'), 10);
  let task = parseInt(props.getProperty('sampleTask'), 10);
  const totalTasks = (labels.length + 1) * SAMPLE_WINDOWS; // +1 = unlabeled stratum

  let idFileCount = parseInt(props.getProperty('idFileCount'), 10);
  let newFound = parseInt(props.getProperty('newFound'), 10);
  const newIds = [];

  while (task < totalTasks && Date.now() - t0 < MAX_RUNTIME_MS) {
    let ids;
    try {
      ids = sampleTask_(labels, task, anchorMs);
    } catch (e) {
      const msg = String(e);
      if (SYSTEMIC_ERR.test(msg)) {
        if (/invoked too many times|quota|user-?rate limit/i.test(msg)) {
          props.deleteProperty('scanStall'); // quota pause is not a stall
        }
        throw e; // outage: abort chunk unpersisted, never condemn the task
      }
      const failCounts = JSON.parse(props.getProperty('failCounts'));
      const key = 's' + task; // 's' prefix cannot collide with walk thread ids
      failCounts[key] = (failCounts[key] || 0) + 1;
      props.setProperty('failCounts', JSON.stringify(failCounts));
      if (failCounts[key] >= 3) {
        console.log('Skipping sampling task ' + task + ' after 3 failures: ' + e);
        ids = []; // one lost window only thins the sample slightly
      } else {
        throw e; // chunk aborts unpersisted; trigger retries this task later
      }
    }
    ids.forEach(function (id) {
      if (!known[id]) {
        known[id] = true;
        newIds.push(id);
      }
    });
    task++;
  }

  if (newIds.length > 0) {
    folder.createFile('ids-' + ('0000' + idFileCount).slice(-4) + '-' + Date.now() + '.json',
      JSON.stringify(newIds));
    idFileCount++;
    newFound += newIds.length;
  }
  props.setProperties({
    sampleTask: String(task),
    idFileCount: String(idFileCount),
    newFound: String(newFound),
  });
  console.log('Sampling: task ' + task + ' / ' + totalTasks + '; ' +
    Object.keys(known).length + ' unique threads in manifest.');

  if (task >= totalTasks) {
    saveFilters_(folder);
    props.setProperties({
      phase: 'walk',
      scansDone: String(MAX_SCANS), // sampling is one-shot: no verify-scan loop
    });
    console.log('Sampling complete — walking ' + Object.keys(known).length + ' threads.');
  }
}

// One sampling task = one (stratum × date-window) Threads.list call.
function sampleTask_(labels, task, anchorMs) {
  const w = task % SAMPLE_WINDOWS;
  const li = Math.floor(task / SAMPLE_WINDOWS);
  const range = windowRange_(anchorMs, w);
  const params = { q: 'after:' + range.after + ' before:' + range.before };
  if (li < labels.length) {
    params.labelIds = [labels[li].i];
    params.maxResults = Math.ceil(SAMPLE_PER_LABEL / SAMPLE_WINDOWS);
  } else {
    params.q = '-has:userlabels ' + params.q;
    params.maxResults = Math.ceil(SAMPLE_UNLABELED / SAMPLE_WINDOWS);
  }
  const res = Gmail.Users.Threads.list('me', params);
  return (res.threads || []).map(function (th) { return th.id; });
}

// Date window w (0 = most recent) as Gmail after:/before: strings. Exact
// month-boundary arithmetic isn't critical — a day of overlap or gap
// between windows only nudges the sample, and the manifest dedupes.
function windowRange_(anchorMs, w) {
  const monthsPer = SAMPLE_MONTHS / SAMPLE_WINDOWS;
  const end = new Date(anchorMs);
  end.setMonth(end.getMonth() - w * monthsPer);
  const start = new Date(anchorMs);
  start.setMonth(start.getMonth() - (w + 1) * monthsPer);
  return {
    after: Utilities.formatDate(start, 'GMT', 'yyyy/MM/dd'),
    before: Utilities.formatDate(end, 'GMT', 'yyyy/MM/dd'),
  };
}

// Snapshot the account's Gmail filters — the existing auto-routing rules
// are analysis input alongside the mail itself.
function saveFilters_(folder) {
  try {
    const filters = Gmail.Users.Settings.Filters.list('me').filter || [];
    folder.createFile('filters-' + Date.now() + '.json', JSON.stringify(filters, null, 2));
  } catch (e) {
    console.log('Could not snapshot filters (non-fatal): ' + e);
  }
}

/**
 * WALK phase: process the frozen ID list by integer index. Deterministic
 * order means retries replay identically, which is what makes the 3-strike
 * poison-thread handling in stubOrRethrow_ converge.
 */
function walkChunk_(props) {
  const t0 = Date.now();
  const own = ownAddresses_();
  const folder = outputFolder_(props);
  const allIds = loadIdArray_(folder);
  let i = parseInt(props.getProperty('walkIndex'), 10);
  let fileIndex = parseInt(props.getProperty('fileIndex'), 10);
  const stubbed = JSON.parse(props.getProperty('stubbedIds'));
  const stubbedSet = {};
  stubbed.forEach(function (id) { stubbedSet[id] = true; });
  const records = [];

  if (allIds.length < i) {
    return fatal_(props, 'ID manifest shrank below walkIndex (' + allIds.length +
      ' < ' + i + ') — was a Drive file or the output folder deleted mid-run?');
  }
  if (i < allIds.length) {
    // Error-class-agnostic wedge breaker: the stall marker is bumped at chunk
    // entry (before any Gmail call), so even uncatchable hard kills count.
    // ~18 zero-progress chunks (~3h) at one id condemns it; daily-quota
    // pauses don't trip this because stubOrRethrow_ resets the marker for
    // quota-class errors, which legitimately park the walk for a day.
    if (bumpStall_(props, 'walkStall', allIds[i]) >= 18 && !stubbedSet[allIds[i]]) {
      stubbed.push(allIds[i]);
      stubbedSet[allIds[i]] = true;
      props.setProperty('stubbedIds', JSON.stringify(stubbed));
      console.log('Stubbed wedged thread ' + allIds[i] + ' after repeated zero-progress chunks.');
    }
  }

  let labelMap; // label id -> name, user labels only
  try {
    labelMap = userLabelMap_();
  } catch (e) {
    // Mirror stubOrRethrow_'s quota handling: a quota-blocked chunk must
    // not count toward the stall breaker (it would condemn a healthy
    // thread after ~3h of outage).
    if (/invoked too many times|quota|user-?rate limit/i.test(String(e))) {
      props.deleteProperty('walkStall');
    }
    throw e;
  }

  while (i < allIds.length && Date.now() - t0 < MAX_RUNTIME_MS) {
    const id = allIds[i];
    let rec;
    if (stubbedSet[id]) {
      rec = { threadId: id, error: 'stubbed after repeated failures' };
    } else {
      try {
        rec = threadRecord_(id, labelMap, own);
      } catch (e) {
        rec = stubOrRethrow_(props, id, e, stubbed, stubbedSet);
      }
    }
    records.push(rec);
    i++;
  }

  // Write the data file BEFORE advancing the index: a crash between the two
  // can only produce duplicates (deduped offline), never a hole.
  if (records.length > 0) {
    folder.createFile('extract-' + ('0000' + fileIndex).slice(-4) + '-' + Date.now() + '.json',
      JSON.stringify(records));
    fileIndex++;
  }
  props.setProperties({ walkIndex: String(i), fileIndex: String(fileIndex) });
  console.log('Progress: ' + i + ' / ' + allIds.length + ' threads exported.');

  if (i >= allIds.length) finish_(props); // sampling is one-shot: walk end = done
}

function stubOrRethrow_(props, id, e, stubbed, stubbedSet) {
  const msg = String(e);
  // Oversized-response errors are thread-specific but contain 'limit
  // exceeded', which would match SYSTEMIC_ERR below and retry forever —
  // test them first and stub.
  if (/urlfetch response size|response (?:size )?too large|exceeded maximum.*(?:size|length)/i.test(msg)) {
    return { threadId: id, error: msg };
  }
  if (SYSTEMIC_ERR.test(msg)) {
    if (/invoked too many times|quota|user-?rate limit/i.test(msg)) {
      // Daily-quota pause: expected to park the walk for hours — must not
      // count toward the zero-progress wedge breaker. (Deliberately NOT
      // matching bare 'limit exceeded': unrecognized variants must stay
      // eligible for the 18-chunk stall breaker.)
      props.deleteProperty('walkStall');
    }
    throw e; // abort chunk unpersisted; trigger retries
  }
  if (THREAD_LOCAL_ERR.test(msg)) return { threadId: id, error: msg };
  const failCounts = JSON.parse(props.getProperty('failCounts'));
  failCounts[id] = (failCounts[id] || 0) + 1;
  if (failCounts[id] >= 3) {
    delete failCounts[id];
    stubbed.push(id);
    stubbedSet[id] = true;
    if (stubbed.length > 400) {
      fatal_(props, 'Over 400 threads stubbed — failures are systemic, not thread-specific.');
      throw e;
    }
    // Persist condemnation immediately: even if this chunk later aborts,
    // the walk can never wedge on this id again.
    props.setProperties({
      failCounts: JSON.stringify(failCounts),
      stubbedIds: JSON.stringify(stubbed),
    });
    return { threadId: id, error: msg + ' (stubbed after 3 attempts)' };
  }
  props.setProperty('failCounts', JSON.stringify(failCounts));
  throw e;
}

function finish_(props) {
  const folder = outputFolder_(props);
  if (!folder.getFilesByName('summary.json').hasNext()) {
    folder.createFile('summary.json', JSON.stringify({
      finishedAt: new Date().toISOString(),
      threadsProcessed: parseInt(props.getProperty('walkIndex'), 10),
      extractFilesWritten: parseInt(props.getProperty('fileIndex'), 10),
      scanPasses: parseInt(props.getProperty('scansDone'), 10),
      stubbedThreads: JSON.parse(props.getProperty('stubbedIds')).length,
      note: 'Dedupe records offline by threadId (keep newest copy); crash ' +
        'retries can duplicate records but never drop threads. Label counts ' +
        'and all stats are computed offline from the extract files.',
      bodyChars: BODY_CHARS,
      oldestDate: OLDEST_DATE || 'all history',
    }, null, 2));
  }
  props.setProperty('done', 'true');
  removeTriggers_();
  console.log('DONE — export complete in Drive folder "' + folder.getName() + '".');
}

// One record per thread: the inbound task (first message) plus every message
// sent BY this mailbox in the thread — those outbound entries are the
// delegation evidence (who it was forwarded/handed to). Fetched via the
// Gmail API advanced service (ONE call per thread, and a quota pool
// separate from — and far larger than — the built-in GmailApp service's).
function threadRecord_(id, labelMap, own) {
  const t = Gmail.Users.Threads.get('me', id, { format: 'full' });
  const msgs = t.messages || [];
  if (msgs.length === 0) return { threadId: id, error: 'empty thread' };
  const first = msgs[0];

  const labelIdSet = {};
  msgs.forEach(function (m) {
    (m.labelIds || []).forEach(function (l) { labelIdSet[l] = true; });
  });
  const labels = Object.keys(labelIdSet)
    .filter(function (l) { return labelMap[l] !== undefined; })
    .map(function (l) { return labelMap[l]; });

  const rec = {
    threadId: id,
    labels: labels,
    messageCount: msgs.length,
    subject: apiHeader_(first, 'Subject'),
    from: apiHeader_(first, 'From'),
    to: apiHeader_(first, 'To'),
    cc: apiHeader_(first, 'Cc'),
    firstDate: new Date(parseInt(first.internalDate, 10)).toISOString(),
    lastDate: new Date(parseInt(msgs[msgs.length - 1].internalDate, 10)).toISOString(),
    firstIsDraft: (first.labelIds || []).indexOf('DRAFT') !== -1,
    messageIdHeader: apiHeader_(first, 'Message-ID'),
    listIdHeader: apiHeader_(first, 'List-Id'), // strongest key for system mail
    attachments: attachmentNames_(first),
    inboundSenders: [],
    outbound: [],
  };
  if (BODY_CHARS > 0) {
    rec.body = cleanBody_(apiBody_(first.payload)).slice(0, BODY_CHARS);
  }

  const scanMsgs = msgs.length > MAX_OUTBOUND_SCAN ? msgs.slice(0, MAX_OUTBOUND_SCAN) : msgs;
  if (msgs.length > MAX_OUTBOUND_SCAN) rec.scanTruncated = true;
  const senders = {};
  scanMsgs.forEach(function (m) {
    if ((m.labelIds || []).indexOf('DRAFT') !== -1) return; // drafts aren't delegation evidence
    const fromH = apiHeader_(m, 'From');
    if (isOwn_(fromH, own)) {
      const subj = apiHeader_(m, 'Subject');
      rec.outbound.push({
        to: apiHeader_(m, 'To'),
        cc: apiHeader_(m, 'Cc'),
        date: new Date(parseInt(m.internalDate, 10)).toISOString(),
        // Raw subject kept so forward-vs-reply survives localized prefixes
        // (Fwd:/WG:/TR:/VS:...) and edited subjects; isForward is convenience.
        subject: subj,
        isForward: /^fwd?:/i.test(subj || ''),
      });
    } else {
      senders[extractAddr_(fromH)] = true;
    }
  });
  rec.inboundSenders = Object.keys(senders).slice(0, 20);
  return rec;
}

// ── Gmail API parsing helpers ───────────────────────────────────────────
function userLabelMap_() {
  const map = {};
  (Gmail.Users.Labels.list('me').labels || []).forEach(function (l) {
    if (l.type === 'user') map[l.id] = l.name;
  });
  return map;
}

// Case-insensitive RFC header lookup on an API message resource.
function apiHeader_(msg, name) {
  const hs = (msg.payload && msg.payload.headers) || [];
  const lower = name.toLowerCase();
  for (let i = 0; i < hs.length; i++) {
    if ((hs[i].name || '').toLowerCase() === lower) return hs[i].value || '';
  }
  return '';
}

// Best-effort plain text from a (possibly nested multipart) payload:
// prefer the FIRST text/plain in document order, fall back to tag-stripped
// text/html, else ''. Attached messages (message/rfc822, or any part
// carrying a filename) are skipped entirely so a forwarded-as-attachment
// email can never masquerade as the actual body.
function apiBody_(payload) {
  let plain = null;
  let html = null;
  const queue = [payload];
  while (queue.length) {
    const p = queue.shift(); // breadth-first preserves document order among siblings
    if (!p) continue;
    const mime = p.mimeType || '';
    if (mime === 'message/rfc822' || (p.filename && p.parts)) continue; // attached message subtree
    if (p.parts) p.parts.forEach(function (x) { queue.push(x); });
    if (p.body && p.body.data && !p.filename) {
      if (plain === null && mime === 'text/plain') plain = p.body.data;
      else if (html === null && mime === 'text/html') html = p.body.data;
    }
  }
  const data = plain !== null ? plain : html;
  if (data === null) return '';
  let text;
  try {
    text = bodyDataToText_(data);
  } catch (e) {
    return '(body-decode-failed: ' + e + ')';
  }
  if (plain === null) {
    text = text
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<[^>]+>/g, ' ');
  }
  return text;
}

// The Apps Script Gmail advanced service hands body.data back as an
// ALREADY-DECODED array of byte values — verified live on this mailbox
// (rawDataPrefix "72,101,108,108,111,44,32,..." = "Hello, ..."), not the
// base64url string the REST API documents. Handle both shapes.
function bodyDataToText_(data) {
  let bytes;
  if (Array.isArray(data)) {
    // normalize to signed bytes; a no-op if the service already did
    bytes = data.map(function (b) { return b > 127 ? b - 256 : b; });
  } else {
    bytes = b64ToBytes_(String(data));
  }
  return Utilities.newBlob(bytes, 'text/plain').getDataAsString('UTF-8');
}

// Defensive path for the documented string shape: strip whitespace, re-pad
// (Gmail may omit base64 padding), fall back to standard alphabet.
function b64ToBytes_(data) {
  let s = String(data).replace(/\s+/g, ''); // strip line-wrapping whitespace
  while (s.length % 4) s += '=';
  try {
    return Utilities.base64DecodeWebSafe(s);
  } catch (e) {
    return Utilities.base64Decode(s.replace(/-/g, '+').replace(/_/g, '/'));
  }
}

// Attachment filenames anywhere in the part tree (binary bodies are only
// referenced by id in format:full, so responses stay reasonably small).
function attachmentNames_(msg) {
  const names = [];
  const stack = [msg.payload];
  while (stack.length) {
    const p = stack.pop();
    if (!p) continue;
    if (p.parts) p.parts.forEach(function (x) { stack.push(x); });
    if (p.filename) names.push(p.filename);
  }
  return names;
}

// ── Helpers ─────────────────────────────────────────────────────────────
// The ID manifest: all ids-*.json files in the folder, sorted by name,
// concatenated, first occurrence wins. Files are immutable once written and
// new files sort after existing ones, so the array is append-only and every
// index stays stable across chunks — the property that makes walkIndex safe.
function loadIdArray_(folder) {
  const files = [];
  const it = folder.getFiles();
  while (it.hasNext()) {
    const f = it.next();
    if (f.getName().indexOf('ids-') === 0) files.push(f);
  }
  files.sort(function (a, b) { return a.getName() < b.getName() ? -1 : 1; });
  const out = [];
  const seen = {};
  files.forEach(function (f) {
    JSON.parse(f.getBlob().getDataAsString()).forEach(function (id) {
      if (!seen[id]) {
        seen[id] = true;
        out.push(id);
      }
    });
  });
  return out;
}

// Consecutive-no-progress counter, keyed by a position token (walk id or
// scan offset). Any progress changes the token, which resets the count.
function bumpStall_(props, key, token) {
  const cur = JSON.parse(props.getProperty(key) || 'null');
  const n = (cur && cur.t === token) ? cur.n + 1 : 1;
  props.setProperty(key, JSON.stringify({ t: token, n: n }));
  return n;
}

// Unrecoverable situation: halt the run loudly. Leaves done=false and drops
// an ERROR.txt in the output folder so the stop is visible and diagnosable.
function fatal_(props, msg) {
  console.error('FATAL: ' + msg);
  try {
    outputFolder_(props).createFile('ERROR.txt', 'Extraction halted: ' + msg +
      '\nHalted at: ' + new Date().toISOString() +
      '\nRun status() for state. Fix the issue and run start() to resume, or reset() to start over.');
  } catch (e) {
    // even the folder is unusable; the console error is all we can do
  }
  removeTriggers_();
}

function ownAddresses_() {
  const list = OWN_ADDRESSES.map(function (a) { return a.toLowerCase(); });
  const session = Session.getEffectiveUser().getEmail().toLowerCase();
  if (session && list.indexOf(session) === -1) list.push(session);
  return list;
}

function extractAddr_(header) {
  const m = (header || '').match(/<([^>]+)>/);
  return (m ? m[1] : (header || '')).trim().toLowerCase();
}

function isOwn_(fromHeader, own) {
  return own.indexOf(extractAddr_(fromHeader)) !== -1;
}

function outputFolder_(props) {
  const id = props.getProperty('folderId');
  if (id) {
    try {
      const f = DriveApp.getFolderById(id);
      if (!f.isTrashed()) return f;
    } catch (e) {
      // folder was deleted — fall through and recreate
    }
  }
  const f = DriveApp.createFolder(OUTPUT_FOLDER);
  props.setProperty('folderId', f.getId());
  return f;
}

function cleanBody_(s) {
  return (s || '')
    .replace(/\r/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function ensureTrigger_() {
  const exists = ScriptApp.getProjectTriggers().some(function (t) {
    return t.getHandlerFunction() === 'start';
  });
  if (!exists) {
    ScriptApp.newTrigger('start').timeBased().everyMinutes(TRIGGER_MINUTES).create();
  }
}

function removeTriggers_() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'start') ScriptApp.deleteTrigger(t);
  });
}
