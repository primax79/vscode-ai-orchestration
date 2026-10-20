import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { getProjectResolver } from './project-resolver';

export function detectSharedWorkspaceRoot(
  folderPaths: string[],
  aiOrchBin?: string | null
): string | null {
  if (!folderPaths || folderPaths.length <= 1) {
    return null;
  }

  const resolvedPaths = folderPaths.map((p) => (fs.existsSync(p) ? fs.realpathSync(p) : path.resolve(p)));

  // Compute Longest Common Directory Ancestor (LCA)
  const splitParts = resolvedPaths.map((p) => p.split(path.sep));
  const first = splitParts[0];
  let commonLen = first.length;
  for (let i = 1; i < splitParts.length; i++) {
    const parts = splitParts[i];
    commonLen = Math.min(commonLen, parts.length);
    for (let j = 0; j < commonLen; j++) {
      if (parts[j] !== first[j]) {
        commonLen = j;
        break;
      }
    }
  }

  if (commonLen <= 1) {
    return null;
  }

  const commonParent = first.slice(0, commonLen).join(path.sep) || path.sep;
  if (!fs.existsSync(commonParent)) {
    return null;
  }

  const hasTasksIndex = fs.existsSync(path.join(commonParent, 'tasks', '00-INDEX.md'));
  if (hasTasksIndex) {
    return commonParent;
  }

  try {
    const resolver = getProjectResolver(commonParent, aiOrchBin);
    if (resolver.getMode() === 'registered') {
      return commonParent;
    }
  } catch {}

  return null;
}

export class WorkspaceManager {
  private static readonly BOUND_WORKSPACE_KEY = 'aiOrchestration.boundWorkspaceFolder';
  private static readonly SELECTED_PROJECT_KEY = 'aiOrchestration.selectedProject';
  private _boundFolder: string | undefined;
  private _selectedProject: string | null = null;
  private _aiOrchBinResolver?: (root?: string) => string | null;

  constructor(
    private readonly context: vscode.ExtensionContext,
    aiOrchBinResolver?: (root?: string) => string | null
  ) {
    this._boundFolder = this.context.workspaceState.get<string>(WorkspaceManager.BOUND_WORKSPACE_KEY);
    this._selectedProject = this.context.workspaceState.get<string | null>(WorkspaceManager.SELECTED_PROJECT_KEY) ?? null;
    this._aiOrchBinResolver = aiOrchBinResolver;
  }

  public getSelectedProject(): string | null {
    return this._selectedProject;
  }

  public async setSelectedProject(projectId: string | null): Promise<void> {
    this._selectedProject = projectId;
    await this.context.workspaceState.update(WorkspaceManager.SELECTED_PROJECT_KEY, projectId);
  }

  public getBoundWorkspaceFolder(): string {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
      return process.cwd();
    }
    if (folders.length === 1) {
      return folders[0].uri.fsPath;
    }

    const folderPaths = folders.map((f) => f.uri.fsPath);
    const bin = this._aiOrchBinResolver ? this._aiOrchBinResolver(folderPaths[0]) : null;
    const sharedRoot = detectSharedWorkspaceRoot(folderPaths, bin);

    const isAllowedBound = (cand: string | undefined): cand is string => {
      if (!cand) return false;
      if (folderPaths.includes(cand)) return true;
      if (sharedRoot && (cand === sharedRoot || (fs.existsSync(cand) && fs.realpathSync(cand) === sharedRoot))) {
        return true;
      }
      return false;
    };

    // Multi-root: check remembered choice
    if (isAllowedBound(this._boundFolder)) {
      return this._boundFolder;
    }
    const saved = this.context.workspaceState.get<string>(WorkspaceManager.BOUND_WORKSPACE_KEY);
    if (isAllowedBound(saved)) {
      this._boundFolder = saved;
      return saved;
    }

    // In a multi-root VS Code workspace whose folders share a common parent that contains
    // tasks/00-INDEX.md or is a registered workspace, bind that parent as the root.
    if (sharedRoot) {
      return sharedRoot;
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
    const folderPaths = folders.map((f) => f.uri.fsPath);
    const bin = this._aiOrchBinResolver ? this._aiOrchBinResolver(folderPaths[0]) : null;
    const sharedRoot = detectSharedWorkspaceRoot(folderPaths, bin);

    const items: Array<{ label: string; description: string; detail?: string; targetPath: string }> = [];

    if (sharedRoot) {
      const alreadyListed = folders.some((f) => {
        const fp = f.uri.fsPath;
        return fp === sharedRoot || (fs.existsSync(fp) && fs.realpathSync(fp) === sharedRoot);
      });
      if (!alreadyListed) {
        items.push({
          label: `${path.basename(sharedRoot)} (Workspace Root)`,
          description: sharedRoot,
          detail: sharedRoot === current ? '(Currently bound — multi-project root)' : '(Multi-project workspace root)',
          targetPath: sharedRoot,
        });
      } else {
        // Put the sharedRoot folder first in the quick pick
        const rootFolder = folders.find((f) => {
          const fp = f.uri.fsPath;
          return fp === sharedRoot || (fs.existsSync(fp) && fs.realpathSync(fp) === sharedRoot);
        })!;
        items.push({
          label: `${rootFolder.name} (Workspace Root)`,
          description: rootFolder.uri.fsPath,
          detail: rootFolder.uri.fsPath === current ? '(Currently bound — multi-project root)' : '(Multi-project workspace root)',
          targetPath: rootFolder.uri.fsPath,
        });
      }
    }

    for (const f of folders) {
      if (items.some((it) => it.targetPath === f.uri.fsPath)) {
        continue;
      }
      items.push({
        label: f.name,
        description: f.uri.fsPath,
        detail: f.uri.fsPath === current ? '(Currently bound)' : undefined,
        targetPath: f.uri.fsPath,
      });
    }

    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: 'Select workspace folder to bind AI Orchestration to',
      title: 'AI Orchestration: Select Workspace Folder',
    });

    if (!picked) {
      return undefined;
    }

    await this.setBoundWorkspaceFolder(picked.targetPath);
    return picked.targetPath;
  }
}
