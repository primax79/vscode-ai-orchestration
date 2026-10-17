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
  RUN_ID_RE,
  requireRunId,
  TASK_ATTACHMENT_ID_RE,
  requireTaskAttachmentId,
  runTargetArgs,
  classifyAttachmentContentType,
} = require('../out/extension.js');

const fail = (m) => { console.error(`FAIL: ${m}`); process.exit(1); };

console.log('--- Running Task Attachments and Triage Tests ---');

// 1. Verify all 5 handlers exist in HANDLER_MAP
const expectedTypes = [
  'uploadTaskAttachment',
  'getTaskAttachment',
  'deleteTaskAttachment',
  'getTriageProposal',
  'acceptTriage',
];

for (const t of expectedTypes) {
  if (typeof HANDLER_MAP[t] !== 'function') {
    fail(`HANDLER_MAP missing function for ${t}`);
  }
}
console.log('PASS: All 5 task attachment & triage handlers present in HANDLER_MAP');

// 2. Task Attachment ID validation (plan tasks refused, valid ^T\d{3,}$)
const validTaskIds = ['T001', 'T042', 'T123', 'T9999'];
for (const id of validTaskIds) {
  if (!TASK_ATTACHMENT_ID_RE.test(id)) fail(`TASK_ATTACHMENT_ID_RE should match ${id}`);
  if (requireTaskAttachmentId({ id }) !== id) fail(`requireTaskAttachmentId failed for ${id}`);
}

const planTaskIds = ['09.11', '01.1', '1.1', 'INIT-01', 'plan-task', 'task.plan'];
for (const id of planTaskIds) {
  if (TASK_ATTACHMENT_ID_RE.test(id)) fail(`TASK_ATTACHMENT_ID_RE should not match ${id}`);
  try {
    requireTaskAttachmentId({ id });
    fail(`requireTaskAttachmentId should throw for plan task: ${id}`);
  } catch (e) {
    if (e.status !== 400) fail(`requireTaskAttachmentId(${id}) expected status 400, got ${e.status}`);
    if (!e.message.toLowerCase().includes('plan tasks take no attachments')) {
      fail(`Expected 'plan tasks take no attachments' error message for ${id}, got: ${e.message}`);
    }
  }
}

const invalidTaskIds = ['', 'T', 'T1', 'T12', 'N001', 'abc', '../T001'];
for (const id of invalidTaskIds) {
  if (TASK_ATTACHMENT_ID_RE.test(id)) fail(`TASK_ATTACHMENT_ID_RE should not match ${id}`);
  try {
    requireTaskAttachmentId({ id });
    fail(`requireTaskAttachmentId should throw for invalid id: ${id}`);
  } catch (e) {
    if (e.status !== 400) fail(`requireTaskAttachmentId(${id}) expected status 400, got ${e.status}`);
    if (!e.message.includes('must match ^T\\d{3,}$')) {
      fail(`Expected regex mismatch error message for ${id}, got: ${e.message}`);
    }
  }
}
console.log('PASS: Task Attachment ID validation (plan tasks refused with clear error)');

// 3. Attachment Name validation (traversal names rejected)
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

// 4. Content Type Classification
const pngMagic = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
if (classifyAttachmentContentType(pngMagic) !== 'image/png') fail('Failed to classify image/png');

const jpegMagic = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]);
if (classifyAttachmentContentType(jpegMagic) !== 'image/jpeg') fail('Failed to classify image/jpeg');

const gifMagic = Buffer.from('GIF89aXYZ');
if (classifyAttachmentContentType(gifMagic) !== 'image/gif') fail('Failed to classify image/gif');

const webpMagic = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(4)]);
if (classifyAttachmentContentType(webpMagic) !== 'image/webp') fail('Failed to classify image/webp');

const pdfMagic = Buffer.from('%PDF-1.4 header content here');
if (classifyAttachmentContentType(pdfMagic) !== 'application/pdf') fail('Failed to classify application/pdf');

const textContent = Buffer.from('This is a plain UTF-8 text file without NUL bytes');
if (classifyAttachmentContentType(textContent) !== 'text/plain; charset=utf-8') fail('Failed to classify text/plain; charset=utf-8');

const binaryUnsupported = Buffer.from([0x00, 0x01, 0x02, 0xff]);
if (classifyAttachmentContentType(binaryUnsupported) !== null) fail('Expected binary content with NUL to return null');
console.log('PASS: Content classification (image magic bytes, PDF, UTF-8 text, unsupported)');

