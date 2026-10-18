import assert from 'assert';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const Module = require('module');
const stub = class {};

// Mock vscode module for TreeItem tests
Module._load = new Proxy(Module._load, {
  apply(target, thisArg, [request, ...rest]) {
    if (request === 'vscode') {
      return {
        workspace: { getConfiguration: () => ({ get: () => undefined }) },
        window: {},
        commands: {},
        Uri: { file: (p) => ({ fsPath: p }) },
        TreeItem: class {
          constructor(label, collapsibleState) {
            this.label = label;
            this.collapsibleState = collapsibleState;
          }
        },
        EventEmitter: stub,
        Disposable: stub,
        ThemeIcon: class {
          constructor(id, color) {
            this.id = id;
            this.color = color;
          }
        },
        ThemeColor: class {
          constructor(id) {
            this.id = id;
          }
        },
        MarkdownString: class {
          constructor(val) {
            this.value = val;
          }
        },
        RelativePattern: stub,
        TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
        StatusBarAlignment: { Left: 1, Right: 2 },
        ViewColumn: {},
      };
    }
    return Reflect.apply(target, thisArg, [request, ...rest]);
  },
});

const {
  shortTitle,
  deriveShortTitle,
  formatQuestionNotification,
  formatStatusBarTooltip,
  formatEventNotification,
  TaskTreeItem,
  InitiativeTreeItem,
  DecisionTreeItem,
  DecisionGroupTreeItem,
  DecisionQuestionTreeItem,
} = require('../out/extension.js');

console.log('--- Running Short Title Unit Tests ---');

// 1. deriveShortTitle unit tests
console.log('Test 1: deriveShortTitle basic & edge cases');
assert.strictEqual(deriveShortTitle(''), '');
assert.strictEqual(deriveShortTitle(null), '');
assert.strictEqual(deriveShortTitle(undefined), '');
assert.strictEqual(deriveShortTitle('   '), '');
assert.strictEqual(deriveShortTitle('---'), '');

// Strip parentheticals
assert.strictEqual(
  deriveShortTitle('(WIP) Add authentication [deprecated]'),
  'Add authentication'
);

// Strip backticks (and stop word 'in' at position 4 drops to 3 words)
assert.strictEqual(
  deriveShortTitle('Fix `login` bug in `auth.ts`'),
  'Fix login bug'
);
assert.strictEqual(
  deriveShortTitle('Fix `login` form styling'),
  'Fix login form styling'
);

// Strip task, question, note, initiative IDs
assert.strictEqual(
  deriveShortTitle('T025: short title field for tasks'),
  'short title field'
);
assert.strictEqual(
  deriveShortTitle('Q001 — Deploy to pre or prod?'),
  'Deploy to pre'
);
assert.strictEqual(
  deriveShortTitle('N012: User feedback notes'),
  'User feedback notes'
);
assert.strictEqual(
  deriveShortTitle('INIT-03: Foundation revamping'),
  'Foundation revamping'
);
assert.strictEqual(
  deriveShortTitle('#12.1 Task title for feature'),
  'Task title for feature'
);
assert.strictEqual(
  deriveShortTitle('#04 Milestone plan'),
  'Milestone plan'
);

// Drop leading articles
assert.strictEqual(deriveShortTitle('The big database migration'), 'big database migration');
assert.strictEqual(deriveShortTitle('A simple dashboard fix'), 'simple dashboard fix');
assert.strictEqual(deriveShortTitle('An end-to-end integration test'), 'end-to-end integration test');
assert.strictEqual(deriveShortTitle('The The The'), 'The The The'); // all articles fallback

// 3-4 significant words & stop word truncation
// 4th word 'or' is in TRAILING_STOP_WORDS -> truncates to 3 words
assert.strictEqual(deriveShortTitle('Deploy to pre or prod?'), 'Deploy to pre');
// 4th word 'access' is not in TRAILING_STOP_WORDS -> keeps 4 words
assert.strictEqual(deriveShortTitle('Allow external network access?'), 'Allow external network access');
// 1 or 2 words are preserved
assert.strictEqual(deriveShortTitle('Refactor'), 'Refactor');
assert.strictEqual(deriveShortTitle('Refactor auth'), 'Refactor auth');

// Length capped at 40 chars and no trailing punctuation
const longTitle = 'Supercalifragilisticexpialidocious Incomprehensibility Unbelievableness Extraordinariness';
const derivedLong = deriveShortTitle(longTitle);
assert.ok(derivedLong.length <= 40, `Expected <= 40 chars, got ${derivedLong.length}`);
assert.ok(!/[.,:;!?—–\-]$/.test(derivedLong), 'Should have no trailing punctuation');

console.log('PASS: deriveShortTitle unit tests succeeded.');

// 2. shortTitle helper tests
console.log('Test 2: shortTitle helper object dispatch');
assert.strictEqual(shortTitle(''), '');
assert.strictEqual(shortTitle(null), '');
assert.strictEqual(shortTitle(undefined), '');

// String input
assert.strictEqual(shortTitle('T001: Implement login flow'), 'Implement login flow');

// Item with explicit short_title
assert.strictEqual(
  shortTitle({ id: 'T001', title: 'Full Title', short_title: 'Custom Short' }),
  'Custom Short'
);

// Item with explicit camelCase shortTitle
assert.strictEqual(
  shortTitle({ id: 'T001', title: 'Full Title', shortTitle: 'Camel Short' }),
  'Camel Short'
);

