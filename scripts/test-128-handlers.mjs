import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
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
  PROPOSAL_ACTION_ID_RE,
  TURN_ID_RE,
  validateTurnId,
  getRotateAfterTokens,
  readPartialAssistantMessages,
  getTurnSortKey,
  compareTurns,
} = require('../out/extension.js');

const fail = (m) => { console.error(`FAIL: ${m}`); process.exit(1); };

console.log('--- Running 12.8 / 12.10 / 12.16 Handlers Parity Tests ---');

// 1. Verify message types exist in HANDLER_MAP
const messageTypes128 = [
  'getOrchestratorStatus',
  'postOrchestratorChat',
  'getOrchestratorConversation',
  'getOrchestratorTurn',
  'pauseOrchestrator',
  'resumeOrchestrator',
  'rotateOrchestrator',
  'cancelOrchestratorTurn',
  'runNextOrchestratorTurn',
  'previewOrchestratorReassign',
  'reassignOrchestrator',
  'previewSetup',
  'applySetup',
  'confirmProposedAction',
  'rejectProposedAction',
];

for (const t of messageTypes128) {
  if (typeof HANDLER_MAP[t] !== 'function') {
    fail(`HANDLER_MAP missing function for ${t}`);
  }
}
console.log('PASS: All 12.8/12.10/12.16 message types present in HANDLER_MAP');

// 2. Read-only command set verification
const fakeRoot = '/fake/workspace';
const readOnlyChecks = [
  ['orchestrator', 'status', '--workspace', fakeRoot],
  ['orchestrator', 'reassign', '--tool', 'kilo', '--dry-run', '--workspace', fakeRoot],
  ['setup', '--plan', '--scope', 'project-local', '--workspace', fakeRoot],
];
for (const cmd of readOnlyChecks) {
  if (!isReadOnlyCommand(cmd)) {
    fail(`isReadOnlyCommand should return true for: ${cmd.join(' ')}`);
  }
}

const mutatingChecks = [
  ['orchestrator', 'enqueue', '--message', 'hi', '--workspace', fakeRoot],
  ['orchestrator', 'pause', '--workspace', fakeRoot],
  ['orchestrator', 'resume', '--workspace', fakeRoot],
  ['orchestrator', 'rotate', '--workspace', fakeRoot],
  ['orchestrator', 'cancel', '000001', '--workspace', fakeRoot],
  ['orchestrator', 'run-next', '--workspace', fakeRoot],
  ['orchestrator', 'reassign', '--tool', 'kilo', '--expect-hash', 'h1', '--workspace', fakeRoot],
  ['setup', '--apply', '--expect-hash', 'h1', '--workspace', fakeRoot],
  ['triggers', 'confirm', 'act1', '--expect-hash', 'h1', '--actor', 'vscode', '--workspace', fakeRoot],
  ['triggers', 'reject', 'act1', '--reason', 'bad', '--actor', 'vscode', '--workspace', fakeRoot],
];
for (const cmd of mutatingChecks) {
  if (isReadOnlyCommand(cmd)) {
    fail(`isReadOnlyCommand should return false for mutating command: ${cmd.join(' ')}`);
  }
}
console.log('PASS: isReadOnlyCommand correctly recognizes read-only vs mutating commands');

