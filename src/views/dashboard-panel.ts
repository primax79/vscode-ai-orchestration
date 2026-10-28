import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as crypto from 'crypto';
import { CliClient, CliError, mapCliStatus } from '../cli-client';
import {
  ProjectInfo,
  ProjectResolver,
  getProjectResolver,
  invalidateProjectResolver,
  fastCountQuestions,
  fastCountInbox,
  canonicalizeTaskState,
  sanitizeSlug,
  UnknownProjectError,
  ProjectRequiredError,
  OutsideWorkspaceError,
} from '../project-resolver';

export const AGGREGATE_OR_GLOBAL_TYPES = new Set([
  'getWorkspace',
  'switchWorkspace',
  'getWorkspaceTasks',
  'getWorkspaceQuestions',
  'getWorkspaceInbox',
  'getWorkspaceRuns',
  'previewFetchRepos',
  'fetchRepos',
]);

export function resolveMessageTargetRoot(
  type: string,
  payload: any,
  boundRoot: string,
  cliClient?: CliClient
): { targetRoot: string; projectId?: string } {
  const aiOrchBin = cliClient?.resolveCliPath ? cliClient.resolveCliPath(boundRoot) : null;
  const resolver = getProjectResolver(boundRoot, aiOrchBin);

  if (AGGREGATE_OR_GLOBAL_TYPES.has(type)) {
    if (payload && typeof payload === 'object' && payload.project) {
      const proj = resolver.resolveProject(String(payload.project));
      return { targetRoot: proj.root, projectId: proj.id };
    }
    return { targetRoot: boundRoot };
  }

  // Global-scope config/env calls with no explicit project may run against boundRoot
  const explicitProject = payload && typeof payload === 'object' ? payload.project : undefined;
  if (
    (explicitProject === undefined || explicitProject === null || !String(explicitProject).trim()) &&
    payload &&
    typeof payload === 'object' &&
    payload.scope === 'global'
  ) {
    return { targetRoot: boundRoot };
  }

  const proj = resolver.resolveProject(explicitProject);
  return { targetRoot: proj.root, projectId: proj.id };
}


export type CliArgBuilder = (payload: any, root: string) => string[];
export type CustomHandler = (panel: DashboardPanel, payload: any, root: string) => Promise<any>;
export type MessageHandler = (panel: DashboardPanel, payload: any, root: string) => Promise<any>;

// Run handlers (07.9, 09.11): same CLI arguments as the web backend (ai-orchestration-ui/backend/server.py).
export const RUN_ID_RE = /^\d{8}-\d{6}-[A-Za-z0-9.]+-(kilo|claude|codex)-[0-9a-f]{4}$/;
export const requireRunId = (payload: any): string => {
  const id = String(payload?.runId || payload?.run_id || payload?.id || '');
  if (!RUN_ID_RE.test(id)) {
    const err: any = new Error(`Invalid run ID ${JSON.stringify(id)}`);
    err.status = 400;
    throw err;
  }
  return id;
};
export const runId = requireRunId;

export const TASK_ATTACHMENT_ID_RE = /^T\d{3,}$/;
export const requireTaskAttachmentId = (payload: any): string => {
  const id = String(payload?.id || payload?.taskId || payload?.task_id || '');
  if (!TASK_ATTACHMENT_ID_RE.test(id)) {
    const isPlan = (id.includes('.') && !id.includes('/')) || (id.length > 0 && /^\d/.test(id)) || id.toLowerCase().includes('plan') || id.startsWith('INIT-');
    const msg = isPlan
      ? 'plan tasks take no attachments'
      : `Invalid task ID ${JSON.stringify(id)}, must match ^T\\d{3,}$`;
    const err: any = new Error(msg);
    err.status = 400;
    throw err;
  }
  return id;
};

export const NOTE_ID_RE = /^N\d{3,}$/;
export const requireNoteId = (payload: any): string => {
  const id = String(payload?.id || payload?.noteId || payload?.note_id || '');
  if (!NOTE_ID_RE.test(id)) {
    const err: any = new Error(`Invalid note ID ${JSON.stringify(id)}, must match ^N\\d{3,}$`);
    err.status = 400;
    throw err;
  }
  return id;
};

export const runTargetArgs = (payload: any): string[] => {
  const note = payload?.note;
  const task = payload?.task;
  if (!note && !task) {
    const err: any = new Error('task or note is required');
    err.status = 400;
    throw err;
  }
  if (note) {
    const noteStr = String(note);
    if (!NOTE_ID_RE.test(noteStr)) {
      const err: any = new Error(`Invalid note ID ${JSON.stringify(noteStr)}, must match ^N\\d{3,}$`);
      err.status = 400;
      throw err;
    }
    return ['--note', noteStr];
  }
  return ['--task', String(task)];
};

const runRequestArgs = (payload: any): string[] => {
  const args: string[] = [];
  for (const [key, flag] of [
    ['mode', '--mode'], ['tool', '--tool'], ['profile', '--profile'], ['model', '--model'],
    ['variant', '--variant'], ['effort', '--effort'], ['isolation', '--isolation'],
    ['target_run', '--target-run'], ['instructions', '--instructions'],
  ] as const) {
    if (payload?.[key]) args.push(flag, String(payload[key]));
  }
  if (payload?.allow_same_tool) args.push('--allow-same-tool');
  if (payload?.allow_dirty_base) args.push('--allow-dirty-base');
  if (payload?.force) args.push('--force');
  return args;
};
const requireTask = (payload: any): string => {
  const task = String(payload?.task || '');
  if (!task) throw new Error('task is required');
  return task;
};

export const requireAttachmentName = (payload: any): string => {
  const name = String(payload?.name || payload?.filename || payload?.attachment || '');
  if (!name || name.includes('/') || name.includes('\\') || name.includes('..') || name.includes('\0')) {
    const err: any = new Error(`Invalid attachment name ${JSON.stringify(name)}`);
    err.status = 400;
    throw err;
  }
  return name;
};

export function sniffImageContentType(buf: Buffer): string {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 && buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a) {
    return 'image/png';
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return 'image/jpeg';
  }
  if (buf.length >= 6) {
    const sig = buf.toString('ascii', 0, 6);
    if (sig === 'GIF87a' || sig === 'GIF89a') {
      return 'image/gif';
    }
  }
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    return 'image/webp';
  }
  return 'application/octet-stream';
}

export function classifyAttachmentContentType(buf: Buffer): string | null {
  const imgType = sniffImageContentType(buf);
  if (imgType !== 'application/octet-stream') {
    return imgType;
  }
  if (buf.length >= 5 && buf.subarray(0, 5).toString('ascii') === '%PDF-') {
    return 'application/pdf';
  }
  const checkLen = Math.min(buf.length, 65536);
  let hasNul = false;
  for (let i = 0; i < checkLen; i++) {
    if (buf[i] === 0) {
      hasNul = true;
      break;
    }
  }
  if (!hasNul) {
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(buf);
      return 'text/plain; charset=utf-8';
    } catch {
      // not valid utf-8
    }
  }
  return null;
}

// Timeline (10.2) & Tree Structure (11.3): same CLI arguments as the web backend's /api/tasks/{id}/priority|size|deps|kind|labels.
export const TREE_NODE_ID_RE = /^(T\d{3,}(\.\d+)*|\d{2,}\.\d+(\.\d+)*)$/;
export const requireTreeNodeId = (payload: any): string => {
  const id = String(payload?.id || payload?.taskId || payload?.task_id || payload?.node_id || payload?.parentId || payload?.parent_id || payload?.parent || '');
  if (!TREE_NODE_ID_RE.test(id)) {
    const err: any = new Error(`Invalid tree node ID ${JSON.stringify(id)}`);
    err.status = 400;
    throw err;
  }
  return id;
};

export const QUESTION_ID_RE = /^Q\d{3,}$/;
export const requireQuestionId = (payload: any): string => {
  const id = String(payload?.id || payload?.questionId || payload?.question_id || '');
  if (!QUESTION_ID_RE.test(id)) {
    const err: any = new Error(`Invalid question ID ${JSON.stringify(id)}, must match ^Q\\d{3,}$`);
    err.status = 400;
    throw err;
  }
  return id;
};

export const MICRO_ID_RE = /^T\d{3,}$/;
export const requireMicrotaskId = (payload: any): string => {
  const id = String(payload?.taskId || payload?.task_id || payload?.id || '');
  if (!MICRO_ID_RE.test(id)) {
    const err: any = new Error(`Invalid microtask id ${JSON.stringify(id)}`);
    err.status = 400;
    throw err;
  }
  return id;
};

export const SET_SHORT_ID_RE = /^(T\d{3,}(\.\d+)*|\d{2,}\.\d+(\.\d+)*|Q\d{3,}|UC\d{3,}|N\d{3,}|INIT-\d+|#\d+)$/;
export const requireSetShortId = (payload: any): string => {
  const id = String(
    payload?.id ||
    payload?.taskId ||
    payload?.task_id ||
    payload?.node_id ||
    payload?.questionId ||
    payload?.question_id ||
    payload?.noteId ||
    payload?.note_id ||
    ''
  );
  if (!SET_SHORT_ID_RE.test(id)) {
    const err: any = new Error(`Invalid item ID ${JSON.stringify(id)}`);
    err.status = 400;
    throw err;
  }
  return id;
};

export const PROPOSAL_ACTION_ID_RE = /^[A-Za-z0-9_-]+$/;

export const TURN_ID_RE = /^[A-Za-z0-9._-]+$/;
export function validateTurnId(id: string): string {
  if (!id || typeof id !== 'string') {
    const err: any = new Error('turn_id is required');
    err.status = 400;
    err.data = { error: 'turn_id is required' };
    throw err;
  }
  const cleanId = id.endsWith('.json') ? id.slice(0, -5) : id;
  const trimmed = cleanId.trim();
  if (
    !trimmed ||
    trimmed.includes('..') ||
    trimmed.includes('/') ||
    trimmed.includes('\\') ||
    trimmed.includes('\0') ||
    !TURN_ID_RE.test(trimmed)
  ) {
    const err: any = new Error(`Invalid turn ID ${JSON.stringify(id)}`);
    err.status = 400;
    err.data = { error: 'invalid_turn_id', message: `Invalid turn ID ${JSON.stringify(id)}` };
    throw err;
  }
  return trimmed;
}

export function getRotateAfterTokens(root: string): number {
  for (const filename of ['.ai-orchestration.local.toml', 'orchestration.toml']) {
    const p = path.join(root, filename);
    if (fs.existsSync(p)) {
      try {
        const content = fs.readFileSync(p, 'utf-8');
        const match = content.match(/rotate_after_tokens\s*=\s*(\d+)/);
        if (match) {
          const val = parseInt(match[1], 10);
          if (!isNaN(val)) return val;
        }
      } catch {}
    }
  }
  return 150000;
}

export function readPartialAssistantMessages(turnDir: string): string[] {
  let chunks: string[] = [];
  if (fs.existsSync(turnDir) && fs.statSync(turnDir).isDirectory()) {
    const files = fs.readdirSync(turnDir);
    chunks = files
      .filter((f) => f.startsWith('events.') && f.endsWith('.jsonl'))
      .sort()
      .map((f) => path.join(turnDir, f));
    if (chunks.length === 0 && files.includes('events.jsonl')) {
      chunks = [path.join(turnDir, 'events.jsonl')];
    }
  }
  const messages: string[] = [];
  const kiloMsgIndex = new Map<string, number>();

  for (const chunk of chunks) {
    try {
      const text = fs.readFileSync(chunk, 'utf-8');
      const lines = text.split(/\r?\n/);
      for (let line of lines) {
        line = line.trim();
        if (!line.startsWith('{')) continue;
        let obj: any;
        try {
          obj = JSON.parse(line);
        } catch {
          continue;
        }
        if (!obj || typeof obj !== 'object') continue;

        const typ = obj.type;
        const part = obj.part;
        if (typ === 'text' && part && typeof part === 'object' && part.type === 'text') {
          const t = part.text;
          if (typeof t === 'string') {
            const mid = part.messageID;
            if (typeof mid === 'string' && kiloMsgIndex.has(mid)) {
              const idx = kiloMsgIndex.get(mid)!;
              messages[idx] = messages[idx] ? `${messages[idx]}\n${t}` : t;
            } else {
              if (typeof mid === 'string') {
                kiloMsgIndex.set(mid, messages.length);
              }
              messages.push(t);
            }
          }
        } else if (typ === 'item.completed' && obj.item && typeof obj.item === 'object') {
          const it = obj.item;
          if (it.type === 'agent_message' && typeof it.text === 'string') {
            messages.push(it.text);
          }
        } else if (obj.role === 'assistant') {
          const content = obj.content || obj.text;
          if (typeof content === 'string' && content.trim()) {
            messages.push(content);
          }
        }
      }
    } catch {}
  }
  return messages;
}

export function getTurnSortKey(t: any): [string, number] {
  const ts = String(
    t.created_at ||
    t.queued_at ||
    t.started_at ||
    t.ended_at ||
    ''
  ).trim();

  let seq = t.turn_seq;
  if (typeof seq !== 'number') {
    const tid = String(t.turn_id ?? '0');
    const firstPart = tid.split('-')[0];
    const parsed = parseInt(firstPart, 10);
    seq = !isNaN(parsed) && /^\d+$/.test(firstPart) ? parsed : 0;
  }
  return [ts, seq];
}

export function compareTurns(a: any, b: any): number {
  const [tsA, seqA] = getTurnSortKey(a);
  const [tsB, seqB] = getTurnSortKey(b);
  if (tsA < tsB) return -1;
  if (tsA > tsB) return 1;
  return seqA - seqB;
}

export const VALID_KINDS = new Set(['bug', 'chore', 'docs', 'feature', 'fix', 'investigation']);
export const VALID_PRIORITIES = new Set(['P0', 'P1', 'P2', 'P3']);
export const VALID_SIZES = new Set(['XS', 'S', 'M', 'L', 'XL']);
export const LABEL_RE = /^[a-z0-9][a-z0-9-]{0,23}$/;

export function extractLabels(val: any): string[] {
  if (!val) return [];
  if (Array.isArray(val)) {
    const items: string[] = [];
    for (const x of val) {
      if (typeof x === 'string') {
        items.push(...x.trim().split(/[\s,]+/).map((p) => p.trim().toLowerCase()).filter(Boolean));
      } else if (x !== undefined && x !== null) {
        const s = String(x).trim().toLowerCase();
        if (s) items.push(s);
      }
    }
    return items;
  }
  if (typeof val === 'string') {
    return val.trim().split(/[\s,]+/).map((p) => p.trim().toLowerCase()).filter(Boolean);
  }
  return [];
}

const TASK_MUTATION_ID_RE = TREE_NODE_ID_RE;
export const VALIDATE_CLOSE_ID_RE = /^(T\d{3,}(\.\d+)*|\d{2,}(\.\d+)*)$/;
const mutationTaskId = requireTreeNodeId;
const depIds = (v: any): string[] =>
  (Array.isArray(v) ? v : v ? [v] : [])
    .filter((x: any) => x !== undefined && x !== null)
    .flatMap((x: any) => String(x).split(/[\s,]+/))
    .map((x: string) => x.trim())
    .filter(Boolean);

// 17.9 parity: link/unlink use cases on a task (preview, then apply with the preview's plan hash).
function taskUseCasesArgs(payload: any, root: string, isPreview: boolean): string[] {
  const taskId = mutationTaskId(payload);
  const action = payload?.action === 'unlink' ? 'unlink' : 'link';
  const raw = payload?.use_cases ?? payload?.useCases;
  const useCases = depIds(raw);
  if (useCases.length === 0) {
    const err: any = new Error('use_cases is required');
    err.status = 400;
    throw err;
  }
  const args = ['tasks', action, taskId, ...useCases, '--tasks-dir', path.join(root, 'tasks')];
  if (isPreview) {
    args.push('--preview');
  } else {
    const expectHash = payload?.expect_plan_hash || payload?.expectPlanHash;
    if (!expectHash) {
      const err: any = new Error('expect_plan_hash is required');
      err.status = 400;
      throw err;
    }
    args.push('--apply', '--expect-plan-hash', String(expectHash));
  }
  return args;
}

export function extractValidateCloseTaskIds(payload: any): string[] {
  let raw = payload?.task_ids;
  if (raw === undefined || raw === null) {
    raw = payload?.tasks;
  }
  if ((raw === undefined || raw === null) && payload?.task_id) {
    raw = [payload.task_id];
  }
  if ((raw === undefined || raw === null) && payload?.id) {
    raw = [payload.id];
  }
  const ids = depIds(raw);
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const tid of ids) {
    if (!seen.has(tid)) {
      seen.add(tid);
      ordered.push(tid);
    }
  }
  return ordered;
}

export function computeValidateClosePlanHash(
  items: Array<{ id: string; state: string; task_hash?: string }>
): string {
  const canonical = items.map((it) => ({
    id: String(it.id),
    state: String(it.state),
    task_hash: String(it.task_hash || ''),
  }));
  const payload = JSON.stringify(canonical);
  return crypto.createHash('sha256').update(payload, 'utf8').digest('hex');
}

function throwValidateCloseError(status: number, payload: any): never {
  const msg =
    payload && typeof payload === 'object' && (payload.error || payload.message)
      ? String(payload.error || payload.message)
      : `Request failed with status ${status}`;
  const err: any = new Error(msg);
  err.status = status;
  err.data = payload;
  throw err;
}

