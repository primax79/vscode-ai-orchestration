import assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import { execFileSync } from 'child_process';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const Module = require('module');
const stub = class {};

Module._load = new Proxy(Module._load, {
  apply(target, thisArg, [request, ...rest]) {
    if (request === 'vscode') {
      return {
        workspace: { getConfiguration: () => ({ get: () => undefined }) },
        window: {},
        commands: {},
        Uri: { file: (p) => ({ fsPath: p }) },
        TreeItem: stub,
        EventEmitter: stub,
        Disposable: stub,
        ThemeIcon: stub,
        ThemeColor: stub,
        MarkdownString: stub,
        RelativePattern: stub,
        TreeItemCollapsibleState: {},
        StatusBarAlignment: {},
        ViewColumn: {},
      };
    }
    return Reflect.apply(target, thisArg, [request, ...rest]);
  },
});

const {
  HANDLER_MAP,
  CUSTOM_HANDLERS,
  TASK_WRITE_TYPES,
  VALIDATE_CLOSE_ID_RE,
  extractValidateCloseTaskIds,
  computeValidateClosePlanHash,
  CliClient,
} = require('../out/extension.js');

const fail = (m) => {
  console.error(`FAIL: ${m}`);
  process.exit(1);
};

console.log('--- Running Validate & Close (T075) Bridge Parity Tests ---');

// 1. Handler registration & TASK_WRITE_TYPES check
assert.strictEqual(typeof CUSTOM_HANDLERS.previewValidateClose, 'function', 'previewValidateClose in CUSTOM_HANDLERS');
assert.strictEqual(typeof CUSTOM_HANDLERS.applyValidateClose, 'function', 'applyValidateClose in CUSTOM_HANDLERS');
assert.strictEqual(typeof HANDLER_MAP.previewValidateClose, 'function', 'previewValidateClose in HANDLER_MAP');
assert.strictEqual(typeof HANDLER_MAP.applyValidateClose, 'function', 'applyValidateClose in HANDLER_MAP');
assert.ok(TASK_WRITE_TYPES.has('applyValidateClose'), 'TASK_WRITE_TYPES includes applyValidateClose');
console.log('PASS: previewValidateClose & applyValidateClose registered in CUSTOM_HANDLERS, HANDLER_MAP, and TASK_WRITE_TYPES');

// 2. ID extraction & regex validation
assert.deepStrictEqual(
  extractValidateCloseTaskIds({ task_ids: ['T001', 'T002, T003', 'T001'] }),
  ['T001', 'T002', 'T003']
);
assert.deepStrictEqual(extractValidateCloseTaskIds({ task_id: '01.2' }), ['01.2']);
assert.ok(VALIDATE_CLOSE_ID_RE.test('T001'));
assert.ok(VALIDATE_CLOSE_ID_RE.test('01.2'));
assert.ok(!VALIDATE_CLOSE_ID_RE.test('BAD!!'));
console.log('PASS: extractValidateCloseTaskIds and VALIDATE_CLOSE_ID_RE');