// 3. CLI_COMMAND_MAP builders (previewSetup, previewOrchestratorReassign)
{
  // A. previewSetup default args
  const defSetup = CLI_COMMAND_MAP.previewSetup({}, fakeRoot);
  if (defSetup[0] !== 'setup' || defSetup[1] !== '--plan' || !defSetup.includes('--scope') || !defSetup.includes('project-local') || !defSetup.includes(fakeRoot)) {
    fail(`previewSetup default args unexpected: ${defSetup.join(' ')}`);
  }

  // B. previewSetup custom args
  const customSetup = CLI_COMMAND_MAP.previewSetup({
    scope: 'project',
    orchestrator: 'claude',
    executor: 'kilo',
    orchestrator_model: 'claude-3-7-sonnet',
    executor_model: 'gemini-2.5-flash',
    verification_mode: 'fast',
  }, fakeRoot);
  if (
    !customSetup.includes('--orchestrator') || !customSetup.includes('claude') ||
    !customSetup.includes('--executor') || !customSetup.includes('kilo') ||
    !customSetup.includes('--orchestrator-model') || !customSetup.includes('claude-3-7-sonnet') ||
    !customSetup.includes('--executor-model') || !customSetup.includes('gemini-2.5-flash') ||
    !customSetup.includes('--verification-mode') || !customSetup.includes('fast') ||
    !customSetup.includes('project')
  ) {
    fail(`previewSetup custom args unexpected: ${customSetup.join(' ')}`);
  }

  // C. previewOrchestratorReassign missing tool -> 400
  try {
    CLI_COMMAND_MAP.previewOrchestratorReassign({}, fakeRoot);
    fail('previewOrchestratorReassign must throw 400 on missing tool');
  } catch (e) {
    if (e.status !== 400) fail(`Expected 400 status for missing tool: ${e}`);
  }

  // D. previewOrchestratorReassign valid args
  const reassArgs = CLI_COMMAND_MAP.previewOrchestratorReassign({
    tool: 'codex',
    model: 'gpt-5',
    scope: 'project',
    no_handoff: true,
    timeout: 300,
  }, fakeRoot);
  if (
    reassArgs[0] !== 'orchestrator' || reassArgs[1] !== 'reassign' ||
    !reassArgs.includes('--tool') || !reassArgs.includes('codex') ||
    !reassArgs.includes('--dry-run') ||
    !reassArgs.includes('--model') || !reassArgs.includes('gpt-5') ||
    !reassArgs.includes('--scope') || !reassArgs.includes('project') ||
    !reassArgs.includes('--no-handoff') ||
    !reassArgs.includes('--timeout') || !reassArgs.includes('300')
  ) {
    fail(`previewOrchestratorReassign args unexpected: ${reassArgs.join(' ')}`);
  }

  console.log('PASS: CLI_COMMAND_MAP previewSetup and previewOrchestratorReassign builders');
}