export async function inspectValidateCloseTasks(
  panel: DashboardPanel,
  tasksDir: string,
  root: string,
  taskIds: string[],
  note: string | null = null
): Promise<{ status: number; payload: any }> {
  if (!taskIds || taskIds.length === 0) {
    return { status: 400, payload: { ok: false, error: 'task_ids is required and must be non-empty' } };
  }

  for (const tid of taskIds) {
    if (!VALIDATE_CLOSE_ID_RE.test(tid)) {
      return { status: 400, payload: { ok: false, error: `Invalid task id '${tid}'` } };
    }
  }

  let listData: any;
  try {
    listData = await panel.cliClient.runJsonCommand<any>(['tasks', 'list', '--tasks-dir', tasksDir], root);
  } catch (e: any) {
    const status = e instanceof CliError ? e.status : (e?.status || 500);
    const data = e instanceof CliError ? e.data : e?.data;
    return {
      status,
      payload: data && typeof data === 'object' ? data : { ok: false, error: e?.message || String(e) },
    };
  }

  if (!listData || typeof listData !== 'object') {
    return { status: 500, payload: { ok: false, error: String(listData) } };
  }

  const treeMap: Record<string, any> = listData.tree && typeof listData.tree === 'object' ? listData.tree : {};
  const allTasksList: any[] = Array.isArray(listData.all_tasks)
    ? listData.all_tasks
    : Array.isArray(listData.emergent_tasks)
      ? listData.emergent_tasks
      : [];
  const tasksById: Record<string, any> = {};
  for (const t of allTasksList) {
    if (t && typeof t === 'object' && t.id) {
      tasksById[String(t.id)] = t;
    }
  }

  const items: any[] = [];
  const plan: any[] = [];

  for (const tid of taskIds) {
    const node = treeMap[tid] || tasksById[tid];
    if (!node) {
      return { status: 404, payload: { ok: false, task_id: tid, error: `Task '${tid}' not found` } };
    }

    if (node.is_container || node.is_leaf === false) {
      return {
        status: 400,
        payload: {
          ok: false,
          task_id: tid,
          error: `Task '${tid}' is a container with derived state; validate and close its leaf tasks instead.`,
        },
      };
    }

    const rawState = String(node.state || '').trim();
    const canonState = String(node.canonical_state || canonicalizeTaskState(rawState)).trim().toLowerCase();
    if (canonState !== 'delivered' && canonState !== 'verified') {
      return {
        status: 400,
        payload: {
          ok: false,
          task_id: tid,
          state: rawState,
          error: `Task '${tid}' is in state '${rawState}'; only 'delivered' or 'verified' tasks can be validated and closed.`,
        },
      };
    }

    const cmd = [
      'tasks', 'transition', tid, 'done',
      '--verifier', 'owner',
      '--dry-run',
      '--tasks-dir', tasksDir,
    ];
    if (note) {
      cmd.push('--reason', note);
    }

    let dryData: any;
    try {
      dryData = await panel.cliClient.runJsonCommand<any>(cmd, root);
    } catch (e: any) {
      const status = e instanceof CliError ? e.status : (e?.status || 500);
      const data = e instanceof CliError ? e.data : e?.data;
      const errMsg = data && typeof data === 'object' && data.error ? data.error : (e?.message || String(e));
      return {
        status,
        payload: {
          ok: false,
          task_id: tid,
          error: errMsg || `Dry-run transition failed for ${tid}`,
        },
      };
    }

    if (!dryData || typeof dryData !== 'object' || !dryData.ok) {
      const errMsg = dryData && typeof dryData === 'object' && dryData.error ? dryData.error : String(dryData);
      const status = mapCliStatus(1, dryData);
      return {
        status,
        payload: {
          ok: false,
          task_id: tid,
          error: errMsg || `Dry-run transition failed for ${tid}`,
        },
      };
    }

    const taskHash = String(
      node.task_hash ||
      node.bundle_sha256 ||
      node.task_bundle_sha256 ||
      dryData.task_hash ||
      dryData.bundle_sha256 ||
      ''
    );
    const title = String(node.title || tid);
    const shortTitleStr = String(node.short_title || node.short || title);
    let verifyBy: any =
      node.verify_by ||
      node['verify-by'] ||
      (tasksById[tid] || {}).verify_by ||
      (tasksById[tid] || {})['verify-by'] ||
      null;
    if (typeof verifyBy === 'string') {
      verifyBy = verifyBy.trim();
      if (!verifyBy || verifyBy === '-') {
        verifyBy = null;
      }
    }

    const pathSteps: string[] =
      Array.isArray(dryData.path) && dryData.path.length > 0
        ? dryData.path.map((s: any) => String(s))
        : canonState === 'delivered'
          ? ['delivered', 'verified', 'done']
          : ['verified', 'done'];
    const relPath = String(dryData.rel_path || node.rel_path || tid);
    const pathStr = pathSteps.join(' -> ');

    items.push({
      id: tid,
      task_id: tid,
      title,
      short_title: shortTitleStr,
      state: canonState,
      raw_state: rawState,
      new_state: dryData.new_state || 'done',
      verify_by: verifyBy,
      verifier: 'owner',
      path: pathSteps,
      rel_path: relPath,
      task_hash: taskHash,
    });
    plan.push({
      action: 'modify',
      task_id: tid,
      path: relPath,
      reason: `${tid} (${shortTitleStr}): ${pathStr} (verifier: owner)` + (note ? ` — ${note}` : ''),
      current_state: canonState,
      state: `${canonState} -> done`,
      before_sha256: taskHash,
    });
  }

  const planHash = computeValidateClosePlanHash(items);
  const summary =
    `Validate and close ${items.length} task(s) as \`owner\`: ` +
    items.map((it) => `\`${it.id}\` (${it.short_title})`).join(', ');

  return {
    status: 200,
    payload: {
      ok: true,
      dry_run: true,
      tasks: items,
      task_ids: items.map((it) => it.id),
      count: items.length,
      verifier: 'owner',
      note,
      plan,
      plan_hash: planHash,
      hash: planHash,
      summary,
    },
  };
}
const mutationTail = (payload: any, preview: boolean): string[] => {
  const h = payload?.expect_task_hash || payload?.expect_hash;
  if (!preview && !h) throw new Error('expect_task_hash is required');
  const tail: string[] = [];
  if (preview) tail.push('--dry-run');
  if (h) tail.push('--expect-task-hash', String(h));
  return tail;
};
const planMutationTail = (payload: any, preview: boolean): string[] => {
  const h = payload?.expect_plan_hash || payload?.expect_hash || payload?.plan_hash || payload?.expect_task_hash;
  if (!preview && !h) {
    const err: any = new Error('expect_plan_hash is required');
    err.status = 400;
    throw err;
  }
  const tail: string[] = [];
  if (preview) tail.push('--dry-run');
  if (h) tail.push('--expect-plan-hash', String(h));
  return tail;
};
const priorityArgs = (preview: boolean): CliArgBuilder => (payload, root) => {
  const p = String(payload?.priority || '').toUpperCase();
  if (!['P0', 'P1', 'P2', 'P3'].includes(p)) throw new Error(`Invalid priority ${JSON.stringify(p)}`);
  const args = ['tasks', 'set-priority', mutationTaskId(payload), p, '--tasks-dir', path.join(root, 'tasks')];
  if (payload?.reason) args.push('--reason', String(payload.reason));
  return [...args, ...mutationTail(payload, preview)];
};
const sizeArgs = (preview: boolean): CliArgBuilder => (payload, root) => {
  const sz = String(payload?.size || '').toUpperCase();
  if (!['XS', 'S', 'M', 'L', 'XL'].includes(sz)) throw new Error(`Invalid size ${JSON.stringify(sz)}`);
  return ['tasks', 'set-size', mutationTaskId(payload), sz, '--tasks-dir', path.join(root, 'tasks'), ...mutationTail(payload, preview)];
};
const depsArgs = (preview: boolean): CliArgBuilder => (payload, root) => {
  const args = ['tasks', 'set-deps', mutationTaskId(payload), '--tasks-dir', path.join(root, 'tasks')];
  const add = depIds(payload?.add);
  const remove = depIds(payload?.remove);
  const to = payload?.to !== undefined ? depIds(payload.to) : payload?.deps !== undefined ? depIds(payload.deps) : null;
  if (add.length) args.push('--add', ...add);
  if (remove.length) args.push('--remove', ...remove);
  if (to) args.push('--to', ...to);
  return [...args, ...mutationTail(payload, preview)];
};

export const setShortArgs = (preview: boolean): CliArgBuilder => (payload, root) => {
  const targetId = requireSetShortId(payload);
  const words = payload?.short_title ?? payload?.shortTitle ?? payload?.short ?? payload?.words;
  if (words === undefined || words === null) {
    const err: any = new Error('short_title is required');
    err.status = 400;
    throw err;
  }
  const cleanWords = String(words).trim();
  if (!cleanWords) {
    const err: any = new Error('short_title cannot be empty');
    err.status = 400;
    throw err;
  }
  const args = ['tasks', 'set-short', targetId, cleanWords, '--tasks-dir', path.join(root, 'tasks')];
  return [...args, ...planMutationTail(payload, preview)];
};

const addChildArgs = (preview: boolean): CliArgBuilder => (payload, root) => {
  const parentId = requireTreeNodeId(payload);
  const title = payload?.title ? String(payload.title).trim() : '';
  if (!title) {
    const err: any = new Error('title is required');
    err.status = 400;
    throw err;
  }
  const kind = payload?.kind ? String(payload.kind).trim() : 'feature';
  const args = ['tasks', 'child', 'add', parentId, '--title', title, '--kind', kind, '--tasks-dir', path.join(root, 'tasks')];
  return [...args, ...planMutationTail(payload, preview)];
};

const expandTaskArgs = (preview: boolean): CliArgBuilder => (payload, root) => {
  const nodeId = requireTreeNodeId(payload);
  const args = ['tasks', 'expand', nodeId, '--tasks-dir', path.join(root, 'tasks')];
  return [...args, ...planMutationTail(payload, preview)];
};

const collapseTaskArgs = (preview: boolean): CliArgBuilder => (payload, root) => {
  const nodeId = requireTreeNodeId(payload);
  const args = ['tasks', 'collapse', nodeId, '--tasks-dir', path.join(root, 'tasks')];
  return [...args, ...planMutationTail(payload, preview)];
};

const reopenTaskArgs = (preview: boolean): CliArgBuilder => (payload, root) => {
  const nodeId = requireTreeNodeId(payload);
  const reason = payload?.reason ? String(payload.reason).trim() : '';
  if (!reason) {
    const err: any = new Error('reason is required');
    err.status = 400;
    throw err;
  }
  const args = ['tasks', 'reopen', nodeId, '--reason', reason, '--tasks-dir', path.join(root, 'tasks')];
  return [...args, ...planMutationTail(payload, preview)];
};

const setKindArgs = (preview: boolean): CliArgBuilder => (payload, root) => {
  const taskId = requireTreeNodeId(payload);
  const kind = String(payload?.kind || '').trim().toLowerCase();
  if (!kind) {
    const err: any = new Error('kind is required');
    err.status = 400;
    throw err;
  }
  if (!VALID_KINDS.has(kind)) {
    const err: any = new Error(`Invalid kind ${JSON.stringify(kind)}, expected one of ${Array.from(VALID_KINDS).sort().join(', ')}`);
    err.status = 400;
    throw err;
  }
  return ['tasks', 'set-kind', taskId, kind, '--tasks-dir', path.join(root, 'tasks'), ...mutationTail(payload, preview)];
};

const setLabelsArgs = (preview: boolean): CliArgBuilder => (payload, root) => {
  const taskId = requireTreeNodeId(payload);
  const addLabels = extractLabels(payload?.add);
  const removeLabels = extractLabels(payload?.remove);
  const toSpecified = payload?.to !== undefined || payload?.labels !== undefined;
  const toLabels = extractLabels(payload?.to !== undefined ? payload.to : payload?.labels);

  if (!addLabels.length && !removeLabels.length && !toSpecified) {
    const err: any = new Error('at least one of add, remove, or to/labels is required');
    err.status = 400;
    throw err;
  }

  for (const lbl of [...addLabels, ...removeLabels, ...toLabels]) {
    if (!LABEL_RE.test(lbl)) {
      const err: any = new Error(`Invalid label format ${JSON.stringify(lbl)}, must match ^[a-z0-9][a-z0-9-]{0,23}$`);
      err.status = 400;
      throw err;
    }
  }

  const args = ['tasks', 'set-labels', taskId, '--tasks-dir', path.join(root, 'tasks')];
  if (addLabels.length) args.push('--add', ...addLabels);
  if (removeLabels.length) args.push('--remove', ...removeLabels);
  if (toSpecified) args.push('--to', ...toLabels);
  return [...args, ...mutationTail(payload, preview)];
};

const createMicrotaskArgs: CliArgBuilder = (payload, root) => {
  const title = payload?.title ? String(payload.title).trim() : '';
  if (!title) {
    const err: any = new Error('title is required');
    err.status = 400;
    throw err;
  }
  const kind = payload?.kind ? String(payload.kind).trim().toLowerCase() : 'chore';
  if (!VALID_KINDS.has(kind)) {
    const err: any = new Error(`Invalid kind ${JSON.stringify(kind)}, expected one of ${Array.from(VALID_KINDS).sort().join(', ')}`);
    err.status = 400;
    throw err;
  }
  const priority = payload?.priority ? String(payload.priority).trim().toUpperCase() : 'P2';
  if (!VALID_PRIORITIES.has(priority)) {
    const err: any = new Error(`Invalid priority ${JSON.stringify(priority)}, expected one of ${Array.from(VALID_PRIORITIES).sort().join(', ')}`);
    err.status = 400;
    throw err;
  }
  const args = ['tasks', 'micro', '--title', title, '--kind', kind, '--priority', priority, '--tasks-dir', path.join(root, 'tasks')];
  if (payload?.paths) args.push('--paths', String(payload.paths));
  const dependsOn = payload?.depends_on || payload?.dependsOn;
  if (dependsOn) args.push('--depends-on', String(dependsOn));
  if (payload?.size) {
    const sz = String(payload.size).trim().toUpperCase();
    if (!VALID_SIZES.has(sz)) {
      const err: any = new Error(`Invalid size ${JSON.stringify(sz)}`);
      err.status = 400;
      throw err;
    }
    args.push('--size', sz);
  }
  if (payload?.executor) args.push('--executor', String(payload.executor));
  if (payload?.what) args.push('--what', String(payload.what));
  const labels = extractLabels(payload?.labels || payload?.label);
  for (const lbl of labels) {
    if (!LABEL_RE.test(lbl)) {
      const err: any = new Error(`Invalid label format ${JSON.stringify(lbl)}, must match ^[a-z0-9][a-z0-9-]{0,23}$`);
      err.status = 400;
      throw err;
    }
    args.push('--label', lbl);
  }
  return args;
};

const promoteMicrotaskArgs: CliArgBuilder = (payload, root) => {
  const taskId = requireMicrotaskId(payload);
  const category = String(payload?.category || 'maintenance').trim() || 'maintenance';
  return ['tasks', 'promote', taskId, '--category', category, '--tasks-dir', path.join(root, 'tasks')];
};