// 5. Run Target Options validation & CLI builders
const mockRoot = '/mock/workspace';
const tasksDir = path.join(mockRoot, 'tasks');

// runTargetArgs
const taskTarget = runTargetArgs({ task: '09.11' });
if (JSON.stringify(taskTarget) !== JSON.stringify(['--task', '09.11'])) {
  fail(`taskTarget mismatch: ${JSON.stringify(taskTarget)}`);
}
const noteTarget = runTargetArgs({ note: 'N001' });
if (JSON.stringify(noteTarget) !== JSON.stringify(['--note', 'N001'])) {
  fail(`noteTarget mismatch: ${JSON.stringify(noteTarget)}`);
}
// note takes precedence over task
const bothTarget = runTargetArgs({ note: 'N001', task: 'T001' });
if (JSON.stringify(bothTarget) !== JSON.stringify(['--note', 'N001'])) {
  fail(`bothTarget mismatch: ${JSON.stringify(bothTarget)}`);
}
try {
  runTargetArgs({});
  fail('runTargetArgs should throw when neither task nor note provided');
} catch (e) {
  if (e.status !== 400) fail(`runTargetArgs expected 400, got ${e.status}`);
}
try {
  runTargetArgs({ note: 'invalid-note' });
  fail('runTargetArgs should throw for invalid note ID');
} catch (e) {
  if (e.status !== 400) fail(`runTargetArgs invalid note expected 400, got ${e.status}`);
}

// getRunOptions
const optArgsTask = CLI_COMMAND_MAP.getRunOptions({ task: 'T001' }, mockRoot);
if (JSON.stringify(optArgsTask) !== JSON.stringify(['run', 'options', '--task', 'T001', '--workspace', mockRoot])) {
  fail(`getRunOptions with task mismatch: ${JSON.stringify(optArgsTask)}`);
}
const optArgsNote = CLI_COMMAND_MAP.getRunOptions({ note: 'N002' }, mockRoot);
if (JSON.stringify(optArgsNote) !== JSON.stringify(['run', 'options', '--note', 'N002', '--workspace', mockRoot])) {
  fail(`getRunOptions with note mismatch: ${JSON.stringify(optArgsNote)}`);
}

// previewRun
const prevArgsTask = CLI_COMMAND_MAP.previewRun({ task: '09.11', mode: 'triage' }, mockRoot);
if (JSON.stringify(prevArgsTask) !== JSON.stringify(['run', 'preview', '--task', '09.11', '--workspace', mockRoot, '--mode', 'triage'])) {
  fail(`previewRun with task mismatch: ${JSON.stringify(prevArgsTask)}`);
}
const prevArgsNote = CLI_COMMAND_MAP.previewRun({ note: 'N005', isolation: 'worktree' }, mockRoot);
if (JSON.stringify(prevArgsNote) !== JSON.stringify(['run', 'preview', '--note', 'N005', '--workspace', mockRoot, '--isolation', 'worktree'])) {
  fail(`previewRun with note mismatch: ${JSON.stringify(prevArgsNote)}`);
}

// startRun
try {
  CLI_COMMAND_MAP.startRun({ task: 'T001' }, mockRoot);
  fail('startRun should require expect_plan_hash');
} catch (e) {
  if (e.status !== 400 && !e.message.includes('expect_plan_hash')) fail(`startRun error mismatch: ${e}`);
}
const startArgsNote = CLI_COMMAND_MAP.startRun({ note: 'N010', expect_plan_hash: 'phash99', model: 'gpt-5' }, mockRoot);
if (JSON.stringify(startArgsNote) !== JSON.stringify([
  'run', 'start', '--note', 'N010', '--expect-plan-hash', 'phash99',
  '--requested-by', 'vscode', '--workspace', mockRoot, '--model', 'gpt-5',
])) {
  fail(`startRun with note mismatch: ${JSON.stringify(startArgsNote)}`);
}
console.log('PASS: getRunOptions, previewRun, startRun note target argument builders');

