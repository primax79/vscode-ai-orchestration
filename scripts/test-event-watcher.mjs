import { createRequire } from 'module';
import * as assert from 'assert';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

const require = createRequire(import.meta.url);
const Module = require('module');

// Mock VS Code environment for testing without running actual VS Code extension host
const stub = class {};
const notificationsShown = [];
const executedCommands = [];
let notifyEventsConfig = true;
let notifyNewQuestionsConfig = true;

Module._load = new Proxy(Module._load, {
  apply(target, thisArg, [request, ...rest]) {
    if (request === 'vscode') {
      return {
        workspace: {
          getConfiguration: (section) => ({
            get: (key, defaultValue) => {
              if (key === 'notifyEvents') return notifyEventsConfig;
              if (key === 'notifyNewQuestions') return notifyNewQuestionsConfig;
              return defaultValue;
            },
          }),
          createFileSystemWatcher: () => ({
            onDidChange: () => ({ dispose: () => {} }),
            onDidCreate: () => ({ dispose: () => {} }),
            onDidDelete: () => ({ dispose: () => {} }),
            dispose: () => {},
          }),
        },
        window: {
          createStatusBarItem: () => ({
            show: () => {},
            hide: () => {},
            dispose: () => {},
            text: '',
            tooltip: '',
            backgroundColor: undefined,
            command: '',
          }),
          showInformationMessage: (msg, ...actions) => {
            notificationsShown.push({ msg, actions });
            return Promise.resolve(actions[0]);
          },
          createOutputChannel: () => ({ appendLine: () => {}, dispose: () => {} }),
        },
        commands: {
          registerCommand: () => ({ dispose: () => {} }),
          executeCommand: (cmd, ...args) => {
            executedCommands.push({ cmd, args });
            return Promise.resolve();
          },
        },
        Uri: { file: (f) => ({ fsPath: f }) },
        TreeItem: stub,
        EventEmitter: stub,
        Disposable: class {
          constructor(fn) { this.fn = fn; }
          dispose() { if (this.fn) this.fn(); }
        },
        ThemeIcon: stub,
        ThemeColor: class { constructor(id) { this.id = id; } },
        MarkdownString: stub,
        RelativePattern: class { constructor(base, pattern) { this.base = base; this.pattern = pattern; } },
        TreeItemCollapsibleState: {},
        StatusBarAlignment: { Left: 1, Right: 2 },
        ViewColumn: {},
      };
    }
    return Reflect.apply(target, thisArg, [request, ...rest]);
  },
});

const {
  mapEventToAreas,
  mapEventsToAreas,
  shouldNotifyEvent,
  formatEventNotification,
  filterNewEvents,
  getOrchestratorStatus,
  EventWatcher,
} = require('../out/extension.js');

console.log('--- Running Event Watcher & Notifications Unit Tests ---');

// Test 1: Event-to-Areas Mapping
console.log('Test 1: Event to areas mapping');
assert.deepStrictEqual(mapEventToAreas({ type: 'task.transitioned', seq: 1, id: '1' }), ['tasks']);
assert.deepStrictEqual(mapEventToAreas({ type: 'task.created', seq: 2, id: '2' }), ['tasks']);
assert.deepStrictEqual(mapEventToAreas({ type: 'question.asked', seq: 3, id: '3' }), ['questions', 'tasks']);
assert.deepStrictEqual(mapEventToAreas({ type: 'question.answered', seq: 4, id: '4' }), ['questions', 'tasks']);
assert.deepStrictEqual(mapEventToAreas({ type: 'note.ready', seq: 5, id: '5' }), ['inbox']);
assert.deepStrictEqual(mapEventToAreas({ type: 'note.processed', seq: 6, id: '6' }), ['inbox']);
assert.deepStrictEqual(mapEventToAreas({ type: 'run.started', seq: 7, id: '7' }), ['runs']);
assert.deepStrictEqual(mapEventToAreas({ type: 'run.finished', seq: 8, id: '8' }), ['runs']);
assert.deepStrictEqual(mapEventToAreas({ type: 'orchestrator.started', seq: 9, id: '9' }), ['orchestrator']);
assert.deepStrictEqual(mapEventToAreas({ type: 'turn.finished', seq: 10, id: '10' }), ['orchestrator']);
assert.deepStrictEqual(mapEventToAreas({ type: 'trigger.fired', seq: 11, id: '11' }), ['orchestrator']);
assert.deepStrictEqual(mapEventToAreas({ type: 'action.proposed', seq: 12, id: '12' }), ['orchestrator']);
assert.deepStrictEqual(mapEventToAreas({ type: 'session.registered', seq: 13, id: '13' }), ['orchestrator']);
assert.deepStrictEqual(mapEventToAreas({ type: 'config.changed', seq: 14, id: '14' }), ['config', 'orchestrator']);

