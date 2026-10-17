import * as vscode from 'vscode';

export class WorkspaceManager {
  private static readonly BOUND_WORKSPACE_KEY = 'aiOrchestration.boundWorkspaceFolder';
  private _boundFolder: string | undefined;

  constructor(private readonly context: vscode.ExtensionContext) {
    this._boundFolder = this.context.workspaceState.get<string>(WorkspaceManager.BOUND_WORKSPACE_KEY);
  }

  public getBoundWorkspaceFolder(): string {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
      return process.cwd();
    }
    if (folders.length === 1) {
      return folders[0].uri.fsPath;
    }
    // Multi-root: check remembered choice
    if (this._boundFolder && folders.some((f) => f.uri.fsPath === this._boundFolder)) {
      return this._boundFolder;
    }
    const saved = this.context.workspaceState.get<string>(WorkspaceManager.BOUND_WORKSPACE_KEY);
    if (saved && folders.some((f) => f.uri.fsPath === saved)) {
      this._boundFolder = saved;
      return saved;
    }
    // Default to first folder if nothing explicitly bound yet
    return folders[0].uri.fsPath;
  }

  public async setBoundWorkspaceFolder(folderPath: string): Promise<void> {
    this._boundFolder = folderPath;
    await this.context.workspaceState.update(WorkspaceManager.BOUND_WORKSPACE_KEY, folderPath);
  }

  public async pickWorkspaceFolder(): Promise<string | undefined> {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
      return undefined;
    }
    if (folders.length === 1) {
      const p = folders[0].uri.fsPath;
      await this.setBoundWorkspaceFolder(p);
      return p;
    }

    const current = this.getBoundWorkspaceFolder();
    const items = folders.map((f) => ({
      label: f.name,
      description: f.uri.fsPath,
      detail: f.uri.fsPath === current ? '(Currently bound)' : undefined,
      folder: f,
    }));

    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: 'Select workspace folder to bind AI Orchestration to',
      title: 'AI Orchestration: Select Workspace Folder',
    });

    if (!picked) {
      return undefined;
    }

    await this.setBoundWorkspaceFolder(picked.folder.uri.fsPath);
    return picked.folder.uri.fsPath;
  }
}
