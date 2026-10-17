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
  DashboardPanel,
  HANDLER_MAP,
  CLI_COMMAND_MAP,
  CUSTOM_HANDLERS,
  NOTE_ID_RE,
  requireNoteId,
  requireAttachmentName,
  sniffImageContentType,
} = require('../out/extension.js');

const fail = (m) => { console.error(`FAIL: ${m}`); process.exit(1); };

console.log('--- Running Inbox Bridge Tests ---');

// 1. Verify all 11 message types exist in HANDLER_MAP
const expectedTypes = [
  'listInbox',
  'getInboxNote',
  'addInboxNote',
  'editInboxNote',
  'uploadInboxAttachment',
  'getInboxAttachment',
  'deleteInboxAttachment',
  'resolveInboxNote',
  'discardInboxNote',
  'reopenInboxNote',
  'inboxToTask',
];

for (const t of expectedTypes) {
  if (typeof HANDLER_MAP[t] !== 'function') {
    fail(`HANDLER_MAP missing function for ${t}`);
  }
}
console.log('PASS: All 11 inbox handlers present in HANDLER_MAP');

// 2. Note ID validation
const validIds = ['N001', 'N123', 'N9999'];
for (const id of validIds) {
  if (!NOTE_ID_RE.test(id)) fail(`NOTE_ID_RE should match ${id}`);
  if (requireNoteId({ id }) !== id) fail(`requireNoteId failed for ${id}`);
}
const invalidIds = ['', 'N', 'N1', 'N12', 'task-1', '01.1', 'N123a', '../N001'];
for (const id of invalidIds) {
  if (NOTE_ID_RE.test(id)) fail(`NOTE_ID_RE should not match ${id}`);
  try {
    requireNoteId({ id });
    fail(`requireNoteId should throw for ${id}`);
  } catch (e) {
    if (e.status !== 400) fail(`requireNoteId(${id}) expected status 400, got ${e.status}`);
  }
}
console.log('PASS: Note ID validation (^N\\d{3,}$)');

// 3. Attachment Name validation (traversal names rejected)
const validNames = ['01-image.png', 'screenshot_2026.jpg', 'my-photo.webp', 'attachment.gif', 'data.bin'];
for (const name of validNames) {
  if (requireAttachmentName({ name }) !== name) fail(`requireAttachmentName failed for ${name}`);
}
const traversalNames = [
  '',
  '../foo.png',
  '..\\foo.png',
  '/etc/passwd',
  'C:\\windows\\system32',
  'folder/sub.png',
  'folder\\sub.png',
  'foo..bar.png',
  'test\0.png',
];
for (const name of traversalNames) {
  try {
    requireAttachmentName({ name });
    fail(`requireAttachmentName should reject traversal name: ${JSON.stringify(name)}`);
  } catch (e) {
    if (e.status !== 400) fail(`requireAttachmentName(${name}) expected status 400, got ${e.status}`);
  }
}
console.log('PASS: Attachment name path traversal validation');

// 4. Sniff image content type magic bytes
const pngMagic = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
if (sniffImageContentType(pngMagic) !== 'image/png') fail('Failed to sniff image/png');

const jpegMagic = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
if (sniffImageContentType(jpegMagic) !== 'image/jpeg') fail('Failed to sniff image/jpeg');

const gif87Magic = Buffer.from('GIF87aXYZ');
if (sniffImageContentType(gif87Magic) !== 'image/gif') fail('Failed to sniff image/gif (87a)');

const gif89Magic = Buffer.from('GIF89aXYZ');
if (sniffImageContentType(gif89Magic) !== 'image/gif') fail('Failed to sniff image/gif (89a)');

const webpMagic = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(4)]);
if (sniffImageContentType(webpMagic) !== 'image/webp') fail('Failed to sniff image/webp');

const octetStream = Buffer.from('plain text file content');
if (sniffImageContentType(octetStream) !== 'application/octet-stream') fail('Failed to fallback to application/octet-stream');
console.log('PASS: Image magic byte sniffing');

// 5. CLI Arg Builders
const mockRoot = '/mock/workspace';
const tasksDir = path.join(mockRoot, 'tasks');

// listInbox
const listArgs1 = CLI_COMMAND_MAP.listInbox({}, mockRoot);
if (JSON.stringify(listArgs1) !== JSON.stringify(['inbox', 'list', '--tasks-dir', tasksDir])) {
  fail(`listInbox args mismatch: ${JSON.stringify(listArgs1)}`);
}
const listArgs2 = CLI_COMMAND_MAP.listInbox({ status: 'ready' }, mockRoot);
if (JSON.stringify(listArgs2) !== JSON.stringify(['inbox', 'list', '--tasks-dir', tasksDir, '--status', 'ready'])) {
  fail(`listInbox with status args mismatch: ${JSON.stringify(listArgs2)}`);
}

