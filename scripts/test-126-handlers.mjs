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
  isReadOnlyCommand,
  computeTriggerToggle,
  getActiveTriggerConfigPath,
  generateUnifiedDiff,
  QUESTION_ID_RE,
  requireQuestionId,
} = require('../out/extension.js');

const fail = (m) => { console.error(`FAIL: ${m}`); process.exit(1); };

console.log('--- Running 12.6 Message Types Parity Tests ---');

// 1. Verify all 18 message types exist in HANDLER_MAP
const messageTypes126 = [
  'getSessions',
  'getSession',
  'getRoleHolder',
  'getTriggers',
  'getTriggersStatus',
  'getTriggersHistory',
  'runTriggersOnce',
  'previewToggleTrigger',
  'toggleTrigger',
  'getProposedActions',
  'confirmProposedAction',
  'rejectProposedAction',
  'getQuestionsAwaitingApplication',
  'applyQuestion',
  'getOrchestratorQueue',
  'getNotifications',
  'markNotificationRead',
  'markAllNotificationsRead',
];

for (const t of messageTypes126) {
  if (typeof HANDLER_MAP[t] !== 'function') {
    fail(`HANDLER_MAP missing function for ${t}`);
  }
}
console.log('PASS: All 18 12.6 message types present in HANDLER_MAP');

// 2. Read-only command set verification
const fakeRoot = '/fake/workspace';
const readOnlyChecks = [
  ['sessions', 'list', '--workspace', fakeRoot],
  ['sessions', 'show', 'sess-001', '--workspace', fakeRoot],
  ['triggers', 'list', '--workspace', fakeRoot],
  ['triggers', 'status', '--role', 'orchestrator', '--workspace', fakeRoot],
  ['triggers', 'history', '--workspace', fakeRoot],
];
for (const cmd of readOnlyChecks) {
  if (!isReadOnlyCommand(cmd)) {
    fail(`isReadOnlyCommand should return true for: ${cmd.join(' ')}`);
  }
}
console.log('PASS: sessions and triggers read-only commands recognized');

// 3. CLI_COMMAND_MAP builders
// A. getTriggers
const trigArgs = CLI_COMMAND_MAP.getTriggers({}, fakeRoot);
if (trigArgs[0] !== 'triggers' || trigArgs[1] !== 'list' || !trigArgs.includes(fakeRoot)) {
  fail(`getTriggers args unexpected: ${trigArgs.join(' ')}`);
}

// B. getTriggersStatus
const trigStatusDefault = CLI_COMMAND_MAP.getTriggersStatus({}, fakeRoot);
if (!trigStatusDefault.includes('orchestrator') || !trigStatusDefault.includes('status')) {
  fail(`getTriggersStatus default args unexpected: ${trigStatusDefault.join(' ')}`);
}
const trigStatusCustom = CLI_COMMAND_MAP.getTriggersStatus({ role: 'executor' }, fakeRoot);
if (!trigStatusCustom.includes('executor')) {
  fail(`getTriggersStatus custom role args unexpected: ${trigStatusCustom.join(' ')}`);
}

// C. getTriggersHistory
const trigHistArgs = CLI_COMMAND_MAP.getTriggersHistory({ rule: 'auto-plan', limit: 50 }, fakeRoot);
if (!trigHistArgs.includes('--rule') || !trigHistArgs.includes('auto-plan') || !trigHistArgs.includes('--limit') || !trigHistArgs.includes('50')) {
  fail(`getTriggersHistory args unexpected: ${trigHistArgs.join(' ')}`);
}
console.log('PASS: getTriggers, getTriggersStatus, getTriggersHistory argument builders');

// 4. Custom Handlers Unit Tests
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-126-'));

