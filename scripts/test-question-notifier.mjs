import * as path from 'path';
import * as fs from 'fs';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const Module = require('module');

// Mock 'vscode' module in Node environment
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') {
    return {
      TreeItem: class TreeItem {
        constructor(label, collapsibleState) {
          this.label = label;
          this.collapsibleState = collapsibleState;
        }
      },
      TreeItemCollapsibleState: {
        None: 0,
        Collapsed: 1,
        Expanded: 2,
      },
      EventEmitter: class EventEmitter {
        event = () => {};
        fire() {}
      },
      Disposable: class Disposable {
        constructor(fn) {
          this.fn = fn;
        }
        dispose() {
          if (this.fn) this.fn();
        }
      },
      ThemeIcon: class ThemeIcon {
        constructor(id, color) {
          this.id = id;
          this.color = color;
        }
      },
      ThemeColor: class ThemeColor {
        constructor(id) {
          this.id = id;
        }
      },
      Uri: {
        file: (f) => ({ fsPath: f, scheme: 'file' }),
        joinPath: (base, ...segments) => ({ fsPath: path.join(base.fsPath || base, ...segments) }),
      },
      RelativePattern: class RelativePattern {
        constructor(base, pattern) {
          this.base = base;
          this.pattern = pattern;
        }
      },
      StatusBarAlignment: {
        Left: 1,
        Right: 2,
      },
      window: {
        createOutputChannel: (name) => ({
          appendLine: (msg) => {},
          dispose: () => {},
        }),
        createTreeView: (id, options) => ({
          badge: undefined,
          dispose: () => {},
        }),
        registerTreeDataProvider: () => ({ dispose: () => {} }),
        createStatusBarItem: (alignment, priority) => ({
          alignment,
          priority,
          text: '',
          tooltip: '',
          command: undefined,
          backgroundColor: undefined,
          visible: false,
          show() {
            this.visible = true;
          },
          hide() {
            this.visible = false;
          },
          dispose() {
            this.visible = false;
          },
        }),
        showInformationMessage: async (message, ...items) => {
          return items[0];
        },
      },
      workspace: {
        workspaceFolders: [],
        getConfiguration: () => ({
          get: (key, def) => def,
        }),
        createFileSystemWatcher: () => ({
          onDidChange: () => ({ dispose: () => {} }),
          onDidCreate: () => ({ dispose: () => {} }),
          onDidDelete: () => ({ dispose: () => {} }),
          dispose: () => {},
        }),
        onDidChangeWorkspaceFolders: () => ({ dispose: () => {} }),
      },
      commands: {
        registerCommand: () => ({ dispose: () => {} }),
        executeCommand: async (cmd, ...args) => {},
      },
    };
  }
  return origLoad.call(this, request, parent, isMain);
};

// Import compiled module from out/extension.js
const extension = require('../out/extension.js');
const {
  diffQuestions,
  formatQuestionNotification,
  formatBatchNotification,
  formatStatusBarTooltip,
  QuestionNotifier,
} = extension;