export const CLI_COMMAND_MAP: Record<string, CliArgBuilder> = {
  getGraph: (payload, root) => ['tasks', 'graph', '--tasks-dir', path.join(root, 'tasks')],
  previewSetPriority: priorityArgs(true),
  setPriority: priorityArgs(false),
  previewSetSize: sizeArgs(true),
  setSize: sizeArgs(false),
  previewSetDeps: depsArgs(true),
  setDeps: depsArgs(false),
  previewSetShort: setShortArgs(true),
  setShort: setShortArgs(false),
  // Names sent by the web frontend (ai-orchestration-ui api.ts)
  previewSetShortTitle: setShortArgs(true),
  setShortTitle: setShortArgs(false),
  getRunOptions: (payload, root) => ['run', 'options', ...runTargetArgs(payload), '--workspace', root],
  previewRun: (payload, root) => ['run', 'preview', ...runTargetArgs(payload), '--workspace', root, ...runRequestArgs(payload)],
  startRun: (payload, root) => {
    if (!payload?.expect_plan_hash) {
      const err: any = new Error('expect_plan_hash is required');
      err.status = 400;
      throw err;
    }
    return ['run', 'start', ...runTargetArgs(payload), '--expect-plan-hash', String(payload.expect_plan_hash),
      '--requested-by', 'vscode', '--workspace', root, ...runRequestArgs(payload)];
  },
  continueRun: (payload, root) => {
    const args = ['run', 'start', '--continue', runId(payload), '--requested-by', 'vscode', '--workspace', root];
    if (payload?.instructions) args.push('--instructions', String(payload.instructions));
    if (payload?.expect_plan_hash) args.push('--expect-plan-hash', String(payload.expect_plan_hash));
    return args;
  },
  listRuns: (payload, root) => {
    const args = ['run', 'list', '--workspace', root];
    if (payload?.task) args.push('--task', String(payload.task));
    if (payload?.active) args.push('--active');
    return args;
  },
  getRun: (payload, root) => ['run', 'show', runId(payload), '--workspace', root],
  getRunLogs: (payload, root) => {
    const args = ['run', 'logs', runId(payload), '--workspace', root];
    if (payload?.since_offset !== undefined && payload?.since_offset !== null) args.push('--since-offset', String(payload.since_offset));
    if (payload?.tail !== undefined && payload?.tail !== null) args.push('--tail', String(payload.tail));
    return args;
  },
  cancelRun: (payload, root) => ['run', 'cancel', runId(payload), '--workspace', root],
  markDeliveredRun: (payload, root) => {
    const args = ['run', 'mark-delivered', runId(payload), '--workspace', root];
    const h = payload?.expect_task_hash || payload?.expect_task_sha256;
    if (h) args.push('--expect-task-hash', String(h));
    return args;
  },
  applyVerdictRun: (payload, root) => {
    const args = payload?.panel_id
      ? ['run', 'apply-verdict', '--panel', String(payload.panel_id), '--workspace', root]
      : ['run', 'apply-verdict', runId(payload), '--workspace', root];
    const h = payload?.expect_task_hash || payload?.expect_task_sha256;
    if (h) args.push('--expect-task-hash', String(h));
    return args;
  },
  cleanupRun: (payload, root) => {
    const args = ['run', 'cleanup', runId(payload), '--workspace', root];
    if (payload?.discard) args.push('--discard');
    if (payload?.dry_run) args.push('--dry-run');
    if (payload?.expect_plan_hash) args.push('--expect-plan-hash', String(payload.expect_plan_hash), '--requested-by', 'vscode');
    return args;
  },
  getTasks: (payload, root) => ['tasks', 'list', '--tasks-dir', path.join(root, 'tasks')],
  validateTasks: (payload, root) => ['tasks', 'validate', '--tasks-dir', path.join(root, 'tasks')],
  transitionTask: (payload, root) => {
    const taskId = payload?.taskId || payload?.task_id;
    const newState = payload?.newState || payload?.new_state;
    const args = ['tasks', 'transition', String(taskId), String(newState), '--tasks-dir', path.join(root, 'tasks')];
    if (payload?.actor) args.push('--actor', String(payload.actor));
    if (payload?.verifier) args.push('--verifier', String(payload.verifier));
    if (payload?.reason) args.push('--reason', String(payload.reason));
    const expectHash = payload?.expectTaskHash || payload?.expect_task_hash;
    if (expectHash) args.push('--expect-task-hash', String(expectHash));
    if (payload?.forceUnblock || payload?.force_unblock) args.push('--force-unblock');
    if (payload?.ownerApproved || payload?.owner_approved) args.push('--owner-approved');
    return args;
  },
  previewSyncIndex: (payload, root) => ['tasks', 'sync-index', '--tasks-dir', path.join(root, 'tasks'), '--check'],
  syncIndex: (payload, root) => [
    'tasks',
    'sync-index',
    '--tasks-dir',
    path.join(root, 'tasks'),
    '--apply',
    '--expect-hash',
    String(payload?.expectHash || payload?.expect_hash),
  ],
  getEnvStatus: (payload, root) => ['env', 'status', '--workspace', root],
  previewInstallSkills: (payload, root) => {
    const scope = payload?.scope || 'global';
    const repo = payload?.repo || 'ai-orchestration';
    const args = ['env', 'install-skills', '--scope', scope, '--repo', repo, '--workspace', root, '--dry-run'];
    const assistants = payload?.assistants || ['all'];
    args.push('--assistants', ...assistants);
    if (payload?.link) args.push('--link');
    if (payload?.plugins && payload.plugins.length > 0) args.push('--plugins', ...payload.plugins);
    if (payload?.overwrite && payload.overwrite.length > 0) args.push('--overwrite', ...payload.overwrite);
    return args;
  },
  installSkills: (payload, root) => {
    const scope = payload?.scope || 'global';
    const repo = payload?.repo || 'ai-orchestration';
    const expectHash = payload?.expectPlanHash || payload?.expect_plan_hash;
    const args = ['env', 'install-skills', '--scope', scope, '--repo', repo, '--workspace', root, '--expect-plan-hash', String(expectHash)];
    const assistants = payload?.assistants || ['all'];
    args.push('--assistants', ...assistants);
    if (payload?.link) args.push('--link');
    if (payload?.plugins && payload.plugins.length > 0) args.push('--plugins', ...payload.plugins);
    if (payload?.overwrite && payload.overwrite.length > 0) args.push('--overwrite', ...payload.overwrite);
    return args;
  },
  previewRegisterMcp: (payload, root) => {
    const server = payload?.server || 'kilo-mcp';
    const assistants = payload?.assistants || ['claude', 'codex'];
    const scope = payload?.scope || 'global';
    const args = ['env', 'register-mcp', server, '--scope', scope, '--workspace', root, '--dry-run'];
    args.push('--assistants', ...assistants);
    if (payload?.provisionVenv || payload?.provision_venv) args.push('--provision-venv');
    return args;
  },
  registerMcp: (payload, root) => {
    const server = payload?.server || 'kilo-mcp';
    const assistants = payload?.assistants || ['claude', 'codex'];
    const scope = payload?.scope || 'global';
    const expectHash = payload?.expectPlanHash || payload?.expect_plan_hash;
    const args = ['env', 'register-mcp', server, '--scope', scope, '--workspace', root, '--expect-plan-hash', String(expectHash)];
    args.push('--assistants', ...assistants);
    if (payload?.provisionVenv || payload?.provision_venv) args.push('--provision-venv');
    return args;
  },
  previewRemoveSkill: (payload, root) => {
    const scope = payload?.scope || 'global';
    return ['env', 'remove-skill', String(payload?.skill), '--assistant', String(payload?.assistant), '--scope', scope, '--workspace', root, '--dry-run'];
  },
  removeSkill: (payload, root) => {
    const scope = payload?.scope || 'global';
    const expectHash = payload?.expectPlanHash || payload?.expect_plan_hash;
    return ['env', 'remove-skill', String(payload?.skill), '--assistant', String(payload?.assistant), '--scope', scope, '--workspace', root, '--expect-plan-hash', String(expectHash)];
  },
  previewResolveConflicts: (payload, root) => ['env', 'resolve-conflicts', '--workspace', root, '--dry-run'],
  resolveConflicts: (payload, root) => ['env', 'resolve-conflicts', '--workspace', root, '--expect-plan-hash', String(payload?.expectPlanHash || payload?.expect_plan_hash)],
  previewFetchRepos: (payload, root) => {
    const args = ['env', 'fetch-repos', '--dry-run'];
    if (payload?.repos && payload.repos.length > 0) args.push('--repos', ...payload.repos);
    return args;
  },
  fetchRepos: (payload, root) => {
    const expectHash = payload?.expectPlanHash || payload?.expect_plan_hash;
    const args = ['env', 'fetch-repos', '--expect-plan-hash', String(expectHash)];
    if (payload?.repos && payload.repos.length > 0) args.push('--repos', ...payload.repos);
    return args;
  },
  getConfig: (payload, root) => ['config', 'show', '--workspace', root],
  previewSetProfile: (payload, root) => {
    const args = ['config', 'set-profile', String(payload?.tool), String(payload?.profile), '--model', String(payload?.model), '--diff'];
    if (payload?.variant) args.push('--variant', String(payload.variant));
    if (payload?.effort) args.push('--effort', String(payload.effort));
    if (payload?.basis) args.push('--basis', String(payload.basis));
    if (payload?.scope) args.push('--scope', String(payload.scope));
    if (payload?.scope === 'project') args.push('--workspace', root);
    return args;
  },
  setProfile: (payload, root) => {
    const expectHash = payload?.expectHash || payload?.expect_hash;
    const args = ['config', 'set-profile', String(payload?.tool), String(payload?.profile), '--model', String(payload?.model), '--expect-hash', String(expectHash)];
    if (payload?.variant) args.push('--variant', String(payload.variant));
    if (payload?.effort) args.push('--effort', String(payload.effort));
    if (payload?.basis) args.push('--basis', String(payload.basis));
    if (payload?.scope) args.push('--scope', String(payload.scope));
    if (payload?.scope === 'project') args.push('--workspace', root);
    return args;
  },
  previewSetRouting: (payload, root) => {
    const scope = payload?.scope || 'global';
    const args = ['config', 'set-routing', '--scope', scope, '--diff'];
    if (scope === 'project') args.push('--workspace', root);
    if (payload?.orchestrator) args.push('--orchestrator', String(payload.orchestrator));
    if (payload?.executor) args.push('--executor', String(payload.executor));
    const defaultProfile = payload?.defaultProfile || payload?.default_profile;
    if (defaultProfile) args.push('--default-profile', String(defaultProfile));
    const verificationMode = payload?.verificationMode || payload?.verification_mode;
    if (verificationMode) args.push('--verification-mode', String(verificationMode));
    return args;
  },
  setRouting: (payload, root) => {
    const scope = payload?.scope || 'global';
    const expectHash = payload?.expectHash || payload?.expect_hash;
    const args = ['config', 'set-routing', '--scope', scope, '--expect-hash', String(expectHash)];
    if (scope === 'project') args.push('--workspace', root);
    if (payload?.orchestrator) args.push('--orchestrator', String(payload.orchestrator));
    if (payload?.executor) args.push('--executor', String(payload.executor));
    const defaultProfile = payload?.defaultProfile || payload?.default_profile;
    if (defaultProfile) args.push('--default-profile', String(defaultProfile));
    const verificationMode = payload?.verificationMode || payload?.verification_mode;
    if (verificationMode) args.push('--verification-mode', String(verificationMode));
    return args;
  },
  renderAgentsMd: (payload, root) => ['render-agents-md', '--workspace', root],
  previewAgentsMd: (payload, root) => ['render-agents-md', '--workspace', root, '--diff'],
  applyAgentsMd: (payload, root) => {
    const expectHash = payload?.expectHash || payload?.expect_hash;
    const args = ['render-agents-md', '--workspace', root, '--apply', '--expect-hash', String(expectHash)];
    if (payload?.allowGlobalRouting || payload?.allow_global_routing) args.push('--allow-global-routing');
    return args;
  },
  getQuestions: (payload, root) => {
    const args = ['questions', 'list', '--tasks-dir', path.join(root, 'tasks')];
    if (payload?.status) args.push('--status', String(payload.status));
    if (payload?.blocks) args.push('--blocks', String(payload.blocks));
    return args;
  },
  listQuestions: (payload, root) => {
    const args = ['questions', 'list', '--tasks-dir', path.join(root, 'tasks')];
    if (payload?.status) args.push('--status', String(payload.status));
    if (payload?.blocks) args.push('--blocks', String(payload.blocks));
    return args;
  },
  getQuestion: (payload, root) => {
    const qid = payload?.id || payload?.questionId || payload?.question_id;
    if (!qid) {
      const err: any = new Error('question_id is required');
      err.status = 400;
      throw err;
    }
    return ['questions', 'show', String(qid), '--tasks-dir', path.join(root, 'tasks')];
  },
  answerQuestion: (payload, root) => {
    const qid = payload?.id || payload?.questionId || payload?.question_id;
    if (!qid) {
      const err: any = new Error('question_id is required');
      err.status = 400;
      throw err;
    }
    const choice = payload?.choice;
    if (!choice) {
      const err: any = new Error('choice is required');
      err.status = 400;
      throw err;
    }
    const args = ['questions', 'answer', String(qid), '--choice', String(choice), '--tasks-dir', path.join(root, 'tasks')];
    if (payload?.text !== undefined && payload?.text !== null) {
      const textStr = String(payload.text);
      if (Buffer.byteLength(textStr, 'utf-8') > 32 * 1024) {
        const err: any = new Error('Answer text exceeds 32 KB limit');
        err.status = 400;
        throw err;
      }
      args.push('--text', textStr);
    }
    if (payload?.by) args.push('--by', String(payload.by));
    return args;
  },
  withdrawQuestion: (payload, root) => {
    const qid = payload?.id || payload?.questionId || payload?.question_id;
    if (!qid) {
      const err: any = new Error('question_id is required');
      err.status = 400;
      throw err;
    }
    const reason = payload?.reason ? String(payload.reason).trim() : '';
    if (!reason) {
      const err: any = new Error('reason is required');
      err.status = 400;
      throw err;
    }
    const args = ['questions', 'withdraw', String(qid), '--reason', reason, '--tasks-dir', path.join(root, 'tasks')];
    if (payload?.by) args.push('--by', String(payload.by));
    return args;
  },
  listInbox: (payload, root) => {
    const args = ['inbox', 'list', '--tasks-dir', path.join(root, 'tasks')];
    if (payload?.status) args.push('--status', String(payload.status));
    return args;
  },
  getInboxNote: (payload, root) => ['inbox', 'show', requireNoteId(payload), '--tasks-dir', path.join(root, 'tasks')],
  addInboxNote: (payload, root) => {
    const title = payload?.title ? String(payload.title).trim() : '';
    if (!title) {
      const err: any = new Error('title is required');
      err.status = 400;
      throw err;
    }
    const args = ['inbox', 'add', '--title', title, '--tasks-dir', path.join(root, 'tasks')];
    if (payload?.kind) args.push('--kind', String(payload.kind));
    if (payload?.about) args.push('--about', String(payload.about));
    if (payload?.author) args.push('--author', String(payload.author));
    if (payload?.status) args.push('--status', String(payload.status));
    if (payload?.body !== undefined && payload?.body !== null) args.push('--body', String(payload.body));
    return args;
  },
  editInboxNote: (payload, root) => {
    const id = requireNoteId(payload);
    const args = ['inbox', 'edit', id, '--tasks-dir', path.join(root, 'tasks')];
    if (payload?.title !== undefined && payload?.title !== null) args.push('--title', String(payload.title));
    if (payload?.kind !== undefined && payload?.kind !== null) args.push('--kind', String(payload.kind));
    if (payload?.about !== undefined && payload?.about !== null) args.push('--about', String(payload.about));
    if (payload?.author !== undefined && payload?.author !== null) args.push('--author', String(payload.author));
    if (payload?.status !== undefined && payload?.status !== null) args.push('--status', String(payload.status));
    const expectHash = payload?.expect_hash || payload?.expectHash;
    if (expectHash) args.push('--expect-hash', String(expectHash));
    if (payload?.body !== undefined && payload?.body !== null) args.push('--body', String(payload.body));
    return args;
  },
  deleteInboxAttachment: (payload, root) => {
    const id = requireNoteId(payload);
    const name = requireAttachmentName(payload);
    return ['inbox', 'detach', id, '--name', name, '--tasks-dir', path.join(root, 'tasks')];
  },
  resolveInboxNote: (payload, root) => {
    const id = requireNoteId(payload);
    const produced = payload?.produced ? String(payload.produced).trim() : '';
    if (!produced) {
      const err: any = new Error('produced is required');
      err.status = 400;
      throw err;
    }
    const args = ['inbox', 'resolve', id, '--produced', produced, '--tasks-dir', path.join(root, 'tasks')];
    if (payload?.by) args.push('--by', String(payload.by));
    return args;
  },
  discardInboxNote: (payload, root) => {
    const id = requireNoteId(payload);
    const reason = payload?.reason ? String(payload.reason).trim() : '';
    if (!reason) {
      const err: any = new Error('reason is required');
      err.status = 400;
      throw err;
    }
    return ['inbox', 'discard', id, '--reason', reason, '--tasks-dir', path.join(root, 'tasks')];
  },
  reopenInboxNote: (payload, root) => ['inbox', 'reopen', requireNoteId(payload), '--tasks-dir', path.join(root, 'tasks')],
  inboxToTask: (payload, root) => {
    const id = requireNoteId(payload);
    const category = payload?.category || payload?.parent ? String(payload.category || payload.parent).trim() : '';
    if (!category) {
      const err: any = new Error('category is required');
      err.status = 400;
      throw err;
    }
    const title = payload?.title ? String(payload.title).trim() : '';
    if (!title) {
      const err: any = new Error('title is required');
      err.status = 400;
      throw err;
    }
    const args = [
      'tasks', 'new',
      '--from-note', id,
      '--category', category,
      '--title', title,
      '--tasks-dir', path.join(root, 'tasks'),
    ];
    if (payload?.priority) args.push('--priority', String(payload.priority));
    const priorityReason = payload?.priority_reason || payload?.priorityReason;
    if (priorityReason) args.push('--priority-reason', String(priorityReason));
    if (payload?.executor) args.push('--executor', String(payload.executor));
    const nextUp = payload?.next_up || payload?.nextUp;
    if (nextUp) args.push('--next-up', String(nextUp));
    const dependsOn = payload?.depends_on || payload?.dependsOn;
    if (dependsOn) args.push('--depends-on', String(dependsOn));
    if (payload?.decider) args.push('--decider', String(payload.decider));
    // 17.4: optional kind and use-case links, passed through only when given.
    if (payload?.kind) args.push('--kind', String(payload.kind));
    const rawUseCases = payload?.use_cases ?? payload?.useCases;
    const useCases = Array.isArray(rawUseCases)
      ? rawUseCases.map((u: any) => String(u).trim()).filter(Boolean).join(',')
      : rawUseCases ? String(rawUseCases).trim() : '';
    if (useCases) args.push('--use-case', useCases);
    return args;
  },
  getUseCases: (payload, root) => {
    const args = ['use-cases', 'list', '--tasks-dir', path.join(root, 'tasks')];
    if (payload?.status && payload.status !== 'all') args.push('--status', String(payload.status));
    return args;
  },
  getUseCase: (payload, root) => ['use-cases', 'show', String(payload?.id || payload?.uc_id), '--tasks-dir', path.join(root, 'tasks')],
  createUseCase: (payload, root) => {
    const args = [
      'use-cases', 'create',
      '--title', String(payload?.title),
      '--tasks-dir', path.join(root, 'tasks'),
    ];
    // Empty id: the engine assigns the next free UC### on save.
    const ucId = String(payload?.id ?? '').trim();
    if (ucId) args.push('--id', ucId);
    if (payload?.actor) args.push('--actor', String(payload.actor));
    if (payload?.status) args.push('--status', String(payload.status));
    if (payload?.priority) args.push('--priority', String(payload.priority));
    if (payload?.linked_tasks) {
      const lt = Array.isArray(payload.linked_tasks) ? payload.linked_tasks.join(',') : String(payload.linked_tasks);
      args.push('--linked-tasks', lt);
    }
    if (payload?.verification_command) args.push('--verification-command', String(payload.verification_command));
    if (payload?.description) args.push('--description', String(payload.description));
    if (payload?.preconditions) args.push('--preconditions', String(payload.preconditions));
    if (payload?.scenario) args.push('--scenario', String(payload.scenario));
    return args;
  },
  validateUseCase: (payload, root) => {
    const args = ['use-cases', 'validate', String(payload?.id || payload?.uc_id), '--tasks-dir', path.join(root, 'tasks')];
    if (payload?.timeout) args.push('--timeout', String(payload.timeout));
    if (payload?.actor) args.push('--actor', String(payload.actor));
    if (payload?.force) args.push('--force');
    return args;
  },
  getUseCaseQueue: (payload, root) => ['use-cases', 'queue', '--tasks-dir', path.join(root, 'tasks')],
  previewTaskUseCases: (payload, root) => taskUseCasesArgs(payload, root, true),
  applyTaskUseCases: (payload, root) => taskUseCasesArgs(payload, root, false),
  runValidationCampaign: (payload, root) => {
    const args = ['use-cases', 'campaign', '--tasks-dir', path.join(root, 'tasks')];
    if (payload?.filter_actor) args.push('--filter-actor', String(payload.filter_actor));
    if (payload?.timeout) args.push('--timeout', String(payload.timeout));
    return args;
  },
  deleteTaskAttachment: (payload, root) => {
    const id = requireTaskAttachmentId(payload);
    const name = requireAttachmentName(payload);
    const args = ['tasks', 'detach', id, '--name', name, '--tasks-dir', path.join(root, 'tasks')];
    const expectHash = payload?.expect_task_hash || payload?.expectTaskHash || payload?.expect_hash;
    if (expectHash) args.push('--expect-task-hash', String(expectHash));
    return args;
  },
  acceptTriage: (payload, root) => {
    const id = requireRunId(payload);
    const args = ['run', 'accept-triage', id, '--workspace', root];
    const only = payload?.only;
    if (only !== undefined && only !== null) {
      if (Array.isArray(only)) {
        args.push('--only', only.map(String).join(','));
      } else {
        args.push('--only', String(only).trim());
      }
    }
    const expectNoteHash = payload?.expect_note_hash || payload?.expectNoteHash;
    if (expectNoteHash) {
      args.push('--expect-note-hash', String(expectNoteHash).trim());
    }
    return args;
  },
  previewAddChild: addChildArgs(true),
  addChild: addChildArgs(false),
  previewExpandTask: expandTaskArgs(true),
  expandTask: expandTaskArgs(false),
  previewCollapseTask: collapseTaskArgs(true),
  collapseTask: collapseTaskArgs(false),
  previewReopenTask: reopenTaskArgs(true),
  reopenTask: reopenTaskArgs(false),
  getLabels: (payload, root) => ['tasks', 'labels', '--tasks-dir', path.join(root, 'tasks')],
  createMicrotask: createMicrotaskArgs,
  promoteMicrotask: promoteMicrotaskArgs,
  previewSetKind: setKindArgs(true),
  setKind: setKindArgs(false),
  previewSetLabels: setLabelsArgs(true),
  setLabels: setLabelsArgs(false),
  getEvents: (payload, root) => {
    const args = ['events', 'tail', '--workspace', root];
    if (payload?.since !== undefined) args.push('--since', String(payload.since));
    if (payload?.limit !== undefined) args.push('--limit', String(payload.limit));
    if (payload?.type) {
      const types = Array.isArray(payload.type) ? payload.type : [payload.type];
      for (const t of types) args.push('--type', String(t));
    }
    if (payload?.session) args.push('--session', String(payload.session));
    return args;
  },
  getEventsStats: (payload, root) => ['events', 'stats', '--workspace', root],
  getTriggers: (payload, root) => ['triggers', 'list', '--workspace', root],
  getTriggersStatus: (payload, root) => {
    const role = String(payload?.role || 'orchestrator');
    return ['triggers', 'status', '--role', role, '--workspace', root];
  },
  getTriggersHistory: (payload, root) => {
    const args = ['triggers', 'history', '--workspace', root];
    if (payload?.rule) args.push('--rule', String(payload.rule));
    if (payload?.limit !== undefined && payload?.limit !== null) args.push('--limit', String(payload.limit));
    return args;
  },
  previewOrchestratorReassign: (payload, root) => {
    const tool = payload?.tool;
    if (!tool || !String(tool).trim()) {
      const err: any = new Error('tool is required');
      err.status = 400;
      err.data = { error: 'tool is required' };
      throw err;
    }
    const args = ['orchestrator', 'reassign', '--tool', String(tool).trim(), '--dry-run', '--workspace', root];
    if (payload?.model) args.push('--model', String(payload.model));
    const scope = payload?.scope || 'project';
    args.push('--scope', String(scope));
    if (payload?.no_handoff || payload?.noHandoff) args.push('--no-handoff');
    if (payload?.timeout) args.push('--timeout', String(payload.timeout));
    return args;
  },
  previewSetup: (payload, root) => {
    const scope = payload?.scope || 'project-local';
    const args = ['setup', '--plan', '--scope', String(scope), '--workspace', root];
    const orch = payload?.orchestrator;
    if (orch) args.push('--orchestrator', String(orch));
    const executor = payload?.executor;
    if (executor) args.push('--executor', String(executor));
    const orchModel = payload?.orchestrator_model || payload?.orchestratorModel;
    if (orchModel) args.push('--orchestrator-model', String(orchModel));
    const execModel = payload?.executor_model || payload?.executorModel;
    if (execModel) args.push('--executor-model', String(execModel));
    const vmode = payload?.verification_mode || payload?.verificationMode;
    if (vmode) args.push('--verification-mode', String(vmode));
    return args;
  },
};

export function checkOriginRunContinuable(
  root: string,
  originRun: string | null | undefined
): { isCont: boolean; reason: string | null; record: any } {
  if (!originRun || originRun === '-' || !String(originRun).trim()) {
    return { isCont: false, reason: 'Question has no origin-run', record: null };
  }
  const id = String(originRun).trim();
  if (!RUN_ID_RE.test(id)) {
    return { isCont: false, reason: `Invalid origin-run id ${JSON.stringify(id)}`, record: null };
  }

  const runDir = path.join(root, '.ai-orchestration', 'runs', id);
  const runJson = path.join(runDir, 'run.json');
  if (!fs.existsSync(runJson) || !fs.statSync(runJson).isFile()) {
    return { isCont: false, reason: `Origin run '${id}' not found in runs registry`, record: null };
  }

  let record: any;
  try {
    record = JSON.parse(fs.readFileSync(runJson, 'utf-8'));
  } catch (e: any) {
    return { isCont: false, reason: `Failed to read run record for '${id}': ${e.message}`, record: null };
  }

  const status = record?.status;
  if (!['succeeded', 'failed', 'cancelled', 'lost'].includes(status)) {
    return { isCont: false, reason: `Origin run '${id}' is not terminal (status: ${status})`, record };
  }

  if (!record?.session_id) {
    return { isCont: false, reason: `Origin run '${id}' has no session_id; cannot continue`, record };
  }

  if (record?.mode === 'execute' && record?.isolation === 'worktree') {
    const wtP = record?.worktree_path || record?.cwd || '';
    if (!wtP || !fs.existsSync(wtP) || !fs.statSync(wtP).isDirectory() || record?.worktree_removed === true) {
      return { isCont: false, reason: `Worktree '${wtP}' for run '${id}' does not exist`, record };
    }
  }

  return { isCont: true, reason: null, record };
}

