// Regression: the extension's refresh asks the dashboard to notify the webview; that path
// must not call back into the extension refresh (it made an endless, doubling loop).
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

const { DashboardPanel } = require('../out/extension.js');
const posted = [];
let extensionRefreshes = 0;
const panel = Object.create(DashboardPanel.prototype);
panel._panel = { webview: { postMessage: (m) => { posted.push(m); return Promise.resolve(true); } } };
// The extension's refreshAll, as wired in activate(): it notifies the panel again.
panel.onTasksUpdated = () => {
  extensionRefreshes++;
  panel.notifyTasksChanged();
  panel.notifyQuestionsChanged();
};

const fail = (m) => { console.error(`FAIL: ${m}`); process.exit(1); };

// 1. Extension-initiated notifications: webview updated, extension not called back.
panel.notifyTasksChanged();
panel.notifyQuestionsChanged();
await new Promise((r) => setTimeout(r, 400));
if (extensionRefreshes !== 0) fail(`extension refresh called back ${extensionRefreshes} time(s)`);
if (posted.length !== 2) fail(`expected 2 webview messages, got ${posted.length}`);

// 2. A file-watcher event refreshes the extension exactly once, and that refresh does not loop.
posted.length = 0;
panel._notifyQuestionsChanged();
await new Promise((r) => setTimeout(r, 400));
if (extensionRefreshes !== 1) fail(`expected 1 extension refresh from a watcher event, got ${extensionRefreshes}`);
if (posted.length > 3) fail(`webview flooded: ${posted.length} messages`);

console.log(`PASS: no refresh loop (extension refreshes ${extensionRefreshes}, webview messages ${posted.length})`);
