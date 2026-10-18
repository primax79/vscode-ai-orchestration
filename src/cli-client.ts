import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { spawn } from 'child_process';

export interface TaskItem {
  kind: 'emergent' | 'initiative_task';
  id: string;
  title: string;
  category: string;
  priority: 'P0' | 'P1' | 'P2' | 'P3';
  priority_reason?: string;
  next_up?: string;
  state: string;
  executor: string;
  depends_on?: string;
  decider?: string;
  sources?: string;
  paths?: string;
  handoff?: string;
  profile?: string;
  verification_mode?: string;
  verifier?: string;
  file_path?: string;
}

export interface InitiativeItem {
  id: string;
  title: string;
  slug: string;
  plan_path: string;
  tasks_count: number;
}

export interface TaskListResult {
  ok: boolean;
  tasks_dir: string;
  emergent_tasks: TaskItem[];
  initiatives: InitiativeItem[];
  all_tasks?: TaskItem[];
}

export interface QuestionOption {
  label: string;
  title: string;
  consequence?: string | null;
  raw?: string;
}

export interface QuestionAnswer {
  choice: string;
  answered_by: string;
  answered: string;
  text?: string | null;
}

export interface QuestionItem {
  id: string;
  question: string;
  status: 'open' | 'answered' | 'withdrawn' | string;
  blocks: string;
  blocks_parsed?: [string, string | null][];
  decider: string;
  asked_by: string;
  asked: string;
  origin_run: string;
  open_answer: string;
  recommended: string;
  title?: string;
  context?: string;
  options?: QuestionOption[];
  answer?: QuestionAnswer;
  file_path?: string;
  rel_path?: string;
  filename?: string;
  headers?: Record<string, string>;
}

export interface QuestionListResult {
  ok: boolean;
  questions: QuestionItem[];
}

export interface OutputChannelLike {
  appendLine(value: string): void;
}

export class CliError extends Error {
  public code: number;
  public status: number;
  public data?: any;
  public stderr: string;

  constructor(message: string, code: number, status: number, data?: any, stderr = '') {
    super(message);
    this.name = 'CliError';
    this.code = code;
    this.status = status;
    this.data = data;
    this.stderr = stderr;
  }
}

export function mapCliStatus(code: number, data: any, defaultErrorStatus = 500): number {
  if (code === 0) return 200;
  if (code === 504) return 504;

  let errStr = '';
  if (data && typeof data === 'object') {
    if (data.error === 'stale-task' || data.error === 'lock-timeout' || data.error === 'stale-note') {
      return 409;
    }
    if (data.error === 'invalid-image-type' || data.reason === 'invalid-image-type') {
      return 415;
    }
    if (data.error === 'size-limit-exceeded' || data.reason === 'size-limit-exceeded') {
      return 413;
    }
    const errVal = data.error || data.message || '';
    errStr = String(errVal).toLowerCase();
  } else if (typeof data === 'string') {
    errStr = data.toLowerCase();
  }

  if (
    errStr.includes('hash mismatch') ||
    errStr.includes('plan hash mismatch') ||
    errStr.includes('stale') ||
    errStr.includes('stale-note') ||
    errStr.includes('lock-timeout') ||
    errStr.includes('task-write lock') ||
    errStr.includes('timed out waiting for task-write lock') ||
    errStr.includes('refusing to apply') ||
    errStr.includes('workspace has no project config') ||
    errStr.includes('no project config')
  ) {
    return 409;
  }

  if (errStr.includes('invalid-image-type') || errStr.includes('magic bytes do not match')) {
    return 415;
  }

  if (errStr.includes('size-limit-exceeded')) {
    return 413;
  }

  if (
    errStr.includes('required') ||
    errStr.includes('invalid') ||
    errStr.includes('unknown') ||
    errStr.includes('unrecognized') ||
    errStr.includes('not found') ||
    errStr.includes('validation') ||
    errStr.includes('illegal transition') ||
    errStr.includes('cannot transition') ||
    errStr.includes('waiting invariant') ||
    errStr.includes('must end with') ||
    errStr.includes('exceeds 160') ||
    errStr.includes('single line')
  ) {
    return 400;
  }

  return defaultErrorStatus;
}

