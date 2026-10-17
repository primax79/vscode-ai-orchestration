import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { CliClient, CliError } from '../cli-client';

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

// Timeline (10.2): same CLI arguments as the web backend's /api/tasks/{id}/priority|size|deps.
const TASK_MUTATION_ID_RE = /^(T\d{3,}|\d{2,}\.\d+)$/;
const mutationTaskId = (payload: any): string => {
  const id = String(payload?.taskId || payload?.task_id || '');
  if (!TASK_MUTATION_ID_RE.test(id)) throw new Error(`Invalid task id ${JSON.stringify(id)}`);
  return id;
};
const depIds = (v: any): string[] =>
  (Array.isArray(v) ? v : v ? [v] : [])
    .flatMap((x: any) => String(x).split(/[\s,]+/))
    .map((x: string) => x.trim())
    .filter(Boolean);
const mutationTail = (payload: any, preview: boolean): string[] => {
  const h = payload?.expect_task_hash || payload?.expect_hash;
  if (!preview && !h) throw new Error('expect_task_hash is required');
  const tail: string[] = [];
  if (preview) tail.push('--dry-run');
  if (h) tail.push('--expect-task-hash', String(h));
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

export const CLI_COMMAND_MAP: Record<string, CliArgBuilder> = {
  getGraph: (payload, root) => ['tasks', 'graph', '--tasks-dir', path.join(root, 'tasks')],
  previewSetPriority: priorityArgs(true),
  setPriority: priorityArgs(false),
  previewSetSize: sizeArgs(true),
  setSize: sizeArgs(false),
  previewSetDeps: depsArgs(true),
  setDeps: depsArgs(false),
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
      '--id', String(payload?.id),
      '--title', String(payload?.title),
      '--tasks-dir', path.join(root, 'tasks'),
    ];
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
    return args;
  },
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
};

export const CUSTOM_HANDLERS: Record<string, CustomHandler> = {
  getWorkspace: async (panel, payload, root) => {
    const tasksDir = path.join(root, 'tasks');
    const hasTasks = fs.existsSync(tasksDir);
    return {
      workspace_path: root,
      workspace_name: path.basename(root),
      has_tasks_dir: hasTasks,
      tasks_path: hasTasks ? tasksDir : null,
    };
  },
  switchWorkspace: async (panel, payload, root) => {
    const target = payload?.workspacePath;
    if (!target || !fs.existsSync(target)) {
      const err: any = new Error(`Invalid or nonexistent workspace path: ${target}`);
      err.status = 400;
      throw err;
    }
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

const TASK_WRITE_TYPES = new Set([
  'deleteTaskAttachment',
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

    // Watch bound folder's tasks/**
    const tasksPattern = new vscode.RelativePattern(this._boundRoot, 'tasks/**');
    const tasksWatcher = vscode.workspace.createFileSystemWatcher(tasksPattern);
    const isQuestionPath = (uri: vscode.Uri) => {
      const rel = path.relative(this._boundRoot, uri.fsPath).replace(/\\/g, '/');
      return rel.startsWith('tasks/questions/') || rel === 'tasks/questions';
    };
    tasksWatcher.onDidChange((uri) => { if (!isQuestionPath(uri)) this._notifyTasksChanged(); });
    tasksWatcher.onDidCreate((uri) => { if (!isQuestionPath(uri)) this._notifyTasksChanged(); });
    tasksWatcher.onDidDelete((uri) => { if (!isQuestionPath(uri)) this._notifyTasksChanged(); });

    // Watch bound folder's tasks/questions/**
    const questionsPattern = new vscode.RelativePattern(this._boundRoot, 'tasks/questions/**');
    const questionsWatcher = vscode.workspace.createFileSystemWatcher(questionsPattern);
    questionsWatcher.onDidChange(() => this._notifyQuestionsChanged());
    questionsWatcher.onDidCreate(() => this._notifyQuestionsChanged());
    questionsWatcher.onDidDelete(() => this._notifyQuestionsChanged());

    // Watch bound folder's .ai-orchestration/runs/*/run.json
    const runsPattern = new vscode.RelativePattern(this._boundRoot, '.ai-orchestration/runs/*/run.json');
    const runsWatcher = vscode.workspace.createFileSystemWatcher(runsPattern);
    runsWatcher.onDidChange(() => this._notifyRunsChanged());
    runsWatcher.onDidCreate(() => this._notifyRunsChanged());
    runsWatcher.onDidDelete(() => this._notifyRunsChanged());

    this._watcherDisposables.push(tasksWatcher, questionsWatcher, runsWatcher);
  }

  // `refreshExtension` is false when the extension itself asked for the notification
  // (refreshAll -> notify*Changed): calling onTasksUpdated (= refreshAll) back from there
  // made an endless, doubling refresh loop (a process storm before 0.2.3, a webview that
  // reloads every few hundred ms after it).
  private _notifyTasksChanged(refreshExtension = true) {
    if (this._tasksDebounceTimer) clearTimeout(this._tasksDebounceTimer);
    this._tasksDebounceTimer = setTimeout(() => {
      this._tasksDebounceTimer = null;
      this._panel.webview.postMessage({ type: 'changed', areas: ['tasks'] });
      if (refreshExtension && this.onTasksUpdated) {
        this.onTasksUpdated();
      }
    }, 50);
  }

  private _notifyQuestionsChanged(refreshExtension = true) {
    if (this._questionsDebounceTimer) clearTimeout(this._questionsDebounceTimer);
    this._questionsDebounceTimer = setTimeout(() => {
      this._questionsDebounceTimer = null;
      this._panel.webview.postMessage({ type: 'changed', areas: ['questions', 'tasks'] });
      if (refreshExtension && this.onTasksUpdated) {
        this.onTasksUpdated();
      }
    }, 50);
  }

  private _notifyRunsChanged() {
    if (this._runsDebounceTimer) clearTimeout(this._runsDebounceTimer);
    this._runsDebounceTimer = setTimeout(() => {
      this._runsDebounceTimer = null;
      this._panel.webview.postMessage({ type: 'changed', areas: ['runs'] });
    }, 50);
  }

  /** Called by the extension's own refresh: updates the webview only. */
  public notifyTasksChanged() {
    this._notifyTasksChanged(false);
  }

  /** Called by the extension's own refresh: updates the webview only. */
  public notifyQuestionsChanged() {
    this._notifyQuestionsChanged(false);
  }

  public postMessage(message: any): Thenable<boolean> {
    return this._panel.webview.postMessage(message);
  }

  private async _handleMessage(message: any) {
    const { id, type, payload } = message || {};
    if (!id || !type) return;

    const root = this.getActiveWorkspaceRoot();

    try {
      const handler = HANDLER_MAP[type];
      if (!handler) {
        const err: any = new Error(`Unhandled message type: ${type}`);
        err.status = 400;
        throw err;
      }

      const data = await handler(this, payload, root);
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
