import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { CliClient } from './cli-client';
import { TaskTreeProvider, TaskTreeItem } from './views/task-tree-provider';
import { DashboardPanel } from './views/dashboard-panel';
import { WorkspaceManager } from './workspace-manager';

export function activate(context: vscode.ExtensionContext) {
  const outputChannel = vscode.window.createOutputChannel('AI Orchestration');
  const cliClient = new CliClient(outputChannel);
  const workspaceManager = new WorkspaceManager(context);

  // Status Bar Item
  const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 10);
  statusBarItem.command = 'aiOrchestration.openDashboard';
  statusBarItem.text = '$(layers) AI Tasks';
  statusBarItem.tooltip = 'Click to open AI Orchestration Task Backlog & Dashboard';
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  // Tree View Providers (bound to current workspace folder)
  const getBoundRoot = () => workspaceManager.getBoundWorkspaceFolder();
  const nextUpProvider = new TaskTreeProvider(cliClient, 'nextUp', getBoundRoot);
  const initiativesProvider = new TaskTreeProvider(cliClient, 'initiatives', getBoundRoot);
  const decisionsProvider = new TaskTreeProvider(cliClient, 'decisions', getBoundRoot);

  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('aiOrchestration.nextUpView', nextUpProvider),
    vscode.window.registerTreeDataProvider('aiOrchestration.initiativesView', initiativesProvider),
    vscode.window.registerTreeDataProvider('aiOrchestration.decisionsView', decisionsProvider)
  );

  const refreshAll = () => {
    nextUpProvider.refresh();
    initiativesProvider.refresh();
    decisionsProvider.refresh();
    if (DashboardPanel.currentPanel) {
      DashboardPanel.currentPanel.notifyTasksChanged();
    }
    updateStatusBarCount();
  };

  const updateStatusBarCount = async () => {
    const root = workspaceManager.getBoundWorkspaceFolder();
    if (!root || !fs.existsSync(root)) return;
    try {
      const res = await cliClient.listTasks(root);
      const active = (res.emergent_tasks || []).filter((t) => t.state !== 'done').length;
      statusBarItem.text = `$(layers) AI Tasks: ${active}`;
    } catch {}
  };

  // Commands
  context.subscriptions.push(
    vscode.commands.registerCommand('aiOrchestration.openDashboard', async () => {
      const folders = vscode.workspace.workspaceFolders;
      if (!folders || folders.length === 0) {
        vscode.window.showWarningMessage('No workspace open to show AI Orchestration dashboard');
        return;
      }

      let boundRoot: string;
      if (folders.length > 1) {
        const picked = await workspaceManager.pickWorkspaceFolder();
        if (!picked) {
          return;
        }
        boundRoot = picked;
      } else {
        boundRoot = folders[0].uri.fsPath;
        await workspaceManager.setBoundWorkspaceFolder(boundRoot);
      }

      DashboardPanel.createOrShow(
        context.extensionUri,
        cliClient,
        boundRoot,
        refreshAll,
        async (newRoot) => {
          await workspaceManager.setBoundWorkspaceFolder(newRoot);
          setupWatcherForBoundFolder();
          refreshAll();
        }
      );
      setupWatcherForBoundFolder();
      refreshAll();
    }),

    vscode.commands.registerCommand('aiOrchestration.refresh', () => {
      refreshAll();
    }),

    vscode.commands.registerCommand('aiOrchestration.syncIndex', async () => {
      const root = workspaceManager.getBoundWorkspaceFolder();
      if (!root || !fs.existsSync(root)) {
        vscode.window.showWarningMessage('No workspace open to sync 00-INDEX.md');
        return;
      }
      try {
        await cliClient.syncIndex(root);
        vscode.window.showInformationMessage('00-INDEX.md synchronized successfully');
        refreshAll();
      } catch (err: any) {
        vscode.window.showErrorMessage(`Sync failed: ${err.message}`);
      }
    }),

    vscode.commands.registerCommand('aiOrchestration.validateTasks', async () => {
      const root = workspaceManager.getBoundWorkspaceFolder();
      if (!root || !fs.existsSync(root)) return;
      try {
        const res = await cliClient.validateTasks(root);
        if (res.ok) {
          vscode.window.showInformationMessage(`Tasks valid (${res.total_tasks} task(s) verified)`);
        } else {
          vscode.window.showErrorMessage(`Validation errors: ${JSON.stringify(res.errors)}`);
        }
      } catch (err: any) {
        vscode.window.showErrorMessage(`Validation failed: ${err.message}`);
      }
    }),

    vscode.commands.registerCommand('aiOrchestration.copyHandoff', (item?: TaskTreeItem) => {
      if (item && item.task.handoff) {
        vscode.env.clipboard.writeText(item.task.handoff);
        vscode.window.showInformationMessage(`Copied handoff prompt for ${item.task.id}`);
      }
    }),

    vscode.commands.registerCommand('aiOrchestration.openTaskFile', (item?: TaskTreeItem) => {
      if (item && item.task.file_path && fs.existsSync(item.task.file_path)) {
        vscode.window.showTextDocument(vscode.Uri.file(item.task.file_path));
      }
    })
  );

  // File System Watcher on tasks/ directory for bound folder
  let activeWatcher: vscode.Disposable | undefined;
  const setupWatcherForBoundFolder = () => {
    if (activeWatcher) {
      activeWatcher.dispose();
      activeWatcher = undefined;
    }
    const bound = workspaceManager.getBoundWorkspaceFolder();
    if (bound && fs.existsSync(bound)) {
      const watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(bound, 'tasks/**/*.{md,toml}')
      );
      watcher.onDidChange(() => refreshAll());
      watcher.onDidCreate(() => refreshAll());
      watcher.onDidDelete(() => refreshAll());
      activeWatcher = watcher;
      context.subscriptions.push(watcher);
    }
  };
  setupWatcherForBoundFolder();

  // Watch for workspace folder changes in VS Code
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      setupWatcherForBoundFolder();
      refreshAll();
    })
  );

  // Initial load
  updateStatusBarCount();
  outputChannel.appendLine('AI Orchestration extension activated.');
}

export function deactivate() {
  if (DashboardPanel.currentPanel) {
    DashboardPanel.currentPanel.dispose();
  }
}
