import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const Module = require('module');
const stub = class {};
Module._load = new Proxy(Module._load, {
  apply(target, thisArg, [request, ...rest]) {
    if (request === 'vscode') {
      return {
        workspace: { getConfiguration: () => ({ get: () => undefined }) },
        window: {}, commands: {}, Uri: stub, TreeItem: stub, EventEmitter: stub, Disposable: stub,
        ThemeIcon: stub, ThemeColor: stub, MarkdownString: stub, RelativePattern: stub,
        TreeItemCollapsibleState: {}, StatusBarAlignment: {}, ViewColumn: {},
      };
    }
    return Reflect.apply(target, thisArg, [request, ...rest]);
  },
});

const {
  HANDLER_MAP,
  CLI_COMMAND_MAP,
  CUSTOM_HANDLERS,
  TREE_NODE_ID_RE,
  requireTreeNodeId,
  QUESTION_ID_RE,
  requireQuestionId,
  MICRO_ID_RE,
  requireMicrotaskId,
  NOTE_ID_RE,
  requireNoteId,
  VALID_KINDS,
  VALID_PRIORITIES,
  VALID_SIZES,
  LABEL_RE,
  extractLabels,
  checkOriginRunContinuable,
  formatContinuationInstructions,
  isReadOnlyCommand,
} = require('../out/extension.js');

const fail = (m) => { console.error(`FAIL: ${m}`); process.exit(1); };

console.log('--- Running Parity Handlers & Argument Builders Tests ---');

// 1. Verify all 19 message types exist in HANDLER_MAP
const newTypes = [
  'previewAnswerAndResume',
  'answerAndResume',
  'previewAddChild',
  'addChild',
  'previewExpandTask',
  'expandTask',
  'previewCollapseTask',
  'collapseTask',
  'previewReopenTask',
  'reopenTask',
  'getLabels',
  'createMicrotask',
  'previewPromoteMicrotask',
  'promoteMicrotask',
  'previewSetKind',
  'setKind',
  'previewSetLabels',
  'setLabels',
  'inboxToMicrotask',
];

for (const t of newTypes) {
  if (typeof HANDLER_MAP[t] !== 'function') {
    fail(`HANDLER_MAP missing function for ${t}`);
  }
}
console.log('PASS: All 19 new handlers present in HANDLER_MAP');

// 2. ID validation tests
// Tree node IDs: ^(T\d{3,}(\.\d+)*|\d{2,}\.\d+(\.\d+)*)$
const validTreeIds = ['T001', 'T123', 'T042.1', 'T123.1.2', '01.1', '01.1.2', '10.2', '10.2.1'];
for (const id of validTreeIds) {
  if (!TREE_NODE_ID_RE.test(id)) fail(`TREE_NODE_ID_RE should match ${id}`);
  if (requireTreeNodeId({ id }) !== id) fail(`requireTreeNodeId failed for ${id}`);
  if (requireTreeNodeId({ taskId: id }) !== id) fail(`requireTreeNodeId failed for taskId ${id}`);
  if (requireTreeNodeId({ parentId: id }) !== id) fail(`requireTreeNodeId failed for parentId ${id}`);
}
const invalidTreeIds = ['', 'T', 'T1', 'T12', '1.1', '01', 'T001.', '01.1.', 'invalid', 'N001', 'Q001', '../T001', 'T001/'];
for (const id of invalidTreeIds) {
  if (TREE_NODE_ID_RE.test(id)) fail(`TREE_NODE_ID_RE should not match ${id}`);
  try {
    requireTreeNodeId({ id });
    fail(`requireTreeNodeId should have rejected ${id}`);
  } catch (e) {
    if (e.status !== 400 && !e.message.includes('Invalid')) fail(`Expected 400 status for invalid tree node id ${id}`);
  }
}
console.log('PASS: Tree node ID validation (valid and invalid formats)');