// Item with title but no short_title (derives)
assert.strictEqual(
  shortTitle({ id: 'T001', title: 'The quick brown fox jumps over' }),
  'quick brown fox jumps'
);

// Item with question (derives)
assert.strictEqual(
  shortTitle({ id: 'Q001', question: 'Deploy to pre or prod?' }),
  'Deploy to pre'
);

// Explicit short_title with whitespace is trimmed
assert.strictEqual(
  shortTitle({ id: 'T002', short_title: '  Trimmed Title  ' }),
  'Trimmed Title'
);

console.log('PASS: shortTitle helper tests succeeded.');

// 3. Tree view item labeling and tooltips
console.log('Test 3: Tree view items label ID (short title) & full title in description/tooltip');

// Next Up TaskTreeItem
const taskItem = new TaskTreeItem(
  {
    id: 'T025',
    title: 'Short title field across extension',
    short_title: 'short title field',
    state: 'in_progress',
    category: 'feat',
    priority: 'P1',
    priority_reason: 'UX enhancement',
    executor: 'kilo',
    file_path: '/fake/path/T025.md',
  },
  '/fake'
);
assert.strictEqual(taskItem.label, 'T025 (short title field)');
assert.ok(taskItem.description.includes('Short title field across extension'));
assert.ok(taskItem.tooltip.value.includes('T025: Short title field across extension'));

// InitiativeTreeItem
const initItem = new InitiativeTreeItem(
  {
    id: '13',
    title: 'Short title enhancements',
    short_title: 'short title init',
    status: 'in progress',
    tasks: [],
    folder: '13-short-titles',
    rel_path: '13-short-titles/plan.md',
  },
  '/fake'
);
assert.strictEqual(initItem.label, '#13 (short title init)');
assert.ok(initItem.description.includes('Short title enhancements'));
assert.ok(initItem.tooltip.includes('Initiative 13: Short title enhancements'));

// DecisionTreeItem (task-tree-provider)
const decTaskItem = new DecisionTreeItem(
  {
    id: 'T042',
    title: 'Wait on architecture decision',
    short_title: 'arch decision',
    state: 'paused',
    decider: 'architect',
  },
  '/fake'
);
assert.strictEqual(decTaskItem.label, 'T042 (arch decision)');
assert.ok(decTaskItem.description.includes('Wait on architecture decision'));
assert.ok(decTaskItem.tooltip.includes('Task T042: Wait on architecture decision'));

// DecisionQuestionTreeItem (decisions-tree-provider)
const decQItem = new DecisionQuestionTreeItem(
  {
    id: 'Q005',
    question: 'Should we enable dark mode by default?',
    short_title: 'dark mode default',
    status: 'open',
    blocks: 'T010',
    recommended: 'A',
    options: [{ label: 'A', title: 'Yes' }],
  },
  '/fake'
);
assert.strictEqual(decQItem.label, 'Q005 (dark mode default)');
assert.ok(decQItem.tooltip.includes('Q005: Should we enable dark mode by default?'));

// DecisionGroupTreeItem
const decGroupItem = new DecisionGroupTreeItem(
  'T010',
  [{ id: 'Q005' }],
  'Theme and Styling'
);
assert.strictEqual(decGroupItem.label, 'Task T010 (Theme and Styling)');
assert.strictEqual(decGroupItem.description, 'Theme and Styling');
assert.ok(decGroupItem.tooltip.includes('Task T010: Theme and Styling'));

console.log('PASS: Tree view items label ID (short title) & full title in description/tooltip');

// 4. Toasts & status bar tooltips never show bare IDs
console.log('Test 4: Toasts & status bar tooltips with short titles');

// Question notification toast
const qNotif = formatQuestionNotification({
  id: 'Q010',
  question: 'Deploy to pre or prod?',
  short_title: 'Deploy to pre',
});
assert.strictEqual(qNotif, 'Q010 (Deploy to pre) needs a decision');

// Single question status bar tooltip
const singleSb = formatStatusBarTooltip(1, {
  id: 'Q010',
  question: 'Deploy to pre or prod?',
  short_title: 'Deploy to pre',
});
assert.strictEqual(singleSb, 'Q010 (Deploy to pre) needs a decision — click to open');

// Multiple questions status bar tooltip
const multiSb = formatStatusBarTooltip(3);
assert.strictEqual(multiSb, '3 open decisions — click to open');

// Event notification toasts for run finished / failed with task short title
const runFinishedNotif = formatEventNotification({
  type: 'run.finished',
  seq: 1,
  id: 'e1',
  subject: 'RUN-123',
  payload: {
    run_id: 'RUN-123',
    status: 'delivered',
    task: 'T025: short title field for tasks',
    short_title: 'short title field',
  },
});
assert.strictEqual(runFinishedNotif.message, 'Run RUN-123 (short title field) finished: delivered');

const runFailedNotif = formatEventNotification({
  type: 'run.failed',
  seq: 2,
  id: 'e2',
  subject: 'RUN-124',
  payload: {
    run_id: 'RUN-124',
    error: 'Build timeout',
    task: 'T026: notification overhaul',
  },
});
assert.strictEqual(runFailedNotif.message, 'Run RUN-124 (notification overhaul) failed: Build timeout');

console.log('PASS: Toasts & status bar tooltips with short titles verified');

console.log('All Short Title tests passed successfully!');