export function formatContinuationInstructions(
  questionId: string,
  questionText: string,
  choice: string,
  freeText?: string | null,
  options?: any[]
): string {
  let chosenLabelTitle = choice;
  if (choice === 'open') {
    chosenLabelTitle = 'Open answer';
  } else if (options && Array.isArray(options)) {
    for (const opt of options) {
      if (typeof opt === 'object' && opt !== null && opt.label === choice) {
        const title = opt.title || opt.text || '';
        if (title) {
          chosenLabelTitle = `${choice} \u2014 ${title}`;
        } else {
          chosenLabelTitle = choice;
        }
        break;
      }
    }
  }

  const qSummary = (questionText || '').trim();
  const parts = [`Answer to ${questionId} (${qSummary}): ${chosenLabelTitle}.`];
  if (freeText && String(freeText).trim()) {
    parts.push(String(freeText).trim());
  }
  return parts.join(' ');
}

export function getActiveTriggerConfigPath(root: string): string {
  const localCfg = path.join(root, '.ai-orchestration.local.toml');
  if (fs.existsSync(localCfg)) return localCfg;
  const wsCfg = path.join(root, 'orchestration.toml');
  if (fs.existsSync(wsCfg)) return wsCfg;
  const globalCfg = (process.env.AI_ORCH_GLOBAL_CONFIG || '').trim();
  if (globalCfg && fs.existsSync(globalCfg)) return path.resolve(globalCfg);
  const configDir = (process.env.AI_ORCH_CONFIG_DIR || '').trim() ||
    ((process.env.AI_ORCH_HOME || '').trim()
      ? path.join((process.env.AI_ORCH_HOME || '').trim(), '.config', 'ai-orchestration')
      : path.join(os.homedir(), '.config', 'ai-orchestration'));
  return path.join(configDir, 'orchestration.toml');
}

export function generateUnifiedDiff(oldText: string, newText: string, filePath: string): string {
  if (oldText === newText) return '';
  const oldLines = oldText.length > 0 ? oldText.split(/\r?\n/) : [];
  if (oldLines.length > 0 && oldLines[oldLines.length - 1] === '') {
    oldLines.pop();
  }
  const newLines = newText.length > 0 ? newText.split(/\r?\n/) : [];
  if (newLines.length > 0 && newLines[newLines.length - 1] === '') {
    newLines.pop();
  }

  let start = 0;
  while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start]) {
    start++;
  }

  let oldEnd = oldLines.length - 1;
  let newEnd = newLines.length - 1;
  while (oldEnd >= start && newEnd >= start && oldLines[oldEnd] === newLines[newEnd]) {
    oldEnd--;
    newEnd--;
  }

  const contextStart = Math.max(0, start - 3);
  const oldContextEnd = Math.min(oldLines.length - 1, oldEnd + 3);
  const newContextEnd = Math.min(newLines.length - 1, newEnd + 3);

  const oldHunkCount = Math.max(0, oldContextEnd - contextStart + 1);
  const newHunkCount = Math.max(0, (newEnd - start + 1) + (start - contextStart) + (newContextEnd - newEnd));

  const diff: string[] = [
    `--- ${filePath}`,
    `+++ ${filePath}`,
    `@@ -${contextStart + 1},${oldHunkCount} +${contextStart + 1},${newHunkCount} @@`,
  ];

  for (let i = contextStart; i < start; i++) {
    diff.push(` ${oldLines[i]}`);
  }
  for (let i = start; i <= oldEnd; i++) {
    diff.push(`-${oldLines[i]}`);
  }
  for (let i = start; i <= newEnd; i++) {
    diff.push(`+${newLines[i]}`);
  }
  for (let i = oldEnd + 1; i <= oldContextEnd; i++) {
    diff.push(` ${oldLines[i]}`);
  }

  return diff.join('\n') + '\n';
}

export function computeTriggerToggle(
  targetFilePath: string,
  ruleName: string | null | undefined,
  killSwitch: boolean | null | undefined,
  enabled: boolean
): { oldText: string; newText: string; diffStr: string; oldHash: string } {
  const oldText = fs.existsSync(targetFilePath) ? fs.readFileSync(targetFilePath, 'utf-8') : '';
  const oldHash = crypto.createHash('sha256').update(Buffer.from(oldText, 'utf-8')).digest('hex');

  const lines = oldText.length > 0 ? oldText.split(/\r?\n/) : [];
  const newLines = [...lines];

  if (killSwitch !== undefined && killSwitch !== null) {
    let inTriggersSection = false;
    let foundEnabled = false;
    for (let i = 0; i < lines.length; i++) {
      const stripped = lines[i].trim();
      if (stripped === '[triggers]') {
        inTriggersSection = true;
      } else if (stripped.startsWith('[') && stripped !== '[triggers]') {
        if (inTriggersSection && !foundEnabled) {
          newLines.splice(i, 0, `enabled = ${enabled ? 'true' : 'false'}`);
          foundEnabled = true;
        }
        inTriggersSection = false;
      } else if (inTriggersSection && /^enabled\s*=/i.test(stripped)) {
        newLines[i] = `enabled = ${enabled ? 'true' : 'false'}`;
        foundEnabled = true;
        break;
      }
    }

    if (!foundEnabled) {
      if (!lines.some((l) => l.trim() === '[triggers]')) {
        newLines.push('');
        newLines.push('[triggers]');
      }
      newLines.push(`enabled = ${enabled ? 'true' : 'false'}`);
    }
  } else if (ruleName) {
    let inTargetRule = false;
    let foundEnabled = false;
    const escapedRule = ruleName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const nameRe = new RegExp(`^name\\s*=\\s*["']${escapedRule}["']`);
    for (let i = 0; i < lines.length; i++) {
      const stripped = lines[i].trim();
      if (stripped === '[[triggers]]' || stripped === '[[trigger]]') {
        inTargetRule = false;
      } else if (nameRe.test(stripped)) {
        inTargetRule = true;
      } else if (inTargetRule && /^enabled\s*=/i.test(stripped)) {
        newLines[i] = `enabled = ${enabled ? 'true' : 'false'}`;
        foundEnabled = true;
        break;
      } else if (inTargetRule && (stripped.startsWith('[') || stripped.startsWith('[['))) {
        newLines.splice(i, 0, `enabled = ${enabled ? 'true' : 'false'}`);
        foundEnabled = true;
        inTargetRule = false;
        break;
      }
    }

    if (inTargetRule && !foundEnabled) {
      newLines.push(`enabled = ${enabled ? 'true' : 'false'}`);
    }
  }

  const newText = newLines.join('\n') + (oldText.endsWith('\n') || !oldText ? '\n' : '');
  const diffStr = generateUnifiedDiff(oldText, newText, targetFilePath);
  return { oldText, newText, diffStr, oldHash };
}