// Question IDs: ^Q\d{3,}$
const validQIds = ['Q001', 'Q123', 'Q9999'];
for (const id of validQIds) {
  if (!QUESTION_ID_RE.test(id)) fail(`QUESTION_ID_RE should match ${id}`);
  if (requireQuestionId({ id }) !== id) fail(`requireQuestionId failed for ${id}`);
}
const invalidQIds = ['', 'Q', 'Q1', 'Q12', 'Q001a', 'T001', 'N001', 'invalid'];
for (const id of invalidQIds) {
  if (QUESTION_ID_RE.test(id)) fail(`QUESTION_ID_RE should not match ${id}`);
  try {
    requireQuestionId({ id });
    fail(`requireQuestionId should have rejected ${id}`);
  } catch (e) {
    if (e.status !== 400) fail(`Expected 400 status for invalid question id ${id}`);
  }
}
console.log('PASS: Question ID validation');

// Microtask IDs: ^T\d{3,}$
const validMicroIds = ['T001', 'T042', 'T9999'];
for (const id of validMicroIds) {
  if (!MICRO_ID_RE.test(id)) fail(`MICRO_ID_RE should match ${id}`);
  if (requireMicrotaskId({ id }) !== id) fail(`requireMicrotaskId failed for ${id}`);
}
const invalidMicroIds = ['', 'T', 'T1', 'T12', 'T001.1', '01.1', 'N001', 'Q001'];
for (const id of invalidMicroIds) {
  if (MICRO_ID_RE.test(id)) fail(`MICRO_ID_RE should not match ${id}`);
  try {
    requireMicrotaskId({ id });
    fail(`requireMicrotaskId should have rejected ${id}`);
  } catch (e) {
    if (e.status !== 400) fail(`Expected 400 status for invalid microtask id ${id}`);
  }
}
console.log('PASS: Microtask ID validation');

// 3. Argument Builders & Validation
const fakeRoot = '/fake/workspace';
const fakeTasksDir = path.join(fakeRoot, 'tasks');

// A. previewAddChild & addChild
// preview
const previewChildArgs = CLI_COMMAND_MAP.previewAddChild({ id: '01.1', title: 'Subtask 1', kind: 'feature' }, fakeRoot);
if (!previewChildArgs.includes('--dry-run')) fail('previewAddChild must include --dry-run');
if (previewChildArgs.includes('--expect-plan-hash')) fail('previewAddChild must not require plan hash');
if (!previewChildArgs.includes('Subtask 1')) fail('previewAddChild must include title');
if (!previewChildArgs.includes('feature')) fail('previewAddChild must include kind');

// apply without hash -> fails
try {
  CLI_COMMAND_MAP.addChild({ id: '01.1', title: 'Subtask 1' }, fakeRoot);
  fail('addChild must fail without expect_plan_hash');
} catch (e) {
  if (!e.message.includes('expect_plan_hash')) fail(`addChild error should mention expect_plan_hash: ${e.message}`);
}
// apply with bad id -> fails
try {
  CLI_COMMAND_MAP.addChild({ id: 'bad-id', title: 'Subtask 1', expect_plan_hash: 'abc' }, fakeRoot);
  fail('addChild must reject bad tree node ID');
} catch (e) {
  if (!e.message.includes('Invalid tree node ID')) fail(`addChild error should mention Invalid tree node ID: ${e.message}`);
}
// apply with missing title -> fails
try {
  CLI_COMMAND_MAP.addChild({ id: '01.1', title: '', expect_plan_hash: 'abc' }, fakeRoot);
  fail('addChild must reject missing title');
} catch (e) {
  if (!e.message.includes('title is required')) fail(`addChild error should mention title is required: ${e.message}`);
}
// apply success
const applyChildArgs = CLI_COMMAND_MAP.addChild({ id: '01.1', title: 'Subtask 1', kind: 'bug', expect_plan_hash: 'hash123' }, fakeRoot);
if (applyChildArgs.includes('--dry-run')) fail('addChild apply must not include --dry-run');
if (!applyChildArgs.includes('--expect-plan-hash') || !applyChildArgs.includes('hash123')) fail('addChild apply must include --expect-plan-hash hash123');
console.log('PASS: previewAddChild and addChild argument builder & validation');

