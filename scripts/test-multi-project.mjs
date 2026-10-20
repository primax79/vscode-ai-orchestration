import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as assert from 'assert';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const Module = require('module');
const stub = class {};

Module._load = new Proxy(Module._load, {
  apply(target, thisArg, [request, ...rest]) {
    if (request === 'vscode') {
      return {
        workspace: {
          workspaceFolders: [],
          getConfiguration: () => ({ get: () => undefined }),
          createFileSystemWatcher: () => ({
            onDidChange: () => ({ dispose: () => {} }),
            onDidCreate: () => ({ dispose: () => {} }),
            onDidDelete: () => ({ dispose: () => {} }),
            dispose: () => {},
          }),
          onDidChangeWorkspaceFolders: () => ({ dispose: () => {} }),
        },
        window: {
          createOutputChannel: () => ({ appendLine: () => {}, dispose: () => {} }),
          createStatusBarItem: () => ({ show: () => {}, hide: () => {}, dispose: () => {} }),
          createTreeView: () => ({ badge: undefined, dispose: () => {} }),
          registerTreeDataProvider: () => ({ dispose: () => {} }),
        },
        commands: {
          registerCommand: () => ({ dispose: () => {} }),
          executeCommand: async () => {},
        },
        Uri: {
          file: (f) => ({ fsPath: f, scheme: 'file' }),
          joinPath: (base, ...segments) => ({ fsPath: path.join(base.fsPath || base, ...segments) }),
        },
        TreeItem: class TreeItem {
          constructor(label, collapsibleState) {
            this.label = label;
            this.collapsibleState = collapsibleState;
          }
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
        MarkdownString: class MarkdownString {
          constructor(val) {
            this.value = val;
          }
        },
        RelativePattern: class RelativePattern {
          constructor(base, pattern) {
            this.base = base;
            this.pattern = pattern;
          }
        },
        TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
        StatusBarAlignment: { Left: 1, Right: 2 },
        ViewColumn: { One: 1 },
      };
    }
    return Reflect.apply(target, thisArg, [request, ...rest]);
  },
});

const {
  ProjectResolver,
  getProjectResolver,
  invalidateProjectResolver,
  DashboardPanel,
  CliClient,
  HANDLER_MAP,
  dispatchMessage,
  resolveMessageTargetRoot,
  TaskTreeProvider,
  ProjectGroupTreeItem,
  DecisionsTreeProvider,
  DecisionProjectTreeItem,
  detectSharedWorkspaceRoot,
} = require('../out/extension.js');

const fail = (m) => {
  console.error(`FAIL: ${m}`);
  process.exit(1);
};

function writeTaskFile(filePath, lines) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, lines.join('\n') + '\n', 'utf-8');
}