// Guards against process storms: at most MAX_CONCURRENT CLI processes, identical
// read-only calls already in flight are shared, and every process has a deadline.
const MAX_CONCURRENT = 4;
const PROCESS_TIMEOUT_MS = 120_000;
const READ_ONLY_COMMANDS = new Set([
  'tasks list', 'tasks validate', 'tasks graph', 'tasks labels', 'questions list', 'questions show',
  'config show', 'env status', 'run list', 'run show', 'run logs', 'run options',
  'inbox list', 'inbox show', 'events tail', 'events stats',
]);

export function isReadOnlyCommand(args: string[]): boolean {
  if (args.includes('--check') || args.includes('--dry-run') || args.includes('--diff')) {
    return true;
  }
  return READ_ONLY_COMMANDS.has(`${args[0] ?? ''} ${args[1] ?? ''}`);
}

export class CliClient {
  private outputChannel: vscode.OutputChannel | OutputChannelLike;
  private running = 0;
  private waiters: Array<() => void> = [];
  private inFlightReads = new Map<string, Promise<any>>();

  constructor(outputChannel: vscode.OutputChannel | OutputChannelLike) {
    this.outputChannel = outputChannel;
  }

  public resolveCliPath(workspaceRoot?: string): string | null {
    // 1. Configured custom path
    try {
      const config = vscode.workspace?.getConfiguration ? vscode.workspace.getConfiguration('aiOrchestration') : undefined;
      const customPath = config?.get<string>('cliPath');
      if (customPath && fs.existsSync(customPath)) {
        return customPath;
      }
    } catch {}

    const home = process.env.HOME || process.env.USERPROFILE || '';

    // Candidate locations in specified order:
    // <workspace>/bin/ai-orch -> <workspace>/../ai-orchestration/bin/ai-orch -> ~/.ai-orchestration/repos/ai-orchestration/bin/ai-orch
    const candidates: string[] = [];
    if (workspaceRoot) {
      candidates.push(
        path.join(workspaceRoot, 'bin', 'ai-orch'),
        path.join(workspaceRoot, 'ai-orchestration', 'bin', 'ai-orch'),
        path.join(workspaceRoot, '..', 'ai-orchestration', 'bin', 'ai-orch')
      );

      // Search upward in parent folders for sibling ai-orchestration/bin/ai-orch (e.g. within worktrees)
      let cur = workspaceRoot;
      while (true) {
        const parent = path.dirname(cur);
        if (parent === cur) break;
        const cand = path.join(parent, 'ai-orchestration', 'bin', 'ai-orch');
        if (!candidates.includes(cand)) {
          candidates.push(cand);
        }
        cur = parent;
      }
    }
    // Shared per-user install (install.sh, `ai-orch env fetch-repos`): preferred outside a dev checkout
    if (home) {
      candidates.push(path.join(home, '.ai-orchestration', 'repos', 'ai-orchestration', 'bin', 'ai-orch'));
    }

    // PATH (VS Code started from the Dock does not inherit the login shell PATH,
    // so the usual user bin directories are checked explicitly as well).
    const pathDirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
    if (home) {
      pathDirs.push(path.join(home, '.local', 'bin'), path.join(home, 'bin'));
    }
    pathDirs.push('/opt/homebrew/bin', '/usr/local/bin');
    for (const dir of pathDirs) {
      const cand = path.join(dir, 'ai-orch');
      if (!candidates.includes(cand)) {
        candidates.push(cand);
      }
    }
    if (home) {
      candidates.push(
        // Claude Code keeps a full clone of the ai-orchestration marketplace repo here
        path.join(home, '.claude', 'plugins', 'marketplaces', 'ai-orchestration', 'bin', 'ai-orch')
      );
    }

    for (const c of candidates) {
      if (fs.existsSync(c)) {
        return c;
      }
    }
    return null;
  }