// Batch mapping
const batchEvents = [
  { type: 'task.transitioned', seq: 1, id: '1' },
  { type: 'run.finished', seq: 2, id: '2' },
  { type: 'note.ready', seq: 3, id: '3' },
  { type: 'task.created', seq: 4, id: '4' },
];
assert.deepStrictEqual(mapEventsToAreas(batchEvents), ['inbox', 'runs', 'tasks']);
assert.deepStrictEqual(mapEventsToAreas([]), []);
console.log('PASS: Test 1 (Event to areas mapping)');

// Test 2: Notification Toasts Decision & Formatting
console.log('Test 2: Notification toast decision and formatting');
assert.strictEqual(shouldNotifyEvent({ type: 'turn.finished', seq: 1, id: '1' }), true);
assert.strictEqual(shouldNotifyEvent({ type: 'turn.failed', seq: 2, id: '2' }), true);
assert.strictEqual(shouldNotifyEvent({ type: 'action.proposed', seq: 3, id: '3' }), true);
assert.strictEqual(
  shouldNotifyEvent({
    type: 'trigger.fired',
    seq: 4,
    id: '4',
    payload: { state: 'proposed', action: 'command' },
  }),
  true
);
assert.strictEqual(shouldNotifyEvent({ type: 'run.finished', seq: 5, id: '5' }), true);
assert.strictEqual(shouldNotifyEvent({ type: 'run.failed', seq: 6, id: '6' }), true);
assert.strictEqual(shouldNotifyEvent({ type: 'task.transitioned', seq: 7, id: '7' }), false);
assert.strictEqual(shouldNotifyEvent({ type: 'session.heartbeat', seq: 8, id: '8' }), false);

// Format turn finished
const turnNotif = formatEventNotification({
  type: 'turn.finished',
  seq: 10,
  id: '10',
  payload: { turns: 3 },
});
assert.strictEqual(turnNotif.message, 'Orchestrator turn finished with a reply (#3)');
assert.strictEqual(turnNotif.actionTitle, 'Open Dashboard');
assert.strictEqual(turnNotif.actionCommand, 'aiOrchestration.openDashboard');

// Format turn failed
const failNotif = formatEventNotification({
  type: 'turn.failed',
  seq: 11,
  id: '11',
  payload: { reason: 'stale-generation-token' },
});
assert.strictEqual(failNotif.message, 'Orchestrator turn failed: stale-generation-token');

// Format proposed action
const propNotif = formatEventNotification({
  type: 'action.proposed',
  seq: 12,
  id: '12',
  payload: { action: 'command: resume-run' },
});
assert.strictEqual(propNotif.message, 'Proposed action awaiting confirmation: command: resume-run');

// Format run finished
const runNotif = formatEventNotification({
  type: 'run.finished',
  seq: 13,
  id: '13',
  subject: 'RUN001',
  payload: { status: 'delivered', verdict: 'pass' },
});
assert.strictEqual(runNotif.message, 'Run RUN001 finished: delivered (verdict: pass)');

