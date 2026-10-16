import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { CliClient } from '../cli-client';

export class DashboardPanel {
  public static currentPanel: DashboardPanel | undefined;
  private readonly _panel: vscode.WebviewPanel;
  private readonly _extensionUri: vscode.Uri;
  private readonly _cliClient: CliClient;
  private _disposables: vscode.Disposable[] = [];

  public static createOrShow(
    extensionUri: vscode.Uri,
    cliClient: CliClient,
    onTasksUpdated?: () => void
  ) {
    const column = vscode.window.activeTextEditor
      ? vscode.window.activeTextEditor.viewColumn
      : undefined;

    if (DashboardPanel.currentPanel) {
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
          extensionUri,
          vscode.Uri.file('/Users/Alfredo/works/ai-coding-tools/ai-orchestration-ui/frontend/dist'),
          vscode.Uri.joinPath(extensionUri, 'dist-webview'),
        ],
      }
    );

    DashboardPanel.currentPanel = new DashboardPanel(panel, extensionUri, cliClient, onTasksUpdated);
  }

  private constructor(
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    cliClient: CliClient,
    private onTasksUpdated?: () => void
  ) {
    this._panel = panel;
    this._extensionUri = extensionUri;
    this._cliClient = cliClient;

    this._panel.iconPath = {
      light: vscode.Uri.joinPath(this._extensionUri, 'resources', 'icon.svg'),
      dark: vscode.Uri.joinPath(this._extensionUri, 'resources', 'icon.svg'),
    };

    this._update();

    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

    this._panel.webview.onDidReceiveMessage(
      async (message) => {
        await this._handleMessage(message);
      },
      null,
      this._disposables
    );
  }

  private getActiveWorkspaceRoot(): string {
    const folders = vscode.workspace.workspaceFolders;
    return folders && folders.length > 0 ? folders[0].uri.fsPath : process.cwd();
  }

  private async _handleMessage(message: any) {
    const root = this.getActiveWorkspaceRoot();
    const { id, type, payload } = message;

    try {
      if (type === 'getWorkspace') {
        const tasksDir = path.join(root, 'tasks');
        const hasTasks = fs.existsSync(tasksDir);
        this._respond(id, {
          workspace_path: root,
          workspace_name: path.basename(root),
          has_tasks_dir: hasTasks,
          tasks_path: hasTasks ? tasksDir : null,
        });
        return;
      }

      if (type === 'getTasks') {
        const data = await this._cliClient.listTasks(root);
        this._respond(id, data);
        return;
      }

      if (type === 'validateTasks') {
        const data = await this._cliClient.validateTasks(root);
        this._respond(id, data);
        return;
      }

      if (type === 'transitionTask') {
        const { taskId, newState, actor, verifier, reason } = payload;
        const data = await this._cliClient.transitionTask(root, taskId, newState, actor, verifier, reason);
        await this._cliClient.syncIndex(root);
        if (this.onTasksUpdated) this.onTasksUpdated();
        this._respond(id, data);
        return;
      }

      if (type === 'syncIndex') {
        const data = await this._cliClient.syncIndex(root);
        if (this.onTasksUpdated) this.onTasksUpdated();
        this._respond(id, data);
        return;
      }

      if (type === 'getTaskDetail') {
        const taskId = payload.taskId;
        const tasksDir = path.join(root, 'tasks');
        const candidates = [
          ...this._globFile(tasksDir, `*/${taskId}-*.md`),
          ...this._globFile(tasksDir, `*/${taskId}/README.md`),
          ...this._globFile(path.join(tasksDir, 'done'), `*/${taskId}-*.md`),
          ...this._globFile(path.join(tasksDir, 'done'), `*/${taskId}/README.md`),
        ];

        if (candidates.length === 0) {
          throw new Error(`Task ${taskId} file not found`);
        }

        const targetFile = candidates[0];
        const content = fs.readFileSync(targetFile, 'utf-8');
        const progressFile = path.join(path.dirname(targetFile), 'PROGRESS.md');
        const progressContent = fs.existsSync(progressFile) ? fs.readFileSync(progressFile, 'utf-8') : null;

        this._respond(id, {
          task_id: taskId,
          file_path: targetFile,
          relative_path: path.relative(root, targetFile),
          is_folder_bundle: path.basename(targetFile) === 'README.md',
          content,
          progress_content: progressContent,
        });
        return;
      }

      if (type === 'getConfig') {
        const data = await this._cliClient.getConfig(root);
        this._respond(id, data);
        return;
      }

      if (type === 'getEnvStatus') {
        const data = await this._cliClient.getEnvStatus(root);
        this._respond(id, data);
        return;
      }

      if (type === 'applyAgentsMd') {
        const data = await this._cliClient.applyAgentsMd(root);
        this._respond(id, data);
        return;
      }
    } catch (e: any) {
      this._respondError(id, e.message || String(e));
    }
  }

  private _globFile(baseDir: string, pattern: string): string[] {
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

  private _respond(id: string, data: any) {
    this._panel.webview.postMessage({ id, data, ok: true });
  }

  private _respondError(id: string, error: string) {
    this._panel.webview.postMessage({ id, error, ok: false });
  }

  public notifyTasksChanged() {
    this._panel.webview.postMessage({ type: 'tasks_changed' });
  }

  public dispose() {
    DashboardPanel.currentPanel = undefined;
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
    // 1. Try local extension dist-webview, then fallback to sibling ai-orchestration-ui/frontend/dist
    let distFolder = path.join(this._extensionUri.fsPath, 'dist-webview');
    if (!fs.existsSync(distFolder)) {
      distFolder = '/Users/Alfredo/works/ai-coding-tools/ai-orchestration-ui/frontend/dist';
    }

    const indexPath = path.join(distFolder, 'index.html');
    if (!fs.existsSync(indexPath)) {
      return `<!DOCTYPE html>
        <html>
          <body style="background:#0f172a;color:#f8fafc;padding:2rem;font-family:sans-serif;">
            <h2>AI Orchestration Frontend Bundle Not Found</h2>
            <p>Please build the frontend: <code>cd ai-orchestration-ui/frontend && npm run build</code></p>
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