// B. previewExpandTask & expandTask
const previewExpandArgs = CLI_COMMAND_MAP.previewExpandTask({ id: '01.1' }, fakeRoot);
if (!previewExpandArgs.includes('expand') || !previewExpandArgs.includes('01.1') || !previewExpandArgs.includes('--dry-run')) {
  fail('previewExpandTask arguments incorrect');
}
try {
  CLI_COMMAND_MAP.expandTask({ id: '01.1' }, fakeRoot);
  fail('expandTask must fail without expect_plan_hash');
} catch (e) {
  if (!e.message.includes('expect_plan_hash')) fail(`expandTask error should mention expect_plan_hash: ${e.message}`);
}
try {
  CLI_COMMAND_MAP.expandTask({ id: 'invalid_id', expect_plan_hash: 'hash' }, fakeRoot);
  fail('expandTask must reject bad id');
} catch (e) {}
const applyExpandArgs = CLI_COMMAND_MAP.expandTask({ id: 'T042.1', expect_plan_hash: 'hash99' }, fakeRoot);
if (applyExpandArgs.includes('--dry-run') || !applyExpandArgs.includes('--expect-plan-hash') || !applyExpandArgs.includes('hash99')) {
  fail('expandTask apply arguments incorrect');
}
console.log('PASS: previewExpandTask and expandTask argument builder & validation');

// C. previewCollapseTask & collapseTask
const previewCollapseArgs = CLI_COMMAND_MAP.previewCollapseTask({ id: '01.1' }, fakeRoot);
if (!previewCollapseArgs.includes('collapse') || !previewCollapseArgs.includes('01.1') || !previewCollapseArgs.includes('--dry-run')) {
  fail('previewCollapseTask arguments incorrect');
}
try {
  CLI_COMMAND_MAP.collapseTask({ id: '01.1' }, fakeRoot);
  fail('collapseTask must fail without expect_plan_hash');
} catch (e) {
  if (!e.message.includes('expect_plan_hash')) fail(`collapseTask error should mention expect_plan_hash: ${e.message}`);
}
try {
  CLI_COMMAND_MAP.collapseTask({ id: 'invalid_id', expect_plan_hash: 'hash' }, fakeRoot);
  fail('collapseTask must reject bad id');
} catch (e) {}
const applyCollapseArgs = CLI_COMMAND_MAP.collapseTask({ id: 'T042.1', expect_plan_hash: 'hash99' }, fakeRoot);
if (applyCollapseArgs.includes('--dry-run') || !applyCollapseArgs.includes('--expect-plan-hash') || !applyCollapseArgs.includes('hash99')) {
  fail('collapseTask apply arguments incorrect');
}
console.log('PASS: previewCollapseTask and collapseTask argument builder & validation');

// D. previewReopenTask & reopenTask
try {
  CLI_COMMAND_MAP.previewReopenTask({ id: '01.1', reason: '' }, fakeRoot);
  fail('previewReopenTask must reject empty reason');
} catch (e) {
  if (!e.message.includes('reason is required')) fail(`previewReopenTask error should mention reason is required: ${e.message}`);
}
const previewReopenArgs = CLI_COMMAND_MAP.previewReopenTask({ id: '01.1', reason: 'needs rework' }, fakeRoot);
if (!previewReopenArgs.includes('reopen') || !previewReopenArgs.includes('--reason') || !previewReopenArgs.includes('needs rework') || !previewReopenArgs.includes('--dry-run')) {
  fail('previewReopenTask arguments incorrect');
}
try {
  CLI_COMMAND_MAP.reopenTask({ id: '01.1', reason: 'needs rework' }, fakeRoot);
  fail('reopenTask must fail without expect_plan_hash');
} catch (e) {
  if (!e.message.includes('expect_plan_hash')) fail(`reopenTask error should mention expect_plan_hash: ${e.message}`);
}
try {
  CLI_COMMAND_MAP.reopenTask({ id: 'invalid_id', reason: 'needs rework', expect_plan_hash: 'h' }, fakeRoot);
  fail('reopenTask must reject bad id');
} catch (e) {}
const applyReopenArgs = CLI_COMMAND_MAP.reopenTask({ id: '01.1', reason: 'needs rework', expect_plan_hash: 'planHash' }, fakeRoot);
if (applyReopenArgs.includes('--dry-run') || !applyReopenArgs.includes('--expect-plan-hash') || !applyReopenArgs.includes('planHash')) {
  fail('reopenTask apply arguments incorrect');
}
console.log('PASS: previewReopenTask and reopenTask argument builder & validation');

