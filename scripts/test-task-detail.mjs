// getTaskDetail serves plan tasks (NN.T) and initiative cards (INIT-NN) from plan.md.
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
const { DashboardPanel, HANDLER_MAP } = require('../out/extension.js');
const fail = (m) => { console.error(`FAIL: ${m}`); process.exit(1); };
if (!HANDLER_MAP) fail('HANDLER_MAP not exported');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-orch-detail-'));
fs.mkdirSync(path.join(root, 'tasks', '05-sample'), { recursive: true });
fs.writeFileSync(path.join(root, 'tasks', '05-sample', 'plan.md'),
  '# 05 - Sample\n\n## Tasks\n\n### 05.1 - First\n\n- **Status:** `open`\n\n### 05.2 — Second\n- **Status:** `done`\n\n## Log\n- entry\n');
const panel = Object.create(DashboardPanel.prototype);
const h = HANDLER_MAP.getTaskDetail;

const a = await h(panel, { taskId: '05.1' }, root);
if (!a.content.startsWith('### 05.1 - First') || a.content.includes('05.2')) fail(`05.1 block wrong: ${JSON.stringify(a.content)}`);
const b = await h(panel, { taskId: '05.2' }, root);
if (b.content.includes('## Log')) fail('05.2 block leaks the Log section');
const c = await h(panel, { taskId: 'INIT-05' }, root);
if (!c.content.includes('## Log')) fail('INIT-05 should return the whole plan');
for (const [id, status] of [['05.9', 404], ['T0*', 400]]) {
  try { await h(panel, { taskId: id }, root); fail(`${id} should throw`); } catch (e) { if (e.status !== status) fail(`${id}: status ${e.status} != ${status}`); }
}
fs.rmSync(root, { recursive: true, force: true });
console.log('PASS: plan-task detail (NN.T block, INIT-NN plan, 404/400)');