export const CUSTOM_HANDLERS: Record<string, CustomHandler> = {
  getWorkspace: async (panel, payload, root) => {
    const aiOrchBin = panel?.cliClient?.resolveCliPath ? panel.cliClient.resolveCliPath(root) : null;
    const resolver = getProjectResolver(root, aiOrchBin);
    const { mode, projects, subWorkspaces } = resolver.getWorkspaceInfo();
    const runCli = async (args: string[], cwd?: string) => {
      if (!panel?.cliClient) return {};
      return panel.cliClient.runJsonCommand<any>(args, cwd || root);
    };

    const projectCounts = await Promise.all(projects.map((p) => resolver.getProjectCounts(p, runCli)));
    const projectTasks = await Promise.all(projects.map((p) => resolver.loadProjectTasks(p, runCli)));

    const projectsSummary = projects.map((p, idx) => {
      const counts = projectCounts[idx];
      const tasks = projectTasks[idx] || [];
      const openQ = fastCountQuestions(p.tasksDir);
      const inboxN = fastCountInbox(p.tasksDir);
      const conditional = tasks.reduce((acc: number, t: any) => acc + (t?.conditional ? 1 : 0), 0);
      return {
        id: p.id,
        path: p.path,
        kind: p.kind,
        uuid: p.uuid ?? null,
        counts,
        conditional,
        open_questions: openQ,
        inbox_notes: inboxN,
      };
    });

    const tasksDir = path.join(root, 'tasks');
    const hasTasks = fs.existsSync(tasksDir) && fs.statSync(tasksDir).isDirectory();
    return {
      root,
      workspace_path: root,
      workspace_name: path.basename(root),
      mode,
      registered: mode === 'registered',
      discovered: mode === 'discovered',
      single: mode === 'single',
      has_tasks_dir: hasTasks,
      tasks_path: hasTasks ? tasksDir : null,
      projects: projectsSummary,
      sub_workspaces: subWorkspaces,
    };
  },
  getWorkspaceTasks: async (panel, payload, root) => {
    const aiOrchBin = panel?.cliClient?.resolveCliPath ? panel.cliClient.resolveCliPath(root) : null;
    const resolver = getProjectResolver(root, aiOrchBin);
    const { projects } = resolver.getWorkspaceInfo();
    const runCli = async (args: string[], cwd?: string) => {
      if (!panel?.cliClient) return {};
      return panel.cliClient.runJsonCommand<any>(args, cwd || root);
    };

    const projectTasksList = await Promise.all(projects.map((p) => resolver.loadProjectTasks(p, runCli)));

    const tasksByProjAndId = new Map<string, Map<string, any>>();
    for (let i = 0; i < projects.length; i++) {
      const p = projects[i];
      const pTasks = projectTasksList[i] || [];
      const pMap = new Map<string, any>();
      for (const t of pTasks) {
        const tid = String(t?.id || '');
        pMap.set(tid, t);
      }
      tasksByProjAndId.set(p.id, pMap);
    }

    const flattenedTasks: any[] = [];
    for (let i = 0; i < projects.length; i++) {
      const p = projects[i];
      const pTasks = projectTasksList[i] || [];
      for (const t of pTasks) {
        const tid = String(t?.id || '');
        const short = t?.short;
        const shortTitleVal = t?.short_title || short || t?.title || '';
        const rawState = t?.state || t?.canonical_state || 'todo';
        const kind =
          t?.kind ||
          (tid.includes('.') && !tid.startsWith('T')
            ? 'initiative_task'
            : tid.startsWith('T')
            ? 'emergent'
            : 'initiative');

        let coords: any[] = Array.isArray(t?.coordinates) ? [...t.coordinates] : [];
        if (coords.length === 0 && Array.isArray(t?.coordinates_refs)) {
          coords = [...t.coordinates_refs];
        }
        if (coords.length === 0 && t?.coordinates_raw) {
          const raw = t.coordinates_raw;
          if (typeof raw === 'string') {
            coords = raw.split(',').map((x: string) => x.trim()).filter(Boolean);
          } else if (Array.isArray(raw)) {
            coords = [...raw];
          }
        }
        if (coords.length === 0 && t?.headers && typeof t.headers === 'object' && t.headers.coordinates) {
          const raw = t.headers.coordinates;
          if (typeof raw === 'string') {
            coords = raw.split(',').map((x: string) => x.trim()).filter(Boolean);
          } else if (Array.isArray(raw)) {
            coords = [...raw];
          }
        }
        if (coords.length === 0 && t?.fields && typeof t.fields === 'object' && t.fields.coordinates) {
          let fVal = t.fields.coordinates;
          if (fVal && typeof fVal === 'object' && !Array.isArray(fVal)) {
            fVal = fVal.value;
          }
          if (typeof fVal === 'string') {
            coords = fVal.split(',').map((x: string) => x.trim()).filter(Boolean);
          } else if (Array.isArray(fVal)) {
            coords = [...fVal];
          }
        }

        const resolvedCoords: any[] = [];
        for (const c of coords) {
          let targetProj: string | null = null;
          let targetId: string | null = null;
          let fallbackState = 'open';
          let fallbackShortTitle = '';

          if (c && typeof c === 'object') {
            targetProj = c.project ? String(c.project) : null;
            targetId = c.id ? String(c.id) : null;
            fallbackState = c.state || 'open';
            fallbackShortTitle = c.short_title || c.short || c.title || '';
          } else if (typeof c === 'string') {
            const cClean = c.trim();
            if (cClean.includes('/')) {
              const idx = cClean.indexOf('/');
              targetProj = cClean.slice(0, idx).trim();
              targetId = cClean.slice(idx + 1).trim();
            } else if (cClean.includes(':')) {
              const idx = cClean.indexOf(':');
              targetProj = cClean.slice(0, idx).trim();
              targetId = cClean.slice(idx + 1).trim();
            }
          }

          if (targetProj && targetId) {
            let targetT: any = null;
            let targetActualProj = targetProj;
            const directMap = tasksByProjAndId.get(targetProj);
            if (directMap && directMap.has(targetId)) {
              targetT = directMap.get(targetId);
            } else {
              for (const projObj of projects) {
                const folderName = path.basename(projObj.root);
                const aliases = new Set([
                  projObj.id,
                  projObj.path,
                  folderName,
                  sanitizeSlug(projObj.id),
                  sanitizeSlug(folderName),
                ]);
                if (aliases.has(targetProj) && tasksByProjAndId.has(projObj.id)) {
                  const aliasMap = tasksByProjAndId.get(projObj.id)!;
                  if (aliasMap.has(targetId)) {
                    targetT = aliasMap.get(targetId);
                    targetActualProj = projObj.id;
                    break;
                  }
                }
              }
            }

            if (targetT) {
              const rawSt = targetT.canonical_state || targetT.state || fallbackState;
              const resolvedState = canonicalizeTaskState(rawSt);
              const resolvedShort = targetT.short_title || targetT.short || targetT.title || fallbackShortTitle;
              resolvedCoords.push({
                project: targetActualProj,
                id: targetId,
                short_title: resolvedShort,
                state: resolvedState,
              });
            } else {
              resolvedCoords.push({
                project: targetProj,
                id: targetId,
                short_title: fallbackShortTitle,
                state: canonicalizeTaskState(fallbackState),
              });
            }
          }
        }

        const item: any = {
          project: p.id,
          id: tid,
          qualified_id: `${p.id}/${tid}`,
          title: t?.title || '',
          short,
          short_title: shortTitleVal,
          state: rawState,
          priority: t?.priority || 'P2',
          kind,
          labels: Array.isArray(t?.labels) ? [...t.labels] : [],
          coordinates: resolvedCoords,
        };
        if (t?.conditional) {
          item.conditional = true;
          item.conditions = Array.isArray(t?.conditions) ? [...t.conditions] : [];
        }
        flattenedTasks.push(item);
      }
    }

    const rawProjects = payload?.project;
    const filterProjects: string[] = Array.isArray(rawProjects)
      ? rawProjects.flatMap((k: any) => String(k).split(',')).map((x: string) => x.trim()).filter(Boolean)
      : typeof rawProjects === 'string'
      ? rawProjects.split(',').map((x: string) => x.trim()).filter(Boolean)
      : [];

    const rawStates = payload?.state;
    const filterStates: string[] = Array.isArray(rawStates)
      ? rawStates.flatMap((k: any) => String(k).split(',')).map((x: string) => x.trim().toLowerCase()).filter(Boolean)
      : typeof rawStates === 'string'
      ? rawStates.split(',').map((x: string) => x.trim().toLowerCase()).filter(Boolean)
      : [];

    const filterKind = payload?.kind ? String(payload.kind).trim().toLowerCase() : '';
    const filterLabel = payload?.label ? String(payload.label).trim() : '';
    const filterText = payload?.text ? String(payload.text).trim().toLowerCase() : '';

    const filtered: any[] = [];
    for (const item of flattenedTasks) {
      if (filterProjects.length > 0 && !filterProjects.includes(item.project)) {
        continue;
      }
      if (filterStates.length > 0) {
        const stClean = String(item.state || '').toLowerCase().replace(/[- ]+/g, '_');
        let matchesState = false;
        for (const fs of filterStates) {
          const fsClean = fs.replace(/[- ]+/g, '_');
          if (stClean === fsClean || String(item.state || '').toLowerCase() === fs) {
            matchesState = true;
            break;
          }
        }
        if (!matchesState) continue;
      }
      if (filterKind && String(item.kind || '').toLowerCase() !== filterKind) {
        continue;
      }
      if (filterLabel && !(item.labels || []).includes(filterLabel)) {
        continue;
      }
      if (filterText) {
        const haystack = `${item.title} ${item.short_title} ${item.id} ${item.qualified_id}`.toLowerCase();
        if (!haystack.includes(filterText)) {
          continue;
        }
      }
      filtered.push(item);
    }

    let page = 1;
    if (payload?.page !== undefined && payload?.page !== null) {
      const parsedPage = parseInt(String(payload.page), 10);
      if (!isNaN(parsedPage) && parsedPage >= 1) {
        page = parsedPage;
      }
    }

    let perPage = 50;
    const rawPerPage = payload?.per_page ?? payload?.limit;
    if (rawPerPage !== undefined && rawPerPage !== null) {
      const parsedPerPage = parseInt(String(rawPerPage), 10);
      if (!isNaN(parsedPerPage)) {
        perPage = Math.max(1, Math.min(500, parsedPerPage));
      }
    }

    const total = filtered.length;
    const startIdx = (page - 1) * perPage;
    const endIdx = startIdx + perPage;
    const paged = filtered.slice(startIdx, endIdx);

    return {
      ok: true,
      tasks: paged,
      items: paged,
      total,
      page,
      per_page: perPage,
    };
  },
  getWorkspaceQuestions: async (panel, payload, root) => {
    const aiOrchBin = panel?.cliClient?.resolveCliPath ? panel.cliClient.resolveCliPath(root) : null;
    const resolver = getProjectResolver(root, aiOrchBin);
    const { projects } = resolver.getWorkspaceInfo();

    const getProjQuestions = async (p: ProjectInfo) => {
      if (!fs.existsSync(p.tasksDir) || !fs.statSync(p.tasksDir).isDirectory()) return [];
      const args = ['questions', 'list', '--tasks-dir', p.tasksDir];
      if (payload?.status && payload.status !== 'all') args.push('--status', String(payload.status));
      if (payload?.blocks) args.push('--blocks', String(payload.blocks));
      try {
        const data = await panel.cliClient.runJsonCommand<any>(args, p.root);
        const items: any[] = (data && typeof data === 'object' && (data.questions || data.items)) || [];
        return items.map((item) => ({ ...item, project: p.id }));
      } catch {
        return [];
      }
    };

    const results = await Promise.all(projects.map((p) => getProjQuestions(p)));
    const allQuestions = results.flat();
    return { ok: true, questions: allQuestions, items: allQuestions };
  },
  getWorkspaceInbox: async (panel, payload, root) => {
    const aiOrchBin = panel?.cliClient?.resolveCliPath ? panel.cliClient.resolveCliPath(root) : null;
    const resolver = getProjectResolver(root, aiOrchBin);
    const { projects } = resolver.getWorkspaceInfo();

    const getProjInbox = async (p: ProjectInfo) => {
      if (!fs.existsSync(p.tasksDir) || !fs.statSync(p.tasksDir).isDirectory()) return [];
      const args = ['inbox', 'list', '--tasks-dir', p.tasksDir];
      if (payload?.status) args.push('--status', String(payload.status));
      try {
        const data = await panel.cliClient.runJsonCommand<any>(args, p.root);
        const items: any[] = (data && typeof data === 'object' && (data.notes || data.items)) || [];
        return items.map((item) => ({ ...item, project: p.id }));
      } catch {
        return [];
      }
    };

    const results = await Promise.all(projects.map((p) => getProjInbox(p)));
    const allNotes = results.flat();
    return { ok: true, notes: allNotes, items: allNotes };
  },
  getWorkspaceRuns: async (panel, payload, root) => {
    const aiOrchBin = panel?.cliClient?.resolveCliPath ? panel.cliClient.resolveCliPath(root) : null;
    const resolver = getProjectResolver(root, aiOrchBin);
    const { projects } = resolver.getWorkspaceInfo();

    const getProjRuns = async (p: ProjectInfo) => {
      const args = ['run', 'list', '--workspace', p.root];
      if (payload?.task) args.push('--task', String(payload.task));
      if (payload?.note) args.push('--note', String(payload.note));
      const active = payload?.active;
      if (active === true || (typeof active === 'string' && ['1', 'true', 'yes', ''].includes(active.toLowerCase()))) {
        args.push('--active');
      }
      try {
        const data = await panel.cliClient.runJsonCommand<any>(args, p.root);
        const items: any[] = (data && typeof data === 'object' && (data.runs || data.items)) || [];
        return items.map((item) => ({ ...item, project: p.id }));
      } catch {
        return [];
      }
    };

    const results = await Promise.all(projects.map((p) => getProjRuns(p)));
    const allRuns = results.flat();
    return { ok: true, runs: allRuns, items: allRuns };
  },
  switchWorkspace: async (panel, payload, root) => {
    const target = payload?.workspacePath;
    if (!target || !fs.existsSync(target)) {
      const err: any = new Error(`Invalid or nonexistent workspace path: ${target}`);
      err.status = 400;
      throw err;
    }
    invalidateProjectResolver(root);
    invalidateProjectResolver(target);
    await panel.bindWorkspace(target);
    return { ok: true, workspace_path: target };
  },
  getTaskDetail: async (panel, payload, root) => {
    const taskId = payload?.taskId || payload?.task_id;
    if (!taskId) {
      const err: any = new Error('taskId is required');
      err.status = 400;
      throw err;
    }
    if (!/^(T\d{3,}|\d{2,}\.\d+|INIT-\d{2,})$/.test(String(taskId))) {
      const err: any = new Error(`Invalid task id ${JSON.stringify(taskId)}`);
      err.status = 400;
      throw err;
    }
    const tasksDir = path.join(root, 'tasks');

    // Initiative tasks (NN.T) and synthetic initiative cards (INIT-NN) live in plan.md
    // (same behaviour as the web backend's api_get_task_detail).
    if (!String(taskId).startsWith('T')) {
      const id = String(taskId);
      const initId = id.startsWith('INIT-') ? id.slice(5) : id.split('.')[0];
      const plan = [tasksDir, path.join(tasksDir, 'done')]
        .flatMap((base) => (fs.existsSync(base) ? fs.readdirSync(base, { withFileTypes: true }) : [])
          .filter((d) => d.isDirectory() && d.name.startsWith(`${initId}-`))
          .map((d) => path.join(base, d.name, 'plan.md')))
        .find((f) => fs.existsSync(f));
      if (!plan) {
        const err: any = new Error(`Plan for initiative ${initId} not found`);
        err.status = 404;
        throw err;
      }
      const planText = fs.readFileSync(plan, 'utf-8');
      let content: string | null = planText;
      if (!id.startsWith('INIT-')) {
        const lines = planText.split('\n');
        const esc = id.replace('.', '\\.');
        const head = new RegExp(`^###\\s+${esc}\\s+[\u2014\u2013-]\\s+`);
        const start = lines.findIndex((l) => head.test(l));
        if (start < 0) {
          // Check for matching table row (e.g. | **T1** | ... |)
          const shortId = id.includes('.') ? id.split('.').pop()! : id;
          const tableRe = new RegExp(`^\\|\\s*\\*\\*(${esc}|${shortId})\\*\\*\\s*\\|\\s*(.+?)\\|`);
          const matchingRow = lines.find((l) => tableRe.test(l));
          if (matchingRow) {
            content = `### Task ${id}\n\n${matchingRow.trim()}\n\n---\n\n${planText}`;
          } else {
            content = null;
          }
        } else {
          let end = lines.length;
          for (let j = start + 1; j < lines.length; j++) {
            if (/^#{1,3}\s/.test(lines[j])) { end = j; break; }
          }
          content = lines.slice(start, end).join('\n').trimEnd() + '\n';
        }
      }
      if (content === null) {
        const err: any = new Error(`Task ${id} not found in ${path.relative(root, plan)}`);
        err.status = 404;
        throw err;
      }
      return {
        task_id: id,
        file_path: plan,
        relative_path: path.relative(root, plan),
        is_folder_bundle: false,
        is_plan_task: true,
        content,
        progress_content: null,
      };
    }

    const candidates = [
      ...panel.globFile(tasksDir, `*/${taskId}-*.md`),
      ...panel.globFile(tasksDir, `*/${taskId}/README.md`),
      ...panel.globFile(path.join(tasksDir, 'done'), `*/${taskId}-*.md`),
      ...panel.globFile(path.join(tasksDir, 'done'), `*/${taskId}/README.md`),
    ];

    if (candidates.length === 0) {
      const err: any = new Error(`Task ${taskId} file not found`);
      err.status = 404;
      throw err;
    }

    const targetFile = candidates[0];
    const content = fs.readFileSync(targetFile, 'utf-8');
    const progressFile = path.join(path.dirname(targetFile), 'PROGRESS.md');
    const progressContent = fs.existsSync(progressFile) ? fs.readFileSync(progressFile, 'utf-8') : null;

    return {
      task_id: taskId,
      file_path: targetFile,
      relative_path: path.relative(root, targetFile),
      is_folder_bundle: path.basename(targetFile) === 'README.md',
      content,
      progress_content: progressContent,
    };
  },
  askQuestion: async (panel, payload, root) => {
    const tasksDir = path.join(root, 'tasks');
    const cmd = ['questions', 'ask', '--tasks-dir', tasksDir];

    const fromTask = payload?.fromTask || payload?.from_task;
    if (fromTask) cmd.push('--from-task', String(fromTask));

    if (payload?.question) cmd.push('--question', String(payload.question));

    if (payload?.recommended) cmd.push('--recommended', String(payload.recommended));

    const openAnswer = payload?.openAnswer !== undefined ? payload.openAnswer : payload?.open_answer;
    if (openAnswer !== undefined && openAnswer !== null) {
      const oaStr = openAnswer === true ? 'yes' : openAnswer === false ? 'no' : String(openAnswer);
      cmd.push('--open-answer', oaStr);
    }

    if (payload?.blocks) {
      const blocks = payload.blocks;
      if (Array.isArray(blocks)) {
        cmd.push('--blocks', blocks.map(String).join(', '));
      } else {
        cmd.push('--blocks', String(blocks));
      }
    }

    if (payload?.decider) cmd.push('--decider', String(payload.decider));
    const askedBy = payload?.askedBy || payload?.asked_by;
    if (askedBy) cmd.push('--asked-by', String(askedBy));
    const originRun = payload?.originRun || payload?.origin_run;
    if (originRun) cmd.push('--origin-run', String(originRun));

    if (Array.isArray(payload?.options)) {
      for (const opt of payload.options) {
        if (typeof opt === 'object' && opt !== null) {
          const label = String(opt.label || '').trim();
          const title = String(opt.title || '').trim();
          const consequence = opt.consequence ? String(opt.consequence).trim() : null;
          let optArg = label;
          if (consequence) {
            optArg = `${label}=${title}: ${consequence}`;
          } else if (title) {
            optArg = `${label}=${title}`;
          }
          cmd.push('--option', optArg);
        } else if (typeof opt === 'string') {
          cmd.push('--option', opt);
        }
      }
    }

    let tempCtxFile: string | null = null;
    try {
      if (payload?.context !== undefined && payload?.context !== null) {
        const tmpDir = os.tmpdir();
        const rand = Math.random().toString(36).substring(2, 10);
        tempCtxFile = path.join(tmpDir, `ai-orch-context-${Date.now()}-${rand}.md`);
        fs.writeFileSync(tempCtxFile, String(payload.context), 'utf-8');
        cmd.push('--context-file', tempCtxFile);
      }

      const res = await panel.cliClient.runJsonCommand<any>(cmd, root);
      if (panel.onTasksUpdated) panel.onTasksUpdated();
      return res;
    } finally {
      if (tempCtxFile && fs.existsSync(tempCtxFile)) {
        try {
          fs.unlinkSync(tempCtxFile);
        } catch {}
      }
    }
  },
  uploadInboxAttachment: async (panel, payload, root) => {
    const id = requireNoteId(payload);
    const rawData = String(payload?.data || '');
    if (!rawData) {
      const err: any = new Error('data is required');
      err.status = 400;
      throw err;
    }
    const base64Str = rawData.includes(',') ? rawData.split(',')[1] : rawData;
    const buf = Buffer.from(base64Str, 'base64');
    if (buf.length > 10 * 1024 * 1024) {
      const err: any = new Error('Attachment exceeds 10 MB limit');
      err.status = 413;
      throw err;
    }

    const rawFilename = String(payload?.filename || payload?.name || 'attachment.png');
    const parsed = path.parse(rawFilename);
    const stem = parsed.name || 'attachment';
    const ext = parsed.ext || '.tmp';
    const sanitizedStem = stem.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^[-._]+|[-._]+$/g, '') || 'attachment';

    const rand = Math.random().toString(36).substring(2, 10);
    const tempFile = path.join(os.tmpdir(), `ai-orch-attach-${Date.now()}-${rand}${ext}`);

    try {
      fs.writeFileSync(tempFile, buf);
      const cmd = [
        'inbox', 'attach', id,
        '--file', tempFile,
        '--name', sanitizedStem,
        '--tasks-dir', path.join(root, 'tasks'),
      ];
      const res = await panel.cliClient.runJsonCommand<any>(cmd, root);
      panel.postMessage({ type: 'changed', areas: ['inbox', 'tasks'] });
      if (panel.onTasksUpdated) panel.onTasksUpdated();
      return res;
    } finally {
      if (tempFile && fs.existsSync(tempFile)) {
        try {
          fs.unlinkSync(tempFile);
        } catch {}
      }
    }
  },
  getInboxAttachment: async (panel, payload, root) => {
    const id = requireNoteId(payload);
    const name = requireAttachmentName(payload);

    const showCmd = ['inbox', 'show', id, '--tasks-dir', path.join(root, 'tasks')];
    let noteData: any;
    try {
      noteData = await panel.cliClient.runJsonCommand<any>(showCmd, root);
    } catch (e: any) {
      const err: any = new Error(`Note ${id} not found`);
      err.status = 404;
      throw err;
    }

    if (!noteData || !noteData.ok || !noteData.note || !noteData.note.folder_path) {
      const err: any = new Error(`Note ${id} folder not found`);
      err.status = 404;
      throw err;
    }

    const folderPath = path.resolve(String(noteData.note.folder_path));
    const attachmentsDir = path.join(folderPath, 'attachments');
    if (!fs.existsSync(attachmentsDir)) {
      const err: any = new Error(`Attachment ${name} not found`);
      err.status = 404;
      throw err;
    }

    const targetFile = path.join(attachmentsDir, name);
    if (!fs.existsSync(targetFile)) {
      const err: any = new Error(`Attachment ${name} not found`);
      err.status = 404;
      throw err;
    }

    const realAttachmentsDir = fs.realpathSync(attachmentsDir);
    const realTargetFile = fs.realpathSync(targetFile);

    const rel = path.relative(realAttachmentsDir, realTargetFile);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      const err: any = new Error('Path traversal detected');
      err.status = 400;
      throw err;
    }

    const stat = fs.statSync(realTargetFile);
    if (!stat.isFile()) {
      const err: any = new Error(`Attachment ${name} not found`);
      err.status = 404;
      throw err;
    }

    const buf = fs.readFileSync(realTargetFile);
    const contentType = sniffImageContentType(buf);
    return {
      data: buf.toString('base64'),
      content_type: contentType,
      contentType,
    };
  },
  uploadTaskAttachment: async (panel, payload, root) => {
    const id = requireTaskAttachmentId(payload);
    const rawData = String(payload?.data || '');
    if (!rawData) {
      const err: any = new Error('data is required');
      err.status = 400;
      throw err;
    }
    const base64Str = rawData.includes(',') ? rawData.split(',')[1] : rawData;
    const buf = Buffer.from(base64Str, 'base64');
    if (buf.length > 10 * 1024 * 1024) {
      const err: any = new Error('Attachment exceeds 10 MB limit');
      err.status = 413;
      throw err;
    }

    const rawFilename = String(payload?.filename || payload?.name || 'attachment.png');
    const parsed = path.parse(rawFilename);
    const stem = parsed.name || 'attachment';
    const ext = parsed.ext || '.tmp';
    const sanitizedStem = stem.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^[-._]+|[-._]+$/g, '') || 'attachment';

    const rand = Math.random().toString(36).substring(2, 10);
    const tempFile = path.join(os.tmpdir(), `ai-orch-task-attach-${Date.now()}-${rand}${ext}`);

    try {
      fs.writeFileSync(tempFile, buf);
      const cmd = [
        'tasks', 'attach', id,
        '--file', tempFile,
        '--name', sanitizedStem,
        '--tasks-dir', path.join(root, 'tasks'),
      ];
      const expectHash = payload?.expect_task_hash || payload?.expectTaskHash || payload?.expect_hash;
      if (expectHash) {
        cmd.push('--expect-task-hash', String(expectHash));
      }
      const res = await panel.cliClient.runJsonCommand<any>(cmd, root);
      panel.postMessage({ type: 'changed', areas: ['tasks'] });
      if (panel.onTasksUpdated) panel.onTasksUpdated();
      return res;
    } finally {
      if (tempFile && fs.existsSync(tempFile)) {
        try {
          fs.unlinkSync(tempFile);
        } catch {}
      }
    }
  },
  getTaskAttachment: async (panel, payload, root) => {
    const id = requireTaskAttachmentId(payload);
    const name = requireAttachmentName(payload);

    const tasksDir = path.join(root, 'tasks');
    let listData: any;
    try {
      listData = await panel.cliClient.runJsonCommand<any>(['tasks', 'list', '--tasks-dir', tasksDir], root);
    } catch (e: any) {
      const err: any = new Error(`Task ${id} not found`);
      err.status = 404;
      throw err;
    }

    if (!listData || typeof listData !== 'object') {
      const err: any = new Error(`Task ${id} not found`);
      err.status = 404;
      throw err;
    }

    let taskEntry: any = null;
    if (Array.isArray(listData.emergent_tasks)) {
      taskEntry = listData.emergent_tasks.find((t: any) => t && t.id === id);
    }
    if (!taskEntry && Array.isArray(listData.all_tasks)) {
      taskEntry = listData.all_tasks.find((t: any) => t && t.id === id);
    }
    if (!taskEntry && listData.tree && typeof listData.tree === 'object') {
      taskEntry = listData.tree[id];
    }

    if (!taskEntry) {
      const err: any = new Error(`Task ${id} not found`);
      err.status = 404;
      throw err;
    }

    let folderPathStr = taskEntry.task_root || taskEntry.folder_path;
    if (!folderPathStr && taskEntry.file_path) {
      folderPathStr = path.dirname(taskEntry.file_path);
    }

    const isFolder = taskEntry.is_folder ?? (Boolean(taskEntry.task_root || taskEntry.folder_path) || (taskEntry.file_path && path.basename(taskEntry.file_path) === 'README.md'));
    if (!isFolder || !folderPathStr) {
      const err: any = new Error(`Task ${id} has no attachments`);
      err.status = 404;
      throw err;
    }

    const folderPath = path.isAbsolute(folderPathStr) ? path.resolve(folderPathStr) : path.resolve(root, folderPathStr);
    const attachmentsDir = path.join(folderPath, 'attachments');
    if (!fs.existsSync(attachmentsDir)) {
      const err: any = new Error(`Attachment ${name} not found`);
      err.status = 404;
      throw err;
    }

    const targetFile = path.join(attachmentsDir, name);
    if (!fs.existsSync(targetFile)) {
      const err: any = new Error(`Attachment ${name} not found`);
      err.status = 404;
      throw err;
    }

    const realAttachmentsDir = fs.realpathSync(attachmentsDir);
    const realTargetFile = fs.realpathSync(targetFile);

    const rel = path.relative(realAttachmentsDir, realTargetFile);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      const err: any = new Error('Path traversal detected');
      err.status = 400;
      throw err;
    }

    const stat = fs.statSync(realTargetFile);
    if (!stat.isFile()) {
      const err: any = new Error(`Attachment ${name} not found`);
      err.status = 404;
      throw err;
    }

    const buf = fs.readFileSync(realTargetFile);
    const contentType = classifyAttachmentContentType(buf);
    if (!contentType) {
      const err: any = new Error('Unsupported attachment format');
      err.status = 415;
      throw err;
    }
    return {
      data: buf.toString('base64'),
      content_type: contentType,
      contentType,
    };
  },
  getTriageProposal: async (panel, payload, root) => {
    const id = requireRunId(payload);
    let data: any;
    try {
      data = await panel.cliClient.runJsonCommand<any>(['run', 'show', id, '--workspace', root], root);
    } catch (e: any) {
      const errStr = String(e?.message || '').toLowerCase();
      if (errStr.includes('not found') || errStr.includes('not-found')) {
        const err: any = new Error(`Run ${id} not found`);
        err.status = 404;
        throw err;
      }
      throw e;
    }
    const runRecord = data && typeof data === 'object' && data.run && typeof data.run === 'object'
      ? data.run
      : (data && typeof data === 'object' ? data : {});

    if (runRecord.mode && runRecord.mode !== 'triage') {
      const err: any = new Error(`Run '${id}' is not a triage run (mode=${runRecord.mode})`);
      err.status = 400;
      throw err;
    }

    let proposalStatus = runRecord.proposal_status ?? null;
    let proposalError = runRecord.proposal_error ?? null;
    let proposal = runRecord.triage_proposal ?? runRecord.proposal ?? null;

    if (proposal === null) {
      const proposalFile = path.join(root, '.ai-orchestration', 'runs', id, 'triage-proposal.json');
      if (fs.existsSync(proposalFile)) {
        try {
          proposal = JSON.parse(fs.readFileSync(proposalFile, 'utf-8'));
        } catch (e: any) {
          if (!proposalError) {
            proposalError = `Failed to parse stored proposal JSON: ${e.message}`;
          }
        }
      }
    }

    if (proposalStatus === null && proposal !== null) {
      proposalStatus = 'pending';
    }

    return {
      ok: true,
      run_id: id,
      proposal_status: proposalStatus,
      proposal_error: proposalError,
      proposal,
    };
  },
  previewPromoteMicrotask: async (panel, payload, root) => {
    const taskId = requireMicrotaskId(payload);
    const category = String(payload?.category || 'maintenance').trim() || 'maintenance';
    const tasksDir = path.join(root, 'tasks');

    let targetFile: string | null = null;
    for (const pdir of [path.join(tasksDir, 'micro'), path.join(tasksDir, 'done', 'micro')]) {
      if (fs.existsSync(pdir) && fs.statSync(pdir).isDirectory()) {
        const files = fs.readdirSync(pdir);
        for (const f of files) {
          if (f.startsWith(`${taskId}-`) && f.endsWith('.md') && f !== 'README.md') {
            targetFile = path.join(pdir, f);
            break;
          }
        }
      }
      if (targetFile) break;
    }

    if (!targetFile || !fs.existsSync(targetFile)) {
      const err: any = new Error(`Microtask ${taskId} not found in tasks/micro/`);
      err.status = 404;
      throw err;
    }

    const fileBytes = fs.readFileSync(targetFile);
    const taskHash = crypto.createHash('sha256').update(fileBytes).digest('hex');

    const expectTaskHash = payload?.expect_task_hash || payload?.expect_hash;
    if (expectTaskHash && String(expectTaskHash).toLowerCase() !== taskHash.toLowerCase()) {
      const err: any = new Error(`Task hash mismatch: expected ${expectTaskHash}, actual ${taskHash}`);
      err.status = 409;
      throw err;
    }

    const baseName = path.basename(targetFile);
    const diffStr = `--- ${baseName}\n+++ tasks/${category}/${baseName}\n(Promote microtask to full emergent task in category '${category}' with Goal, Steps, and Verification)\n`;
    return {
      ok: true,
      dry_run: true,
      id: taskId,
      task_id: taskId,
      category,
      summary: `Promote microtask ${taskId} to category '${category}'`,
      diff: diffStr,
      hash: taskHash,
      task_hash: taskHash,
      base_task_hash: taskHash,
    };
  },
  inboxToMicrotask: async (panel, payload, root) => {
    const noteId = requireNoteId({ id: payload?.noteId || payload?.id || payload?.note_id });
    const tasksDir = path.join(root, 'tasks');

    let note: any = {};
    try {
      const showData = await panel.cliClient.runJsonCommand<any>(['inbox', 'show', noteId, '--tasks-dir', tasksDir], root);
      if (!showData || !showData.ok || !showData.note) {
        const err: any = new Error(`Note ${noteId} not found`);
        err.status = 404;
        throw err;
      }
      note = showData.note;
    } catch (e: any) {
      if (e.status === 404 || String(e.message).includes('not found')) {
        const err: any = new Error(`Note ${noteId} not found`);
        err.status = 404;
        throw err;
      }
      throw e;
    }

    const title = String(payload?.title || note.title || `Issue from note ${noteId}`).trim();
    let kind = String(payload?.kind || (VALID_KINDS.has(note.kind) ? note.kind : 'bug')).trim().toLowerCase();
    if (!VALID_KINDS.has(kind)) kind = 'bug';
    const priority = String(payload?.priority || 'P2').trim().toUpperCase();
    const what = payload?.what || note.body || `Created from inbox note ${noteId}.`;

    const labels = extractLabels(payload?.labels || payload?.label);
    if (!labels.length && note.about) {
      for (const ab of String(note.about).split(/[\s,]+/)) {
        const clean = ab.trim().toLowerCase().replace(/[^a-z0-9-]/g, '');
        if (clean && LABEL_RE.test(clean) && !labels.includes(clean)) {
          labels.push(clean);
        }
      }
    }

    const cmd = [
      'tasks', 'micro',
      '--title', title,
      '--kind', kind,
      '--priority', priority,
      '--tasks-dir', tasksDir,
    ];
    if (payload?.paths) cmd.push('--paths', String(payload.paths));
    const dependsOn = payload?.depends_on || payload?.dependsOn;
    if (dependsOn) cmd.push('--depends-on', String(dependsOn));
    if (payload?.executor) cmd.push('--executor', String(payload.executor));
    if (what) cmd.push('--what', String(what));
    for (const lbl of labels) {
      cmd.push('--label', lbl);
    }

    const res = await panel.cliClient.runJsonCommand<any>(cmd, root);
    const taskId = res?.id;
    if (taskId) {
      try {
        await panel.cliClient.runJsonCommand<any>(['inbox', 'resolve', noteId, '--produced', taskId, '--tasks-dir', tasksDir], root);
      } catch {}
    }

    panel.postMessage({ type: 'changed', areas: ['inbox', 'tasks'] });
    if (taskId) {
      panel.postMessage({ type: 'task_created', task_id: taskId });
    }
    if (panel.onTasksUpdated) panel.onTasksUpdated();
    return res;
  },
  previewAnswerAndResume: async (panel, payload, root) => {
    const qid = requireQuestionId(payload);
    const choice = payload?.choice;
    if (!choice) {
      const err: any = new Error('choice is required');
      err.status = 400;
      throw err;
    }

    const tasksDir = path.join(root, 'tasks');
    const qRes = await panel.cliClient.runJsonCommand<any>(['questions', 'show', qid, '--tasks-dir', tasksDir], root);
    const qData = qRes?.question || qRes || {};
    if (qData.status && qData.status !== 'open') {
      const err: any = new Error(`Question ${qid} is already ${qData.status}`);
      err.status = 400;
      throw err;
    }

    const originRun = qData.origin_run || qData['origin-run'];
    const { isCont, reason, record } = checkOriginRunContinuable(root, originRun);

    if (!isCont) {
      return {
        ok: true,
        continuable: false,
        can_resume: false,
        reason,
        question_id: qid,
        origin_run: originRun && originRun !== '-' ? originRun : null,
      };
    }

    const planHash = record?.plan_hash || '';
    const prompt = formatContinuationInstructions(
      qid,
      qData.question || '',
      String(choice),
      payload?.text,
      qData.options
    );

    return {
      ok: true,
      continuable: true,
      can_resume: true,
      run_id: originRun,
      origin_run: originRun,
      question_id: qid,
      plan_hash: planHash,
      prompt,
      instructions: prompt,
    };
  },
  answerAndResume: async (panel, payload, root) => {
    const qid = requireQuestionId(payload);
    const choice = payload?.choice;
    if (!choice) {
      const err: any = new Error('choice is required');
      err.status = 400;
      throw err;
    }

    const tasksDir = path.join(root, 'tasks');
    const qRes = await panel.cliClient.runJsonCommand<any>(['questions', 'show', qid, '--tasks-dir', tasksDir], root);
    const qData = qRes?.question || qRes || {};
    if (qData.status && qData.status !== 'open') {
      const err: any = new Error(`Question ${qid} is already ${qData.status}`);
      err.status = 400;
      throw err;
    }

    const originRun = qData.origin_run || qData['origin-run'];
    const { isCont, reason, record } = checkOriginRunContinuable(root, originRun);

    const textStr = payload?.text !== undefined && payload?.text !== null ? String(payload.text) : null;
    if (textStr && Buffer.byteLength(textStr, 'utf-8') > 32 * 1024) {
      const err: any = new Error('Answer text exceeds 32 KB limit');
      err.status = 400;
      throw err;
    }

    if (isCont) {
      const planHash = record?.plan_hash || '';
      const expectPlanHash = payload?.expect_plan_hash || payload?.expect_hash;
      if (!expectPlanHash) {
        const err: any = new Error('expect_plan_hash is required for continuable run');
        err.status = 400;
        throw err;
      }
      if (String(expectPlanHash).trim().toLowerCase() !== planHash.trim().toLowerCase()) {
        const err: any = new Error(`Plan hash mismatch: expected ${expectPlanHash}, actual ${planHash}`);
        err.status = 409;
        err.data = {
          error: 'plan-hash-mismatch',
          detail: `Plan hash mismatch: expected ${expectPlanHash}, actual ${planHash}`,
        };
        throw err;
      }
    }

    // 1. Answer question
    const ansCmd = ['questions', 'answer', qid, '--choice', String(choice), '--tasks-dir', tasksDir];
    if (textStr) ansCmd.push('--text', textStr);
    if (payload?.by) ansCmd.push('--by', String(payload.by));

    await panel.cliClient.runJsonCommand<any>(ansCmd, root);

    // 2. If continuable, start continuation run
    if (isCont) {
      const prompt = formatContinuationInstructions(
        qid,
        qData.question || '',
        String(choice),
        textStr,
        qData.options
      );
      const continueCmd = [
        'run', 'start',
        '--continue', originRun,
        '--instructions', prompt,
        '--expect-plan-hash', record?.plan_hash || '',
        '--requested-by', 'vscode',
        '--workspace', root,
      ];

      let rData: any = null;
      let rErr: any = null;
      try {
        rData = await panel.cliClient.runJsonCommand<any>(continueCmd, root);
      } catch (e: any) {
        rErr = e;
      }

      panel.postMessage({ type: 'changed', areas: ['questions', 'tasks', 'runs'] });
      panel.postMessage({ type: 'question_answered', question_id: qid, choice: String(choice) });
      if (panel.onTasksUpdated) panel.onTasksUpdated();

      if (!rErr) {
        return {
          ok: true,
          question_id: qid,
          choice,
          resumed: true,
          run_id: rData?.run_id ?? null,
          continued_from: originRun,
          instructions: prompt,
        };
      } else {
        const errMsg = rErr.data?.error || rErr.message || String(rErr);
        return {
          ok: true,
          question_id: qid,
          choice,
          resumed: false,
          reason: `Run continue failed to start: ${errMsg}`,
          continued_from: originRun,
          instructions: prompt,
        };
      }
    } else {
      panel.postMessage({ type: 'changed', areas: ['questions', 'tasks', 'runs'] });
      panel.postMessage({ type: 'question_answered', question_id: qid, choice: String(choice) });
      if (panel.onTasksUpdated) panel.onTasksUpdated();
      return {
        ok: true,
        question_id: qid,
        choice,
        resumed: false,
        reason,
      };
    }
  },
  getSessions: async (panel, payload, root) => {
    const cmd = ['sessions', 'list', '--workspace', root];
    if (payload?.role) cmd.push('--role', String(payload.role));
    if (payload?.status) cmd.push('--status', String(payload.status));
    if (payload?.tool) cmd.push('--tool', String(payload.tool));

    const data = await panel.cliClient.runJsonCommand<any>(cmd, root);
    const sessionsList = Array.isArray(data)
      ? data
      : (data && typeof data === 'object' && Array.isArray(data.sessions) ? data.sessions : []);
    return { ok: true, sessions: sessionsList };
  },
  getSession: async (panel, payload, root) => {
    const sessionId = String(payload?.sessionId || payload?.session_id || payload?.id || '').trim();
    if (!sessionId) {
      const err: any = new Error('sessionId is required');
      err.status = 400;
      throw err;
    }
    const cmd = ['sessions', 'show', sessionId, '--workspace', root];
    try {
      const data = await panel.cliClient.runJsonCommand<any>(cmd, root);
      return data && typeof data === 'object' && !Array.isArray(data) ? data : { session: data };
    } catch (e: any) {
      const errStr = String(e?.data?.error || e?.message || '').toLowerCase();
      if (errStr.includes('not found') || errStr.includes('no session')) {
        const err: any = new Error(e.message || `Session not found: ${sessionId}`);
        err.status = 404;
        err.data = e.data;
        throw err;
      }
      throw e;
    }
  },
  getRoleHolder: async (panel, payload, root) => {
    const roleName = String(payload?.role || 'orchestrator').trim();
    const cmd = ['sessions', 'show', '--role', roleName, '--workspace', root];
    try {
      const data = await panel.cliClient.runJsonCommand<any>(cmd, root);
      return data && typeof data === 'object' && !Array.isArray(data) ? data : { role: data };
    } catch (e: any) {
      const errStr = String(e?.data?.error || e?.message || '').toLowerCase();
      if (errStr.includes('not found') || errStr.includes('no holder') || errStr.includes('no active holder')) {
        const err: any = new Error(e.message || `No active holder for role: ${roleName}`);
        err.status = 404;
        err.data = e.data;
        throw err;
      }
      throw e;
    }
  },
  runTriggersOnce: async (panel, payload, root) => {
    const cmd = ['triggers', 'run-once', '--workspace', root];
    if (payload?.dry_run || payload?.dryRun) cmd.push('--dry-run');
    if (payload?.role) cmd.push('--role', String(payload.role));

    const data = await panel.cliClient.runJsonCommand<any>(cmd, root);
    panel.postMessage({ type: 'triggers_run', result: data });
    panel.postMessage({ type: 'changed', areas: ['triggers', 'events'] });
    return data;
  },
  previewToggleTrigger: async (panel, payload, root) => {
    const ruleName = payload?.rule_name || payload?.ruleName;
    const killSwitch = payload?.kill_switch !== undefined ? payload.kill_switch : payload?.killSwitch;
    const enabled = Boolean(payload?.enabled);

    const targetCfg = getActiveTriggerConfigPath(root);
    const { oldText, newText, diffStr, oldHash } = computeTriggerToggle(targetCfg, ruleName, killSwitch, enabled);

    return {
      ok: true,
      path: targetCfg,
      diff: diffStr,
      hash: oldHash,
      changed: oldText !== newText,
    };
  },
  toggleTrigger: async (panel, payload, root) => {
    const expectHash = payload?.expect_hash || payload?.expectHash;
    if (!expectHash) {
      const err: any = new Error('expect_hash is required');
      err.status = 400;
      throw err;
    }

    const ruleName = payload?.rule_name || payload?.ruleName;
    const killSwitch = payload?.kill_switch !== undefined ? payload.kill_switch : payload?.killSwitch;
    const enabled = Boolean(payload?.enabled);

    const targetCfg = getActiveTriggerConfigPath(root);
    const { oldText, newText, diffStr, oldHash } = computeTriggerToggle(targetCfg, ruleName, killSwitch, enabled);

    if (String(expectHash).toLowerCase() !== oldHash.toLowerCase()) {
      const err: any = new Error(`Config hash mismatch: expected ${expectHash}, actual ${oldHash}`);
      err.status = 409;
      throw err;
    }

    const parentDir = path.dirname(targetCfg);
    if (!fs.existsSync(parentDir)) {
      fs.mkdirSync(parentDir, { recursive: true });
    }
    fs.writeFileSync(targetCfg, newText, 'utf-8');

    panel.postMessage({ type: 'config_updated' });
    panel.postMessage({ type: 'changed', areas: ['config', 'triggers'] });

    return {
      ok: true,
      applied: true,
      path: targetCfg,
      hash: crypto.createHash('sha256').update(Buffer.from(newText, 'utf-8')).digest('hex'),
    };
  },
  getProposedActions: async (panel, payload, root) => {
    const propDir = path.join(root, '.ai-orchestration', 'proposed_actions');
    const records: any[] = [];
    if (fs.existsSync(propDir) && fs.statSync(propDir).isDirectory()) {
      const entries = fs.readdirSync(propDir).filter((name) => name.endsWith('.json') && !name.startsWith('.'));
      entries.sort();
      for (const entry of entries) {
        const fullPath = path.join(propDir, entry);
        try {
          if (fs.statSync(fullPath).isFile()) {
            const raw = fs.readFileSync(fullPath, 'utf-8');
            records.push(JSON.parse(raw));
          }
        } catch {}
      }
    }
    records.sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
    return {
      ok: true,
      proposed_actions: records,
      count: records.length,
    };
  },
  confirmProposedAction: async (panel, payload, root) => {
    const actionId = String(payload?.actionId || payload?.action_id || payload?.id || '');
    const cleanId = actionId.endsWith('.json') ? actionId.slice(0, -5) : actionId;
    if (!cleanId || !PROPOSAL_ACTION_ID_RE.test(cleanId)) {
      const err: any = new Error(`Action ID '${actionId}' is invalid (must be alphanumeric/hyphens/underscores without path separators).`);
      err.status = 400;
      err.data = {
        ok: false,
        action_id: actionId,
        error: 'invalid_action_id',
        message: `Action ID '${actionId}' is invalid (must be alphanumeric/hyphens/underscores without path separators).`,
      };
      throw err;
    }

    const expectHash = payload?.expect_hash || payload?.expectHash;
    if (!expectHash || typeof expectHash !== 'string' || !expectHash.trim()) {
      const err: any = new Error("Field 'expect_hash' is required and must be non-empty.");
      err.status = 400;
      err.data = {
        ok: false,
        action_id: cleanId,
        error: 'missing_expect_hash',
        message: "Field 'expect_hash' is required and must be non-empty.",
      };
      throw err;
    }

    const cmd = [
      'triggers',
      'confirm',
      cleanId,
      '--expect-hash',
      expectHash.trim(),
      '--actor',
      'vscode',
      '--workspace',
      root,
    ];

    try {
      const data = await panel.cliClient.runJsonCommand<any>(cmd, root);
      const areas = ['triggers', 'events'];
      if (data && typeof data === 'object' && data.run_id) {
        areas.push('runs');
      }
      panel.postMessage({ type: 'changed', areas });
      return data;
    } catch (e: any) {
      const errData = e.data || {};
      const errType = typeof errData === 'object' ? errData.error : '';
      let status = e.status;
      if (errType === 'proposal_not_found') {
        status = 404;
      } else if (errType === 'not_pending' || errType === 'hash_mismatch' || errType === 'plan_hash_mismatch') {
        status = 409;
      } else if (errType === 'disallowed_command') {
        status = 400;
      } else if (errType === 'preview_failed' || errType === 'start_failed') {
        status = 502;
      }
      e.status = status;
      throw e;
    }
  },
  rejectProposedAction: async (panel, payload, root) => {
    const actionId = String(payload?.actionId || payload?.action_id || payload?.id || '');
    const cleanId = actionId.endsWith('.json') ? actionId.slice(0, -5) : actionId;
    if (!cleanId || !PROPOSAL_ACTION_ID_RE.test(cleanId)) {
      const err: any = new Error(`Action ID '${actionId}' is invalid (must be alphanumeric/hyphens/underscores without path separators).`);
      err.status = 400;
      err.data = {
        ok: false,
        action_id: actionId,
        error: 'invalid_action_id',
        message: `Action ID '${actionId}' is invalid (must be alphanumeric/hyphens/underscores without path separators).`,
      };
      throw err;
    }

    const reason = payload?.reason;
    if (!reason || typeof reason !== 'string' || !reason.trim()) {
      const err: any = new Error("Field 'reason' is required and must be non-empty.");
      err.status = 400;
      err.data = {
        ok: false,
        action_id: cleanId,
        error: 'missing_reason',
        message: "Field 'reason' is required and must be non-empty.",
      };
      throw err;
    }

    if (reason.trim().length > 1000) {
      const err: any = new Error('Reason exceeds maximum length of 1000 characters.');
      err.status = 400;
      err.data = {
        ok: false,
        action_id: cleanId,
        error: 'reason_too_long',
        message: 'Reason exceeds maximum length of 1000 characters.',
      };
      throw err;
    }

    const cmd = [
      'triggers',
      'reject',
      cleanId,
      '--reason',
      reason.trim(),
      '--actor',
      'vscode',
      '--workspace',
      root,
    ];

    try {
      const data = await panel.cliClient.runJsonCommand<any>(cmd, root);
      panel.postMessage({ type: 'changed', areas: ['triggers', 'events'] });
      return data;
    } catch (e: any) {
      const errData = e.data || {};
      const errType = typeof errData === 'object' ? errData.error : '';
      let status = e.status;
      if (errType === 'proposal_not_found') {
        status = 404;
      } else if (errType === 'not_pending' || errType === 'hash_mismatch') {
        status = 409;
      } else if (errType === 'missing_reason' || errType === 'disallowed_command') {
        status = 400;
      }
      e.status = status;
      throw e;
    }
  },
  getQuestionsAwaitingApplication: async (panel, payload, root) => {
    const tasksDir = path.join(root, 'tasks');
    const data = await panel.cliClient.runJsonCommand<any>(
      ['questions', 'list', '--tasks-dir', tasksDir, '--status', 'answered'],
      root
    );
    const allQuestions = Array.isArray(data?.questions) ? data.questions : [];
    const awaiting = allQuestions.filter((q: any) => !q.applied);
    return {
      ok: true,
      questions: awaiting,
      count: awaiting.length,
    };
  },
  applyQuestion: async (panel, payload, root) => {
    const qId = requireQuestionId(payload);
    const tasksDir = path.join(root, 'tasks');
    const cmd = ['questions', 'apply', qId, '--tasks-dir', tasksDir];
    if (payload?.by) cmd.push('--by', String(payload.by));
    if (payload?.ref) cmd.push('--ref', String(payload.ref));
    if (payload?.note) cmd.push('--note', String(payload.note));
    if (payload?.force) cmd.push('--force');
    if (payload?.dry_run || payload?.dryRun) cmd.push('--dry-run');

    const data = await panel.cliClient.runJsonCommand<any>(cmd, root);
    if (!payload?.dry_run && !payload?.dryRun) {
      panel.postMessage({ type: 'question_applied', question_id: qId });
      panel.postMessage({ type: 'changed', areas: ['questions', 'tasks'] });
    }
    return (data && typeof data === 'object') ? data : { ok: true, id: qId };
  },
  getOrchestratorQueue: async (panel, payload, root) => {
    const qDir = path.join(root, '.ai-orchestration', 'orchestrator', 'queue');
    const items: any[] = [];
    if (fs.existsSync(qDir) && fs.statSync(qDir).isDirectory()) {
      const entries = fs.readdirSync(qDir).filter((name) => name.endsWith('.json') && !name.startsWith('.'));
      entries.sort();
      for (const entry of entries) {
        const fullPath = path.join(qDir, entry);
        try {
          if (fs.statSync(fullPath).isFile()) {
            const raw = fs.readFileSync(fullPath, 'utf-8');
            items.push(JSON.parse(raw));
          }
        } catch {}
      }
    }
    items.sort((a, b) => Number(a.turn_seq || 0) - Number(b.turn_seq || 0));
    return {
      ok: true,
      queue: items,
      count: items.length,
    };
  },
  getNotifications: async (panel, payload, root) => {
    const notifDir = path.join(root, '.ai-orchestration', 'notifications');
    const notifications: any[] = [];
    if (fs.existsSync(notifDir) && fs.statSync(notifDir).isDirectory()) {
      const entries = fs.readdirSync(notifDir).filter((name) => name.endsWith('.json') && !name.startsWith('.'));
      entries.sort();
      for (const entry of entries) {
        const fullPath = path.join(notifDir, entry);
        try {
          if (fs.statSync(fullPath).isFile()) {
            const raw = fs.readFileSync(fullPath, 'utf-8');
            notifications.push(JSON.parse(raw));
          }
        } catch {}
      }
    }
    notifications.sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));

    let recentEvents: any[] = [];
    try {
      const res = await panel.cliClient.runJsonCommand<any>(
        ['events', 'tail', '--limit', '25', '--workspace', root],
        root
      );
      if (res && Array.isArray(res.events)) {
        recentEvents = res.events;
      }
    } catch {}

    const unreadCount = notifications.filter((n) => !n.read).length;
    return {
      ok: true,
      notifications,
      recent_events: recentEvents,
      unread_count: unreadCount,
    };
  },
  markNotificationRead: async (panel, payload, root) => {
    const notifId = String(payload?.id || payload?.notifId || payload?.notif_id || '').trim();
    const notifDir = path.join(root, '.ai-orchestration', 'notifications');

    if (!notifId || notifId.includes('/') || notifId.includes('\\') || notifId.includes('..')) {
      const err: any = new Error(`Invalid notification ID ${JSON.stringify(notifId)}`);
      err.status = 400;
      throw err;
    }

    if (notifId === 'all') {
      if (fs.existsSync(notifDir) && fs.statSync(notifDir).isDirectory()) {
        const entries = fs.readdirSync(notifDir).filter((name) => name.endsWith('.json') && !name.startsWith('.'));
        for (const entry of entries) {
          const fullPath = path.join(notifDir, entry);
          try {
            const data = JSON.parse(fs.readFileSync(fullPath, 'utf-8'));
            data.read = true;
            fs.writeFileSync(fullPath, JSON.stringify(data, null, 2), 'utf-8');
          } catch {}
        }
      }
      panel.postMessage({ type: 'changed', areas: ['notifications'] });
      return { ok: true, marked_all: true };
    }

    const filename = notifId.endsWith('.json') ? notifId : `${notifId}.json`;
    const target = path.join(notifDir, filename);
    if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
      const err: any = new Error('Notification not found');
      err.status = 404;
      throw err;
    }

    try {
      const data = JSON.parse(fs.readFileSync(target, 'utf-8'));
      data.read = true;
      fs.writeFileSync(target, JSON.stringify(data, null, 2), 'utf-8');
      panel.postMessage({ type: 'changed', areas: ['notifications'] });
      return { ok: true, id: notifId };
    } catch (e: any) {
      const err: any = new Error(e.message || String(e));
      err.status = 500;
      throw err;
    }
  },
  markAllNotificationsRead: async (panel, payload, root) => {
    const notifDir = path.join(root, '.ai-orchestration', 'notifications');
    if (fs.existsSync(notifDir) && fs.statSync(notifDir).isDirectory()) {
      const entries = fs.readdirSync(notifDir).filter((name) => name.endsWith('.json') && !name.startsWith('.'));
      for (const entry of entries) {
        const fullPath = path.join(notifDir, entry);
        try {
          const data = JSON.parse(fs.readFileSync(fullPath, 'utf-8'));
          data.read = true;
          fs.writeFileSync(fullPath, JSON.stringify(data, null, 2), 'utf-8');
        } catch {}
      }
    }
    panel.postMessage({ type: 'changed', areas: ['notifications'] });
    return { ok: true, marked_all: true };
  },
  getOrchestratorStatus: async (panel, payload, root) => {
    const data = await panel.cliClient.runJsonCommand<any>(
      ['orchestrator', 'status', '--workspace', root],
      root
    );
    if (data && typeof data === 'object') {
      if (data.rotate_after_tokens === undefined) {
        data.rotate_after_tokens = getRotateAfterTokens(root);
      }
      if (data.ok === undefined) {
        data.ok = true;
      }
    }
    return data;
  },
  postOrchestratorChat: async (panel, payload, root) => {
    const message = payload?.message;
    if (message === undefined || message === null || !String(message).trim()) {
      const err: any = new Error('message is required and must not be empty');
      err.status = 400;
      err.data = { error: 'message is required and must not be empty' };
      throw err;
    }
    const turnType = String(payload?.type || 'owner_chat');
    const priority = String(payload?.priority || 'owner');
    const args = [
      'orchestrator',
      'enqueue',
      '--message',
      String(message).trim(),
      '--type',
      turnType,
      '--priority',
      priority,
      '--workspace',
      root,
    ];
    if (payload?.policy) {
      args.push('--policy', String(payload.policy));
    }
    const data = await panel.cliClient.runJsonCommand<any>(args, root);
    const turnRec = data && typeof data === 'object' ? data.turn ?? null : null;
    panel.postMessage({ type: 'turn_queued', turn: turnRec });
    panel.postMessage({ type: 'changed', areas: ['orchestrator', 'queue', 'events'] });
    return data && typeof data === 'object' ? data : { ok: true, result: data };
  },
  getOrchestratorConversation: async (panel, payload, root) => {
    const limit = payload?.limit !== undefined && payload?.limit !== null ? parseInt(String(payload.limit), 10) : 50;
    const offset = payload?.offset !== undefined && payload?.offset !== null ? parseInt(String(payload.offset), 10) : 0;
    const safeLimit = isNaN(limit) ? 50 : limit;
    const safeOffset = isNaN(offset) ? 0 : offset;
    const order = String(payload?.order || 'asc').toLowerCase();

    const tDir = path.join(root, '.ai-orchestration', 'orchestrator', 'turns');
    const qDir = path.join(root, '.ai-orchestration', 'orchestrator', 'queue');

    const turnsById = new Map<string, any>();

    // 1. Read archived/completed turns
    if (fs.existsSync(tDir) && fs.statSync(tDir).isDirectory()) {
      const dirs = fs.readdirSync(tDir);
      for (const d of dirs) {
        if (d.startsWith('.')) continue;
        const dPath = path.join(tDir, d);
        if (!fs.existsSync(dPath) || !fs.statSync(dPath).isDirectory()) continue;

        const tJson = path.join(dPath, 'turn.json');
        if (fs.existsSync(tJson) && fs.statSync(tJson).isFile()) {
          try {
            const rec = JSON.parse(fs.readFileSync(tJson, 'utf-8'));
            const turnId = String(rec.turn_id || d);
            let createdTs = rec.created_at || rec.queued_at || rec.started_at || rec.ended_at;
            if (!createdTs) {
              try {
                createdTs = fs.statSync(tJson).mtime.toISOString();
              } catch {
                createdTs = '';
              }
            }
            if (!rec.created_at) rec.created_at = createdTs;
            let assistantMsgs = rec.assistant_messages;
            if (!assistantMsgs && rec.state === 'running') {
              assistantMsgs = readPartialAssistantMessages(dPath);
              rec.assistant_messages = assistantMsgs;
            }
            if (rec.output === undefined) {
              rec.output = Array.isArray(assistantMsgs) ? assistantMsgs.join('\n\n') : String(assistantMsgs || '');
            }
            turnsById.set(turnId, rec);
          } catch {}
        } else {
          try {
            const pFile = path.join(dPath, 'prompt.txt');
            const promptText = fs.existsSync(pFile) && fs.statSync(pFile).isFile() ? fs.readFileSync(pFile, 'utf-8') : '';
            const inFile = path.join(dPath, 'input.json');
            const inData = fs.existsSync(inFile) && fs.statSync(inFile).isFile() ? JSON.parse(fs.readFileSync(inFile, 'utf-8')) : {};
            const partialMsgs = readPartialAssistantMessages(dPath);
            let createdTs = inData.created_at;
            if (!createdTs) {
              try {
                createdTs = fs.statSync(dPath).mtime.toISOString();
              } catch {
                createdTs = '';
              }
            }
            const firstPart = d.split('-')[0];
            const parsedSeq = parseInt(firstPart, 10);
            turnsById.set(d, {
              turn_id: d,
              turn_seq: !isNaN(parsedSeq) && /^\d+$/.test(firstPart) ? parsedSeq : 0,
              state: 'running',
              type: inData.turn_type || 'owner_chat',
              prompt_text: promptText,
              message: inData.prompt_text,
              output: partialMsgs.join('\n\n'),
              assistant_messages: partialMsgs,
              created_at: createdTs || '',
            });
          } catch {}
        }
      }
    }

    // 2. Read active queue items
    if (fs.existsSync(qDir) && fs.statSync(qDir).isDirectory()) {
      const qFiles = fs.readdirSync(qDir);
      for (const f of qFiles) {
        if (!f.endsWith('.json') || f.startsWith('.')) continue;
        const qPath = path.join(qDir, f);
        try {
          const qRec = JSON.parse(fs.readFileSync(qPath, 'utf-8'));
          const stem = f.slice(0, -5);
          const tid = String(qRec.turn_id || stem);
          const qTs = qRec.created_at || qRec.queued_at || '';
          if (!qRec.created_at) qRec.created_at = qTs;

          if (turnsById.has(tid)) {
            const existing = turnsById.get(tid);
            if (['running', 'claimed', 'queued'].includes(existing.state || qRec.state) && existing.state !== 'done') {
              Object.assign(existing, qRec);
              if (!existing.assistant_messages || existing.assistant_messages.length === 0) {
                const tSubdir = path.join(tDir, tid);
                if (fs.existsSync(tSubdir) && fs.statSync(tSubdir).isDirectory()) {
                  const partialMsgs = readPartialAssistantMessages(tSubdir);
                  existing.assistant_messages = partialMsgs;
                  existing.output = partialMsgs.join('\n\n');
                }
              }
            }
          } else {
            if (qRec.output === undefined) qRec.output = '';
            if (qRec.assistant_messages === undefined) qRec.assistant_messages = [];
            const tSubdir = path.join(tDir, tid);
            if (fs.existsSync(tSubdir) && fs.statSync(tSubdir).isDirectory()) {
              const partialMsgs = readPartialAssistantMessages(tSubdir);
              if (partialMsgs.length > 0) {
                qRec.assistant_messages = partialMsgs;
                qRec.output = partialMsgs.join('\n\n');
              }
            }
            turnsById.set(tid, qRec);
          }
        } catch {}
      }
    }

    const allTurns = Array.from(turnsById.values());
    allTurns.sort(compareTurns);
    if (order === 'desc') {
      allTurns.reverse();
    }

    const totalCount = allTurns.length;
    const paged = safeLimit > 0 ? allTurns.slice(safeOffset, safeOffset + safeLimit) : allTurns.slice(safeOffset);

    return {
      ok: true,
      turns: paged,
      count: totalCount,
      limit: safeLimit,
      offset: safeOffset,
    };
  },
  getOrchestratorTurn: async (panel, payload, root) => {
    const rawTurnId = payload?.turnId || payload?.turn_id || payload?.id;
    if (!rawTurnId || !String(rawTurnId).trim()) {
      const err: any = new Error('turn_id is required');
      err.status = 400;
      err.data = { error: 'turn_id is required' };
      throw err;
    }
    const turnId = validateTurnId(String(rawTurnId));
    const tDir = path.join(root, '.ai-orchestration', 'orchestrator', 'turns', turnId);
    const qFile = path.join(root, '.ai-orchestration', 'orchestrator', 'queue', `${turnId}.json`);

    let turnDoc: any = null;
    const tJson = path.join(tDir, 'turn.json');
    if (fs.existsSync(tJson) && fs.statSync(tJson).isFile()) {
      try {
        turnDoc = JSON.parse(fs.readFileSync(tJson, 'utf-8'));
      } catch {}
    } else if (fs.existsSync(qFile) && fs.statSync(qFile).isFile()) {
      try {
        turnDoc = JSON.parse(fs.readFileSync(qFile, 'utf-8'));
      } catch {}
    }

    if (!turnDoc) {
      const err: any = new Error(`Turn ${turnId} not found`);
      err.status = 404;
      err.data = { error: `Turn ${turnId} not found` };
      throw err;
    }

    const promptFile = path.join(tDir, 'prompt.txt');
    if (fs.existsSync(promptFile) && fs.statSync(promptFile).isFile() && turnDoc.prompt_text === undefined) {
      try {
        turnDoc.prompt_text = fs.readFileSync(promptFile, 'utf-8');
      } catch {}
    }

    let assistantMsgs = turnDoc.assistant_messages;
    if (!assistantMsgs && fs.existsSync(tDir) && fs.statSync(tDir).isDirectory()) {
      assistantMsgs = readPartialAssistantMessages(tDir);
      turnDoc.assistant_messages = assistantMsgs;
    }
    if (turnDoc.output === undefined) {
      turnDoc.output = Array.isArray(assistantMsgs) ? assistantMsgs.join('\n\n') : String(assistantMsgs || '');
    }

    return { ok: true, turn: turnDoc };
  },
  pauseOrchestrator: async (panel, payload, root) => {
    const data = await panel.cliClient.runJsonCommand<any>(
      ['orchestrator', 'pause', '--workspace', root],
      root
    );
    panel.postMessage({ type: 'orchestrator_paused', result: data });
    panel.postMessage({ type: 'changed', areas: ['orchestrator', 'events'] });
    return data;
  },
  resumeOrchestrator: async (panel, payload, root) => {
    const data = await panel.cliClient.runJsonCommand<any>(
      ['orchestrator', 'resume', '--workspace', root],
      root
    );
    panel.postMessage({ type: 'orchestrator_resumed', result: data });
    panel.postMessage({ type: 'changed', areas: ['orchestrator', 'events'] });
    return data;
  },
  rotateOrchestrator: async (panel, payload, root) => {
    const args = ['orchestrator', 'rotate', '--workspace', root];
    if (payload?.tool) args.push('--tool', String(payload.tool));
    if (payload?.model) args.push('--model', String(payload.model));
    if (payload?.reason) args.push('--reason', String(payload.reason));
    if (payload?.no_handoff || payload?.noHandoff) args.push('--no-handoff');

    const data = await panel.cliClient.runJsonCommand<any>(args, root);
    panel.postMessage({ type: 'orchestrator_rotated', result: data });
    panel.postMessage({ type: 'changed', areas: ['orchestrator', 'events', 'sessions'] });
    return data;
  },
  cancelOrchestratorTurn: async (panel, payload, root) => {
    const turnId = payload?.turnId || payload?.turn_id || payload?.id;
    if (!turnId || !String(turnId).trim()) {
      const err: any = new Error('turn_id is required');
      err.status = 400;
      err.data = { error: 'turn_id is required' };
      throw err;
    }
    const cleanId = validateTurnId(String(turnId));
    const args = ['orchestrator', 'cancel', cleanId, '--workspace', root];
    const data = await panel.cliClient.runJsonCommand<any>(args, root);
    panel.postMessage({ type: 'turn_cancelled', turn_id: cleanId });
    panel.postMessage({ type: 'changed', areas: ['orchestrator', 'queue', 'events'] });
    return data;
  },
  runNextOrchestratorTurn: async (panel, payload, root) => {
    const args = ['orchestrator', 'run-next', '--workspace', root];
    if (payload?.timeout) {
      args.push('--timeout', String(payload.timeout));
    }
    const data = await panel.cliClient.runJsonCommand<any>(args, root);
    panel.postMessage({ type: 'changed', areas: ['orchestrator', 'queue', 'events'] });
    return data;
  },
  reassignOrchestrator: async (panel, payload, root) => {
    const tool = payload?.tool;
    if (!tool || !String(tool).trim()) {
      const err: any = new Error('tool is required');
      err.status = 400;
      err.data = { error: 'tool is required' };
      throw err;
    }
    const expectHash = payload?.expect_hash || payload?.expect_plan_hash || payload?.expectHash;
    if (!expectHash || !String(expectHash).trim()) {
      const err: any = new Error('expect_hash is required');
      err.status = 400;
      err.data = { error: 'expect_hash is required' };
      throw err;
    }
    const args = [
      'orchestrator',
      'reassign',
      '--tool',
      String(tool).trim(),
      '--expect-hash',
      String(expectHash).trim(),
      '--workspace',
      root,
    ];
    if (payload?.model) args.push('--model', String(payload.model));
    const scope = payload?.scope || 'project';
    args.push('--scope', String(scope));
    if (payload?.no_handoff || payload?.noHandoff) args.push('--no-handoff');
    if (payload?.timeout) args.push('--timeout', String(payload.timeout));

    const data = await panel.cliClient.runJsonCommand<any>(args, root);
    panel.postMessage({ type: 'orchestrator_reassigned', result: data });
    panel.postMessage({ type: 'changed', areas: ['orchestrator', 'events', 'sessions', 'config'] });
    return data;
  },
  applySetup: async (panel, payload, root) => {
    const expectHash = payload?.expect_hash || payload?.expect_plan_hash || payload?.expectHash;
    if (!expectHash || !String(expectHash).trim()) {
      const err: any = new Error('expect_hash is required');
      err.status = 400;
      err.data = { error: 'expect_hash is required' };
      throw err;
    }
    const scope = payload?.scope || 'project-local';
    const args = [
      'setup',
      '--apply',
      '--expect-hash',
      String(expectHash).trim(),
      '--scope',
      String(scope),
      '--workspace',
      root,
    ];
    if (payload?.orchestrator) args.push('--orchestrator', String(payload.orchestrator));
    if (payload?.executor) args.push('--executor', String(payload.executor));
    const orchModel = payload?.orchestrator_model || payload?.orchestratorModel;
    if (orchModel) args.push('--orchestrator-model', String(orchModel));
    const execModel = payload?.executor_model || payload?.executorModel;
    if (execModel) args.push('--executor-model', String(execModel));
    const vmode = payload?.verification_mode || payload?.verificationMode;
    if (vmode) args.push('--verification-mode', String(vmode));
    if (payload?.start_orchestrator || payload?.startOrchestrator) args.push('--start-orchestrator');

    const data = await panel.cliClient.runJsonCommand<any>(args, root);
    panel.postMessage({ type: 'setup_applied', result: data });
    panel.postMessage({ type: 'config_updated' });
    panel.postMessage({ type: 'changed', areas: ['config', 'orchestrator', 'events', 'sessions'] });
    return data;
  },
  previewValidateClose: async (panel, payload, root) => {
    const taskIds = extractValidateCloseTaskIds(payload);
    const noteRaw = payload?.note !== undefined && payload?.note !== null ? payload.note : payload?.reason;
    const note = noteRaw !== undefined && noteRaw !== null && String(noteRaw).trim() ? String(noteRaw).trim() : null;
    const tasksDir = path.join(root, 'tasks');
    const { status, payload: resultPayload } = await inspectValidateCloseTasks(panel, tasksDir, root, taskIds, note);
    if (status !== 200) {
      throwValidateCloseError(status, resultPayload);
    }
    return resultPayload;
  },
  applyValidateClose: async (panel, payload, root) => {
    const taskIds = extractValidateCloseTaskIds(payload);
    const noteRaw = payload?.note !== undefined && payload?.note !== null ? payload.note : payload?.reason;
    const note = noteRaw !== undefined && noteRaw !== null && String(noteRaw).trim() ? String(noteRaw).trim() : null;

    const expectPlanHash =
      payload?.expect_plan_hash ||
      payload?.expectPlanHash ||
      payload?.expect_hash ||
      payload?.expectHash ||
      payload?.plan_hash ||
      payload?.planHash ||
      payload?.hash;
    const expectTaskHashes =
      payload?.expect_task_hashes ||
      payload?.expectTaskHashes ||
      payload?.task_hashes ||
      payload?.taskHashes;

    const tasksDir = path.join(root, 'tasks');
    const { status, payload: previewPayload } = await inspectValidateCloseTasks(panel, tasksDir, root, taskIds, note);
    if (status !== 200) {
      if (
        status === 400 &&
        expectPlanHash &&
        String(previewPayload?.error || '').includes("only 'delivered' or 'verified'")
      ) {
        throwValidateCloseError(409, {
          ok: false,
          error: `stale-plan: ${previewPayload?.error}`,
          details: previewPayload,
        });
      }
      throwValidateCloseError(status, previewPayload);
    }

    const currentPlanHash: string = previewPayload.plan_hash;
    const items: any[] = previewPayload.tasks;

    if (expectPlanHash) {
      if (String(expectPlanHash).trim().toLowerCase() !== String(currentPlanHash).toLowerCase()) {
        throwValidateCloseError(409, {
          ok: false,
          error: 'stale-plan: task states or hashes changed since preview',
          expected: String(expectPlanHash).trim(),
          actual: currentPlanHash,
          tasks: items,
          plan_hash: currentPlanHash,
          hash: currentPlanHash,
        });
      }
    }

    if (expectTaskHashes && typeof expectTaskHashes === 'object' && !Array.isArray(expectTaskHashes)) {
      for (const it of items) {
        const tid = it.id;
        const expH = expectTaskHashes[tid];
        if (expH && String(expH).trim().toLowerCase() !== String(it.task_hash || '').toLowerCase()) {
          throwValidateCloseError(409, {
            ok: false,
            task_id: tid,
            error: 'stale-task: task hash changed since preview',
            expected: String(expH).trim(),
            actual: it.task_hash,
          });
        }
      }
    }

    const results: any[] = [];
    for (const it of items) {
      const tid = it.id;
      const cmd = [
        'tasks', 'transition', tid, 'done',
        '--verifier', 'owner',
        '--tasks-dir', tasksDir,
      ];
      if (note) {
        cmd.push('--reason', note);
      }
      if (it.task_hash) {
        cmd.push('--expect-task-hash', String(it.task_hash));
      }

      let data: any;
      try {
        data = await panel.cliClient.runJsonCommand<any>(cmd, root);
      } catch (e: any) {
        const errStatus = e instanceof CliError ? e.status : (e?.status || 500);
        const errData = e instanceof CliError ? e.data : e?.data;
        const errMsg =
          errData && typeof errData === 'object' && errData.error
            ? errData.error
            : e?.message || String(e);
        throwValidateCloseError(errStatus, {
          ok: false,
          task_id: tid,
          error: errMsg,
          completed: results,
          details: errData,
        });
      }

      if (data && typeof data === 'object' && data.ok === false) {
        const errStatus = mapCliStatus(1, data);
        throwValidateCloseError(errStatus, {
          ok: false,
          task_id: tid,
          error: data.error || `Transition failed for ${tid}`,
          completed: results,
          details: data,
        });
      }

      const resItem = data && typeof data === 'object' ? data : { ok: true, task_id: tid, new_state: 'done' };
      results.push(resItem);
      if (panel.postMessage) {
        panel.postMessage({
          type: 'task_transitioned',
          task_id: tid,
          new_state: resItem.new_state || 'done',
        });
      }
    }

    let inSync = false;
    try {
      const checkData = await panel.cliClient.runJsonCommand<any>(
        ['tasks', 'sync-index', '--tasks-dir', tasksDir, '--check'],
        root
      );
      inSync = Boolean(checkData && typeof checkData === 'object' && checkData.in_sync);
    } catch {}

    if (panel.postMessage) {
      panel.postMessage({ type: 'changed', areas: ['tasks'] });
      panel.postMessage({ type: 'tasks_changed' });
    }
    if (panel.onTasksUpdated) {
      panel.onTasksUpdated();
    }

    return {
      ok: true,
      applied: true,
      count: results.length,
      task_ids: items.map((it) => it.id),
      verifier: 'owner',
      note,
      results,
      index_in_sync: inSync,
    };
  },
};