// E. getLabels
const labelsArgs = CLI_COMMAND_MAP.getLabels({}, fakeRoot);
if (labelsArgs[0] !== 'tasks' || labelsArgs[1] !== 'labels' || !labelsArgs.includes(fakeTasksDir)) {
  fail(`getLabels arguments incorrect: ${labelsArgs.join(' ')}`);
}
console.log('PASS: getLabels argument builder');

// F. createMicrotask
try {
  CLI_COMMAND_MAP.createMicrotask({ title: '' }, fakeRoot);
  fail('createMicrotask must reject empty title');
} catch (e) {
  if (!e.message.includes('title is required')) fail(`createMicrotask should mention title is required: ${e.message}`);
}
try {
  CLI_COMMAND_MAP.createMicrotask({ title: 'Task', kind: 'invalid-kind' }, fakeRoot);
  fail('createMicrotask must reject invalid kind');
} catch (e) {
  if (!e.message.includes('Invalid kind')) fail(`createMicrotask should mention Invalid kind: ${e.message}`);
}
try {
  CLI_COMMAND_MAP.createMicrotask({ title: 'Task', priority: 'P9' }, fakeRoot);
  fail('createMicrotask must reject invalid priority');
} catch (e) {
  if (!e.message.includes('Invalid priority')) fail(`createMicrotask should mention Invalid priority: ${e.message}`);
}
try {
  CLI_COMMAND_MAP.createMicrotask({ title: 'Task', size: 'XXL' }, fakeRoot);
  fail('createMicrotask must reject invalid size');
} catch (e) {
  if (!e.message.includes('Invalid size')) fail(`createMicrotask should mention Invalid size: ${e.message}`);
}
try {
  CLI_COMMAND_MAP.createMicrotask({ title: 'Task', labels: ['valid-label', 'INVALID_LABEL!'] }, fakeRoot);
  fail('createMicrotask must reject invalid label');
} catch (e) {
  if (!e.message.includes('Invalid label format')) fail(`createMicrotask should mention Invalid label format: ${e.message}`);
}

const fullMicroArgs = CLI_COMMAND_MAP.createMicrotask({
  title: 'Fix typo',
  kind: 'fix',
  priority: 'P1',
  size: 'S',
  paths: 'src/file.ts',
  depends_on: 'T001',
  executor: 'kilo',
  what: 'Fix typo in comment',
  labels: ['docs', 'quick-fix'],
}, fakeRoot);

if (!fullMicroArgs.includes('micro') ||
    !fullMicroArgs.includes('Fix typo') ||
    !fullMicroArgs.includes('fix') ||
    !fullMicroArgs.includes('P1') ||
    !fullMicroArgs.includes('S') ||
    !fullMicroArgs.includes('src/file.ts') ||
    !fullMicroArgs.includes('T001') ||
    !fullMicroArgs.includes('kilo') ||
    !fullMicroArgs.includes('docs') ||
    !fullMicroArgs.includes('quick-fix')) {
  fail(`createMicrotask arguments incorrect: ${fullMicroArgs.join(' ')}`);
}
console.log('PASS: createMicrotask argument builder & validation');