// Format run failed
const runFailNotif = formatEventNotification({
  type: 'run.failed',
  seq: 14,
  id: '14',
  subject: 'RUN002',
  payload: { error: 'Process timeout' },
});
assert.strictEqual(runFailNotif.message, 'Run RUN002 failed: Process timeout');
console.log('PASS: Test 2 (Notification toast formatting)');

// Test 3: Sequence Bookkeeping & Filtering
console.log('Test 3: Sequence bookkeeping and filtering');
const stream = [
  { seq: 10, id: 'e10', type: 'task.transitioned' },
  { seq: 11, id: 'e11', type: 'turn.finished' },
  { seq: 12, id: 'e12', type: 'run.finished' },
];

// Since seq 10: only 11 and 12 returned
const filter1 = filterNewEvents(stream, 10);
assert.strictEqual(filter1.newEvents.length, 2);
assert.strictEqual(filter1.maxSeq, 12);
assert.deepStrictEqual(filter1.newEvents.map((e) => e.seq), [11, 12]);

// With notifiedSeqs deduplication
const notified = new Set([11]);
const filter2 = filterNewEvents(stream, 10, notified);
assert.strictEqual(filter2.newEvents.length, 1);
assert.strictEqual(filter2.newEvents[0].seq, 12);
assert.strictEqual(filter2.maxSeq, 12);

// Since seq 15: empty
const filter3 = filterNewEvents(stream, 15);
assert.strictEqual(filter3.newEvents.length, 0);
assert.strictEqual(filter3.maxSeq, 15);
console.log('PASS: Test 3 (Sequence bookkeeping & filtering)');

// Test 4: Orchestrator Status Inspection
console.log('Test 4: Orchestrator status inspection');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-test-'));
try {
  // Missing file
  const s0 = getOrchestratorStatus(tmpDir);
  assert.strictEqual(s0.started, false);

  // Active orchestrator
  const dotAi = path.join(tmpDir, '.ai-orchestration');
  const qDir = path.join(dotAi, 'orchestrator', 'queue');
  fs.mkdirSync(qDir, { recursive: true });

  fs.writeFileSync(
    path.join(dotAi, 'orchestrator.json'),
    JSON.stringify({
      status: 'active',
      current: { tool: 'claude', status: 'active' },
    })
  );
  fs.writeFileSync(path.join(qDir, '1.json'), '{}');
  fs.writeFileSync(path.join(qDir, '2.json'), '{}');

  const s1 = getOrchestratorStatus(tmpDir);
  assert.strictEqual(s1.started, true);
  assert.strictEqual(s1.tool, 'claude');
  assert.strictEqual(s1.paused, false);
  assert.strictEqual(s1.queueLength, 2);

  // Paused orchestrator
  fs.writeFileSync(
    path.join(dotAi, 'orchestrator.json'),
    JSON.stringify({
      status: 'paused',
      current: { tool: 'kilo', status: 'paused' },
    })
  );
  const s2 = getOrchestratorStatus(tmpDir);
  assert.strictEqual(s2.started, true);
  assert.strictEqual(s2.paused, true);
  assert.strictEqual(s2.tool, 'kilo');
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}
console.log('PASS: Test 4 (Orchestrator status inspection)');

// Test 5: EventWatcher Integration, Seed, Reload, and Dedupe
console.log('Test 5: EventWatcher integration, seed, reload, and deduplication');
const wsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'event-watcher-ws-'));
const eventsDir = path.join(wsDir, '.ai-orchestration', 'events');
fs.mkdirSync(eventsDir, { recursive: true });
fs.writeFileSync(path.join(eventsDir, 'chunks.json'), JSON.stringify([]));

const mockState = new Map();
const context = {
  workspaceState: {
    get: (k, def) => (mockState.has(k) ? mockState.get(k) : def),
    update: (k, v) => { mockState.set(k, v); return Promise.resolve(); },
  },
  subscriptions: [],
};

