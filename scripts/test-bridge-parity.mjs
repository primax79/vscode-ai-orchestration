import * as fs from 'fs';
import * as path from 'path';

function findApiTs() {
  // 1. Direct sibling: ../ai-orchestration-ui/frontend/src/api.ts
  const direct = path.resolve(process.cwd(), '../ai-orchestration-ui/frontend/src/api.ts');
  if (fs.existsSync(direct)) {
    return direct;
  }

  // 2. Search upward in case running inside a worktree
  let current = process.cwd();
  while (true) {
    const candidate = path.resolve(current, '../ai-orchestration-ui/frontend/src/api.ts');
    if (fs.existsSync(candidate)) {
      return candidate;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

function extractObjectKeys(source, objectName) {
  const keys = new Set();
  const objRegex = new RegExp(`export const ${objectName}[^=]*=\\s*\\{([\\s\\S]*?)\\n\\};`, 'm');
  const match = source.match(objRegex);
  if (!match) {
    throw new Error(`Could not find ${objectName} in source`);
  }
  const body = match[1];
  // Match top-level property keys indented by 2 spaces
  const keyRegex = /^  ([a-zA-Z0-9_]+)\s*:/gm;
  let keyMatch;
  while ((keyMatch = keyRegex.exec(body)) !== null) {
    keys.add(keyMatch[1]);
  }
  return keys;
}

function runBridgeParityCheck() {
  console.log('--- Running Bridge Parity Check ---');
  const apiTsPath = findApiTs();
  if (!apiTsPath) {
    console.warn('WARN: Sibling api.ts not found. Skipping bridge parity check.');
    return;
  }

  console.log(`Found api.ts at: ${apiTsPath}`);
  const apiContent = fs.readFileSync(apiTsPath, 'utf-8');

  // Extract all sendVsCodeMessage types
  const sendMsgRegex = /sendVsCodeMessage(?:<[^>]+>)?\(\s*['"]([^'"]+)['"]/g;
  const apiTypes = new Set();
  let m;
  while ((m = sendMsgRegex.exec(apiContent)) !== null) {
    apiTypes.add(m[1]);
  }

  console.log(`Extracted ${apiTypes.size} message types from api.ts:`, Array.from(apiTypes).sort());

  // Extract handled types from src/views/dashboard-panel.ts
  const panelPath = path.resolve(process.cwd(), 'src/views/dashboard-panel.ts');
  if (!fs.existsSync(panelPath)) {
    console.error(`FAIL: ${panelPath} not found!`);
    process.exit(1);
  }
  const panelContent = fs.readFileSync(panelPath, 'utf-8');

  const cliKeys = extractObjectKeys(panelContent, 'CLI_COMMAND_MAP');
  const customKeys = extractObjectKeys(panelContent, 'CUSTOM_HANDLERS');
  const handledTypes = new Set([...cliKeys, ...customKeys]);

  console.log(`Extracted ${handledTypes.size} handled types from dashboard-panel.ts:`, Array.from(handledTypes).sort());

  const pending079Types = new Set([
    'getRunOptions',
    'previewRun',
    'startRun',
    'continueRun',
    'listRuns',
    'getRun',
    'getRunLogs',
    'cancelRun',
    'markDeliveredRun',
    'applyVerdictRun',
    'cleanupRun',
  ]);

  const pending126Types = new Set([
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
  ]);

  const missing = [];
  const pending = [];
  for (const t of apiTypes) {
    if (!handledTypes.has(t)) {
      if (pending079Types.has(t) || pending126Types.has(t)) {
        pending.push(t);
      } else {
        missing.push(t);
      }
    }
  }

  if (pending.length > 0) {
    console.log(`NOTE: ${pending.length} message types are pending upcoming UI tasks:`, pending);
  }

  if (missing.length > 0) {
    console.error(`FAIL: Missing handlers in dashboard-panel.ts for types:`, missing);
    process.exit(1);
  }

  console.log(`PASS: All ${apiTypes.size} message types in api.ts are implemented in dashboard-panel.ts.`);
}

async function runCliStatusMappingTests() {
  console.log('--- Running CLI Status Mapping Tests ---');
  const cliClientPath = path.resolve(process.cwd(), 'src/cli-client.ts');
  const cliContent = fs.readFileSync(cliClientPath, 'utf-8');

  // Verify non-zero rejection logic is in place
  if (!cliContent.includes('exitCode !== 0') && !cliContent.includes('code !== 0')) {
    console.error('FAIL: cli-client.ts does not check non-zero exit code properly');
    process.exit(1);
  }

  // Quick evaluation of status mapping logic
  const keywords409 = ['stale', 'lock-timeout', 'hash mismatch', 'task-write lock'];
  for (const kw of keywords409) {
    if (!cliContent.toLowerCase().includes(kw.toLowerCase())) {
      console.error(`FAIL: cli-client.ts missing 409 keyword mapping for: ${kw}`);
      process.exit(1);
    }
  }

  const keywords400 = ['required', 'invalid', 'validation', 'illegal transition'];
  for (const kw of keywords400) {
    if (!cliContent.toLowerCase().includes(kw.toLowerCase())) {
      console.error(`FAIL: cli-client.ts missing 400 keyword mapping for: ${kw}`);
      process.exit(1);
    }
  }

  const cliClientOut = path.resolve(process.cwd(), 'out/cli-client.js');
  if (fs.existsSync(cliClientOut)) {
    const { mapCliStatus } = await import(cliClientOut);
    if (mapCliStatus(0, {}) !== 200) throw new Error('Expected 200 for code 0');
    if (mapCliStatus(1, { error: 'stale-task' }) !== 409) throw new Error('Expected 409 for stale-task');
    if (mapCliStatus(1, { error: 'lock-timeout' }) !== 409) throw new Error('Expected 409 for lock-timeout');
    if (mapCliStatus(1, 'Task hash mismatch: expected aaa got bbb') !== 409) throw new Error('Expected 409 for hash mismatch');
    if (mapCliStatus(1, 'Validation error: invalid state') !== 400) throw new Error('Expected 400 for validation error');
    if (mapCliStatus(1, 'Something went wrong') !== 500) throw new Error('Expected 500 for generic error');
    console.log('PASS: mapCliStatus runtime unit tests passed.');
  }

  console.log('PASS: CLI status mapping checks succeeded.');
}

runBridgeParityCheck();
await runCliStatusMappingTests();
console.log('All tests passed successfully.');