export const HANDLER_MAP: Record<string, MessageHandler> = {
  ...CUSTOM_HANDLERS,
};

const INBOX_WRITE_TYPES = new Set([
  'addInboxNote',
  'editInboxNote',
  'deleteInboxAttachment',
  'resolveInboxNote',
  'discardInboxNote',
  'reopenInboxNote',
  'inboxToTask',
  'acceptTriage',
]);

export const TASK_WRITE_TYPES = new Set([
  'applyTaskUseCases',
  'deleteTaskAttachment',
  'setPriority',
  'setSize',
  'setDeps',
  'addChild',
  'expandTask',
  'collapseTask',
  'reopenTask',
  'setKind',
  'setLabels',
  'setShort',
  'setShortTitle',
  'createMicrotask',
  'promoteMicrotask',
  'applyValidateClose',
]);

for (const [type, builder] of Object.entries(CLI_COMMAND_MAP)) {
  HANDLER_MAP[type] = async (panel: DashboardPanel, payload: any, root: string) => {
    const args = builder(payload, root);
    const data = await panel.cliClient.runJsonCommand<any>(args, root);

    if (INBOX_WRITE_TYPES.has(type)) {
      panel.postMessage({ type: 'changed', areas: ['inbox', 'tasks'] });
      if (panel.onTasksUpdated) panel.onTasksUpdated();
    } else if (TASK_WRITE_TYPES.has(type)) {
      panel.postMessage({ type: 'changed', areas: ['tasks'] });
      if (type === 'createMicrotask' && data && typeof data === 'object' && data.id) {
        panel.postMessage({ type: 'task_created', task_id: data.id });
      }
      if (panel.onTasksUpdated) panel.onTasksUpdated();
    } else if (type === 'transitionTask') {
      try {
        const checkData = await panel.cliClient.runJsonCommand<any>(
          ['tasks', 'sync-index', '--tasks-dir', path.join(root, 'tasks'), '--check'],
          root
        );
        if (data && typeof data === 'object') {
          data.index_in_sync = checkData?.in_sync ?? false;
        }
      } catch {}
      if (panel.onTasksUpdated) panel.onTasksUpdated();
    } else if (
      type === 'setPriority' ||
      type === 'setSize' ||
      type === 'setDeps' ||
      type === 'setShort' ||
      type === 'startRun' ||
      type === 'continueRun' ||
      type === 'cancelRun' ||
      type === 'markDeliveredRun' ||
      type === 'applyVerdictRun' ||
      type === 'syncIndex' ||
      type === 'applyAgentsMd' ||
      type === 'answerQuestion' ||
      type === 'withdrawQuestion'
    ) {
      if (panel.onTasksUpdated) panel.onTasksUpdated();
    }

    return data;
  };
}