  public async runJsonCommand<T>(args: string[], workspaceRoot?: string): Promise<T> {
    const cliPath = this.resolveCliPath(workspaceRoot);
    if (!cliPath) {
      throw new CliError(
        'ai-orch CLI not found. Please install ai-orchestration or configure aiOrchestration.cliPath in settings.',
        1,
        500
      );
    }

    const pythonExe = process.platform === 'win32' ? 'python' : 'python3';
    const fullArgs = [cliPath, ...args];
    if (!fullArgs.includes('--json')) {
      fullArgs.push('--json');
    }

    const cwd = workspaceRoot || process.cwd();
    if (!isReadOnlyCommand(args)) {
      return this.withSlot(() => this.spawnJson<T>(pythonExe, fullArgs, cwd));
    }
    const key = `${cwd}\u0000${fullArgs.join('\u0000')}`;
    const existing = this.inFlightReads.get(key);
    if (existing) {
      return existing as Promise<T>;
    }
    const p = this.withSlot(() => this.spawnJson<T>(pythonExe, fullArgs, cwd)).finally(() => {
      this.inFlightReads.delete(key);
    });
    this.inFlightReads.set(key, p);
    return p;
  }

  private async withSlot<T>(fn: () => Promise<T>): Promise<T> {
    if (this.running >= MAX_CONCURRENT) {
      await new Promise<void>((r) => this.waiters.push(r));
    }
    this.running++;
    try {
      return await fn();
    } finally {
      this.running--;
      const next = this.waiters.shift();
      if (next) next();
    }
  }

