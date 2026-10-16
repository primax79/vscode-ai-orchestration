import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { CliClient, TaskItem, InitiativeItem, TaskListResult } from '../cli-client';

export class TaskTreeItem extends vscode.TreeItem {
  constructor(
    public readonly task: TaskItem,
    public readonly workspaceRoot: string
  ) {
    super(
      `[${task.priority}] ${task.id}: ${task.title}`,
      vscode.TreeItemCollapsibleState.None
    );

    this.tooltip = new vscode.MarkdownString(
      `### ${task.id}: ${task.title}\n\n` +
      `- **State:** \`${task.state}\`\n` +
      `- **Priority:** \`${task.priority}\` (${task.priority_reason || 'none'})\n` +
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
    } else if (task.state === 'delivered') {
      this.iconPath = new vscode.ThemeIcon('pass', new vscode.ThemeColor('charts.blue'));
    } else if (task.state === 'verified') {
      this.iconPath = new vscode.ThemeIcon('verified', new vscode.ThemeColor('charts.green'));
    } else {
      this.iconPath = new vscode.ThemeIcon('circle-outline');
    }

    // Click command opens the markdown file
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
    public readonly initiative: InitiativeItem,
    public readonly workspaceRoot: string
  ) {
    super(
      `Initiative #${initiative.id}: ${initiative.title}`,
      vscode.TreeItemCollapsibleState.None
    );

    this.description = `${initiative.tasks_count} subtasks`;
    this.iconPath = new vscode.ThemeIcon('layers', new vscode.ThemeColor('charts.purple'));
    this.tooltip = `Initiative ${initiative.id}: ${initiative.title}\nPlan: ${initiative.plan_path}`;

    if (initiative.plan_path && fs.existsSync(initiative.plan_path)) {
      this.command = {
        command: 'vscode.open',
        title: 'Open Initiative Plan',
        arguments: [vscode.Uri.file(initiative.plan_path)],
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

  constructor(
    private cliClient: CliClient,
    private viewType: 'nextUp' | 'initiatives' | 'decisions'
  ) {}

  public refresh(): void {
    this.cachedResult = null;
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
    if (element) {
      return [];
    }

    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
      return [new vscode.TreeItem('No workspace open')];
    }

    const rootPath = workspaceFolders[0].uri.fsPath;
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

      const tasks = this.cachedResult.emergent_tasks || [];
      const initiatives = this.cachedResult.initiatives || [];

      if (this.viewType === 'nextUp') {
        const nextUps = tasks.filter((t) => t.next_up === 'yes' && t.state !== 'done');
        if (nextUps.length === 0) {
          return [new vscode.TreeItem('No tasks currently in Next Up queue')];
        }
        return nextUps.map((t) => new TaskTreeItem(t, rootPath));
      }

      if (this.viewType === 'initiatives') {
        if (initiatives.length === 0) {
          return [new vscode.TreeItem('No planned initiatives found')];
        }
        return initiatives.map((init) => new InitiativeTreeItem(init, rootPath));
      }

      if (this.viewType === 'decisions') {
        const decisions = tasks.filter(
          (t) => (t.decider && t.decider !== '-') || t.state === 'waiting'
        );
        if (decisions.length === 0) {
          return [new vscode.TreeItem('No decisions waiting on user')];
        }
        return decisions.map((t) => new DecisionTreeItem(t, rootPath));
      }

      return [];
    } catch (err: any) {
      const errItem = new vscode.TreeItem(`Error: ${err.message || err}`);
      errItem.iconPath = new vscode.ThemeIcon('error');
      return [errItem];
    }
  }
}