export function dispatchMessage(
  panel: DashboardPanel,
  type: string,
  payload: any,
  boundRoot: string
): Promise<any> {
  const handler = HANDLER_MAP[type];
  if (!handler) {
    const err: any = new Error(`Unhandled message type: ${type}`);
    err.status = 400;
    return Promise.reject(err);
  }
  try {
    const { targetRoot } = resolveMessageTargetRoot(type, payload, boundRoot, panel?.cliClient);
    return handler(panel, payload, targetRoot);
  } catch (err) {
    return Promise.reject(err);
  }
}

export const ALL_HANDLED_TYPES = new Set(Object.keys(HANDLER_MAP));

export class DashboardPanel {
  public static currentPanel: DashboardPanel | undefined;
  private readonly _panel: vscode.WebviewPanel;
  private readonly _extensionUri: vscode.Uri;
  public readonly cliClient: CliClient;
  public onTasksUpdated?: () => void;
  public onFolderBound?: (newRoot: string) => void | Promise<void>;
  private _boundRoot: string;
  private _disposables: vscode.Disposable[] = [];
  private _watcherDisposables: vscode.Disposable[] = [];
  private _tasksDebounceTimer: any = null;
  private _runsDebounceTimer: any = null;
  private _questionsDebounceTimer: any = null;