async function runMultiProjectTests() {
  console.log('--- Running Multi-Project Support Tests (16.9c) ---');

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vscode-multi-proj-'));
  try {
    // Build a scratch workspace with:
    // - _workspace (root tasks/00-INDEX.md + coordination task T001 coordinating proj-alpha/T001 and proj-beta/T002)
    // - proj-alpha (tasks/00-INDEX.md + T001 in progress, T002 conditional done)
    // - proj-beta (tasks/00-INDEX.md + T001 open, T002 delivered, plus open question Q001 and inbox note N001)
    // - node_modules/ignored-proj/tasks/00-INDEX.md (must be skipped)
    // - .kilo/worktrees/wt-proj/tasks/00-INDEX.md (must be skipped)

    const wsTasks = path.join(tmpRoot, 'tasks');
    const alphaRoot = path.join(tmpRoot, 'proj-alpha');
    const betaRoot = path.join(tmpRoot, 'proj-beta');

    fs.mkdirSync(wsTasks, { recursive: true });
    fs.writeFileSync(path.join(wsTasks, '00-INDEX.md'), '# Workspace Index\n', 'utf-8');
    writeTaskFile(path.join(wsTasks, 'coordination', 'T001-release-chain.md'), [
      '# T001 Release chain across alpha and beta',
      '',
      '- id: T001',
      '- title: Release chain across alpha and beta',
      '- short: Alpha then Beta release',
      '- category: coordination',
      '- priority: P1',
      '- priority-reason: release ordering',
      '- next-up: yes',
      '- state: open',
      '- executor: self',
      '- depends-on: -',
      '- decider: -',
      '- coordinates: proj-alpha/T001, proj-beta/T002',
      '',
      '## Goal',
      'Coordinate alpha and beta.',
    ]);

    fs.mkdirSync(path.join(alphaRoot, 'tasks'), { recursive: true });
    fs.writeFileSync(path.join(alphaRoot, 'tasks', '00-INDEX.md'), '# Alpha Index\n', 'utf-8');
    writeTaskFile(path.join(alphaRoot, 'tasks', 'core', 'T001-alpha-auth.md'), [
      '# T001 Implement Alpha Auth',
      '',
      '- id: T001',
      '- title: Implement Alpha Auth',
      '- short: Alpha Auth',
      '- category: core',
      '- priority: P0',
      '- priority-reason: critical',
      '- next-up: yes',
      '- state: in progress',
      '- executor: kilo',
      '- depends-on: -',
      '- decider: -',
      '- labels: auth, security',
    ]);
    writeTaskFile(path.join(alphaRoot, 'tasks', 'core', 'T002-alpha-legacy.md'), [
      '# T002 Alpha Legacy Cleanup',
      '',
      '- id: T002',
      '- title: Alpha Legacy Cleanup',
      '- short: Alpha Legacy',
      '- category: core',
      '- priority: P2',
      '- priority-reason: cleanup',
      '- next-up: no',
      '- state: done',
      '- conditional: yes',
      '- executor: self',
      '- depends-on: -',
      '- decider: -',
    ]);

    fs.mkdirSync(path.join(betaRoot, 'tasks', 'questions'), { recursive: true });
    fs.mkdirSync(path.join(betaRoot, 'tasks', '_inbox'), { recursive: true });
    fs.writeFileSync(path.join(betaRoot, 'tasks', '00-INDEX.md'), '# Beta Index\n', 'utf-8');
    writeTaskFile(path.join(betaRoot, 'tasks', 'api', 'T001-beta-endpoints.md'), [
      '# T001 Beta API Endpoints',
      '',
      '- id: T001',
      '- title: Beta API Endpoints',
      '- short: Beta Endpoints',
      '- category: api',
      '- priority: P1',
      '- priority-reason: api',
      '- next-up: yes',
      '- state: open',
      '- executor: claude',
      '- depends-on: -',
      '- decider: -',
    ]);
    writeTaskFile(path.join(betaRoot, 'tasks', 'api', 'T002-beta-client.md'), [
      '# T002 Beta Client SDK',
      '',
      '- id: T002',
      '- title: Beta Client SDK',
      '- short: Beta Client',
      '- category: api',
      '- priority: P1',
      '- priority-reason: sdk',
      '- next-up: no',
      '- state: delivered',
      '- executor: kilo',
      '- depends-on: -',
      '- decider: -',
    ]);
    writeTaskFile(path.join(betaRoot, 'tasks', 'questions', 'Q001-beta-schema.md'), [
      '# Q001 — Which schema version for Beta?',
      '',
      '- id: Q001',
      '- status: open',
      '- blocks: T001',
      '- decider: owner',
      '- asked-by: claude',
      '- asked: 2026-10-20',
      '- recommended: A',
      '',
      '## Question',
      'Which schema version for Beta?',
      '',
      '## Options',
      '### A — v2',
      'Use v2.',
    ]);
    writeTaskFile(path.join(betaRoot, 'tasks', '_inbox', 'to-analyze', 'N001-beta-idea', 'note.md'), [
      '# N001 — Beta caching idea',
      '',
      '- id: N001',
      '- status: ready',
      '- kind: idea',
      '- author: owner',
      '',
      'Cache responses.',
    ]);

    // Excluded folders
    writeTaskFile(path.join(tmpRoot, 'node_modules', 'pkg', 'tasks', '00-INDEX.md'), ['# Ignored']);
    writeTaskFile(path.join(tmpRoot, '.kilo', 'worktrees', 'wt1', 'tasks', '00-INDEX.md'), ['# Ignored']);

    const cliClient = new CliClient({ appendLine: () => {} });
    const panel = Object.create(DashboardPanel.prototype);
    panel.cliClient = cliClient;
    panel._boundRoot = tmpRoot;
    panel.postMessage = () => Promise.resolve(true);

    // 1. Test ProjectResolver discovery
    console.log('Test 1: ProjectResolver discovery & exclusions');
    const resolver = getProjectResolver(tmpRoot, cliClient.resolveCliPath(tmpRoot));
    const info = resolver.getWorkspaceInfo();
    assert.strictEqual(info.mode, 'discovered');
    const projIds = info.projects.map((p) => p.id);
    assert.deepStrictEqual(projIds, ['_workspace', 'proj-alpha', 'proj-beta']);
    assert.strictEqual(info.projects[0].kind, '_workspace');
    assert.strictEqual(info.projects[1].kind, 'project');
    assert.strictEqual(info.projects[2].kind, 'project');
    console.log('PASS: Test 1 (ProjectResolver discovery)');

    // 2. Test routing: project payload reaches right root; missing project -> 400; unknown project -> 404
    console.log('Test 2: Dispatcher per-project routing');
    // Missing project on project-scoped message -> 400 project-required
    let missingErr = null;
    try {
      await dispatchMessage(panel, 'getTasks', {}, tmpRoot);
    } catch (e) {
      missingErr = e;
    }
    if (!missingErr || missingErr.status !== 400 || missingErr.data?.error !== 'project-required') {
      fail(`Expected 400 project-required when project is missing, got: ${JSON.stringify(missingErr)}`);
    }

    // Unknown project -> 404 unknown-project
    let unknownErr = null;
    try {
      await dispatchMessage(panel, 'getTasks', { project: 'nonexistent-proj' }, tmpRoot);
    } catch (e) {
      unknownErr = e;
    }
    if (!unknownErr || unknownErr.status !== 404 || unknownErr.data?.error !== 'unknown-project') {
      fail(`Expected 404 unknown-project for unknown project, got: ${JSON.stringify(unknownErr)}`);
    }

    // Valid project payload reaches the right root
    const alphaTasksRes = await dispatchMessage(panel, 'getTasks', { project: 'proj-alpha' }, tmpRoot);
    assert.ok(alphaTasksRes.tasks_dir.startsWith(fs.realpathSync(alphaRoot)));
    const alphaTaskIds = (alphaTasksRes.all_tasks || alphaTasksRes.emergent_tasks || []).map((t) => t.id).sort();
    assert.deepStrictEqual(alphaTaskIds, ['T001', 'T002']);

    const betaQuestionsRes = await dispatchMessage(panel, 'getQuestions', { project: 'proj-beta', status: 'open' }, tmpRoot);
    assert.strictEqual(betaQuestionsRes.questions.length, 1);
    assert.strictEqual(betaQuestionsRes.questions[0].id, 'Q001');
    console.log('PASS: Test 2 (Dispatcher routing: right root, 400 missing, 404 unknown)');

    // 3. Test getWorkspace counts
    console.log('Test 3: getWorkspace aggregate counts');
    const wsRes = await dispatchMessage(panel, 'getWorkspace', {}, tmpRoot);
    assert.strictEqual(wsRes.mode, 'discovered');
    assert.strictEqual(wsRes.discovered, true);
    assert.strictEqual(wsRes.registered, false);
    assert.strictEqual(wsRes.projects.length, 3);

    const wsProj = wsRes.projects.find((p) => p.id === '_workspace');
    const alphaProj = wsRes.projects.find((p) => p.id === 'proj-alpha');
    const betaProj = wsRes.projects.find((p) => p.id === 'proj-beta');

    assert.strictEqual(wsProj.counts.open, 1);
    assert.strictEqual(wsProj.counts.total, 1);

    assert.strictEqual(alphaProj.counts['in progress'], 1);
    assert.strictEqual(alphaProj.counts.done, 1);
    assert.strictEqual(alphaProj.counts.total, 2);

    assert.strictEqual(betaProj.counts.open, 1);
    assert.strictEqual(betaProj.counts.delivered, 1);
    assert.strictEqual(betaProj.counts.total, 2);
    assert.strictEqual(betaProj.open_questions, 1);
    assert.strictEqual(betaProj.inbox_notes, 1);
    console.log('PASS: Test 3 (getWorkspace counts, open_questions, inbox_notes)');

    // 4. Test getWorkspaceTasks with coordinates resolution, filters, and paging
    console.log('Test 4: getWorkspaceTasks with coordinates and paging');
    const allWsTasks = await dispatchMessage(panel, 'getWorkspaceTasks', { page: 1, per_page: 50 }, tmpRoot);
    assert.strictEqual(allWsTasks.ok, true);
    assert.strictEqual(allWsTasks.total, 5);
    assert.strictEqual(allWsTasks.tasks.length, 5);

    const coordTask = allWsTasks.tasks.find((t) => t.qualified_id === '_workspace/T001');
    assert.ok(coordTask, 'Expected _workspace/T001 in aggregate tasks');
    assert.strictEqual(coordTask.short_title, 'Alpha then Beta release');
    assert.strictEqual(coordTask.coordinates.length, 2);
    assert.deepStrictEqual(coordTask.coordinates[0], {
      project: 'proj-alpha',
      id: 'T001',
      short_title: 'Alpha Auth',
      state: 'in progress',
    });
    assert.deepStrictEqual(coordTask.coordinates[1], {
      project: 'proj-beta',
      id: 'T002',
      short_title: 'Beta Client',
      state: 'delivered',
    });

    // Paging check: per_page=2, page=1 and page=2
    const page1 = await dispatchMessage(panel, 'getWorkspaceTasks', { page: 1, per_page: 2 }, tmpRoot);
    const page2 = await dispatchMessage(panel, 'getWorkspaceTasks', { page: 2, per_page: 2 }, tmpRoot);
    const page3 = await dispatchMessage(panel, 'getWorkspaceTasks', { page: 3, per_page: 2 }, tmpRoot);
    assert.strictEqual(page1.total, 5);
    assert.strictEqual(page1.tasks.length, 2);
    assert.strictEqual(page2.tasks.length, 2);
    assert.strictEqual(page3.tasks.length, 1);

    // Filter by project and state
    const filteredByState = await dispatchMessage(
      panel,
      'getWorkspaceTasks',
      { state: ['in progress', 'delivered'] },
      tmpRoot
    );
    assert.strictEqual(filteredByState.total, 2);
    assert.deepStrictEqual(
      filteredByState.tasks.map((t) => t.qualified_id).sort(),
      ['proj-alpha/T001', 'proj-beta/T002']
    );

    // Aggregate questions & inbox
    const aggQuestions = await dispatchMessage(panel, 'getWorkspaceQuestions', { status: 'open' }, tmpRoot);
    assert.strictEqual(aggQuestions.questions.length, 1);
    assert.strictEqual(aggQuestions.questions[0].project, 'proj-beta');
    assert.strictEqual(aggQuestions.questions[0].id, 'Q001');

    const aggInbox = await dispatchMessage(panel, 'getWorkspaceInbox', {}, tmpRoot);
    assert.strictEqual(aggInbox.notes.length, 1);
    assert.strictEqual(aggInbox.notes[0].project, 'proj-beta');
    assert.strictEqual(aggInbox.notes[0].id, 'N001');
    console.log('PASS: Test 4 (getWorkspaceTasks coordinates, filters, paging, questions & inbox)');

    // 5. Test Tree views in multi-project mode (All projects vs selected project)
    console.log('Test 5: Tree views in multi-project mode');
    let selectedProj = null;
    const nextUpTree = new TaskTreeProvider(cliClient, 'nextUp', () => tmpRoot, () => selectedProj);
    const topNodes = await nextUpTree.getChildren();
    assert.strictEqual(topNodes.length, 3);
    assert.ok(topNodes[0] instanceof ProjectGroupTreeItem);
    assert.strictEqual(topNodes[0].label, '_workspace');

    const alphaChildren = await nextUpTree.getChildren(topNodes[1]);
    assert.strictEqual(alphaChildren.length, 1);
    assert.strictEqual(alphaChildren[0].label, 'proj-alpha/T001 (Alpha Auth)');

    // Narrow tree to proj-alpha -> bare IDs
    selectedProj = 'proj-alpha';
    nextUpTree.refresh();
    const narrowedNodes = await nextUpTree.getChildren();
    assert.strictEqual(narrowedNodes.length, 1);
    assert.strictEqual(narrowedNodes[0].label, 'T001 (Alpha Auth)');

    // Multi-root shared parent detection
    const shared = detectSharedWorkspaceRoot([alphaRoot, betaRoot]);
    assert.strictEqual(shared, fs.realpathSync(tmpRoot));
    console.log('PASS: Test 5 (Tree views & multi-root shared parent detection)');
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }

  console.log('All Multi-Project tests passed!');
}

await runMultiProjectTests();