// G. promoteMicrotask
try {
  CLI_COMMAND_MAP.promoteMicrotask({ id: 'bad-id' }, fakeRoot);
  fail('promoteMicrotask must reject bad microtask ID');
} catch (e) {
  if (!e.message.includes('Invalid microtask id')) fail(`promoteMicrotask error: ${e.message}`);
}
const promoteArgs = CLI_COMMAND_MAP.promoteMicrotask({ id: 'T042', category: 'architecture' }, fakeRoot);
if (!promoteArgs.includes('promote') || !promoteArgs.includes('T042') || !promoteArgs.includes('architecture')) {
  fail(`promoteMicrotask arguments incorrect: ${promoteArgs.join(' ')}`);
}
// default category is maintenance
const promoteDefaultArgs = CLI_COMMAND_MAP.promoteMicrotask({ taskId: 'T042' }, fakeRoot);
if (!promoteDefaultArgs.includes('maintenance')) {
  fail(`promoteMicrotask default category should be maintenance: ${promoteDefaultArgs.join(' ')}`);
}
console.log('PASS: promoteMicrotask argument builder & validation');

// H. previewSetKind & setKind
try {
  CLI_COMMAND_MAP.previewSetKind({ taskId: 'bad-id', kind: 'bug' }, fakeRoot);
  fail('previewSetKind must reject bad task id');
} catch (e) {}
try {
  CLI_COMMAND_MAP.previewSetKind({ taskId: 'T001', kind: 'nonexistent' }, fakeRoot);
  fail('previewSetKind must reject invalid kind');
} catch (e) {}
const previewKindArgs = CLI_COMMAND_MAP.previewSetKind({ taskId: 'T001', kind: 'feature' }, fakeRoot);
if (!previewKindArgs.includes('set-kind') || !previewKindArgs.includes('feature') || !previewKindArgs.includes('--dry-run')) {
  fail('previewSetKind arguments incorrect');
}
try {
  CLI_COMMAND_MAP.setKind({ taskId: 'T001', kind: 'bug' }, fakeRoot);
  fail('setKind must fail without expect_task_hash');
} catch (e) {
  if (!e.message.includes('expect_task_hash is required')) fail(`setKind error should mention expect_task_hash: ${e.message}`);
}
const applyKindArgs = CLI_COMMAND_MAP.setKind({ taskId: '01.1', kind: 'bug', expect_task_hash: 'taskHash123' }, fakeRoot);
if (applyKindArgs.includes('--dry-run') || !applyKindArgs.includes('--expect-task-hash') || !applyKindArgs.includes('taskHash123')) {
  fail('setKind apply arguments incorrect');
}
console.log('PASS: previewSetKind and setKind argument builder & validation');

// I. previewSetLabels & setLabels
try {
  CLI_COMMAND_MAP.previewSetLabels({ taskId: 'bad-id', add: 'ui' }, fakeRoot);
  fail('previewSetLabels must reject bad task id');
} catch (e) {}
try {
  CLI_COMMAND_MAP.previewSetLabels({ taskId: 'T001' }, fakeRoot);
  fail('previewSetLabels must reject when no add/remove/to is specified');
} catch (e) {
  if (!e.message.includes('at least one of add, remove, or to/labels is required')) fail(`setLabels error: ${e.message}`);
}
try {
  CLI_COMMAND_MAP.previewSetLabels({ taskId: 'T001', add: 'INVALID LABEL!' }, fakeRoot);
  fail('previewSetLabels must reject invalid label');
} catch (e) {}

const previewLabelsArgs = CLI_COMMAND_MAP.previewSetLabels({ taskId: 'T001', add: ['ui', 'frontend'], remove: 'legacy' }, fakeRoot);
if (!previewLabelsArgs.includes('set-labels') || !previewLabelsArgs.includes('--add') || !previewLabelsArgs.includes('ui') || !previewLabelsArgs.includes('frontend') || !previewLabelsArgs.includes('--remove') || !previewLabelsArgs.includes('legacy') || !previewLabelsArgs.includes('--dry-run')) {
  fail(`previewSetLabels arguments incorrect: ${previewLabelsArgs.join(' ')}`);
}

try {
  CLI_COMMAND_MAP.setLabels({ taskId: 'T001', to: 'clean' }, fakeRoot);
  fail('setLabels must fail without expect_task_hash');
} catch (e) {
  if (!e.message.includes('expect_task_hash is required')) fail(`setLabels error should mention expect_task_hash: ${e.message}`);
}