// 3. Unit tests with fixture (exact backend algorithm & shape parity)
{
  const fixtureTasks = [
    {
      id: 'T001',
      title: 'T001: First delivered task',
      short_title: 'First delivered task',
      state: 'delivered',
      canonical_state: 'delivered',
      verify_by: 'owner',
      is_leaf: true,
      is_container: false,
      bundle_sha256: 'aaaa1111bbbb2222cccc3333dddd4444eeee5555ffff6666aaaa1111bbbb2222',
      rel_path: 'ui/T001-first/README.md',
    },
    {
      id: 'T002',
      title: 'T002: Second verified task',
      short_title: 'Second verified task',
      state: 'verified',
      canonical_state: 'verified',
      verify_by: '-',
      is_leaf: true,
      is_container: false,
      bundle_sha256: '1111aaaa2222bbbb3333cccc4444dddd5555eeee6666ffff1111aaaa2222bbbb',
      rel_path: 'ui/T002-second/README.md',
    },
    {
      id: 'T003',
      title: 'T003: Open task',
      short_title: 'Open task',
      state: 'open',
      canonical_state: 'open',
      is_leaf: true,
      is_container: false,
      bundle_sha256: '9999999999999999999999999999999999999999999999999999999999999999',
    },
  ];

  // Expected hash computed with the documented backend algorithm:
  // json.dumps([{"id": it["id"], "state": it["state"], "task_hash": it.get("task_hash") or ""}], sort_keys=True, separators=(",", ":"))
  const expectedCanonicalJson = JSON.stringify([
    {
      id: 'T001',
      state: 'delivered',
      task_hash: 'aaaa1111bbbb2222cccc3333dddd4444eeee5555ffff6666aaaa1111bbbb2222',
    },
    {
      id: 'T002',
      state: 'verified',
      task_hash: '1111aaaa2222bbbb3333cccc4444dddd5555eeee6666ffff1111aaaa2222bbbb',
    },
  ]);
  const expectedPlanHash = crypto.createHash('sha256').update(expectedCanonicalJson, 'utf8').digest('hex');

  let executedCmds = [];
  let postedMessages = [];
  let tasksUpdatedCount = 0;

  const mockPanel = {
    cliClient: {
      runJsonCommand: async (args) => {
        executedCmds.push(args);
        if (args[0] === 'tasks' && args[1] === 'list') {
          return {
            ok: true,
            emergent_tasks: fixtureTasks,
            all_tasks: fixtureTasks,
            tree: Object.fromEntries(fixtureTasks.map((t) => [t.id, t])),
          };
        }
        if (args[0] === 'tasks' && args[1] === 'transition') {
          const tid = args[2];
          const isDry = args.includes('--dry-run');
          const task = fixtureTasks.find((t) => t.id === tid);
          return {
            ok: true,
            dry_run: isDry,
            task_id: tid,
            old_state: task.state,
            new_state: 'done',
            path: task.state === 'delivered' ? ['delivered', 'verified', 'done'] : ['verified', 'done'],
            rel_path: task.rel_path,
            task_hash: task.bundle_sha256,
          };
        }
        if (args[0] === 'tasks' && args[1] === 'sync-index') {
          return { ok: true, in_sync: true };
        }
        return { ok: true };
      },
    },
    postMessage: (msg) => postedMessages.push(msg),
    onTasksUpdated: () => {
      tasksUpdatedCount++;
    },
  };

  // 3a. Validation errors: empty, invalid id, not found, non-delivered/verified
  await assert.rejects(
    () => HANDLER_MAP.previewValidateClose(mockPanel, { task_ids: [] }, '/fake/root'),
    (err) => err.status === 400
  );
  await assert.rejects(
    () => HANDLER_MAP.previewValidateClose(mockPanel, { task_ids: ['BAD!!'] }, '/fake/root'),
    (err) => err.status === 400
  );
  await assert.rejects(
    () => HANDLER_MAP.previewValidateClose(mockPanel, { task_ids: ['T999'] }, '/fake/root'),
    (err) => err.status === 404
  );
  await assert.rejects(
    () => HANDLER_MAP.previewValidateClose(mockPanel, { task_ids: ['T001', 'T003'] }, '/fake/root'),
    (err) => err.status === 400 && err.message.includes('T003')
  );

  // 3b. Preview shape and hash equal to backend's for the same fixture
  const previewRes = await HANDLER_MAP.previewValidateClose(
    mockPanel,
    { task_ids: ['T001', 'T002'], note: 'Owner verified' },
    '/fake/root'
  );
  assert.strictEqual(previewRes.ok, true);
  assert.strictEqual(previewRes.dry_run, true);
  assert.strictEqual(previewRes.count, 2);
  assert.strictEqual(previewRes.verifier, 'owner');
  assert.strictEqual(previewRes.note, 'Owner verified');
  assert.deepStrictEqual(previewRes.task_ids, ['T001', 'T002']);
  assert.strictEqual(previewRes.plan_hash, expectedPlanHash);
  assert.strictEqual(previewRes.hash, expectedPlanHash);
  assert.strictEqual(
    previewRes.summary,
    'Validate and close 2 task(s) as `owner`: `T001` (First delivered task), `T002` (Second verified task)'
  );
  assert.strictEqual(previewRes.tasks.length, 2);
  assert.deepStrictEqual(previewRes.tasks[0], {
    id: 'T001',
    task_id: 'T001',
    title: 'T001: First delivered task',
    short_title: 'First delivered task',
    state: 'delivered',
    raw_state: 'delivered',
    new_state: 'done',
    verify_by: 'owner',
    verifier: 'owner',
    path: ['delivered', 'verified', 'done'],
    rel_path: 'ui/T001-first/README.md',
    task_hash: 'aaaa1111bbbb2222cccc3333dddd4444eeee5555ffff6666aaaa1111bbbb2222',
  });
  assert.strictEqual(previewRes.tasks[1].verify_by, null, 'verify_by "-" normalized to null');
  assert.deepStrictEqual(previewRes.tasks[1].path, ['verified', 'done']);
  console.log('PASS: previewValidateClose response shape and plan_hash match backend algorithm');

  // 3c. Apply refuses on changed plan hash or per-task hash (409)
  await assert.rejects(
    () =>
      HANDLER_MAP.applyValidateClose(
        mockPanel,
        { task_ids: ['T001', 'T002'], expect_plan_hash: 'deadbeef'.repeat(8) },
        '/fake/root'
      ),
    (err) => err.status === 409 && err.message.includes('stale-plan')
  );
  await assert.rejects(
    () =>
      HANDLER_MAP.applyValidateClose(
        mockPanel,
        {
          task_ids: ['T001', 'T002'],
          expect_plan_hash: expectedPlanHash,
          expect_task_hashes: { T001: '0000'.repeat(16) },
        },
        '/fake/root'
      ),
    (err) => err.status === 409 && err.message.includes('stale-task')
  );
  console.log('PASS: applyValidateClose refuses on stale plan_hash or stale task_hash with 409');

  // 3d. Apply succeeds with matching hash, posts messages, and calls onTasksUpdated
  executedCmds = [];
  postedMessages = [];
  tasksUpdatedCount = 0;

  const applyRes = await HANDLER_MAP.applyValidateClose(
    mockPanel,
    {
      task_ids: ['T001', 'T002'],
      note: 'Owner verified',
      expect_plan_hash: expectedPlanHash,
    },
    '/fake/root'
  );
  assert.strictEqual(applyRes.ok, true);
  assert.strictEqual(applyRes.applied, true);
  assert.strictEqual(applyRes.count, 2);
  assert.strictEqual(applyRes.verifier, 'owner');
  assert.strictEqual(applyRes.note, 'Owner verified');
  assert.deepStrictEqual(applyRes.task_ids, ['T001', 'T002']);
  assert.strictEqual(applyRes.results.length, 2);
  assert.strictEqual(applyRes.index_in_sync, true);
  assert.strictEqual(tasksUpdatedCount, 1, 'onTasksUpdated called once after apply');
  assert.ok(
    postedMessages.some((m) => m.type === 'changed' && Array.isArray(m.areas) && m.areas.includes('tasks')),
    'posted changed (tasks) message'
  );
  assert.ok(
    postedMessages.some((m) => m.type === 'tasks_changed'),
    'posted tasks_changed message'
  );
  console.log('PASS: applyValidateClose unit test with mock CLI succeeded');
}