// 4. Custom Handlers Unit Tests with Mock Panel
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-128-'));

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

  // Test getOrchestratorStatus
  {
    executedCmds = [];
    const createFreshMockPanel = () => createMockPanel({
      'orchestrator status': () => ({ state: 'idle', generation: 1 }),
    });
    const res = await CUSTOM_HANDLERS.getOrchestratorStatus(createFreshMockPanel(), {}, tmpDir);
    if (!res.ok || res.state !== 'idle' || res.rotate_after_tokens !== 150000) {
      fail(`getOrchestratorStatus result mismatch: ${JSON.stringify(res)}`);
    }
    if (executedCmds[0][0] !== 'orchestrator' || executedCmds[0][1] !== 'status') {
      fail(`getOrchestratorStatus args unexpected: ${executedCmds[0].join(' ')}`);
    }

    // Custom rotate_after_tokens from orchestration.toml
    fs.writeFileSync(path.join(tmpDir, 'orchestration.toml'), '[orchestrator]\nrotate_after_tokens = 250000\n', 'utf-8');
    const resCustom = await CUSTOM_HANDLERS.getOrchestratorStatus(createFreshMockPanel(), {}, tmpDir);
    if (resCustom.rotate_after_tokens !== 250000) {
      fail(`Expected 250000 rotate_after_tokens, got ${resCustom.rotate_after_tokens}`);
    }
    fs.unlinkSync(path.join(tmpDir, 'orchestration.toml'));
    console.log('PASS: getOrchestratorStatus handler');
  }

  // Test postOrchestratorChat
  {
    executedCmds = [];
    postedMessages = [];
    updatedCalled = false;

    // Missing message -> 400
    try {
      await CUSTOM_HANDLERS.postOrchestratorChat(createMockPanel(), { message: '   ' }, tmpDir);
      fail('postOrchestratorChat must throw 400 on empty message');
    } catch (e) {
      if (e.status !== 400) fail(`Expected 400 status: ${e}`);
    }

    // Success call
    const mockPanel = createMockPanel({
      'orchestrator enqueue': { ok: true, turn: { turn_id: '000003', state: 'queued' } },
    });
    const res = await CUSTOM_HANDLERS.postOrchestratorChat(mockPanel, {
      message: 'Plan feature X',
      type: 'owner_chat',
      priority: 'owner',
      policy: 'auto',
    }, tmpDir);

    if (!res.ok || res.turn?.turn_id !== '000003') {
      fail(`postOrchestratorChat result mismatch: ${JSON.stringify(res)}`);
    }
    const cmd = executedCmds[0];
    if (
      !cmd.includes('enqueue') || !cmd.includes('--message') || !cmd.includes('Plan feature X') ||
      !cmd.includes('--type') || !cmd.includes('owner_chat') ||
      !cmd.includes('--priority') || !cmd.includes('owner') ||
      !cmd.includes('--policy') || !cmd.includes('auto')
    ) {
      fail(`postOrchestratorChat args unexpected: ${cmd.join(' ')}`);
    }
    if (updatedCalled) fail('postOrchestratorChat must not trigger onTasksUpdated');
    if (!postedMessages.some((m) => m.type === 'turn_queued' && m.turn?.turn_id === '000003')) {
      fail('postOrchestratorChat must post turn_queued');
    }
    if (!postedMessages.some((m) => m.type === 'changed' && m.areas.includes('orchestrator') && m.areas.includes('queue') && m.areas.includes('events'))) {
      fail('postOrchestratorChat must post changed areas [orchestrator, queue, events]');
    }
    console.log('PASS: postOrchestratorChat handler');
  }

  // Test pauseOrchestrator and resumeOrchestrator
  {
    executedCmds = [];
    postedMessages = [];
    updatedCalled = false;

    const mockPanel = createMockPanel({
      'orchestrator pause': { ok: true, paused: true },
      'orchestrator resume': { ok: true, paused: false },
    });

    const pauseRes = await CUSTOM_HANDLERS.pauseOrchestrator(mockPanel, {}, tmpDir);
    if (!pauseRes.paused) fail('pauseOrchestrator response unexpected');
    if (updatedCalled) fail('pauseOrchestrator must not trigger onTasksUpdated');
    if (!postedMessages.some((m) => m.type === 'orchestrator_paused')) fail('pauseOrchestrator must post orchestrator_paused');
    if (!postedMessages.some((m) => m.type === 'changed' && m.areas.includes('orchestrator') && m.areas.includes('events'))) {
      fail('pauseOrchestrator must post changed for orchestrator, events');
    }

    postedMessages = [];
    const resumeRes = await CUSTOM_HANDLERS.resumeOrchestrator(mockPanel, {}, tmpDir);
    if (resumeRes.paused) fail('resumeOrchestrator response unexpected');
    if (updatedCalled) fail('resumeOrchestrator must not trigger onTasksUpdated');
    if (!postedMessages.some((m) => m.type === 'orchestrator_resumed')) fail('resumeOrchestrator must post orchestrator_resumed');
    if (!postedMessages.some((m) => m.type === 'changed' && m.areas.includes('orchestrator') && m.areas.includes('events'))) {
      fail('resumeOrchestrator must post changed for orchestrator, events');
    }
    console.log('PASS: pauseOrchestrator and resumeOrchestrator handlers');
  }

  // Test rotateOrchestrator
  {
    executedCmds = [];
    postedMessages = [];
    updatedCalled = false;

    const mockPanel = createMockPanel({
      'orchestrator rotate': { ok: true, rotated: true, generation: 2 },
    });

    const res = await CUSTOM_HANDLERS.rotateOrchestrator(mockPanel, {
      tool: 'claude',
      model: 'claude-3-7-sonnet',
      reason: 'context limit',
      no_handoff: true,
    }, tmpDir);

    if (!res.ok || res.generation !== 2) fail('rotateOrchestrator response unexpected');
    const cmd = executedCmds[0];
    if (
      !cmd.includes('rotate') ||
      !cmd.includes('--tool') || !cmd.includes('claude') ||
      !cmd.includes('--model') || !cmd.includes('claude-3-7-sonnet') ||
      !cmd.includes('--reason') || !cmd.includes('context limit') ||
      !cmd.includes('--no-handoff')
    ) {
      fail(`rotateOrchestrator args unexpected: ${cmd.join(' ')}`);
    }
    if (updatedCalled) fail('rotateOrchestrator must not trigger onTasksUpdated');
    if (!postedMessages.some((m) => m.type === 'orchestrator_rotated')) fail('rotateOrchestrator must post orchestrator_rotated');
    if (!postedMessages.some((m) => m.type === 'changed' && m.areas.includes('orchestrator') && m.areas.includes('events') && m.areas.includes('sessions'))) {
      fail('rotateOrchestrator must post changed for orchestrator, events, sessions');
    }
    console.log('PASS: rotateOrchestrator handler');
  }

  // Test cancelOrchestratorTurn
  {
    executedCmds = [];
    postedMessages = [];
    updatedCalled = false;

    // Missing turnId -> 400
    try {
      await CUSTOM_HANDLERS.cancelOrchestratorTurn(createMockPanel(), {}, tmpDir);
      fail('cancelOrchestratorTurn must throw 400 on missing turn_id');
    } catch (e) {
      if (e.status !== 400) fail(`Expected 400 status: ${e}`);
    }

    // Traversal -> 400
    try {
      await CUSTOM_HANDLERS.cancelOrchestratorTurn(createMockPanel(), { turnId: '../secret' }, tmpDir);
      fail('cancelOrchestratorTurn must throw 400 on traversal');
    } catch (e) {
      if (e.status !== 400) fail(`Expected 400 status: ${e}`);
    }

    const mockPanel = createMockPanel({
      'orchestrator cancel': { ok: true, cancelled: true },
    });
    const res = await CUSTOM_HANDLERS.cancelOrchestratorTurn(mockPanel, { turnId: '000004' }, tmpDir);
    if (!res.ok) fail('cancelOrchestratorTurn response unexpected');
    const cmd = executedCmds[0];
    if (!cmd.includes('cancel') || !cmd.includes('000004')) {
      fail(`cancelOrchestratorTurn args unexpected: ${cmd.join(' ')}`);
    }
    if (updatedCalled) fail('cancelOrchestratorTurn must not trigger onTasksUpdated');
    if (!postedMessages.some((m) => m.type === 'turn_cancelled' && m.turn_id === '000004')) {
      fail('cancelOrchestratorTurn must post turn_cancelled');
    }
    if (!postedMessages.some((m) => m.type === 'changed' && m.areas.includes('orchestrator') && m.areas.includes('queue') && m.areas.includes('events'))) {
      fail('cancelOrchestratorTurn must post changed for orchestrator, queue, events');
    }
    console.log('PASS: cancelOrchestratorTurn handler');
  }

  // Test runNextOrchestratorTurn
  {
    executedCmds = [];
    postedMessages = [];
    updatedCalled = false;

    const mockPanel = createMockPanel({
      'orchestrator run-next': { ok: true, executed: true },
    });
    const res = await CUSTOM_HANDLERS.runNextOrchestratorTurn(mockPanel, { timeout: 120 }, tmpDir);
    if (!res.ok) fail('runNextOrchestratorTurn response unexpected');
    const cmd = executedCmds[0];
    if (!cmd.includes('run-next') || !cmd.includes('--timeout') || !cmd.includes('120')) {
      fail(`runNextOrchestratorTurn args unexpected: ${cmd.join(' ')}`);
    }
    if (updatedCalled) fail('runNextOrchestratorTurn must not trigger onTasksUpdated');
    if (!postedMessages.some((m) => m.type === 'changed' && m.areas.includes('orchestrator') && m.areas.includes('queue') && m.areas.includes('events'))) {
      fail('runNextOrchestratorTurn must post changed for orchestrator, queue, events');
    }
    console.log('PASS: runNextOrchestratorTurn handler');
  }

  // Test reassignOrchestrator
  {
    executedCmds = [];
    postedMessages = [];
    updatedCalled = false;

    // Missing tool -> 400
    try {
      await CUSTOM_HANDLERS.reassignOrchestrator(createMockPanel(), { expect_hash: 'h1' }, tmpDir);
      fail('reassignOrchestrator must throw 400 on missing tool');
    } catch (e) {
      if (e.status !== 400) fail(`Expected 400 status: ${e}`);
    }

    // Missing expect_hash -> 400
    try {
      await CUSTOM_HANDLERS.reassignOrchestrator(createMockPanel(), { tool: 'kilo' }, tmpDir);
      fail('reassignOrchestrator must throw 400 on missing expect_hash');
    } catch (e) {
      if (e.status !== 400) fail(`Expected 400 status: ${e}`);
    }

    const mockPanel = createMockPanel({
      'orchestrator reassign': { ok: true, reassigned: true, generation: 3 },
    });
    const res = await CUSTOM_HANDLERS.reassignOrchestrator(mockPanel, {
      tool: 'kilo',
      expect_hash: 'hash-abc',
      model: 'kilo/gemini-2.5-pro',
      scope: 'project',
      no_handoff: false,
      timeout: 180,
    }, tmpDir);

    if (!res.ok || res.generation !== 3) fail('reassignOrchestrator response unexpected');
    const cmd = executedCmds[0];
    if (
      !cmd.includes('reassign') ||
      !cmd.includes('--tool') || !cmd.includes('kilo') ||
      !cmd.includes('--expect-hash') || !cmd.includes('hash-abc') ||
      !cmd.includes('--model') || !cmd.includes('kilo/gemini-2.5-pro') ||
      !cmd.includes('--scope') || !cmd.includes('project') ||
      !cmd.includes('--timeout') || !cmd.includes('180')
    ) {
      fail(`reassignOrchestrator args unexpected: ${cmd.join(' ')}`);
    }
    if (updatedCalled) fail('reassignOrchestrator must not trigger onTasksUpdated');
    if (!postedMessages.some((m) => m.type === 'orchestrator_reassigned')) fail('reassignOrchestrator must post orchestrator_reassigned');
    if (!postedMessages.some((m) => m.type === 'changed' && m.areas.includes('orchestrator') && m.areas.includes('events') && m.areas.includes('sessions') && m.areas.includes('config'))) {
      fail('reassignOrchestrator must post changed for orchestrator, events, sessions, config');
    }
    console.log('PASS: reassignOrchestrator handler');
  }

  // Test applySetup
  {
    executedCmds = [];
    postedMessages = [];
    updatedCalled = false;

    // Missing expect_hash -> 400
    try {
      await CUSTOM_HANDLERS.applySetup(createMockPanel(), {}, tmpDir);
      fail('applySetup must throw 400 on missing expect_hash');
    } catch (e) {
      if (e.status !== 400) fail(`Expected 400 status: ${e}`);
    }

    const mockPanel = createMockPanel({
      'setup --apply': { ok: true, applied: true },
    });
    const res = await CUSTOM_HANDLERS.applySetup(mockPanel, {
      expect_hash: 'plan-hash-123',
      scope: 'project-local',
      orchestrator: 'claude',
      executor: 'kilo',
      orchestrator_model: 'claude-3-7-sonnet',
      executor_model: 'gemini-2.5-flash',
      verification_mode: 'full',
      start_orchestrator: true,
    }, tmpDir);

    if (!res.ok) fail('applySetup response unexpected');
    const cmd = executedCmds[0];
    if (
      cmd[0] !== 'setup' || cmd[1] !== '--apply' ||
      !cmd.includes('--expect-hash') || !cmd.includes('plan-hash-123') ||
      !cmd.includes('--scope') || !cmd.includes('project-local') ||
      !cmd.includes('--orchestrator') || !cmd.includes('claude') ||
      !cmd.includes('--executor') || !cmd.includes('kilo') ||
      !cmd.includes('--orchestrator-model') || !cmd.includes('claude-3-7-sonnet') ||
      !cmd.includes('--executor-model') || !cmd.includes('gemini-2.5-flash') ||
      !cmd.includes('--verification-mode') || !cmd.includes('full') ||
      !cmd.includes('--start-orchestrator')
    ) {
      fail(`applySetup args unexpected: ${cmd.join(' ')}`);
    }
    if (updatedCalled) fail('applySetup must not trigger onTasksUpdated');
    if (!postedMessages.some((m) => m.type === 'setup_applied')) fail('applySetup must post setup_applied');
    if (!postedMessages.some((m) => m.type === 'config_updated')) fail('applySetup must post config_updated');
    if (!postedMessages.some((m) => m.type === 'changed' && m.areas.includes('config') && m.areas.includes('orchestrator') && m.areas.includes('events') && m.areas.includes('sessions'))) {
      fail('applySetup must post changed for config, orchestrator, events, sessions');
    }
    console.log('PASS: applySetup handler');
  }

  // Test confirmProposedAction & rejectProposedAction
  {
    executedCmds = [];
    postedMessages = [];
    updatedCalled = false;

    // 1. confirmProposedAction validation
    // invalid action ID (path traversal) -> 400
    try {
      await CUSTOM_HANDLERS.confirmProposedAction(createMockPanel(), { actionId: '../act1', expect_hash: 'h1' }, tmpDir);
      fail('confirmProposedAction must reject traversal in actionId');
    } catch (e) {
      if (e.status !== 400 || e.data?.error !== 'invalid_action_id') fail(`Expected invalid_action_id: ${JSON.stringify(e)}`);
    }

    // missing expect_hash -> 400
    try {
      await CUSTOM_HANDLERS.confirmProposedAction(createMockPanel(), { actionId: 'act1' }, tmpDir);
      fail('confirmProposedAction must require expect_hash');
    } catch (e) {
      if (e.status !== 400 || e.data?.error !== 'missing_expect_hash') fail(`Expected missing_expect_hash: ${JSON.stringify(e)}`);
    }

    // confirmProposedAction success
    const mockConfirmPanel = createMockPanel({
      'triggers confirm': { ok: true, confirmed: true, run_id: '20261018-120000-T001-kilo-abcd' },
    });
    const confRes = await CUSTOM_HANDLERS.confirmProposedAction(mockConfirmPanel, { actionId: 'act1.json', expect_hash: 'h123' }, tmpDir);
    if (!confRes.ok) fail('confirmProposedAction response unexpected');
    const confCmd = executedCmds[0];
    if (
      confCmd[0] !== 'triggers' || confCmd[1] !== 'confirm' ||
      confCmd[2] !== 'act1' ||
      !confCmd.includes('--expect-hash') || !confCmd.includes('h123') ||
      !confCmd.includes('--actor') || !confCmd.includes('vscode') ||
      !confCmd.includes('--workspace') || !confCmd.includes(tmpDir)
    ) {
      fail(`confirmProposedAction args unexpected: ${confCmd.join(' ')}`);
    }
    if (updatedCalled) fail('confirmProposedAction must not trigger onTasksUpdated');
    if (!postedMessages.some((m) => m.type === 'changed' && m.areas.includes('triggers') && m.areas.includes('events') && m.areas.includes('runs'))) {
      fail('confirmProposedAction must post changed for triggers, events, runs');
    }

    // confirmProposedAction error mapping
    const errMapTest = async (cliError, expectedStatus) => {
      const errPanel = {
        cliClient: {
          runJsonCommand: async () => {
            const err = new Error('CLI failed');
            err.status = 500;
            err.data = { error: cliError };
            throw err;
          },
        },
        postMessage: () => {},
      };
      try {
        await CUSTOM_HANDLERS.confirmProposedAction(errPanel, { actionId: 'act1', expect_hash: 'h1' }, tmpDir);
        fail(`Should have thrown for ${cliError}`);
      } catch (e) {
        if (e.status !== expectedStatus) fail(`Expected ${expectedStatus} for ${cliError}, got ${e.status}`);
      }
    };
    await errMapTest('proposal_not_found', 404);
    await errMapTest('not_pending', 409);
    await errMapTest('hash_mismatch', 409);
    await errMapTest('disallowed_command', 400);
    await errMapTest('preview_failed', 502);

    // 2. rejectProposedAction validation
    // invalid action ID -> 400
    try {
      await CUSTOM_HANDLERS.rejectProposedAction(createMockPanel(), { actionId: 'bad/id', reason: 'no' }, tmpDir);
      fail('rejectProposedAction must reject traversal in actionId');
    } catch (e) {
      if (e.status !== 400 || e.data?.error !== 'invalid_action_id') fail(`Expected invalid_action_id: ${JSON.stringify(e)}`);
    }

    // missing reason -> 400
    try {
      await CUSTOM_HANDLERS.rejectProposedAction(createMockPanel(), { actionId: 'act2' }, tmpDir);
      fail('rejectProposedAction must require reason');
    } catch (e) {
      if (e.status !== 400 || e.data?.error !== 'missing_reason') fail(`Expected missing_reason: ${JSON.stringify(e)}`);
    }

    // reason too long (> 1000 chars) -> 400
    try {
      await CUSTOM_HANDLERS.rejectProposedAction(createMockPanel(), { actionId: 'act2', reason: 'x'.repeat(1001) }, tmpDir);
      fail('rejectProposedAction must reject reasons > 1000 chars');
    } catch (e) {
      if (e.status !== 400 || e.data?.error !== 'reason_too_long') fail(`Expected reason_too_long: ${JSON.stringify(e)}`);
    }

    // rejectProposedAction success
    executedCmds = [];
    postedMessages = [];
    updatedCalled = false;
    const mockRejectPanel = createMockPanel({
      'triggers reject': { ok: true, rejected: true },
    });
    const rejRes = await CUSTOM_HANDLERS.rejectProposedAction(mockRejectPanel, { actionId: 'act2', reason: 'not needed' }, tmpDir);
    if (!rejRes.ok) fail('rejectProposedAction response unexpected');
    const rejCmd = executedCmds[0];
    if (
      rejCmd[0] !== 'triggers' || rejCmd[1] !== 'reject' ||
      rejCmd[2] !== 'act2' ||
      !rejCmd.includes('--reason') || !rejCmd.includes('not needed') ||
      !rejCmd.includes('--actor') || !rejCmd.includes('vscode') ||
      !rejCmd.includes('--workspace') || !rejCmd.includes(tmpDir)
    ) {
      fail(`rejectProposedAction args unexpected: ${rejCmd.join(' ')}`);
    }
    if (updatedCalled) fail('rejectProposedAction must not trigger onTasksUpdated');
    if (!postedMessages.some((m) => m.type === 'changed' && m.areas.includes('triggers') && m.areas.includes('events'))) {
      fail('rejectProposedAction must post changed for triggers, events');
    }

    console.log('PASS: confirmProposedAction and rejectProposedAction handlers and error mapping');
  }

  // 5. Turn ID Traversal Rejection Tests
  {
    const traversalIds = ['../turn1', '..\\turn1', 'foo/bar', 'foo\\bar', '../../etc/passwd', 'turn\0bad'];
    for (const badId of traversalIds) {
      try {
        validateTurnId(badId);
        fail(`validateTurnId should have rejected ${JSON.stringify(badId)}`);
      } catch (e) {
        if (e.status !== 400) fail(`Expected status 400 for bad turn ID: ${e}`);
      }

      try {
        await CUSTOM_HANDLERS.getOrchestratorTurn(createMockPanel(), { turnId: badId }, tmpDir);
        fail(`getOrchestratorTurn should have rejected traversal ID ${JSON.stringify(badId)}`);
      } catch (e) {
        if (e.status !== 400) fail(`Expected status 400 for bad turn ID: ${e}`);
      }
    }
    console.log('PASS: turn-id path traversal rejection verified');
  }

  // 6. Turn Detail (getOrchestratorTurn) & Assistant-messages extraction
  {
    const turnsBaseDir = path.join(tmpDir, '.ai-orchestration', 'orchestrator', 'turns');
    const turn10Dir = path.join(turnsBaseDir, '000010');
    fs.mkdirSync(turn10Dir, { recursive: true });

    // Turn 10 with streaming events.001.jsonl and events.002.jsonl
    fs.writeFileSync(path.join(turn10Dir, 'turn.json'), JSON.stringify({
      turn_id: '000010',
      turn_seq: 10,
      state: 'running',
      created_at: '2026-10-18T11:00:00Z',
    }));
    fs.writeFileSync(path.join(turn10Dir, 'prompt.txt'), 'Refactor module X');

    // Streaming chunks testing kilo part.text with messageID aggregation
    fs.writeFileSync(path.join(turn10Dir, 'events.001.jsonl'), [
      JSON.stringify({ type: 'text', part: { type: 'text', text: 'Hello', messageID: 'm1' } }),
      JSON.stringify({ type: 'text', part: { type: 'text', text: ' world', messageID: 'm1' } }),
      JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Completed subagent task' } }),
    ].join('\n'));
    fs.writeFileSync(path.join(turn10Dir, 'events.002.jsonl'), [
      JSON.stringify({ role: 'assistant', content: 'Final summary message' }),
    ].join('\n'));

    const detailRes = await CUSTOM_HANDLERS.getOrchestratorTurn(createMockPanel(), { turnId: '000010' }, tmpDir);
    if (!detailRes.ok || !detailRes.turn) fail('getOrchestratorTurn response unexpected');
    if (detailRes.turn.prompt_text !== 'Refactor module X') fail('prompt_text mismatch');
    const msgs = detailRes.turn.assistant_messages;
    if (!Array.isArray(msgs) || msgs.length !== 3) {
      fail(`assistant_messages mismatch: ${JSON.stringify(msgs)}`);
    }
    if (msgs[0] !== 'Hello\n world' || msgs[1] !== 'Completed subagent task' || msgs[2] !== 'Final summary message') {
      fail(`assistant message contents unexpected: ${JSON.stringify(msgs)}`);
    }
    if (!detailRes.turn.output.includes('Hello\n world') || !detailRes.turn.output.includes('Final summary message')) {
      fail('turn output string does not combine assistant messages');
    }

    // 404 for missing turn
    try {
      await CUSTOM_HANDLERS.getOrchestratorTurn(createMockPanel(), { turnId: '000999' }, tmpDir);
      fail('getOrchestratorTurn must throw 404 for non-existent turn');
    } catch (e) {
      if (e.status !== 404) fail(`Expected 404 for missing turn: ${e}`);
    }

    console.log('PASS: getOrchestratorTurn and readPartialAssistantMessages extraction');
  }

  // 7. Turn Ordering Tests (Chronological sorting: hand-off turn after numbered turns)
  {
    const turnsDir = path.join(tmpDir, '.ai-orchestration', 'orchestrator', 'turns');
    fs.rmSync(turnsDir, { recursive: true, force: true });
    fs.mkdirSync(turnsDir, { recursive: true });

    // Turn 1: 000001 created at 10:00:00Z
    const t1Dir = path.join(turnsDir, '000001');
    fs.mkdirSync(t1Dir, { recursive: true });
    fs.writeFileSync(path.join(t1Dir, 'turn.json'), JSON.stringify({
      turn_id: '000001',
      turn_seq: 1,
      type: 'owner_chat',
      state: 'done',
      created_at: '2026-10-18T10:00:00Z',
      assistant_messages: ['Turn 1 reply'],
    }));

    // Turn 2: 000002 created at 10:05:00Z
    const t2Dir = path.join(turnsDir, '000002');
    fs.mkdirSync(t2Dir, { recursive: true });
    fs.writeFileSync(path.join(t2Dir, 'turn.json'), JSON.stringify({
      turn_id: '000002',
      turn_seq: 2,
      type: 'owner_chat',
      state: 'done',
      created_at: '2026-10-18T10:05:00Z',
      assistant_messages: ['Turn 2 reply'],
    }));

    // Handoff turn: handoff-gen002-abc123 created after Turn 2 (ended at 10:10:00Z)
    const handoffDir = path.join(turnsDir, 'handoff-gen002-abc123');
    fs.mkdirSync(handoffDir, { recursive: true });
    fs.writeFileSync(path.join(handoffDir, 'turn.json'), JSON.stringify({
      turn_id: 'handoff-gen002-abc123',
      type: 'handoff',
      state: 'done',
      ended_at: '2026-10-18T10:10:00Z',
      assistant_messages: ['Handoff completed'],
    }));

    // Ascending order: Turn 1, then Turn 2, then Handoff (strictly chronological)
    const convAsc = await CUSTOM_HANDLERS.getOrchestratorConversation(createMockPanel(), { order: 'asc' }, tmpDir);
    if (!convAsc.ok || !Array.isArray(convAsc.turns)) fail('getOrchestratorConversation asc failed');
    const ascIds = convAsc.turns.map((t) => t.turn_id);
    if (ascIds.join(',') !== '000001,000002,handoff-gen002-abc123') {
      fail(`Ascending turn ordering mismatch: expected [000001, 000002, handoff-gen002-abc123], got [${ascIds.join(', ')}]`);
    }

    // Descending order: Handoff, then Turn 2, then Turn 1
    const convDesc = await CUSTOM_HANDLERS.getOrchestratorConversation(createMockPanel(), { order: 'desc' }, tmpDir);
    if (!convDesc.ok || !Array.isArray(convDesc.turns)) fail('getOrchestratorConversation desc failed');
    const descIds = convDesc.turns.map((t) => t.turn_id);
    if (descIds.join(',') !== 'handoff-gen002-abc123,000002,000001') {
      fail(`Descending turn ordering mismatch: expected [handoff-gen002-abc123, 000002, 000001], got [${descIds.join(', ')}]`);
    }

    // Pagination test: limit 1, offset 1
    const convPage = await CUSTOM_HANDLERS.getOrchestratorConversation(createMockPanel(), { order: 'asc', limit: 1, offset: 1 }, tmpDir);
    if (convPage.turns.length !== 1 || convPage.turns[0].turn_id !== '000002') {
      fail(`Pagination mismatch: ${JSON.stringify(convPage)}`);
    }

    console.log('PASS: turn ordering (hand-off turn after numbered turns) and pagination');
  }

} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

console.log('All 12.8 / 12.10 / 12.16 parity tests passed successfully!');