  public static createOrShow(
    extensionUri: vscode.Uri,
    cliClient: CliClient,
    boundRoot: string,
    onTasksUpdated?: () => void,
    onFolderBound?: (newRoot: string) => void | Promise<void>
  ) {
    const column = vscode.window.activeTextEditor
      ? vscode.window.activeTextEditor.viewColumn
      : undefined;

    if (DashboardPanel.currentPanel) {
      if (DashboardPanel.currentPanel._boundRoot !== boundRoot) {
        DashboardPanel.currentPanel.bindWorkspace(boundRoot);
      }
      DashboardPanel.currentPanel.onTasksUpdated = onTasksUpdated;
      DashboardPanel.currentPanel.onFolderBound = onFolderBound;
      DashboardPanel.currentPanel._panel.reveal(column);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'aiOrchestrationDashboard',
      'AI Orchestration Backlog',
      column || vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(extensionUri, 'dist-webview'),
          vscode.Uri.joinPath(extensionUri, 'resources'),
        ],
      }
    );

    DashboardPanel.currentPanel = new DashboardPanel(
      panel,
      extensionUri,
      cliClient,
      boundRoot,
      onTasksUpdated,
      onFolderBound
    );
  }

  private constructor(
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    cliClient: CliClient,
    boundRoot: string,
    onTasksUpdated?: () => void,
    onFolderBound?: (newRoot: string) => void | Promise<void>
  ) {
    this._panel = panel;
    this._extensionUri = extensionUri;
    this.cliClient = cliClient;
    this._boundRoot = boundRoot;
    this.onTasksUpdated = onTasksUpdated;
    this.onFolderBound = onFolderBound;

    this._panel.iconPath = {
      light: vscode.Uri.joinPath(this._extensionUri, 'resources', 'icon.svg'),
      dark: vscode.Uri.joinPath(this._extensionUri, 'resources', 'icon.svg'),
    };

    this._update();
    this._setupWatchers();

    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

    this._panel.webview.onDidReceiveMessage(
      async (message) => {
        await this._handleMessage(message);
      },
      null,
      this._disposables
    );
  }

  public getActiveWorkspaceRoot(): string {
    return this._boundRoot;
  }

  public async bindWorkspace(newRoot: string) {
    invalidateProjectResolver(this._boundRoot);
    invalidateProjectResolver(newRoot);
    this._boundRoot = newRoot;
    this._setupWatchers();
    if (this.onFolderBound) {
      await this.onFolderBound(newRoot);
    }
    this._panel.webview.postMessage({ type: 'changed', areas: ['tasks', 'config', 'env', 'questions', 'inbox'] });
    if (this.onTasksUpdated) {
      this.onTasksUpdated();
    }
  }

  private _setupWatchers() {
    while (this._watcherDisposables.length) {
      const d = this._watcherDisposables.pop();
      if (d) d.dispose();
    }

    if (!fs.existsSync(this._boundRoot)) {
      return;
    }

    // Watch 00-INDEX.md across workspace to invalidate project discovery cache
    const indexPattern = new vscode.RelativePattern(this._boundRoot, '**/tasks/00-INDEX.md');
    const indexWatcher = vscode.workspace.createFileSystemWatcher(indexPattern);
    const onIndexLayoutChange = () => {
      invalidateProjectResolver(this._boundRoot);
      this._setupWatchers();
      this._notifyTasksChanged();
    };
    indexWatcher.onDidCreate(onIndexLayoutChange);
    indexWatcher.onDidDelete(onIndexLayoutChange);
    indexWatcher.onDidChange(() => {
      invalidateProjectResolver(this._boundRoot);
    });
    this._watcherDisposables.push(indexWatcher);

    const aiOrchBin = this.cliClient?.resolveCliPath ? this.cliClient.resolveCliPath(this._boundRoot) : null;
    const resolver = getProjectResolver(this._boundRoot, aiOrchBin);
    let projects = resolver.getProjects();
    if (!projects || projects.length === 0) {
      projects = [
        {
          id: '_workspace',
          path: '.',
          kind: 'project',
          root: this._boundRoot,
          tasksDir: path.join(this._boundRoot, 'tasks'),
        },
      ];
    }

    // File watchers stay on even with the event stream: hand edits and git pulls emit no events.
    for (const proj of projects) {
      const pRoot = proj.root;
      const pId = proj.id;

      const tasksPattern = new vscode.RelativePattern(pRoot, 'tasks/**');
      const tasksWatcher = vscode.workspace.createFileSystemWatcher(tasksPattern);
      const isQuestionPath = (uri?: vscode.Uri) => {
        if (!uri || !uri.fsPath) return false;
        const rel = path.relative(pRoot, uri.fsPath).replace(/\\/g, '/');
        return rel.startsWith('tasks/questions/') || rel === 'tasks/questions';
      };
      tasksWatcher.onDidChange((uri) => { if (!isQuestionPath(uri)) this._notifyTasksChanged(true, pId); });
      tasksWatcher.onDidCreate((uri) => { if (!isQuestionPath(uri)) this._notifyTasksChanged(true, pId); });
      tasksWatcher.onDidDelete((uri) => { if (!isQuestionPath(uri)) this._notifyTasksChanged(true, pId); });

      const questionsPattern = new vscode.RelativePattern(pRoot, 'tasks/questions/**');
      const questionsWatcher = vscode.workspace.createFileSystemWatcher(questionsPattern);
      questionsWatcher.onDidChange(() => this._notifyQuestionsChanged(true, pId));
      questionsWatcher.onDidCreate(() => this._notifyQuestionsChanged(true, pId));
      questionsWatcher.onDidDelete(() => this._notifyQuestionsChanged(true, pId));

      const runsPattern = new vscode.RelativePattern(pRoot, '.ai-orchestration/runs/*/run.json');
      const runsWatcher = vscode.workspace.createFileSystemWatcher(runsPattern);
      runsWatcher.onDidChange(() => this._notifyRunsChanged(pId));
      runsWatcher.onDidCreate(() => this._notifyRunsChanged(pId));
      runsWatcher.onDidDelete(() => this._notifyRunsChanged(pId));

      this._watcherDisposables.push(tasksWatcher, questionsWatcher, runsWatcher);
    }
  }

  private _defaultProjectId(): string | undefined {
    if (!this._boundRoot) return undefined;
    try {
      const aiOrchBin = this.cliClient?.resolveCliPath ? this.cliClient.resolveCliPath(this._boundRoot) : null;
      const resolver = getProjectResolver(this._boundRoot, aiOrchBin);
      const projects = resolver.getProjects();
      if (projects.length === 1) return projects[0].id;
      if (projects.length > 1) return '_workspace';
    } catch {}
    return undefined;
  }

  // `refreshExtension` is false when the extension itself asked for the notification
  // (refreshAll -> notify*Changed): calling onTasksUpdated (= refreshAll) back from there
  // made an endless, doubling refresh loop (a process storm before 0.2.3, a webview that
  // reloads every few hundred ms after it).
  private _notifyTasksChanged(refreshExtension = true, project?: string) {
    if (this._tasksDebounceTimer) clearTimeout(this._tasksDebounceTimer);
    const proj = project || this._defaultProjectId();
    this._tasksDebounceTimer = setTimeout(() => {
      this._tasksDebounceTimer = null;
      const msg: any = { type: 'changed', areas: ['tasks'] };
      if (proj) msg.project = proj;
      this._panel.webview.postMessage(msg);
      if (refreshExtension && this.onTasksUpdated) {
        this.onTasksUpdated();
      }
    }, 50);
  }

  private _notifyQuestionsChanged(refreshExtension = true, project?: string) {
    if (this._questionsDebounceTimer) clearTimeout(this._questionsDebounceTimer);
    const proj = project || this._defaultProjectId();
    this._questionsDebounceTimer = setTimeout(() => {
      this._questionsDebounceTimer = null;
      const msg: any = { type: 'changed', areas: ['questions', 'tasks'] };
      if (proj) msg.project = proj;
      this._panel.webview.postMessage(msg);
      if (refreshExtension && this.onTasksUpdated) {
        this.onTasksUpdated();
      }
    }, 50);
  }

  private _notifyRunsChanged(project?: string) {
    if (this._runsDebounceTimer) clearTimeout(this._runsDebounceTimer);
    const proj = project || this._defaultProjectId();
    this._runsDebounceTimer = setTimeout(() => {
      this._runsDebounceTimer = null;
      const msg: any = { type: 'changed', areas: ['runs'] };
      if (proj) msg.project = proj;
      this._panel.webview.postMessage(msg);
    }, 50);
  }

  /** Called by the extension's own refresh: updates the webview only. */
  public notifyTasksChanged(project?: string) {
    this._notifyTasksChanged(false, project);
  }

  /** Called by the extension's own refresh: updates the webview only. */
  public notifyQuestionsChanged(project?: string) {
    this._notifyQuestionsChanged(false, project);
  }

  /** Called when new events arrive from the event stream: updates the webview only. */
  public notifyAreasChanged(areas: string[], project?: string) {
    if (this._panel && Array.isArray(areas) && areas.length > 0) {
      const proj = project || this._defaultProjectId();
      const msg: any = { type: 'changed', areas };
      if (proj) msg.project = proj;
      this._panel.webview.postMessage(msg);
    }
  }

  public postMessage(message: any): Thenable<boolean> {
    return this._panel.webview.postMessage(message);
  }

  private async _handleMessage(message: any) {
    const { id, type, payload } = message || {};
    if (!id || !type) return;

    const root = this.getActiveWorkspaceRoot();

    try {
      const data = await dispatchMessage(this, type, payload, root);
      this._respond(id, data);
    } catch (e: any) {
      const status = e instanceof CliError ? e.status : (e.status || 500);
      const data = e instanceof CliError ? e.data : e.data;
      this._respondError(id, e.message || String(e), status, data);
    }
  }

  public globFile(baseDir: string, pattern: string): string[] {
    if (!fs.existsSync(baseDir)) return [];
    const [sub, filePattern] = pattern.split('/');
    const results: string[] = [];

    const dirs = fs.readdirSync(baseDir, { withFileTypes: true });
    for (const d of dirs) {
      if (!d.isDirectory()) continue;
      const subPath = path.join(baseDir, d.name);
      const subFiles = fs.readdirSync(subPath);
      for (const f of subFiles) {
        if (filePattern.includes('*')) {
          const prefix = filePattern.split('*')[0];
          const suffix = filePattern.split('*')[1];
          if (f.startsWith(prefix) && f.endsWith(suffix)) {
            results.push(path.join(subPath, f));
          }
        } else if (f === filePattern) {
          results.push(path.join(subPath, f));
        }
      }
    }
    return results;
  }

  private _respond(id: string, data: any, status = 200) {
    this._panel.webview.postMessage({ id, ok: true, data, status });
  }

  private _respondError(id: string, error: string, status = 500, data?: any) {
    this._panel.webview.postMessage({ id, ok: false, error, status, data });
  }

  public dispose() {
    DashboardPanel.currentPanel = undefined;
    while (this._watcherDisposables.length) {
      const w = this._watcherDisposables.pop();
      if (w) w.dispose();
    }
    if (this._tasksDebounceTimer) clearTimeout(this._tasksDebounceTimer);
    if (this._runsDebounceTimer) clearTimeout(this._runsDebounceTimer);
    if (this._questionsDebounceTimer) clearTimeout(this._questionsDebounceTimer);
    this._panel.dispose();
    while (this._disposables.length) {
      const x = this._disposables.pop();
      if (x) x.dispose();
    }
  }

  private _update() {
    this._panel.webview.html = this._getHtmlForWebview(this._panel.webview);
  }

  private _getHtmlForWebview(webview: vscode.Webview): string {
    const distFolder = path.join(this._extensionUri.fsPath, 'dist-webview');
    const indexPath = path.join(distFolder, 'index.html');
    if (!fs.existsSync(indexPath)) {
      return `<!DOCTYPE html>
        <html>
          <body style="background:#0f172a;color:#f8fafc;padding:2rem;font-family:sans-serif;">
            <h2>AI Orchestration Frontend Bundle Not Found</h2>
            <p>dist-webview/index.html is missing. Run <code>npm run sync-webview</code>.</p>
          </body>
        </html>`;
    }

    let html = fs.readFileSync(indexPath, 'utf-8');

    // Rewrite relative asset paths with webview.asWebviewUri
    const distUri = vscode.Uri.file(distFolder);
    html = html.replace(/(src|href)="\.?\/?assets\/([^"]+)"/g, (match, attr, assetFile) => {
      const assetUri = webview.asWebviewUri(vscode.Uri.joinPath(distUri, 'assets', assetFile));
      return `${attr}="${assetUri}"`;
    });

    return html;
  }
}