// getInboxNote
const getNoteArgs = CLI_COMMAND_MAP.getInboxNote({ id: 'N005' }, mockRoot);
if (JSON.stringify(getNoteArgs) !== JSON.stringify(['inbox', 'show', 'N005', '--tasks-dir', tasksDir])) {
  fail(`getInboxNote args mismatch: ${JSON.stringify(getNoteArgs)}`);
}

// addInboxNote
try {
  CLI_COMMAND_MAP.addInboxNote({}, mockRoot);
  fail('addInboxNote should throw without title');
} catch (e) {
  if (e.status !== 400) fail(`addInboxNote missing title status ${e.status}`);
}
const addArgs = CLI_COMMAND_MAP.addInboxNote({
  title: 'Fix bridge bug',
  kind: 'bug',
  about: 'tasks/09',
  author: 'dev',
  status: 'ready',
  body: 'Sample body text',
}, mockRoot);
if (JSON.stringify(addArgs) !== JSON.stringify([
  'inbox', 'add', '--title', 'Fix bridge bug', '--tasks-dir', tasksDir,
  '--kind', 'bug', '--about', 'tasks/09', '--author', 'dev', '--status', 'ready',
  '--body', 'Sample body text',
])) {
  fail(`addInboxNote args mismatch: ${JSON.stringify(addArgs)}`);
}

// editInboxNote
const editArgs = CLI_COMMAND_MAP.editInboxNote({
  id: 'N010',
  title: 'Updated title',
  kind: 'feature',
  about: 'tasks/10',
  author: 'lead',
  status: 'draft',
  expect_hash: 'hash123',
  body: 'Updated body',
}, mockRoot);
if (JSON.stringify(editArgs) !== JSON.stringify([
  'inbox', 'edit', 'N010', '--tasks-dir', tasksDir,
  '--title', 'Updated title', '--kind', 'feature', '--about', 'tasks/10', '--author', 'lead',
  '--status', 'draft', '--expect-hash', 'hash123', '--body', 'Updated body',
])) {
  fail(`editInboxNote args mismatch: ${JSON.stringify(editArgs)}`);
}

// deleteInboxAttachment
const detachArgs = CLI_COMMAND_MAP.deleteInboxAttachment({ id: 'N001', name: '01-img.png' }, mockRoot);
if (JSON.stringify(detachArgs) !== JSON.stringify(['inbox', 'detach', 'N001', '--name', '01-img.png', '--tasks-dir', tasksDir])) {
  fail(`deleteInboxAttachment args mismatch: ${JSON.stringify(detachArgs)}`);
}

// resolveInboxNote
try {
  CLI_COMMAND_MAP.resolveInboxNote({ id: 'N001' }, mockRoot);
  fail('resolveInboxNote should require produced');
} catch (e) {
  if (e.status !== 400) fail(`resolveInboxNote missing produced status ${e.status}`);
}
const resolveArgs = CLI_COMMAND_MAP.resolveInboxNote({ id: 'N001', produced: 'T042', by: 'architect' }, mockRoot);
if (JSON.stringify(resolveArgs) !== JSON.stringify(['inbox', 'resolve', 'N001', '--produced', 'T042', '--tasks-dir', tasksDir, '--by', 'architect'])) {
  fail(`resolveInboxNote args mismatch: ${JSON.stringify(resolveArgs)}`);
}

// discardInboxNote
try {
  CLI_COMMAND_MAP.discardInboxNote({ id: 'N001' }, mockRoot);
  fail('discardInboxNote should require reason');
} catch (e) {
  if (e.status !== 400) fail(`discardInboxNote missing reason status ${e.status}`);
}
const discardArgs = CLI_COMMAND_MAP.discardInboxNote({ id: 'N001', reason: 'duplicate note' }, mockRoot);
if (JSON.stringify(discardArgs) !== JSON.stringify(['inbox', 'discard', 'N001', '--reason', 'duplicate note', '--tasks-dir', tasksDir])) {
  fail(`discardInboxNote args mismatch: ${JSON.stringify(discardArgs)}`);
}

// reopenInboxNote
const reopenArgs = CLI_COMMAND_MAP.reopenInboxNote({ id: 'N001' }, mockRoot);
if (JSON.stringify(reopenArgs) !== JSON.stringify(['inbox', 'reopen', 'N001', '--tasks-dir', tasksDir])) {
  fail(`reopenInboxNote args mismatch: ${JSON.stringify(reopenArgs)}`);
}

