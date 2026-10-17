import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { CliClient, TaskItem, InitiativeItem, TaskListResult } from '../cli-client';
import {
  DecisionsTreeProvider,
  DecisionGroupTreeItem,
  DecisionQuestionTreeItem,
  DecisionTreeItem as NewDecisionTreeItem,
} from './decisions-tree-provider';

export class TaskTreeItem extends vscode.TreeItem {
  constructor(
    public readonly task: TaskItem,
    public readonly workspaceRoot: string
  ) {
    super(
      `[${task.priority || 'P1'}] ${task.id}: ${task.title}`,
      vscode.TreeItemCollapsibleState.None
    );

    this.tooltip = new vscode.MarkdownString(
      `### ${task.id}: ${task.title}\n\n` +
      `- **State:** \`${task.state}\`\n` +
      `- **Priority:** \`${task.priority || 'P1'}\` (${task.priority_reason || 'none'})\n` +
      `- **Assignee:** \`${task.executor || 'self'}\`\n` +
      `- **Category:** \`${task.category}\`\n` +
      (task.handoff ? `\n**Handoff Prompt:**\n\`\`\`\n${task.handoff}\n\`\`\`\n` : '')
    );
    this.tooltip.isTrusted = true;

    this.description = `${task.state} (${task.executor || 'self'})`;
    this.contextValue = 'taskItem';

    // Icons matching priority and state
    if (task.priority === 'P0') {
      this.iconPath = new vscode.ThemeIcon('flame', new vscode.ThemeColor('errorForeground'));
    } else if (task.priority === 'P1') {
      this.iconPath = new vscode.ThemeIcon('issue-opened', new vscode.ThemeColor('charts.orange'));
    } else if (task.state === 'paused') {
      this.iconPath = new vscode.ThemeIcon('debug-pause', new vscode.ThemeColor('charts.yellow'));
    } else if (task.state === 'delivered') {
      this.iconPath = new vscode.ThemeIcon('pass', new vscode.ThemeColor('charts.blue'));
    } else if (task.state === 'verified') {
      this.iconPath = new vscode.ThemeIcon('verified', new vscode.ThemeColor('charts.green'));
    } else if (task.state === 'done') {
      this.iconPath = new vscode.ThemeIcon('check', new vscode.ThemeColor('charts.green'));
    } else {
      this.iconPath = new vscode.ThemeIcon('circle-outline');
    }

    if (task.file_path && fs.existsSync(task.file_path)) {
      this.command = {
        command: 'vscode.open',
        title: 'Open Task File',
        arguments: [vscode.Uri.file(task.file_path)],
      };
    }
  }
}

export class InitiativeTreeItem extends vscode.TreeItem {
  constructor(
    public readonly initiative: any,
    public readonly workspaceRoot: string
  ) {
    const hasSubtasks = (initiative.tasks || []).length > 0;
    super(
      `#${initiative.id}: ${initiative.title}`,
      hasSubtasks
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None
    );

    const status = initiative.status || (initiative.location === 'merged' ? 'done' : 'active');
    this.description = `${status} (${(initiative.tasks || []).length} tasks)`;

    if (status === 'done') {
      this.iconPath = new vscode.ThemeIcon('pass-filled', new vscode.ThemeColor('charts.green'));
    } else if (status === 'in progress') {
      this.iconPath = new vscode.ThemeIcon('sync', new vscode.ThemeColor('charts.blue'));
    } else {
      this.iconPath = new vscode.ThemeIcon('layers', new vscode.ThemeColor('charts.purple'));
    }

    this.tooltip = `Initiative ${initiative.id}: ${initiative.title}\nStatus: ${status}\nFolder: ${initiative.folder}`;

    const planPath = path.join(workspaceRoot, 'tasks', initiative.rel_path);
    if (fs.existsSync(planPath)) {
      this.command = {
        command: 'vscode.open',
        title: 'Open Initiative Plan',
        arguments: [vscode.Uri.file(planPath)],
      };
    }
  }
}

export class DecisionTreeItem extends vscode.TreeItem {
  constructor(
    public readonly task: TaskItem,
    public readonly workspaceRoot: string
  ) {
    super(
      `[Decision] ${task.id}: ${task.decider || task.title}`,
      vscode.TreeItemCollapsibleState.None
    );

    this.description = `Waiting on: ${task.decider || 'owner'}`;
    this.iconPath = new vscode.ThemeIcon('question', new vscode.ThemeColor('charts.yellow'));
    this.tooltip = `Task ${task.id} is waiting on decision:\n${task.decider}`;

    if (task.file_path && fs.existsSync(task.file_path)) {
      this.command = {
        command: 'vscode.open',
        title: 'Open Task File',
        arguments: [vscode.Uri.file(task.file_path)],
      };
    }
  }
}