// 6. deleteTaskAttachment CLI Arg Builder
const delTaskArgs1 = CLI_COMMAND_MAP.deleteTaskAttachment({ id: 'T001', name: 'diagram.png' }, mockRoot);
if (JSON.stringify(delTaskArgs1) !== JSON.stringify(['tasks', 'detach', 'T001', '--name', 'diagram.png', '--tasks-dir', tasksDir])) {
  fail(`deleteTaskAttachment args mismatch: ${JSON.stringify(delTaskArgs1)}`);
}
const delTaskArgs2 = CLI_COMMAND_MAP.deleteTaskAttachment({ id: 'T001', name: 'diagram.png', expect_task_hash: 'hash-abc' }, mockRoot);
if (JSON.stringify(delTaskArgs2) !== JSON.stringify(['tasks', 'detach', 'T001', '--name', 'diagram.png', '--tasks-dir', tasksDir, '--expect-task-hash', 'hash-abc'])) {
  fail(`deleteTaskAttachment with hash mismatch: ${JSON.stringify(delTaskArgs2)}`);
}
try {
  CLI_COMMAND_MAP.deleteTaskAttachment({ id: '09.11', name: 'diagram.png' }, mockRoot);
  fail('deleteTaskAttachment should refuse plan task');
} catch (e) {
  if (e.status !== 400) fail(`deleteTaskAttachment plan task expected 400, got ${e.status}`);
}
try {
  CLI_COMMAND_MAP.deleteTaskAttachment({ id: 'T001', name: '../evil.png' }, mockRoot);
  fail('deleteTaskAttachment should refuse traversal name');
} catch (e) {
  if (e.status !== 400) fail(`deleteTaskAttachment traversal name expected 400, got ${e.status}`);
}
console.log('PASS: deleteTaskAttachment CLI arg builder and validations');

// 7. acceptTriage CLI Arg Builder
const validRunId = '20261018-120000-main-kilo-abcd';
const acceptArgs1 = CLI_COMMAND_MAP.acceptTriage({ runId: validRunId }, mockRoot);
if (JSON.stringify(acceptArgs1) !== JSON.stringify(['run', 'accept-triage', validRunId, '--workspace', mockRoot])) {
  fail(`acceptTriage args mismatch: ${JSON.stringify(acceptArgs1)}`);
}
const acceptArgs2 = CLI_COMMAND_MAP.acceptTriage({ runId: validRunId, only: [0, 2], expect_note_hash: 'nhash123' }, mockRoot);
if (JSON.stringify(acceptArgs2) !== JSON.stringify([
  'run', 'accept-triage', validRunId, '--workspace', mockRoot,
  '--only', '0,2', '--expect-note-hash', 'nhash123',
])) {
  fail(`acceptTriage with options mismatch: ${JSON.stringify(acceptArgs2)}`);
}
try {
  CLI_COMMAND_MAP.acceptTriage({ runId: 'bad-run-id' }, mockRoot);
  fail('acceptTriage should refuse invalid run ID');
} catch (e) {
  if (e.status !== 400) fail(`acceptTriage bad run id expected 400, got ${e.status}`);
}
console.log('PASS: acceptTriage CLI arg builder and validations');