// 4. End-to-end test with real ai-orch CLI and temp tasks dir
{
  const cliClient = new CliClient({ appendLine: () => {} });
  const binPath = cliClient.resolveCliPath(process.cwd());
  if (!binPath) {
    fail('Could not resolve real ai-orch CLI for end-to-end test');
  }
  cliClient.resolveCliPath = () => binPath;

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'test-validate-close-'));
  const tasksDir = path.join(tmpRoot, 'tasks');
  fs.mkdirSync(tasksDir, { recursive: true });
  fs.writeFileSync(path.join(tasksDir, '00-INDEX.md'), '# Tasks Index\n', 'utf-8');

  try {
    for (const title of ['First task', 'Second task', 'Third task']) {
      execFileSync(
        'python3',
        [
          binPath,
          'tasks',
          'new',
          '--title',
          title,
          '--goal',
          `Goal for ${title}`,
          '--priority-reason',
          'Test fixture',
          '--step',
          'Implement feature',
          '--verification',
          'Run tests',
          '--category',
          'ui',
          '--priority',
          'P2',
          '--tasks-dir',
          tasksDir,
          '--json',
        ],
        { stdio: 'pipe' }
      );
    }

    execFileSync('python3', [binPath, 'tasks', 'transition', 'T001', 'in progress', '--tasks-dir', tasksDir, '--json'], { stdio: 'pipe' });
    execFileSync('python3', [binPath, 'tasks', 'transition', 'T001', 'delivered', '--verify-by', 'owner', '--tasks-dir', tasksDir, '--json'], { stdio: 'pipe' });

    execFileSync('python3', [binPath, 'tasks', 'transition', 'T002', 'in progress', '--tasks-dir', tasksDir, '--json'], { stdio: 'pipe' });
    execFileSync('python3', [binPath, 'tasks', 'transition', 'T002', 'delivered', '--tasks-dir', tasksDir, '--json'], { stdio: 'pipe' });
    execFileSync('python3', [binPath, 'tasks', 'transition', 'T002', 'verified', '--verifier', 'owner', '--tasks-dir', tasksDir, '--json'], { stdio: 'pipe' });

    const posted = [];
    let updated = 0;
    const realPanel = {
      cliClient,
      postMessage: (m) => posted.push(m),
      onTasksUpdated: () => {
        updated++;
      },
    };

    // Preview on real tasks
    const prev = await HANDLER_MAP.previewValidateClose(
      realPanel,
      { task_ids: ['T001', 'T002'], note: 'Validated in VS Code bridge test' },
      tmpRoot
    );
    assert.strictEqual(prev.ok, true);
    assert.strictEqual(prev.count, 2);
    assert.strictEqual(prev.tasks[0].id, 'T001');
    assert.strictEqual(prev.tasks[0].state, 'delivered');
    assert.strictEqual(prev.tasks[0].verify_by, 'owner');
    assert.strictEqual(prev.tasks[1].id, 'T002');
    assert.strictEqual(prev.tasks[1].state, 'verified');

    const expectedRealHash = computeValidateClosePlanHash(prev.tasks);
    assert.strictEqual(prev.plan_hash, expectedRealHash);

    // Apply with wrong hash -> 409
    await assert.rejects(
      () =>
        HANDLER_MAP.applyValidateClose(
          realPanel,
          { task_ids: ['T001', 'T002'], expect_plan_hash: 'badhash' },
          tmpRoot
        ),
      (err) => err.status === 409
    );

    // Apply with valid plan_hash -> transitions both to done with verifier=owner
    const applied = await HANDLER_MAP.applyValidateClose(
      realPanel,
      {
        task_ids: ['T001', 'T002'],
        note: 'Validated in VS Code bridge test',
        expect_plan_hash: prev.plan_hash,
      },
      tmpRoot
    );
    assert.strictEqual(applied.ok, true);
    assert.strictEqual(applied.applied, true);
    assert.strictEqual(applied.count, 2);
    assert.strictEqual(updated, 1);
    assert.ok(posted.some((m) => m.type === 'changed' && m.areas.includes('tasks')));

    // Verify on disk via ai-orch tasks show
    for (const tid of ['T001', 'T002']) {
      const showOut = JSON.parse(
        execFileSync('python3', [binPath, 'tasks', 'show', tid, '--tasks-dir', tasksDir, '--json'], {
          encoding: 'utf-8',
        })
      );
      assert.strictEqual(showOut.task.canonical_state, 'done');
      assert.strictEqual(showOut.task.in_done, true);
      const readmeText = fs.readFileSync(showOut.task.file_path, 'utf-8');
      assert.ok(readmeText.includes('- state: done'));
      assert.ok(readmeText.includes('- verifier: owner'));
      assert.ok(readmeText.includes('Validated in VS Code bridge test'));
    }

    // Re-applying on already-done task with old expect_plan_hash -> 409 stale-plan
    await assert.rejects(
      () =>
        HANDLER_MAP.applyValidateClose(
          realPanel,
          { task_ids: ['T001'], expect_plan_hash: prev.plan_hash },
          tmpRoot
        ),
      (err) => err.status === 409 && err.message.includes('stale-plan')
    );

    console.log('PASS: End-to-end previewValidateClose & applyValidateClose with real ai-orch CLI');
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

console.log('All Validate & Close (T075) tests passed successfully!');