async function runQuestionNotifierTests() {
  console.log('--- Running Question Notifier Unit & Integration Tests ---');

  // Test 1: Pure diff - seed no-toast on first run
  console.log('Test 1: seed no-toast on initial run after activation');
  const initialQuestions = [
    { id: 'Q001', question: 'Should we enable feature X?', status: 'open' },
    { id: 'Q002', question: 'Which pattern to choose?', status: 'open' },
  ];
  const initialResult = diffQuestions(null, initialQuestions, [], true);
  if (initialResult.toNotify.length !== 0) {
    throw new Error(`Expected toNotify to be empty on seed, got ${initialResult.toNotify.length} items`);
  }
  if (initialResult.count !== 2) {
    throw new Error(`Expected count to be 2, got ${initialResult.count}`);
  }
  if (!initialResult.newNotifiedSet.has('Q001') || !initialResult.newNotifiedSet.has('Q002')) {
    throw new Error('Expected newNotifiedSet to contain Q001 and Q002 after seed');
  }
  console.log('PASS: Test 1 (seed no-toast) succeeded.');

  // Test 2: Pure diff - new id → toast
  console.log('Test 2: single new id → toast');
  const currentAfterQ003 = [
    { id: 'Q001', question: 'Should we enable feature X?', status: 'open' },
    { id: 'Q002', question: 'Which pattern to choose?', status: 'open' },
    { id: 'Q003', question: 'Allow external network access?', status: 'open' },
  ];
  const resultSingleNew = diffQuestions(
    ['Q001', 'Q002'],
    currentAfterQ003,
    initialResult.newNotifiedSet,
    false
  );
  if (resultSingleNew.toNotify.length !== 1) {
    throw new Error(`Expected exactly 1 item in toNotify, got ${resultSingleNew.toNotify.length}`);
  }
  if (resultSingleNew.toNotify[0].id !== 'Q003') {
    throw new Error(`Expected toNotify to contain Q003, got ${resultSingleNew.toNotify[0].id}`);
  }
  if (resultSingleNew.count !== 3) {
    throw new Error(`Expected count 3, got ${resultSingleNew.count}`);
  }
  if (!resultSingleNew.newNotifiedSet.has('Q003')) {
    throw new Error('Expected newNotifiedSet to include Q003');
  }
  const toastMsg = formatQuestionNotification(resultSingleNew.toNotify[0]);
  if (toastMsg !== 'Q003 (Allow external network access) needs a decision') {
    throw new Error(`Unexpected single notification format: "${toastMsg}"`);
  }
  console.log(`PASS: Test 2 (single new id toast: "${toastMsg}") succeeded.`);

  // Test 3: Pure diff - batch → one aggregated notification
  console.log('Test 3: batch of new ids → one aggregated notification');
  const currentBatch = [
    { id: 'Q001', question: 'Q1' },
    { id: 'Q002', question: 'Q2' },
    { id: 'Q004', question: 'Q4' },
    { id: 'Q005', question: 'Q5' },
    { id: 'Q006', question: 'Q6' },
  ];
  const resultBatch = diffQuestions(
    ['Q001', 'Q002'],
    currentBatch,
    ['Q001', 'Q002'],
    false
  );
  if (resultBatch.toNotify.length !== 3) {
    throw new Error(`Expected 3 items in toNotify, got ${resultBatch.toNotify.length}`);
  }
  const batchNotifiedIds = resultBatch.toNotify.map((q) => q.id);
  if (JSON.stringify(batchNotifiedIds) !== JSON.stringify(['Q004', 'Q005', 'Q006'])) {
    throw new Error(`Expected [Q004, Q005, Q006], got ${JSON.stringify(batchNotifiedIds)}`);
  }
  if (resultBatch.count !== 5) {
    throw new Error(`Expected count 5, got ${resultBatch.count}`);
  }
  const batchMsg = formatBatchNotification(resultBatch.toNotify.length);
  if (batchMsg !== '3 new decisions waiting') {
    throw new Error(`Unexpected batch message format: "${batchMsg}"`);
  }
  console.log(`PASS: Test 3 (batch notification: "${batchMsg}") succeeded.`);

  // Test 4: Pure diff - answered → count decreases, no toast
  console.log('Test 4: answered question → count decreases without toast');
  const currentAfterAnswer = [
    { id: 'Q002', question: 'Which pattern to choose?', status: 'open' },
    // Q001 was answered/withdrawn
  ];
  const resultAnswered = diffQuestions(
    ['Q001', 'Q002'],
    currentAfterAnswer,
    ['Q001', 'Q002'],
    false
  );
  if (resultAnswered.toNotify.length !== 0) {
    throw new Error(`Expected 0 items to notify on answer, got ${resultAnswered.toNotify.length}`);
  }
  if (resultAnswered.count !== 1) {
    throw new Error(`Expected count to decrease to 1, got ${resultAnswered.count}`);
  }
  if (!resultAnswered.newNotifiedSet.has('Q001') || !resultAnswered.newNotifiedSet.has('Q002')) {
    throw new Error('Expected newNotifiedSet to retain previous notified IDs');
  }
  console.log('PASS: Test 4 (count decreases on answer) succeeded.');

  // Test 5: Persistence round-trip & reload simulation
  console.log('Test 5: persistence round-trip in workspaceState');
  const mockWorkspaceState = new Map();
  const stateKey = 'aiOrchestration.notifiedQuestions:/test/workspace';

  // Session 1: initial seed of Q001, Q002
  const s1Result = diffQuestions(null, initialQuestions, [], true);
  mockWorkspaceState.set(stateKey, Array.from(s1Result.newNotifiedSet));

  // Reload: read from workspaceState
  const persistedArray = mockWorkspaceState.get(stateKey);
  const reloadedSet = new Set(persistedArray);

  // Session 2: new question Q007 arrives while Q001 and Q002 are still open
  const s2Questions = [
    ...initialQuestions,
    { id: 'Q007', question: 'New decision after reload?' },
  ];
  const s2Result = diffQuestions(null, s2Questions, reloadedSet, false);
  if (s2Result.toNotify.length !== 1 || s2Result.toNotify[0].id !== 'Q007') {
    throw new Error(`Expected only Q007 in toNotify after reload, got ${JSON.stringify(s2Result.toNotify)}`);
  }
  mockWorkspaceState.set(stateKey, Array.from(s2Result.newNotifiedSet));

  // Reload again: verify Q007 is remembered and not notified a second time
  const reloadedAgainSet = new Set(mockWorkspaceState.get(stateKey));
  const s3Result = diffQuestions(null, s2Questions, reloadedAgainSet, false);
  if (s3Result.toNotify.length !== 0) {
    throw new Error(`Expected 0 items to notify on second reload, got ${s3Result.toNotify.length}`);
  }
  console.log('PASS: Test 5 (persistence round-trip) succeeded.');

  // Test 6: Status bar formatting and warning background behavior
  console.log('Test 6: status bar item formatting & warning background');
  const mockContext = {
    workspaceState: {
      get: (k, def) => mockWorkspaceState.get(k) || def,
      update: async (k, v) => {
        mockWorkspaceState.set(k, v);
      },
    },
    subscriptions: [],
  };
  const mockCli = {
    listQuestions: async (root, status) => ({
      ok: true,
      questions: currentAfterQ003,
    }),
  };

  const notifier = new QuestionNotifier(
    mockContext,
    mockCli,
    () => process.cwd()
  );
  const sbItem = notifier.getStatusBarItem();

  // Test status bar with count > 0
  notifier.updateStatusBar(3);
  if (sbItem.text !== '$(question) 3') {
    throw new Error(`Expected text '$(question) 3', got '${sbItem.text}'`);
  }
  if (sbItem.tooltip !== '3 open decisions — click to open') {
    throw new Error(`Expected tooltip '3 open decisions — click to open', got '${sbItem.tooltip}'`);
  }
  if (!sbItem.backgroundColor || sbItem.backgroundColor.id !== 'statusBarItem.warningBackground') {
    throw new Error(`Expected warning background for count > 0, got ${JSON.stringify(sbItem.backgroundColor)}`);
  }

  // Test status bar with count = 0 (neutral background)
  notifier.updateStatusBar(0);
  if (sbItem.text !== '$(question) 0') {
    throw new Error(`Expected text '$(question) 0', got '${sbItem.text}'`);
  }
  if (sbItem.tooltip !== '0 open decisions — click to open') {
    throw new Error(`Expected tooltip '0 open decisions — click to open', got '${sbItem.tooltip}'`);
  }
  if (sbItem.backgroundColor !== undefined) {
    throw new Error(`Expected undefined (neutral) background for count 0, got ${JSON.stringify(sbItem.backgroundColor)}`);
  }
  notifier.dispose();
  console.log('PASS: Test 6 (status bar item formatting & warning background) succeeded.');

  // Test 7: Object-based options signature support
  console.log('Test 7: object-based options signature support');
  const objResult = diffQuestions({
    currentQuestions: currentAfterQ003,
    persistedNotifiedIds: ['Q001', 'Q002'],
    isInitialRun: false,
  });
  if (objResult.toNotify.length !== 1 || objResult.toNotify[0].id !== 'Q003') {
    throw new Error('Object signature diffQuestions failed to return Q003 in toNotify');
  }
  console.log('PASS: Test 7 (object options signature) succeeded.');

  console.log('All Question Notifier tests passed successfully!');
}

runQuestionNotifierTests().catch((err) => {
  console.error('FAIL in Question Notifier tests:', err);
  process.exit(1);
});