// 8. Custom Handlers: uploadTaskAttachment and getTaskAttachment
const tmpTestDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-orch-task-att-test-'));
try {
  const postedMessages = [];
  let updatedCalled = false;
  let cliExecutedArgs = null;
  let tempFileObserved = null;

  const mockPanel = {
    cliClient: {
      runJsonCommand: async (cmd) => {
        cliExecutedArgs = cmd;
        const fileIdx = cmd.indexOf('--file');
        if (fileIdx >= 0) {
          tempFileObserved = cmd[fileIdx + 1];
          if (!fs.existsSync(tempFileObserved)) {
            throw new Error(`Temp file does not exist during command: ${tempFileObserved}`);
          }
        }
        return { ok: true, attachment: '01-diagram.png' };
      },
    },
    postMessage: (m) => { postedMessages.push(m); return Promise.resolve(true); },
    onTasksUpdated: () => { updatedCalled = true; },
  };

  // Reject missing data
  try {
    await CUSTOM_HANDLERS.uploadTaskAttachment(mockPanel, { id: 'T001' }, tmpTestDir);
    fail('uploadTaskAttachment should throw when data is missing');
  } catch (e) {
    if (e.status !== 400) fail(`uploadTaskAttachment missing data status ${e.status}`);
  }

  // Reject plan task
  try {
    await CUSTOM_HANDLERS.uploadTaskAttachment(mockPanel, { id: '09.11', data: 'aGVsbG8=' }, tmpTestDir);
    fail('uploadTaskAttachment should reject plan task');
  } catch (e) {
    if (e.status !== 400) fail(`uploadTaskAttachment plan task expected 400, got ${e.status}`);
  }

  // Reject payload over 10 MB decoded
  const hugeBuf = Buffer.alloc(10 * 1024 * 1024 + 1);
  try {
    await CUSTOM_HANDLERS.uploadTaskAttachment(mockPanel, {
      id: 'T001',
      data: hugeBuf.toString('base64'),
    }, tmpTestDir);
    fail('uploadTaskAttachment should reject >10MB decoded payload');
  } catch (e) {
    if (e.status !== 413) fail(`uploadTaskAttachment oversized payload expected 413, got ${e.status}`);
  }

  // Successful upload
  const testPng = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const resUpload = await CUSTOM_HANDLERS.uploadTaskAttachment(mockPanel, {
    id: 'T001',
    filename: 'architecture diagram 2026.png',
    data: testPng.toString('base64'),
    expect_task_hash: 'thash999',
  }, tmpTestDir);

  if (!resUpload.ok || resUpload.attachment !== '01-diagram.png') {
    fail(`uploadTaskAttachment result unexpected: ${JSON.stringify(resUpload)}`);
  }
  if (!tempFileObserved) fail('Temp file was never passed to CLI');
  if (fs.existsSync(tempFileObserved)) fail('Temp file was not cleaned up');
  if (!cliExecutedArgs.includes('--name') || !cliExecutedArgs.includes('architecture-diagram-2026')) {
    fail(`Sanitized filename stem not passed: ${JSON.stringify(cliExecutedArgs)}`);
  }
  if (!cliExecutedArgs.includes('--expect-task-hash') || !cliExecutedArgs.includes('thash999')) {
    fail(`expect-task-hash not passed: ${JSON.stringify(cliExecutedArgs)}`);
  }
  const changedMsg = postedMessages.find((m) => m.type === 'changed');
  if (!changedMsg || !changedMsg.areas || changedMsg.areas.length !== 1 || changedMsg.areas[0] !== 'tasks') {
    fail(`Expected changed message for tasks only, got ${JSON.stringify(postedMessages)}`);
  }
  if (!updatedCalled) fail('onTasksUpdated was not called');
  console.log('PASS: uploadTaskAttachment handler, size check, temp cleanup, and change broadcast');

  // 9. Test getTaskAttachment Custom Handler
  const taskFolder = path.join(tmpTestDir, 'tasks', 'core', 'T001-sample');
  const attDir = path.join(taskFolder, 'attachments');
  fs.mkdirSync(attDir, { recursive: true });

  const samplePngPath = path.join(attDir, '01-diag.png');
  fs.writeFileSync(samplePngPath, testPng);

  const samplePdfPath = path.join(attDir, 'spec.pdf');
  fs.writeFileSync(samplePdfPath, Buffer.from('%PDF-1.4 sample document'));

  const sampleTxtPath = path.join(attDir, 'notes.txt');
  fs.writeFileSync(sampleTxtPath, Buffer.from('plain text utf8 content'));

  const outsideFile = path.join(tmpTestDir, 'outside.txt');
  fs.writeFileSync(outsideFile, 'secret outside');
  const symlinkPath = path.join(attDir, 'symlink.png');
  try {
    fs.symlinkSync(outsideFile, symlinkPath);
  } catch {}

  const mockPanelGet = {
    cliClient: {
      runJsonCommand: async (cmd) => {
        if (cmd[0] === 'tasks' && cmd[1] === 'list') {
          return {
            ok: true,
            emergent_tasks: [
              {
                id: 'T001',
                is_folder: true,
                task_root: taskFolder,
              },
              {
                id: 'T002',
                is_folder: false,
                file_path: path.join(tmpTestDir, 'tasks', 'core', 'T002-single.md'),
              },
            ],
          };
        }
        throw new Error(`Unexpected CLI command: ${cmd.join(' ')}`);
      },
    },
  };

  // Traversal name rejection
  try {
    await CUSTOM_HANDLERS.getTaskAttachment(mockPanelGet, { id: 'T001', name: '../secret.txt' }, tmpTestDir);
    fail('getTaskAttachment should reject traversal name');
  } catch (e) {
    if (e.status !== 400) fail(`getTaskAttachment traversal name expected 400, got ${e.status}`);
  }

  // Plan task rejection
  try {
    await CUSTOM_HANDLERS.getTaskAttachment(mockPanelGet, { id: '09.11', name: '01-diag.png' }, tmpTestDir);
    fail('getTaskAttachment should reject plan task');
  } catch (e) {
    if (e.status !== 400) fail(`getTaskAttachment plan task expected 400, got ${e.status}`);
  }

  // Task not found
  try {
    await CUSTOM_HANDLERS.getTaskAttachment(mockPanelGet, { id: 'T999', name: '01-diag.png' }, tmpTestDir);
    fail('getTaskAttachment should fail 404 for missing task');
  } catch (e) {
    if (e.status !== 404) fail(`getTaskAttachment missing task expected 404, got ${e.status}`);
  }

  // Task without attachments (non-folder task)
  try {
    await CUSTOM_HANDLERS.getTaskAttachment(mockPanelGet, { id: 'T002', name: '01-diag.png' }, tmpTestDir);
    fail('getTaskAttachment should fail 404 for non-folder task');
  } catch (e) {
    if (e.status !== 404) fail(`getTaskAttachment non-folder task expected 404, got ${e.status}`);
  }

  // Missing attachment file
  try {
    await CUSTOM_HANDLERS.getTaskAttachment(mockPanelGet, { id: 'T001', name: '02-missing.png' }, tmpTestDir);
    fail('getTaskAttachment should fail 404 for missing attachment file');
  } catch (e) {
    if (e.status !== 404) fail(`getTaskAttachment missing file expected 404, got ${e.status}`);
  }

  // Symlink escaping attachments dir rejected via realpath
  if (fs.existsSync(symlinkPath)) {
    try {
      await CUSTOM_HANDLERS.getTaskAttachment(mockPanelGet, { id: 'T001', name: 'symlink.png' }, tmpTestDir);
      fail('getTaskAttachment should reject symlink escaping attachments dir');
    } catch (e) {
      if (e.status !== 400) fail(`getTaskAttachment symlink traversal expected 400, got ${e.status}`);
    }
  }

  // Valid PNG retrieval
  const getPngRes = await CUSTOM_HANDLERS.getTaskAttachment(mockPanelGet, { id: 'T001', name: '01-diag.png' }, tmpTestDir);
  if (getPngRes.content_type !== 'image/png' || getPngRes.contentType !== 'image/png') {
    fail(`getTaskAttachment unexpected content type for PNG: ${JSON.stringify(getPngRes)}`);
  }
  if (getPngRes.data !== testPng.toString('base64')) {
    fail('getTaskAttachment PNG data mismatch');
  }

  // Valid PDF retrieval
  const getPdfRes = await CUSTOM_HANDLERS.getTaskAttachment(mockPanelGet, { id: 'T001', name: 'spec.pdf' }, tmpTestDir);
  if (getPdfRes.content_type !== 'application/pdf') {
    fail(`getTaskAttachment unexpected content type for PDF: ${JSON.stringify(getPdfRes)}`);
  }

  // Valid UTF-8 text retrieval
  const getTxtRes = await CUSTOM_HANDLERS.getTaskAttachment(mockPanelGet, { id: 'T001', name: 'notes.txt' }, tmpTestDir);
  if (getTxtRes.content_type !== 'text/plain; charset=utf-8') {
    fail(`getTaskAttachment unexpected content type for text: ${JSON.stringify(getTxtRes)}`);
  }
  console.log('PASS: getTaskAttachment handler, 404s, realpath containment, and mime-typed base64 responses');

  // 10. Test getTriageProposal Custom Handler
  const mockPanelTriage = {
    cliClient: {
      runJsonCommand: async (cmd) => {
        if (cmd[0] === 'run' && cmd[1] === 'show') {
          const runIdArg = cmd[2];
          if (runIdArg === '20261018-120000-main-kilo-0001') {
            return {
              ok: true,
              run: {
                id: runIdArg,
                mode: 'triage',
                proposal_status: 'pending',
                triage_proposal: { tasks: [{ title: 'New Task' }] },
              },
            };
          }
          if (runIdArg === '20261018-120000-main-kilo-0002') {
            // Not triage run
            return {
              ok: true,
              run: {
                id: runIdArg,
                mode: 'execution',
              },
            };
          }
          if (runIdArg === '20261018-120000-main-kilo-0003') {
            // Triage run with proposal in disk file
            return {
              ok: true,
              run: {
                id: runIdArg,
                mode: 'triage',
              },
            };
          }
          const err = new Error('Run not found');
          err.status = 404;
          throw err;
        }
        throw new Error(`Unexpected CLI command: ${cmd.join(' ')}`);
      },
    },
  };

  // Run with proposal in CLI response
  const triage1 = await CUSTOM_HANDLERS.getTriageProposal(mockPanelTriage, { runId: '20261018-120000-main-kilo-0001' }, tmpTestDir);
  if (!triage1.ok || triage1.proposal_status !== 'pending' || !triage1.proposal || triage1.proposal.tasks.length !== 1) {
    fail(`getTriageProposal unexpected result for 0001: ${JSON.stringify(triage1)}`);
  }

  // Non-triage run throws 400
  try {
    await CUSTOM_HANDLERS.getTriageProposal(mockPanelTriage, { runId: '20261018-120000-main-kilo-0002' }, tmpTestDir);
    fail('getTriageProposal should throw for non-triage run');
  } catch (e) {
    if (e.status !== 400 || !e.message.includes('not a triage run')) {
      fail(`getTriageProposal non-triage expected 400, got ${e.status}: ${e.message}`);
    }
  }

  // Triage run with proposal file on disk
  const run3Dir = path.join(tmpTestDir, '.ai-orchestration', 'runs', '20261018-120000-main-kilo-0003');
  fs.mkdirSync(run3Dir, { recursive: true });
  fs.writeFileSync(path.join(run3Dir, 'triage-proposal.json'), JSON.stringify({ tasks: [{ title: 'Disk Task' }] }));

  const triage3 = await CUSTOM_HANDLERS.getTriageProposal(mockPanelTriage, { runId: '20261018-120000-main-kilo-0003' }, tmpTestDir);
  if (!triage3.ok || triage3.proposal_status !== 'pending' || !triage3.proposal || triage3.proposal.tasks[0].title !== 'Disk Task') {
    fail(`getTriageProposal unexpected result for 0003 from disk: ${JSON.stringify(triage3)}`);
  }

  // Run not found
  try {
    await CUSTOM_HANDLERS.getTriageProposal(mockPanelTriage, { runId: '20261018-120000-main-kilo-9999' }, tmpTestDir);
    fail('getTriageProposal should fail 404 for missing run');
  } catch (e) {
    if (e.status !== 404) fail(`getTriageProposal missing run expected 404, got ${e.status}`);
  }
  console.log('PASS: getTriageProposal handler (proposal in run show, proposal file fallback, non-triage error, 404)');

  // 11. Test deleteTaskAttachment and acceptTriage write notifications in HANDLER_MAP
  const delTestMessages = [];
  let delUpdated = false;
  const delPanel = {
    cliClient: {
      runJsonCommand: async () => ({ ok: true }),
    },
    postMessage: (m) => { delTestMessages.push(m); return Promise.resolve(true); },
    onTasksUpdated: () => { delUpdated = true; },
  };

  await HANDLER_MAP.deleteTaskAttachment(delPanel, { id: 'T001', name: '01-diag.png' }, tmpTestDir);
  const delChanged = delTestMessages.find((m) => m.type === 'changed');
  if (!delChanged || !delChanged.areas || delChanged.areas.length !== 1 || delChanged.areas[0] !== 'tasks') {
    fail(`deleteTaskAttachment did not post changed areas: ['tasks'], got: ${JSON.stringify(delTestMessages)}`);
  }
  if (!delUpdated) fail('deleteTaskAttachment did not call onTasksUpdated');

  const acceptTestMessages = [];
  let acceptUpdated = false;
  const acceptPanel = {
    cliClient: {
      runJsonCommand: async () => ({ ok: true }),
    },
    postMessage: (m) => { acceptTestMessages.push(m); return Promise.resolve(true); },
    onTasksUpdated: () => { acceptUpdated = true; },
  };

  await HANDLER_MAP.acceptTriage(acceptPanel, { runId: validRunId }, tmpTestDir);
  const acceptChanged = acceptTestMessages.find((m) => m.type === 'changed');
  if (!acceptChanged || !acceptChanged.areas.includes('inbox') || !acceptChanged.areas.includes('tasks')) {
    fail(`acceptTriage did not post changed areas: ['inbox', 'tasks'], got: ${JSON.stringify(acceptTestMessages)}`);
  }
  if (!acceptUpdated) fail('acceptTriage did not call onTasksUpdated');
  console.log('PASS: deleteTaskAttachment and acceptTriage postMessage changed broadcasts');

} finally {
  fs.rmSync(tmpTestDir, { recursive: true, force: true });
}

console.log('All task attachments and triage tests passed successfully!');