let tailResultEvents = [];
let tailResultLastSeq = null;
const mockCliClient = {
  tailEvents: async (root, since, limit) => {
    return {
      ok: true,
      events: tailResultEvents.filter((e) => since === undefined || e.seq > since),
      count: tailResultEvents.length,
      first_seq: tailResultEvents[0]?.seq ?? null,
      last_seq: tailResultLastSeq ?? (tailResultEvents[tailResultEvents.length - 1]?.seq ?? null),
    };
  },
};

const receivedEvents = [];
const receivedAreas = [];
const watcher = new EventWatcher(
  context,
  mockCliClient,
  () => wsDir,
  (events, areas) => {
    receivedEvents.push(...events);
    receivedAreas.push(...areas);
  }
);

// Initial seed: event log already has seq 20
tailResultLastSeq = 20;
tailResultEvents = [{ seq: 20, id: 'ev20', type: 'task.transitioned' }];
notificationsShown.length = 0;

await watcher.initializeSequenceSeed(wsDir);
// Stored seq should be 20, no notifications shown for seed
assert.strictEqual(mockState.get(`aiOrchestration.lastEventSeq:${wsDir}`), 20);
assert.strictEqual(notificationsShown.length, 0);

// Now a new event arrives: seq 21 (turn.finished)
tailResultEvents = [
  { seq: 20, id: 'ev20', type: 'task.transitioned' },
  { seq: 21, id: 'ev21', type: 'turn.finished', payload: { turns: 1 } },
];
tailResultLastSeq = 21;

await watcher.pollNewEvents();

// Sequence advances to 21
assert.strictEqual(mockState.get(`aiOrchestration.lastEventSeq:${wsDir}`), 21);
// Area received
assert.deepStrictEqual(receivedAreas, ['orchestrator']);
assert.strictEqual(receivedEvents.length, 1);
assert.strictEqual(receivedEvents[0].seq, 21);
// Toast shown for turn.finished
assert.strictEqual(notificationsShown.length, 1);
assert.strictEqual(notificationsShown[0].msg, 'Orchestrator turn finished with a reply (#1)');

// Simulate reload: watcher re-initialized, but state key has seq 21
const reloadWatcher = new EventWatcher(
  context,
  mockCliClient,
  () => wsDir,
  () => {}
);
notificationsShown.length = 0;
await reloadWatcher.initializeSequenceSeed(wsDir);
// Does NOT re-notify turn 21 on reload
assert.strictEqual(notificationsShown.length, 0);

// Question deduplication test:
// Question Q001 arrives as event seq 22
tailResultEvents.push({
  seq: 22,
  id: 'ev22',
  type: 'question.asked',
  subject: 'Q001',
  payload: { id: 'Q001', question: 'Deploy to pre or prod?' },
});
tailResultLastSeq = 22;

await watcher.pollNewEvents();

// Notified question should be stored in workspaceState under both question and seq keys
assert.strictEqual(notificationsShown.length, 1);
assert.strictEqual(notificationsShown[0].msg, 'Q001 (Deploy to pre) needs a decision');
const storedQuestions = mockState.get(`aiOrchestration.notifiedQuestions:${wsDir}`);
assert.ok(storedQuestions.includes('Q001'));
const storedSeqs = mockState.get(`aiOrchestration.notifiedEventSeqs:${wsDir}`);
assert.ok(storedSeqs.includes(22));

// Subsequent poll with same event does not toast again
notificationsShown.length = 0;
await watcher.pollNewEvents();
assert.strictEqual(notificationsShown.length, 0);

// Cleanup
watcher.dispose();
reloadWatcher.dispose();
fs.rmSync(wsDir, { recursive: true, force: true });
console.log('PASS: Test 5 (EventWatcher integration, seed, reload, and deduplication)');

console.log('All Event Watcher tests passed successfully!');
