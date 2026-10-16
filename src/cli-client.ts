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
}

export class CliClient {
  private outputChannel: vscode.OutputChannel;

  constructor(outputChannel: vscode.OutputChannel) {
    this.outputChannel = outputChannel;
  }

  public resolveCliPath(workspaceRoot?: string): string | null {
    // 1. Configured custom path
    const config = vscode.workspace.getConfiguration('aiOrchestration');
    const customPath = config.get<string>('cliPath');
    if (customPath && fs.existsSync(customPath)) {
      return customPath;
    }

    const home = process.env.HOME || process.env.USERPROFILE || '';

    // Candidate locations
    const candidates: string[] = [];
    if (workspaceRoot) {
      candidates.push(
        path.join(workspaceRoot, 'bin', 'ai-orch'),
        path.join(workspaceRoot, 'ai-orchestration', 'bin', 'ai-orch'),
        path.join(workspaceRoot, '..', 'ai-orchestration', 'bin', 'ai-orch')
      );
    }
    candidates.push(
      path.join(home, '.ai-orchestration', 'repos', 'ai-orchestration', 'bin', 'ai-orch'),
      '/Users/Alfredo/works/ai-coding-tools/ai-orchestration/bin/ai-orch'
    );

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
      throw new Error(
        'ai-orch CLI not found. Please install ai-orchestration or configure aiOrchestration.cliPath in settings.'
      );
    }

    const pythonExe = process.platform === 'win32' ? 'python' : 'python3';
    const fullArgs = [cliPath, ...args, '--json'];

    this.outputChannel.appendLine(`[exec] ${pythonExe} ${fullArgs.join(' ')}`);

    return new Promise((resolve, reject) => {
      const proc = spawn(pythonExe, fullArgs, {
        cwd: workspaceRoot || process.cwd(),
        env: process.env,
      });

      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (d) => (stdout += d.toString()));
      proc.stderr.on('data', (d) => (stderr += d.toString()));

      proc.on('close', (code) => {
        if (code !== 0 && !stdout.trim()) {
          this.outputChannel.appendLine(`[error] code=${code} stderr=${stderr}`);
          return reject(new Error(stderr || `Process exited with code ${code}`));
        }
        try {
          const parsed = JSON.parse(stdout.trim());
          resolve(parsed as T);
        } catch (e: any) {
          this.outputChannel.appendLine(`[json parse error] output was: ${stdout}`);
          reject(new Error(`Failed to parse CLI JSON output: ${e.message}`));
        }
      });

      proc.on('error', (err) => {
        reject(err);
      });
    });
  }

  public async listTasks(workspaceRoot: string): Promise<TaskListResult> {
    const tasksDir = path.join(workspaceRoot, 'tasks');
    return this.runJsonCommand<TaskListResult>(['tasks', 'list', '--tasks-dir', tasksDir], workspaceRoot);
  }

  public async syncIndex(workspaceRoot: string): Promise<any> {
    const tasksDir = path.join(workspaceRoot, 'tasks');
    return this.runJsonCommand(['tasks', 'sync-index', '--tasks-dir', tasksDir, '--apply'], workspaceRoot);
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
    reason?: string
  ): Promise<any> {
    const tasksDir = path.join(workspaceRoot, 'tasks');
    const args = ['tasks', 'transition', taskId, newState, '--tasks-dir', tasksDir, '--actor', actor];
    if (verifier) args.push('--verifier', verifier);
    if (reason) args.push('--reason', reason);
    return this.runJsonCommand(args, workspaceRoot);
  }

  public async getConfig(workspaceRoot: string): Promise<any> {
    return this.runJsonCommand(['config', 'show', '--workspace', workspaceRoot], workspaceRoot);
  }

  public async getEnvStatus(workspaceRoot: string): Promise<any> {
    return this.runJsonCommand(['env', 'status', '--workspace', workspaceRoot], workspaceRoot);
  }

  public async applyAgentsMd(workspaceRoot: string): Promise<any> {
    return this.runJsonCommand(['render-agents-md', '--workspace', workspaceRoot, '--apply'], workspaceRoot);
  }
}