// inboxToTask
try {
  CLI_COMMAND_MAP.inboxToTask({ id: 'N001', title: 'Task Title' }, mockRoot);
  fail('inboxToTask should require category');
} catch (e) {
  if (e.status !== 400) fail(`inboxToTask missing category status ${e.status}`);
}
try {
  CLI_COMMAND_MAP.inboxToTask({ id: 'N001', category: 'features' }, mockRoot);
  fail('inboxToTask should require title');
} catch (e) {
  if (e.status !== 400) fail(`inboxToTask missing title status ${e.status}`);
}
const toTaskArgs = CLI_COMMAND_MAP.inboxToTask({
  id: 'N001',
  category: 'core',
  title: 'Core Enhancement',
  priority: 'P1',
  priority_reason: 'critical path',
  executor: 'kilo',
  next_up: 'yes',
  depends_on: 'T003',
  decider: 'human',
}, mockRoot);
if (JSON.stringify(toTaskArgs) !== JSON.stringify([
  'tasks', 'new', '--from-note', 'N001', '--category', 'core', '--title', 'Core Enhancement',
  '--tasks-dir', tasksDir, '--priority', 'P1', '--priority-reason', 'critical path',
  '--executor', 'kilo', '--next-up', 'yes', '--depends-on', 'T003', '--decider', 'human',
])) {
  fail(`inboxToTask args mismatch: ${JSON.stringify(toTaskArgs)}`);
}
console.log('PASS: All 9 CLI command builders verified');