export class TaskTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private _onDidChangeTreeData: vscode.EventEmitter<vscode.TreeItem | undefined | null | void> =
    new vscode.EventEmitter<vscode.TreeItem | undefined | null | void>();
  readonly onDidChangeTreeData: vscode.Event<vscode.TreeItem | undefined | null | void> =
    this._onDidChangeTreeData.event;

  private cachedResult: TaskListResult | null = null;
  private decisionsDelegate?: DecisionsTreeProvider;

  constructor(
    private cliClient: CliClient,
    private viewType: 'nextUp' | 'initiatives' | 'decisions',
    private getRootPath?: () => string
  ) {}

  public refresh(): void {
    this.cachedResult = null;
    if (this.decisionsDelegate) {
      this.decisionsDelegate.refresh();
    }
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
    const rootPath = this.getRootPath
      ? this.getRootPath()
      : (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0
          ? vscode.workspace.workspaceFolders[0].uri.fsPath
          : null);

    if (!rootPath) {
      return [new vscode.TreeItem('No workspace open')];
    }
    const tasksDir = path.join(rootPath, 'tasks');
    if (!fs.existsSync(tasksDir)) {
      const item = new vscode.TreeItem('No tasks/ directory found');
      item.description = 'Run "ai-orch config init-project"';
      return [item];
    }

    try {
      if (!this.cachedResult) {
        this.cachedResult = await this.cliClient.listTasks(rootPath);
      }

      const allTasks = this.cachedResult.all_tasks || this.cachedResult.emergent_tasks || [];
      const initiatives = this.cachedResult.initiatives || [];

      // If expanding an initiative, show its subtasks!
      if (element instanceof InitiativeTreeItem) {
        const init = element.initiative;
        const subtasks = (init.tasks || []).map((st: any) => {
          const item = new vscode.TreeItem(
            `[${st.state || init.status || 'open'}] ${st.id}: ${st.title}`,
            vscode.TreeItemCollapsibleState.None
          );
          item.description = st.state || init.status;
          item.iconPath = st.state === 'done' || init.status === 'done'
            ? new vscode.ThemeIcon('check', new vscode.ThemeColor('charts.green'))
            : st.state === 'verified'
            ? new vscode.ThemeIcon('verified', new vscode.ThemeColor('charts.green'))
            : new vscode.ThemeIcon('circle-outline');
          const planPath = path.join(rootPath, 'tasks', init.rel_path);
          item.command = {
            command: 'vscode.open',
            title: 'Open Plan',
            arguments: [vscode.Uri.file(planPath)],
          };
          return item;
        });
        return subtasks;
      }

      if (this.viewType === 'nextUp') {
        const nextUps = allTasks.filter((t) => t.next_up === 'yes' && t.state !== 'done');
        if (nextUps.length > 0) {
          return nextUps.map((t) => new TaskTreeItem(t, rootPath));
        }
        // Fallback: show active in-progress tasks
        const active = allTasks.filter((t) => t.state !== 'done');
        if (active.length === 0) {
          const allDone = new vscode.TreeItem('All tasks completed!');
          allDone.iconPath = new vscode.ThemeIcon('pass-filled', new vscode.ThemeColor('charts.green'));
          return [allDone];
        }
        return active.slice(0, 10).map((t) => new TaskTreeItem(t, rootPath));
      }

      if (this.viewType === 'initiatives') {
        if (initiatives.length === 0) {
          return [new vscode.TreeItem('No planned initiatives found')];
        }
        return initiatives.map((init) => new InitiativeTreeItem(init, rootPath));
      }

      if (this.viewType === 'decisions') {
        if (!this.decisionsDelegate) {
          this.decisionsDelegate = new DecisionsTreeProvider(this.cliClient, this.getRootPath);
        }
        return this.decisionsDelegate.getChildren(element);
      }

      return [];
    } catch (err: any) {
      const errItem = new vscode.TreeItem(`Error: ${err.message || err}`);
      errItem.iconPath = new vscode.ThemeIcon('error');
      return [errItem];
    }
  }
}

export {
  DecisionsTreeProvider,
  DecisionGroupTreeItem,
  DecisionQuestionTreeItem,
};