  private spawnJson<T>(pythonExe: string, fullArgs: string[], cwd: string): Promise<T> {
    this.outputChannel.appendLine(`[exec] ${pythonExe} ${fullArgs.join(' ')}`);

    return new Promise((resolve, reject) => {
      const proc = spawn(pythonExe, fullArgs, {
        cwd,
        env: process.env,
      });
      const timer = setTimeout(() => {
        this.outputChannel.appendLine(`[timeout] killing after ${PROCESS_TIMEOUT_MS} ms: ${fullArgs.join(' ')}`);
        proc.kill('SIGKILL');
      }, PROCESS_TIMEOUT_MS);

      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (d) => (stdout += d.toString()));
      proc.stderr.on('data', (d) => (stderr += d.toString()));

      proc.on('close', (code) => {
        clearTimeout(timer);
        const exitCode = code ?? 0;
        let parsed: any = null;
        let isJson = false;

        const trimmedOut = stdout.trim();
        if (trimmedOut) {
          try {
            parsed = JSON.parse(trimmedOut);
            isJson = true;
          } catch (e: any) {
            // Not JSON
          }
        }

        if (exitCode !== 0) {
          this.outputChannel.appendLine(`[error] code=${exitCode} stderr=${stderr} stdout=${stdout}`);
          const status = mapCliStatus(exitCode, parsed || stderr || stdout);
          let errMsg = `Process exited with code ${exitCode}`;
          if (parsed && typeof parsed === 'object') {
            errMsg = parsed.error || parsed.message || JSON.stringify(parsed);
          } else if (stderr.trim()) {
            errMsg = stderr.trim();
          } else if (trimmedOut) {
            errMsg = trimmedOut;
          }
          return reject(new CliError(errMsg, exitCode, status, parsed, stderr));
        }

        if (!isJson) {
          this.outputChannel.appendLine(`[json parse error] output was: ${stdout}`);
          return reject(new CliError(`Failed to parse CLI JSON output: ${stdout}`, 0, 500, undefined, stderr));
        }

        resolve(parsed as T);
      });

      proc.on('error', (err) => {
        clearTimeout(timer);
        reject(new CliError(err.message, -1, 500, undefined, String(err)));
      });
    });
  }

  public async listTasks(workspaceRoot: string): Promise<TaskListResult> {
    const tasksDir = path.join(workspaceRoot, 'tasks');
    return this.runJsonCommand<TaskListResult>(['tasks', 'list', '--tasks-dir', tasksDir], workspaceRoot);
  }

  public async listQuestions(workspaceRoot: string, status?: string, blocks?: string): Promise<QuestionListResult> {
    const tasksDir = path.join(workspaceRoot, 'tasks');
    const args = ['questions', 'list', '--tasks-dir', tasksDir];
    if (status) {
      args.push('--status', status);
    }
    if (blocks) {
      args.push('--blocks', blocks);
    }
    return this.runJsonCommand<QuestionListResult>(args, workspaceRoot);
  }

  public async syncIndex(workspaceRoot: string, expectHash?: string): Promise<any> {
    const tasksDir = path.join(workspaceRoot, 'tasks');
    const args = ['tasks', 'sync-index', '--tasks-dir', tasksDir, '--apply'];
    if (expectHash) {
      args.push('--expect-hash', expectHash);
    }
    return this.runJsonCommand(args, workspaceRoot);
  }

  public async validateTasks(workspaceRoot: string): Promise<any> {
    const tasksDir = path.join(workspaceRoot, 'tasks');
    return this.runJsonCommand(['tasks', 'validate', '--tasks-dir', tasksDir], workspaceRoot);
  }

  public async transitionTask(
    workspaceRoot: string,
    taskId: string,
    newState: string,
    actor = 'operator',
    verifier?: string,
    reason?: string,
    expectTaskHash?: string,
    forceUnblock?: boolean
  ): Promise<any> {
    const tasksDir = path.join(workspaceRoot, 'tasks');
    const args = ['tasks', 'transition', taskId, newState, '--tasks-dir', tasksDir, '--actor', actor];
    if (verifier) args.push('--verifier', verifier);
    if (reason) args.push('--reason', reason);
    if (expectTaskHash) args.push('--expect-task-hash', expectTaskHash);
    if (forceUnblock) args.push('--force-unblock');
    return this.runJsonCommand(args, workspaceRoot);
  }

  public async getConfig(workspaceRoot: string): Promise<any> {
    return this.runJsonCommand(['config', 'show', '--workspace', workspaceRoot], workspaceRoot);
  }

  public async getEnvStatus(workspaceRoot: string): Promise<any> {
    return this.runJsonCommand(['env', 'status', '--workspace', workspaceRoot], workspaceRoot);
  }

  public async applyAgentsMd(workspaceRoot: string, expectHash?: string, allowGlobalRouting = false): Promise<any> {
    const args = ['render-agents-md', '--workspace', workspaceRoot, '--apply'];
    if (expectHash) args.push('--expect-hash', expectHash);
    if (allowGlobalRouting) args.push('--allow-global-routing');
    return this.runJsonCommand(args, workspaceRoot);
  }

  public async tailEvents(
    workspaceRoot: string,
    since?: number,
    limit?: number,
    types?: string[],
    session?: string
  ): Promise<{ ok: boolean; events: any[]; count: number; first_seq: number | null; last_seq: number | null }> {
    const args = ['events', 'tail', '--workspace', workspaceRoot];
    if (since !== undefined) {
      args.push('--since', String(since));
    }
    if (limit !== undefined) {
      args.push('--limit', String(limit));
    }
    if (types && types.length > 0) {
      for (const t of types) {
        args.push('--type', t);
      }
    }
    if (session) {
      args.push('--session', session);
    }
    return this.runJsonCommand(args, workspaceRoot);
  }

  public async getEventsStats(workspaceRoot: string): Promise<any> {
    return this.runJsonCommand(['events', 'stats', '--workspace', workspaceRoot], workspaceRoot);
  }
}