const applyLabelsArgs = CLI_COMMAND_MAP.setLabels({ taskId: '01.1.2', to: ['clean', 'v2'], expect_task_hash: 'h789' }, fakeRoot);
if (applyLabelsArgs.includes('--dry-run') || !applyLabelsArgs.includes('--to') || !applyLabelsArgs.includes('clean') || !applyLabelsArgs.includes('v2') || !applyLabelsArgs.includes('--expect-task-hash') || !applyLabelsArgs.includes('h789')) {
  fail(`setLabels apply arguments incorrect: ${applyLabelsArgs.join(' ')}`);
}
console.log('PASS: previewSetLabels and setLabels argument builder & validation');

// 4. CLI client read-only set verification
if (!isReadOnlyCommand(['tasks', 'labels', '--tasks-dir', fakeTasksDir])) {
  fail('isReadOnlyCommand should return true for tasks labels');
}
console.log('PASS: tasks labels is in read-only command set');

// 5. Test checkOriginRunContinuable & formatContinuationInstructions
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parity-test-'));
try {
  // Test formatContinuationInstructions
  const formatted = formatContinuationInstructions('Q001', 'Allow network?', 'A', 'free details', [
    { label: 'A', title: 'Yes, allow' },
    { label: 'B', title: 'No' },
  ]);
  if (!formatted.includes('Answer to Q001 (Allow network?): A — Yes, allow.') || !formatted.includes('free details')) {
    fail(`formatContinuationInstructions mismatch: ${formatted}`);
  }

  // checkOriginRunContinuable validations
  const noRunRes = checkOriginRunContinuable(tmpDir, '-');
  if (noRunRes.isCont || !noRunRes.reason.includes('no origin-run')) {
    fail('checkOriginRunContinuable should report no origin-run for "-"');
  }

  const badIdRes = checkOriginRunContinuable(tmpDir, 'invalid-run-id');
  if (badIdRes.isCont || !badIdRes.reason.includes('Invalid origin-run id')) {
    fail('checkOriginRunContinuable should report invalid id');
  }

  const validRunId = '20261018-120000-T001-kilo-abcd';
  const missingRunRes = checkOriginRunContinuable(tmpDir, validRunId);
  if (missingRunRes.isCont || !missingRunRes.reason.includes('not found in runs registry')) {
    fail('checkOriginRunContinuable should report not found');
  }

  // Create fake run record
  const runFolder = path.join(tmpDir, '.ai-orchestration', 'runs', validRunId);
  fs.mkdirSync(runFolder, { recursive: true });
  fs.writeFileSync(path.join(runFolder, 'run.json'), JSON.stringify({
    run_id: validRunId,
    status: 'succeeded',
    session_id: 'sess-123',
    plan_hash: 'plan-hash-1',
  }));

  const validRunRes = checkOriginRunContinuable(tmpDir, validRunId);
  if (!validRunRes.isCont || validRunRes.record.session_id !== 'sess-123') {
    fail('checkOriginRunContinuable should succeed for valid terminal run with session_id');
  }
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}
console.log('PASS: checkOriginRunContinuable and formatContinuationInstructions unit tests');