try {
  let executedCmds = [];
  let postedMessages = [];
  let updatedCalled = false;

  const createMockPanel = (mockResults = {}) => ({
    cliClient: {
      runJsonCommand: async (cmd) => {
        executedCmds.push(cmd);
        const key = `${cmd[0]} ${cmd[1]}`;
        if (mockResults[key]) {
          const res = mockResults[key];
          if (typeof res === 'function') return res(cmd);
          return res;
        }
        return { ok: true };
      },
    },
    postMessage: (msg) => { postedMessages.push(msg); },
    onTasksUpdated: () => { updatedCalled = true; },
  });

  // Test getSessions
  {
    executedCmds = [];
    const mockPanel = createMockPanel({
      'sessions list': () => [
        { session_id: 's1', role: 'orchestrator', status: 'active', tool: 'claude' },
      ],
    });
    const res = await CUSTOM_HANDLERS.getSessions(mockPanel, { role: 'orchestrator', status: 'active', tool: 'claude' }, tmpDir);
    if (!res.ok || !Array.isArray(res.sessions) || res.sessions.length !== 1) {
      fail(`getSessions result mismatch: ${JSON.stringify(res)}`);
    }
    const lastCmd = executedCmds[0];
    if (!lastCmd.includes('--role') || !lastCmd.includes('orchestrator') || !lastCmd.includes('--status') || !lastCmd.includes('--tool')) {
      fail(`getSessions flags unexpected: ${lastCmd.join(' ')}`);
    }
    console.log('PASS: getSessions handler');
  }

  // Test getSession
  {
    executedCmds = [];
    // missing sessionId -> 400
    try {
      await CUSTOM_HANDLERS.getSession(createMockPanel(), {}, tmpDir);
      fail('getSession must throw when sessionId is missing');
    } catch (e) {
      if (e.status !== 400) fail(`Expected 400 status for missing sessionId: ${e}`);
    }

    // not found error -> 404
    const notFoundPanel = {
      cliClient: {
        runJsonCommand: async () => {
          const err = new Error('Session not found: s-missing');
          err.data = { error: 'Session not found: s-missing' };
          throw err;
        },
      },
      postMessage: () => {},
    };
    try {
      await CUSTOM_HANDLERS.getSession(notFoundPanel, { sessionId: 's-missing' }, tmpDir);
      fail('getSession must throw 404 when session not found');
    } catch (e) {
      if (e.status !== 404) fail(`Expected 404 status: ${e.status}`);
    }

    // success
    const successPanel = createMockPanel({
      'sessions show': { session_id: 's-123', role: 'orchestrator' },
    });
    const res = await CUSTOM_HANDLERS.getSession(successPanel, { sessionId: 's-123' }, tmpDir);
    if (res.session_id !== 's-123') fail(`getSession response unexpected: ${JSON.stringify(res)}`);
    console.log('PASS: getSession handler');
  }

  // Test getRoleHolder
  {
    // not found -> 404
    const notFoundPanel = {
      cliClient: {
        runJsonCommand: async () => {
          const err = new Error('No holder for role: orchestrator');
          err.data = { error: 'No holder for role: orchestrator' };
          throw err;
        },
      },
      postMessage: () => {},
    };
    try {
      await CUSTOM_HANDLERS.getRoleHolder(notFoundPanel, { role: 'orchestrator' }, tmpDir);
      fail('getRoleHolder must throw 404 when no holder found');
    } catch (e) {
      if (e.status !== 404) fail(`Expected 404 status: ${e.status}`);
    }

    // success
    const successPanel = createMockPanel({
      'sessions show': { holder: 'claude', role: 'orchestrator' },
    });
    const res = await CUSTOM_HANDLERS.getRoleHolder(successPanel, { role: 'orchestrator' }, tmpDir);
    if (res.holder !== 'claude') fail(`getRoleHolder response unexpected: ${JSON.stringify(res)}`);
    console.log('PASS: getRoleHolder handler');
  }

  // Test runTriggersOnce
  {
    executedCmds = [];
    postedMessages = [];
    updatedCalled = false;
    const mockPanel = createMockPanel({
      'triggers run-once': { ok: true, matched: 2, firings: 1 },
    });
    const res = await CUSTOM_HANDLERS.runTriggersOnce(mockPanel, { role: 'orchestrator', dry_run: false }, tmpDir);
    if (!res.ok || res.matched !== 2) fail(`runTriggersOnce unexpected: ${JSON.stringify(res)}`);
    if (updatedCalled) fail('runTriggersOnce must not trigger onTasksUpdated refresh loop');
    if (!postedMessages.some((m) => m.type === 'triggers_run')) fail('runTriggersOnce must post triggers_run');
    if (!postedMessages.some((m) => m.type === 'changed' && m.areas.includes('triggers') && m.areas.includes('events'))) {
      fail('runTriggersOnce must post changed for triggers and events');
    }
    console.log('PASS: runTriggersOnce handler');
  }

  // Test trigger toggle logic (computeTriggerToggle, previewToggleTrigger, toggleTrigger)
  {
    const configPath = path.join(tmpDir, 'orchestration.toml');
    const initialConfig = `[orchestration]\ndefault_tool = "kilo"\n\n[triggers]\nenabled = true\n\n[[triggers]]\nname = "auto-plan"\nenabled = true\n`;
    fs.writeFileSync(configPath, initialConfig, 'utf-8');

    // 1. Kill switch preview & toggle
    const prevKill = await CUSTOM_HANDLERS.previewToggleTrigger(createMockPanel(), { kill_switch: true, enabled: false }, tmpDir);
    if (!prevKill.ok || !prevKill.changed || !prevKill.diff.includes('-enabled = true') || !prevKill.diff.includes('+enabled = false')) {
      fail(`previewToggleTrigger kill switch mismatch: ${JSON.stringify(prevKill)}`);
    }

    // Bad hash -> 409
    try {
      await CUSTOM_HANDLERS.toggleTrigger(createMockPanel(), { kill_switch: true, enabled: false, expect_hash: 'bad-hash' }, tmpDir);
      fail('toggleTrigger must throw 409 on hash mismatch');
    } catch (e) {
      if (e.status !== 409) fail(`Expected 409 status for hash mismatch: ${e}`);
    }

    // Missing expect_hash -> 400
    try {
      await CUSTOM_HANDLERS.toggleTrigger(createMockPanel(), { kill_switch: true, enabled: false }, tmpDir);
      fail('toggleTrigger must throw 400 on missing expect_hash');
    } catch (e) {
      if (e.status !== 400) fail(`Expected 400 status for missing expect_hash: ${e}`);
    }

    // Success toggle kill_switch
    postedMessages = [];
    updatedCalled = false;
    const applyKill = await CUSTOM_HANDLERS.toggleTrigger(createMockPanel(), { kill_switch: true, enabled: false, expect_hash: prevKill.hash }, tmpDir);
    if (!applyKill.ok || !applyKill.applied) fail(`toggleTrigger apply mismatch: ${JSON.stringify(applyKill)}`);
    if (updatedCalled) fail('toggleTrigger must not call onTasksUpdated');
    if (!postedMessages.some((m) => m.type === 'config_updated')) fail('toggleTrigger must post config_updated');
    if (!postedMessages.some((m) => m.type === 'changed' && m.areas.includes('config') && m.areas.includes('triggers'))) {
      fail('toggleTrigger must post changed areas config, triggers');
    }
    const updatedContent = fs.readFileSync(configPath, 'utf-8');
    if (!updatedContent.includes('[triggers]\nenabled = false')) fail('config file was not updated with enabled = false');

    // 2. Rule toggle
    const prevRule = await CUSTOM_HANDLERS.previewToggleTrigger(createMockPanel(), { rule_name: 'auto-plan', enabled: false }, tmpDir);
    if (!prevRule.ok || !prevRule.changed || !prevRule.diff.includes('auto-plan')) {
      fail(`previewToggleTrigger rule mismatch: ${JSON.stringify(prevRule)}`);
    }
    const applyRule = await CUSTOM_HANDLERS.toggleTrigger(createMockPanel(), { rule_name: 'auto-plan', enabled: false, expect_hash: prevRule.hash }, tmpDir);
    if (!applyRule.ok || !applyRule.applied) fail('toggleTrigger rule apply failed');
    const finalContent = fs.readFileSync(configPath, 'utf-8');
    if (!finalContent.includes('name = "auto-plan"\nenabled = false')) fail('rule was not disabled in config file');
    console.log('PASS: previewToggleTrigger and toggleTrigger handlers');
  }

  // Test getProposedActions, confirmProposedAction, rejectProposedAction
  {
    const propDir = path.join(tmpDir, '.ai-orchestration', 'proposed_actions');
    fs.mkdirSync(propDir, { recursive: true });
    fs.writeFileSync(path.join(propDir, 'act1.json'), JSON.stringify({ id: 'act1', title: 'Action 1', created_at: '2026-10-18T10:00:00Z' }));
    fs.writeFileSync(path.join(propDir, 'act2.json'), JSON.stringify({ id: 'act2', title: 'Action 2', created_at: '2026-10-18T11:00:00Z' }));

    const propRes = await CUSTOM_HANDLERS.getProposedActions(createMockPanel(), {}, tmpDir);
    if (!propRes.ok || propRes.count !== 2 || propRes.proposed_actions[0].id !== 'act2') {
      fail(`getProposedActions unexpected: ${JSON.stringify(propRes)}`);
    }

    // confirmProposedAction -> 400 not implemented
    try {
      await CUSTOM_HANDLERS.confirmProposedAction(createMockPanel(), { actionId: 'act1' }, tmpDir);
      fail('confirmProposedAction must throw 400');
    } catch (e) {
      if (e.status !== 400 || e.data?.error !== 'not-implemented' || e.data?.action_id !== 'act1') {
        fail(`confirmProposedAction error mismatch: ${JSON.stringify(e)}`);
      }
    }

    // rejectProposedAction -> 400 not implemented
    try {
      await CUSTOM_HANDLERS.rejectProposedAction(createMockPanel(), { actionId: 'act2' }, tmpDir);
      fail('rejectProposedAction must throw 400');
    } catch (e) {
      if (e.status !== 400 || e.data?.error !== 'not-implemented' || e.data?.action_id !== 'act2') {
        fail(`rejectProposedAction error mismatch: ${JSON.stringify(e)}`);
      }
    }
    console.log('PASS: getProposedActions, confirmProposedAction, rejectProposedAction handlers');
  }

  // Test getQuestionsAwaitingApplication
  {
    const mockPanel = createMockPanel({
      'questions list': {
        ok: true,
        questions: [
          { id: 'Q001', question: 'Deploy?', status: 'answered', applied: false },
          { id: 'Q002', question: 'Migrate?', status: 'answered', applied: true },
          { id: 'Q003', question: 'Test?', status: 'answered', applied: false },
        ],
      },
    });
    const res = await CUSTOM_HANDLERS.getQuestionsAwaitingApplication(mockPanel, {}, tmpDir);
    if (!res.ok || res.count !== 2 || res.questions.length !== 2) {
      fail(`getQuestionsAwaitingApplication mismatch: ${JSON.stringify(res)}`);
    }
    if (res.questions.some((q) => q.id === 'Q002')) {
      fail('getQuestionsAwaitingApplication must filter out applied questions');
    }
    console.log('PASS: getQuestionsAwaitingApplication handler');
  }

  // Test applyQuestion
  {
    executedCmds = [];
    postedMessages = [];
    updatedCalled = false;

    // Bad id -> 400
    try {
      await CUSTOM_HANDLERS.applyQuestion(createMockPanel(), { questionId: 'bad-id' }, tmpDir);
      fail('applyQuestion must reject invalid question id');
    } catch (e) {
      if (e.status !== 400) fail(`Expected 400 status: ${e}`);
    }

    const mockPanel = createMockPanel({
      'questions apply': { ok: true, id: 'Q001', applied: true },
    });

    const res = await CUSTOM_HANDLERS.applyQuestion(mockPanel, {
      questionId: 'Q001',
      by: 'user',
      ref: 'T005',
      note: 'Proceed with option A',
      force: true,
    }, tmpDir);

    if (!res.ok || res.id !== 'Q001') fail(`applyQuestion response unexpected: ${JSON.stringify(res)}`);
    const cmd = executedCmds[0];
    if (!cmd.includes('Q001') || !cmd.includes('--by') || !cmd.includes('user') || !cmd.includes('--ref') || !cmd.includes('--note') || !cmd.includes('--force')) {
      fail(`applyQuestion args unexpected: ${cmd.join(' ')}`);
    }
    if (updatedCalled) fail('applyQuestion must not trigger extension onTasksUpdated');
    if (!postedMessages.some((m) => m.type === 'question_applied' && m.question_id === 'Q001')) {
      fail('applyQuestion must post question_applied');
    }
    if (!postedMessages.some((m) => m.type === 'changed' && m.areas.includes('questions') && m.areas.includes('tasks'))) {
      fail('applyQuestion must post changed for questions and tasks');
    }
    console.log('PASS: applyQuestion handler');
  }

  // Test getOrchestratorQueue
  {
    const qDir = path.join(tmpDir, '.ai-orchestration', 'orchestrator', 'queue');
    fs.mkdirSync(qDir, { recursive: true });
    fs.writeFileSync(path.join(qDir, 'q2.json'), JSON.stringify({ turn_seq: 2, task_id: 'T002' }));
    fs.writeFileSync(path.join(qDir, 'q1.json'), JSON.stringify({ turn_seq: 1, task_id: 'T001' }));

    const res = await CUSTOM_HANDLERS.getOrchestratorQueue(createMockPanel(), {}, tmpDir);
    if (!res.ok || res.count !== 2 || res.queue[0].turn_seq !== 1 || res.queue[1].turn_seq !== 2) {
      fail(`getOrchestratorQueue response unexpected: ${JSON.stringify(res)}`);
    }
    console.log('PASS: getOrchestratorQueue handler');
  }

  // Test getNotifications, markNotificationRead, markAllNotificationsRead
  {
    const notifDir = path.join(tmpDir, '.ai-orchestration', 'notifications');
    fs.mkdirSync(notifDir, { recursive: true });
    fs.writeFileSync(path.join(notifDir, 'n1.json'), JSON.stringify({ id: 'n1', title: 'Notif 1', read: false, created_at: '2026-10-18T08:00:00Z' }));
    fs.writeFileSync(path.join(notifDir, 'n2.json'), JSON.stringify({ id: 'n2', title: 'Notif 2', read: true, created_at: '2026-10-18T09:00:00Z' }));

    const mockPanel = createMockPanel({
      'events tail': { ok: true, events: [{ id: 'ev1', type: 'turn.finished' }] },
    });

    const notifRes = await CUSTOM_HANDLERS.getNotifications(mockPanel, {}, tmpDir);
    if (!notifRes.ok || notifRes.unread_count !== 1 || notifRes.notifications.length !== 2 || notifRes.recent_events.length !== 1) {
      fail(`getNotifications response unexpected: ${JSON.stringify(notifRes)}`);
    }

    // markNotificationRead path traversal -> 400
    try {
      await CUSTOM_HANDLERS.markNotificationRead(createMockPanel(), { id: '../secret' }, tmpDir);
      fail('markNotificationRead must reject traversal');
    } catch (e) {
      if (e.status !== 400) fail(`Expected 400: ${e}`);
    }

    // markNotificationRead not found -> 404
    try {
      await CUSTOM_HANDLERS.markNotificationRead(createMockPanel(), { id: 'missing' }, tmpDir);
      fail('markNotificationRead must 404 for missing');
    } catch (e) {
      if (e.status !== 404) fail(`Expected 404: ${e}`);
    }

    // markNotificationRead single success
    postedMessages = [];
    const readRes = await CUSTOM_HANDLERS.markNotificationRead(createMockPanel(), { id: 'n1' }, tmpDir);
    if (!readRes.ok || readRes.id !== 'n1') fail(`markNotificationRead response unexpected: ${JSON.stringify(readRes)}`);
    const n1Data = JSON.parse(fs.readFileSync(path.join(notifDir, 'n1.json'), 'utf-8'));
    if (!n1Data.read) fail('n1.json was not marked as read');
    if (!postedMessages.some((m) => m.type === 'changed' && m.areas.includes('notifications'))) {
      fail('markNotificationRead must post changed for notifications');
    }

    // reset n1, n2 to false
    n1Data.read = false;
    fs.writeFileSync(path.join(notifDir, 'n1.json'), JSON.stringify(n1Data), 'utf-8');
    const n2Data = JSON.parse(fs.readFileSync(path.join(notifDir, 'n2.json'), 'utf-8'));
    n2Data.read = false;
    fs.writeFileSync(path.join(notifDir, 'n2.json'), JSON.stringify(n2Data), 'utf-8');

    // markAllNotificationsRead success
    postedMessages = [];
    const markAllRes = await CUSTOM_HANDLERS.markAllNotificationsRead(createMockPanel(), {}, tmpDir);
    if (!markAllRes.ok || !markAllRes.marked_all) fail(`markAllNotificationsRead unexpected: ${JSON.stringify(markAllRes)}`);
    const n1After = JSON.parse(fs.readFileSync(path.join(notifDir, 'n1.json'), 'utf-8'));
    const n2After = JSON.parse(fs.readFileSync(path.join(notifDir, 'n2.json'), 'utf-8'));
    if (!n1After.read || !n2After.read) fail('markAllNotificationsRead did not mark all notifications read');
    if (!postedMessages.some((m) => m.type === 'changed' && m.areas.includes('notifications'))) {
      fail('markAllNotificationsRead must post changed for notifications');
    }
    console.log('PASS: getNotifications, markNotificationRead, markAllNotificationsRead handlers');
  }

} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

console.log('All 12.6 message types parity tests passed successfully!');
