// CliClient process guard: concurrency cap, shared identical reads, writes not shared.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const Module = require('module');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-orch-guard-'));
const counter = path.join(tmp, 'count');
const fake = path.join(tmp, 'ai-orch');
// Fake CLI: records peak concurrency via a lock-free counter file, sleeps 300 ms, prints JSON.
fs.writeFileSync(fake, `
import json, os, sys, time, fcntl
p = ${JSON.stringify(counter)}
def bump(d):
    with open(p, 'a+') as f:
        fcntl.flock(f, fcntl.LOCK_EX); f.seek(0); raw = f.read().split()
        cur, peak, total = (int(x) for x in raw) if raw else (0, 0, 0)
        cur += d; peak = max(peak, cur); total += 1 if d > 0 else 0
        f.seek(0); f.truncate(); f.write(f"{cur} {peak} {total}")
bump(1); time.sleep(0.3); bump(-1)
print(json.dumps({"ok": True}))
`);
Module._load = new Proxy(Module._load, {
  apply(target, thisArg, [request, ...rest]) {
    if (request === 'vscode') {
      // The bundle subclasses these at load time; behaviour is irrelevant here
      const stub = class {};
      const workspace = { getConfiguration: () => ({ get: (k) => (k === 'cliPath' ? fake : undefined) }) };
      return {
        workspace, TreeItem: stub, EventEmitter: stub, Disposable: stub, ThemeIcon: stub, ThemeColor: stub,
        MarkdownString: stub, TreeItemCollapsibleState: {}, StatusBarAlignment: {}, ViewColumn: {}, Uri: stub,
        RelativePattern: stub,
      };
    }
    return Reflect.apply(target, thisArg, [request, ...rest]);
  },
});

const { CliClient } = require('../out/extension.js');
const client = new CliClient({ appendLine() {} });
const read = Array.from({ length: 10 }, () => client.runJsonCommand(['tasks', 'list'], tmp));
const writes = Array.from({ length: 10 }, (_, i) => client.runJsonCommand(['tasks', 'transition', `T${i}`], tmp));
await Promise.all([...read, ...writes]);
const [cur, peak, total] = fs.readFileSync(counter, 'utf-8').split(' ').map(Number);
const fail = (m) => { console.error(`FAIL: ${m}`); process.exit(1); };
if (cur !== 0) fail(`processes still counted: ${cur}`);
if (peak > 4) fail(`peak concurrency ${peak} > 4`);
if (total !== 11) fail(`expected 11 processes (1 shared read + 10 writes), got ${total}`);
console.log(`PASS: CLI guard (peak ${peak}, processes ${total})`);
fs.rmSync(tmp, { recursive: true, force: true });