// 6. Test previewPromoteMicrotask handler
const microTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parity-micro-'));
try {
  const microDir = path.join(microTmpDir, 'tasks', 'micro');
  fs.mkdirSync(microDir, { recursive: true });
  const microFile = path.join(microDir, 'T015-fix-header.md');
  fs.writeFileSync(microFile, '# T015 Fix Header\nGoal: Fix header');
  const fileHash = crypto.createHash('sha256').update(fs.readFileSync(microFile)).digest('hex');

  const mockPanel = {
    cliClient: { runJsonCommand: async () => ({ ok: true }) },
    postMessage: () => {},
  };

  // Missing microtask -> 404
  try {
    await CUSTOM_HANDLERS.previewPromoteMicrotask(mockPanel, { taskId: 'T099' }, microTmpDir);
    fail('previewPromoteMicrotask must 404 for nonexistent microtask');
  } catch (e) {
    if (e.status !== 404) fail(`Expected 404 status: ${e}`);
  }

  // Hash mismatch -> 409
  try {
    await CUSTOM_HANDLERS.previewPromoteMicrotask(mockPanel, { taskId: 'T015', expect_task_hash: 'wrong-hash' }, microTmpDir);
    fail('previewPromoteMicrotask must 409 for hash mismatch');
  } catch (e) {
    if (e.status !== 409) fail(`Expected 409 status: ${e}`);
  }

  // Success preview
  const prevRes = await CUSTOM_HANDLERS.previewPromoteMicrotask(mockPanel, { taskId: 'T015', category: 'maintenance', expect_task_hash: fileHash }, microTmpDir);
  if (!prevRes.ok || !prevRes.dry_run || prevRes.hash !== fileHash || !prevRes.diff.includes('T015-fix-header.md')) {
    fail(`previewPromoteMicrotask response mismatch: ${JSON.stringify(prevRes)}`);
  }
} finally {
  fs.rmSync(microTmpDir, { recursive: true, force: true });
}
console.log('PASS: previewPromoteMicrotask custom handler tests');

// 7. Test inboxToMicrotask handler
const inboxTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parity-inbox-'));
try {
  let executedCmds = [];
  let postedMessages = [];
  let updatedCalled = false;
  const mockPanel = {
    cliClient: {
      runJsonCommand: async (cmd) => {
        executedCmds.push(cmd);
        if (cmd[0] === 'inbox' && cmd[1] === 'show') {
          return {
            ok: true,
            note: {
              id: 'N005',
              title: 'Crash on launch',
              kind: 'bug',
              body: 'App crashed with code 1',
              about: 'core, crash',
            },
          };
        }
        if (cmd[0] === 'tasks' && cmd[1] === 'micro') {
          return { ok: true, id: 'T016' };
        }
        if (cmd[0] === 'inbox' && cmd[1] === 'resolve') {
          return { ok: true };
        }
        return { ok: true };
      },
    },
    postMessage: (msg) => { postedMessages.push(msg); },
    onTasksUpdated: () => { updatedCalled = true; },
  };

  const res = await CUSTOM_HANDLERS.inboxToMicrotask(mockPanel, { noteId: 'N005' }, inboxTmpDir);
  if (!res.ok || res.id !== 'T016') fail(`inboxToMicrotask response unexpected: ${JSON.stringify(res)}`);

  // Verify inbox show was run
  if (!executedCmds.some((c) => c[0] === 'inbox' && c[1] === 'show' && c[2] === 'N005')) {
    fail('inboxToMicrotask should call inbox show N005');
  }
  // Verify tasks micro was run with note details
  const microCmd = executedCmds.find((c) => c[0] === 'tasks' && c[1] === 'micro');
  if (!microCmd || !microCmd.includes('Crash on launch') || !microCmd.includes('bug') || !microCmd.includes('core')) {
    fail(`inboxToMicrotask micro command unexpected: ${microCmd?.join(' ')}`);
  }
  // Verify inbox resolve was run with produced T016
  if (!executedCmds.some((c) => c[0] === 'inbox' && c[1] === 'resolve' && c.includes('T016'))) {
    fail('inboxToMicrotask should call inbox resolve with produced T016');
  }
  // Verify notifications
  if (!postedMessages.some((m) => m.type === 'changed' && m.areas.includes('inbox') && m.areas.includes('tasks'))) {
    fail('inboxToMicrotask should post changed notification for inbox and tasks');
  }
  if (!postedMessages.some((m) => m.type === 'task_created' && m.task_id === 'T016')) {
    fail('inboxToMicrotask should post task_created notification for T016');
  }
  if (!updatedCalled) fail('inboxToMicrotask should call onTasksUpdated');
} finally {
  fs.rmSync(inboxTmpDir, { recursive: true, force: true });
}
console.log('PASS: inboxToMicrotask custom handler tests');

