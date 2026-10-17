import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { CliClient, CliError } from '../cli-client';

export type CliArgBuilder = (payload: any, root: string) => string[];
export type CustomHandler = (panel: DashboardPanel, payload: any, root: string) => Promise<any>;
export type MessageHandler = (panel: DashboardPanel, payload: any, root: string) => Promise<any>;

export const CLI_COMMAND_MAP: Record<string, CliArgBuilder> = {
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
  listQuestions: (payload, root) => {
    const args = ['questions', 'list', '--tasks-dir', path.join(root, 'tasks')];
    if (payload?.status) args.push('--status', String(payload.status));
    if (payload?.blocks) args.push('--blocks', String(payload.blocks));
    return args;
  },
  getQuestion: (payload, root) => ['questions', 'show', String(payload?.questionId || payload?.question_id), '--tasks-dir', path.join(root, 'tasks')],
  answerQuestion: (payload, root) => {
    const qid = payload?.questionId || payload?.question_id;
    const choice = payload?.choice;
    const args = ['questions', 'answer', String(qid), '--choice', String(choice), '--tasks-dir', path.join(root, 'tasks')];
    if (payload?.text) args.push('--text', String(payload.text));
    if (payload?.by) args.push('--by', String(payload.by));
    return args;
  },
  withdrawQuestion: (payload, root) => ['questions', 'withdraw', String(payload?.questionId || payload?.question_id), '--tasks-dir', path.join(root, 'tasks')],
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
    const tasksDir = path.join(root, 'tasks');
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
};

export const HANDLER_MAP: Record<string, MessageHandler> = {
  ...CUSTOM_HANDLERS,
};

for (const [type, builder] of Object.entries(CLI_COMMAND_MAP)) {
  HANDLER_MAP[type] = async (panel: DashboardPanel, payload: any, root: string) => {
    const args = builder(payload, root);
    const data = await panel.cliClient.runJsonCommand<any>(args, root);

    if (type === 'transitionTask') {
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
    } else if (type === 'syncIndex' || type === 'applyAgentsMd') {
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
    this._panel.webview.postMessage({ type: 'changed', areas: ['tasks', 'config', 'env'] });
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
    tasksWatcher.onDidChange(() => this._notifyTasksChanged());
    tasksWatcher.onDidCreate(() => this._notifyTasksChanged());
    tasksWatcher.onDidDelete(() => this._notifyTasksChanged());

    // Watch bound folder's .ai-orchestration/runs/*/run.json
    const runsPattern = new vscode.RelativePattern(this._boundRoot, '.ai-orchestration/runs/*/run.json');
    const runsWatcher = vscode.workspace.createFileSystemWatcher(runsPattern);
    runsWatcher.onDidChange(() => this._notifyRunsChanged());
    runsWatcher.onDidCreate(() => this._notifyRunsChanged());
    runsWatcher.onDidDelete(() => this._notifyRunsChanged());

    this._watcherDisposables.push(tasksWatcher, runsWatcher);
  }

  private _notifyTasksChanged() {
    if (this._tasksDebounceTimer) clearTimeout(this._tasksDebounceTimer);
    this._tasksDebounceTimer = setTimeout(() => {
      this._tasksDebounceTimer = null;
      this._panel.webview.postMessage({ type: 'changed', areas: ['tasks'] });
      if (this.onTasksUpdated) {
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

  public notifyTasksChanged() {
    this._notifyTasksChanged();
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