// 6. Test uploadInboxAttachment Custom Handler
const tmpTestDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-orch-inbox-test-'));
try {
  const postedMessages = [];
  let updatedCalled = false;
  let cliExecutedArgs = null;
  let tempFileObserved = null;

  const mockPanel = {
    cliClient: {
      runJsonCommand: async (cmd) => {
        cliExecutedArgs = cmd;
        // Verify temp file exists during CLI call
        const fileIdx = cmd.indexOf('--file');
        if (fileIdx >= 0) {
          tempFileObserved = cmd[fileIdx + 1];
          if (!fs.existsSync(tempFileObserved)) {
            throw new Error(`Temp file does not exist during command: ${tempFileObserved}`);
          }
        }
        return { ok: true, attachment: '01-test.png' };
      },
    },
    postMessage: (m) => { postedMessages.push(m); return Promise.resolve(true); },
    onTasksUpdated: () => { updatedCalled = true; },
  };

  // Reject missing data
  try {
    await CUSTOM_HANDLERS.uploadInboxAttachment(mockPanel, { id: 'N001' }, tmpTestDir);
    fail('uploadInboxAttachment should throw when data is missing');
  } catch (e) {
    if (e.status !== 400) fail(`uploadInboxAttachment missing data status ${e.status}`);
  }

  // Reject payload over 10 MB decoded
  const hugeBuf = Buffer.alloc(10 * 1024 * 1024 + 1);
  try {
    await CUSTOM_HANDLERS.uploadInboxAttachment(mockPanel, {
      id: 'N001',
      data: hugeBuf.toString('base64'),
    }, tmpTestDir);
    fail('uploadInboxAttachment should reject >10MB decoded payload');
  } catch (e) {
    if (e.status !== 413) fail(`uploadInboxAttachment oversized payload expected 413, got ${e.status}`);
  }

  // Successful upload
  const testPng = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const resUpload = await CUSTOM_HANDLERS.uploadInboxAttachment(mockPanel, {
    id: 'N001',
    filename: 'my photo 2026.png',
    data: testPng.toString('base64'),
  }, tmpTestDir);

  if (!resUpload.ok || resUpload.attachment !== '01-test.png') {
    fail(`upload result unexpected: ${JSON.stringify(resUpload)}`);
  }
  if (!tempFileObserved) fail('Temp file was never passed to CLI');
  if (fs.existsSync(tempFileObserved)) fail('Temp file was not cleaned up');
  if (!cliExecutedArgs.includes('--name') || !cliExecutedArgs.includes('my-photo-2026')) {
    fail(`Sanitized filename stem not passed: ${JSON.stringify(cliExecutedArgs)}`);
  }
  const changedMsg = postedMessages.find((m) => m.type === 'changed');
  if (!changedMsg || !changedMsg.areas.includes('inbox') || !changedMsg.areas.includes('tasks')) {
    fail(`Expected changed message for inbox and tasks, got ${JSON.stringify(postedMessages)}`);
  }
  if (!updatedCalled) fail('onTasksUpdated was not called');
  console.log('PASS: uploadInboxAttachment handler, size check, temp cleanup, and change broadcast');

  // 7. Test getInboxAttachment Custom Handler
  const noteFolder = path.join(tmpTestDir, 'note_N001');
  const attDir = path.join(noteFolder, 'attachments');
  fs.mkdirSync(attDir, { recursive: true });

  const samplePngPath = path.join(attDir, '01-photo.png');
  fs.writeFileSync(samplePngPath, testPng);

  const outsideFile = path.join(tmpTestDir, 'outside.txt');
  fs.writeFileSync(outsideFile, 'secret outside');
  const symlinkPath = path.join(attDir, 'symlink.png');
  try {
    fs.symlinkSync(outsideFile, symlinkPath);
  } catch {}

  const mockPanelGet = {
    cliClient: {
      runJsonCommand: async (cmd) => {
        if (cmd[0] === 'inbox' && cmd[1] === 'show') {
          if (cmd[2] === 'N001') {
            return {
              ok: true,
              note: {
                id: 'N001',
                folder_path: noteFolder,
              },
            };
          }
          const err = new Error('Note not found');
          err.status = 404;
          throw err;
        }
        throw new Error(`Unexpected CLI command: ${cmd.join(' ')}`);
      },
    },
  };

  // Traversal name rejection before CLI call
  try {
    await CUSTOM_HANDLERS.getInboxAttachment(mockPanelGet, { id: 'N001', name: '../secret.txt' }, tmpTestDir);
    fail('getInboxAttachment should reject traversal name');
  } catch (e) {
    if (e.status !== 400) fail(`getInboxAttachment traversal name expected 400, got ${e.status}`);
  }

  // Note not found
  try {
    await CUSTOM_HANDLERS.getInboxAttachment(mockPanelGet, { id: 'N999', name: '01-photo.png' }, tmpTestDir);
    fail('getInboxAttachment should fail 404 for missing note');
  } catch (e) {
    if (e.status !== 404) fail(`getInboxAttachment missing note expected 404, got ${e.status}`);
  }

  // Attachment file not found
  try {
    await CUSTOM_HANDLERS.getInboxAttachment(mockPanelGet, { id: 'N001', name: '02-missing.png' }, tmpTestDir);
    fail('getInboxAttachment should fail 404 for missing attachment file');
  } catch (e) {
    if (e.status !== 404) fail(`getInboxAttachment missing file expected 404, got ${e.status}`);
  }

  // Symlink escaping attachments dir rejected via realpath check
  if (fs.existsSync(symlinkPath)) {
    try {
      await CUSTOM_HANDLERS.getInboxAttachment(mockPanelGet, { id: 'N001', name: 'symlink.png' }, tmpTestDir);
      fail('getInboxAttachment should reject symlink escaping attachments dir');
    } catch (e) {
      if (e.status !== 400) fail(`getInboxAttachment symlink traversal expected 400, got ${e.status}`);
    }
  }

  // Valid attachment retrieval
  const getRes = await CUSTOM_HANDLERS.getInboxAttachment(mockPanelGet, { id: 'N001', name: '01-photo.png' }, tmpTestDir);
  if (getRes.content_type !== 'image/png' || getRes.contentType !== 'image/png') {
    fail(`getInboxAttachment unexpected content type: ${JSON.stringify(getRes)}`);
  }
  if (getRes.data !== testPng.toString('base64')) {
    fail('getInboxAttachment data mismatch');
  }
  console.log('PASS: getInboxAttachment handler, 404s, realpath traversal check, and base64 retrieval');

  // 8. Test Write Notifications for HANDLER_MAP CLI writes
  const writeTypes = [
    'addInboxNote',
    'editInboxNote',
    'deleteInboxAttachment',
    'resolveInboxNote',
    'discardInboxNote',
    'reopenInboxNote',
    'inboxToTask',
  ];

  for (const wt of writeTypes) {
    const messages = [];
    let updated = false;
    const testPanel = {
      cliClient: {
        runJsonCommand: async () => ({ ok: true }),
      },
      postMessage: (m) => { messages.push(m); return Promise.resolve(true); },
      onTasksUpdated: () => { updated = true; },
    };

    let samplePayload = { id: 'N001' };
    if (wt === 'addInboxNote') samplePayload = { title: 'T' };
    if (wt === 'deleteInboxAttachment') samplePayload = { id: 'N001', name: '01.png' };
    if (wt === 'resolveInboxNote') samplePayload = { id: 'N001', produced: 'T001' };
    if (wt === 'discardInboxNote') samplePayload = { id: 'N001', reason: 'R' };
    if (wt === 'inboxToTask') samplePayload = { id: 'N001', category: 'C', title: 'T' };

    await HANDLER_MAP[wt](testPanel, samplePayload, tmpTestDir);

    const ch = messages.find((m) => m.type === 'changed');
    if (!ch || !ch.areas.includes('inbox') || !ch.areas.includes('tasks')) {
      fail(`Write handler ${wt} did not post changed areas: ['inbox', 'tasks']`);
    }
    if (!updated) fail(`Write handler ${wt} did not call onTasksUpdated`);
  }
  console.log('PASS: All 7 CLI write handlers post changed notification and refresh tasks');

} finally {
  fs.rmSync(tmpTestDir, { recursive: true, force: true });
}

console.log('All inbox bridge tests passed successfully!');