// 8. Test previewAnswerAndResume and answerAndResume handlers
const ansTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parity-answer-'));
try {
  const runId = '20261018-120000-T001-kilo-1234';
  const runFolder = path.join(ansTmpDir, '.ai-orchestration', 'runs', runId);
  fs.mkdirSync(runFolder, { recursive: true });
  fs.writeFileSync(path.join(runFolder, 'run.json'), JSON.stringify({
    run_id: runId,
    status: 'succeeded',
    session_id: 'session-xyz',
    plan_hash: 'hash-abc',
  }));

  let executedCmds = [];
  let postedMessages = [];
  let updatedCalled = false;
  const mockPanel = {
    cliClient: {
      runJsonCommand: async (cmd) => {
        executedCmds.push(cmd);
        if (cmd[0] === 'questions' && cmd[1] === 'show') {
          return {
            ok: true,
            question: {
              id: 'Q001',
              status: 'open',
              question: 'Continue with approach?',
              origin_run: runId,
              options: [{ label: 'A', title: 'Yes proceed' }, { label: 'B', title: 'Abort' }],
            },
          };
        }
        if (cmd[0] === 'questions' && cmd[1] === 'answer') {
          return { ok: true, choice: 'A' };
        }
        if (cmd[0] === 'run' && cmd[1] === 'start' && cmd.includes('--continue')) {
          return { ok: true, run_id: '20261018-120500-T001-kilo-5678' };
        }
        return { ok: true };
      },
    },
    postMessage: (msg) => { postedMessages.push(msg); },
    onTasksUpdated: () => { updatedCalled = true; },
  };

  // Preview
  const prev = await CUSTOM_HANDLERS.previewAnswerAndResume(mockPanel, { id: 'Q001', choice: 'A', text: 'More notes' }, ansTmpDir);
  if (!prev.ok || !prev.continuable || !prev.can_resume || prev.plan_hash !== 'hash-abc' || !prev.instructions.includes('Yes proceed')) {
    fail(`previewAnswerAndResume response unexpected: ${JSON.stringify(prev)}`);
  }

  // Apply hash mismatch -> 409
  try {
    await CUSTOM_HANDLERS.answerAndResume(mockPanel, { id: 'Q001', choice: 'A', expect_plan_hash: 'wrong-hash' }, ansTmpDir);
    fail('answerAndResume should fail on hash mismatch');
  } catch (e) {
    if (e.status !== 409) fail(`Expected 409 status for hash mismatch: ${e}`);
  }

  // Apply success
  const ansRes = await CUSTOM_HANDLERS.answerAndResume(mockPanel, { id: 'Q001', choice: 'A', text: 'Notes', expect_plan_hash: 'hash-abc' }, ansTmpDir);
  if (!ansRes.ok || !ansRes.resumed || ansRes.continued_from !== runId) {
    fail(`answerAndResume response unexpected: ${JSON.stringify(ansRes)}`);
  }

  // Verify questions answer CLI was run
  if (!executedCmds.some((c) => c[0] === 'questions' && c[1] === 'answer' && c[2] === 'Q001' && c.includes('A'))) {
    fail('answerAndResume should call questions answer Q001 --choice A');
  }
  // Verify run start --continue was run
  if (!executedCmds.some((c) => c[0] === 'run' && c[1] === 'start' && c.includes('--continue') && c.includes(runId))) {
    fail('answerAndResume should call run start --continue');
  }
  // Verify broadcasts
  if (!postedMessages.some((m) => m.type === 'changed' && m.areas.includes('runs') && m.areas.includes('questions'))) {
    fail('answerAndResume should broadcast changed areas');
  }
  if (!postedMessages.some((m) => m.type === 'question_answered' && m.question_id === 'Q001')) {
    fail('answerAndResume should broadcast question_answered');
  }
  if (!updatedCalled) fail('answerAndResume should call onTasksUpdated');
} finally {
  fs.rmSync(ansTmpDir, { recursive: true, force: true });
}
console.log('PASS: previewAnswerAndResume and answerAndResume custom handler tests');

console.log('All parity handlers & argument builder tests passed successfully!');
