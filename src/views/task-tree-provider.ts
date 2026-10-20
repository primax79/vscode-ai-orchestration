import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { CliClient, TaskItem, InitiativeItem, TaskListResult } from '../cli-client';
import { shortTitle } from '../short-title';
import { ProjectInfo, getProjectResolver } from '../project-resolver';
import {
  DecisionsTreeProvider,
  DecisionGroupTreeItem,
  DecisionQuestionTreeItem,
  DecisionTreeItem as NewDecisionTreeItem,
} from './decisions-tree-provider';

export class ProjectGroupTreeItem extends vscode.TreeItem {
  constructor(
    public readonly project: ProjectInfo,
    public readonly count?: number
  ) {
    super(project.id, vscode.TreeItemCollapsibleState.Expanded);
    this.id = `project-group-${project.id}`;
    this.contextValue = 'projectGroup';
    this.description = count !== undefined ? `${project.path} (${count})` : project.path;
    this.tooltip = `Project ${project.id} (${project.path}) — kind: ${project.kind}`;
    this.iconPath =
      project.kind === '_workspace'
        ? new vscode.ThemeIcon('root-folder', new vscode.ThemeColor('charts.purple'))
        : new vscode.ThemeIcon('folder-library', new vscode.ThemeColor('charts.blue'));
  }
}

export class TaskTreeItem extends vscode.TreeItem {
  constructor(
    public readonly task: TaskItem,
    public readonly workspaceRoot: string,
    public readonly projectPrefix?: string
  ) {
    const st = shortTitle(task);
    const idLabel = projectPrefix ? `${projectPrefix}/${task.id}` : task.id;
    const label = st ? `${idLabel} (${st})` : idLabel;
    super(
      label,
      vscode.TreeItemCollapsibleState.None
    );

    this.tooltip = new vscode.MarkdownString(
      `### ${idLabel}: ${task.title}\n\n` +
      `- **State:** \`${task.state}\`\n` +
      `- **Priority:** \`${task.priority || 'P1'}\` (${task.priority_reason || 'none'})\n` +
      `- **Assignee:** \`${task.executor || 'self'}\`\n` +
      `- **Category:** \`${task.category}\`\n` +
      (task.handoff ? `\n**Handoff Prompt:**\n\`\`\`\n${task.handoff}\n\`\`\`\n` : '')
    );
    this.tooltip.isTrusted = true;

    this.description = `${task.title} • ${task.state} (${task.executor || 'self'})`;
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
    public readonly workspaceRoot: string,
    public readonly projectPrefix?: string
  ) {
    const hasSubtasks = (initiative.tasks || []).length > 0;
    const st = shortTitle(initiative);
    const rawIdStr = String(initiative.id).startsWith('#') ? initiative.id : `#${initiative.id}`;
    const idStr = projectPrefix ? `${projectPrefix}/${rawIdStr}` : rawIdStr;
    const label = st ? `${idStr} (${st})` : idStr;
    super(
      label,
      hasSubtasks
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None
    );

    const status = initiative.status || (initiative.location === 'merged' ? 'done' : 'active');
    this.description = `${initiative.title} • ${status} (${(initiative.tasks || []).length} tasks)`;

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
    public readonly workspaceRoot: string,
    public readonly projectPrefix?: string
  ) {
    const st = shortTitle(task);
    const idLabel = projectPrefix ? `${projectPrefix}/${task.id}` : task.id;
    const label = st ? `${idLabel} (${st})` : idLabel;
    super(
      label,
      vscode.TreeItemCollapsibleState.None
    );

    this.description = `${task.title} • Waiting on: ${task.decider || 'owner'}`;
    this.iconPath = new vscode.ThemeIcon('question', new vscode.ThemeColor('charts.yellow'));
    this.tooltip = `Task ${idLabel}: ${task.title}\nWaiting on decision: ${task.decider}`;

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
  private cachedByProject = new Map<string, TaskListResult>();
  private decisionsDelegate?: DecisionsTreeProvider;

  constructor(
    private cliClient: CliClient,
    private viewType: 'nextUp' | 'initiatives' | 'decisions' | 'useCases',
    private getRootPath?: () => string,
    private getSelectedProject?: () => string | null
  ) {}

  public refresh(): void {
    this.cachedResult = null;
    this.cachedByProject.clear();
    if (this.decisionsDelegate) {
      this.decisionsDelegate.refresh();
    }
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  private async _loadTasksForRoot(projectRoot: string): Promise<TaskListResult> {
    if (this.cachedByProject.has(projectRoot)) {
      return this.cachedByProject.get(projectRoot)!;
    }
    const res = await this.cliClient.listTasks(projectRoot);
    this.cachedByProject.set(projectRoot, res);
    return res;
  }

  private async _getChildrenForProject(
    projectRoot: string,
    projectPrefix?: string
  ): Promise<vscode.TreeItem[]> {
    const tasksDir = path.join(projectRoot, 'tasks');
    if (!fs.existsSync(tasksDir)) {
      const item = new vscode.TreeItem('No tasks/ directory found');
      item.description = 'Run "ai-orch config init-project"';
      return [item];
    }

    if (this.viewType === 'useCases') {
      const res = await this.cliClient.runJsonCommand<any>(
        ['use-cases', 'list', '--tasks-dir', tasksDir],
        projectRoot
      );
      const ucs = res.use_cases || [];
      if (ucs.length === 0) {
        const empty = new vscode.TreeItem('No use cases found in tasks/use-cases/');
        empty.iconPath = new vscode.ThemeIcon('info');
        return [empty];
      }
      return ucs.map((u: any) => {
        const st = shortTitle(u);
        const idLabel = projectPrefix ? `${projectPrefix}/${u.id}` : u.id;
        const label = st ? `${idLabel} (${st})` : idLabel;
        const item = new vscode.TreeItem(
          label,
          vscode.TreeItemCollapsibleState.None
        );
        item.description = `${u.title} • ${u.status} (${u.actor})`;
        item.tooltip = `${idLabel}: ${u.title}\nActor: ${u.actor}\nStatus: ${u.status}\nLast verdict: ${u.last_verdict || 'untested'}`;
        if (u.last_verdict === 'pass') {
          item.iconPath = new vscode.ThemeIcon('pass-filled', new vscode.ThemeColor('charts.green'));
        } else if (u.last_verdict === 'fail') {
          item.iconPath = new vscode.ThemeIcon('error', new vscode.ThemeColor('charts.red'));
        } else {
          item.iconPath = new vscode.ThemeIcon('target', new vscode.ThemeColor('charts.blue'));
        }
        if (u.file_path && fs.existsSync(u.file_path)) {
          item.command = {
            command: 'vscode.open',
            title: 'Open Use Case',
            arguments: [vscode.Uri.file(u.file_path)],
          };
        }
        return item;
      });
    }

    const result = await this._loadTasksForRoot(projectRoot);
    const allTasks = result.all_tasks || result.emergent_tasks || [];
    const initiatives = result.initiatives || [];

    if (this.viewType === 'nextUp') {
      const nextUps = allTasks.filter((t) => t.next_up === 'yes' && t.state !== 'done');
      if (nextUps.length > 0) {
        return nextUps.map((t) => new TaskTreeItem(t, projectRoot, projectPrefix));
      }
      const active = allTasks.filter((t) => t.state !== 'done');
      if (active.length === 0) {
        const allDone = new vscode.TreeItem('All tasks completed!');
        allDone.iconPath = new vscode.ThemeIcon('pass-filled', new vscode.ThemeColor('charts.green'));
        return [allDone];
      }
      return active.slice(0, 10).map((t) => new TaskTreeItem(t, projectRoot, projectPrefix));
    }

    if (this.viewType === 'initiatives') {
      if (initiatives.length === 0) {
        return [new vscode.TreeItem('No planned initiatives found')];
      }
      return initiatives.map((init) => new InitiativeTreeItem(init, projectRoot, projectPrefix));
    }

    return [];
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

    if (this.viewType === 'decisions') {
      if (!this.decisionsDelegate) {
        this.decisionsDelegate = new DecisionsTreeProvider(
          this.cliClient,
          this.getRootPath,
          undefined,
          this.getSelectedProject
        );
      }
      return this.decisionsDelegate.getChildren(element);
    }

    try {
      // If expanding an initiative, show its subtasks!
      if (element instanceof InitiativeTreeItem) {
        const init = element.initiative;
        const projPrefix = element.projectPrefix;
        const subtasks = (init.tasks || []).map((st: any) => {
          const sTitle = shortTitle(st);
          const idLabel = projPrefix ? `${projPrefix}/${st.id}` : st.id;
          const label = sTitle ? `${idLabel} (${sTitle})` : idLabel;
          const item = new vscode.TreeItem(
            label,
            vscode.TreeItemCollapsibleState.None
          );
          item.description = `${st.title} (${st.state || init.status || 'open'})`;
          item.tooltip = `${idLabel}: ${st.title}\nState: ${st.state || init.status || 'open'}`;
          item.iconPath = st.state === 'done' || init.status === 'done'
            ? new vscode.ThemeIcon('check', new vscode.ThemeColor('charts.green'))
            : st.state === 'verified'
            ? new vscode.ThemeIcon('verified', new vscode.ThemeColor('charts.green'))
            : new vscode.ThemeIcon('circle-outline');
          const planPath = path.join(element.workspaceRoot, 'tasks', init.rel_path);
          item.command = {
            command: 'vscode.open',
            title: 'Open Plan',
            arguments: [vscode.Uri.file(planPath)],
          };
          return item;
        });
        return subtasks;
      }

      // If expanding a project group node in multi-project common view
      if (element instanceof ProjectGroupTreeItem) {
        return this._getChildrenForProject(element.project.root, element.project.id);
      }

      // Resolve projects at rootPath
      const aiOrchBin = this.cliClient?.resolveCliPath ? this.cliClient.resolveCliPath(rootPath) : null;
      const resolver = getProjectResolver(rootPath, aiOrchBin);
      const projects = resolver.getProjects();

      if (projects.length > 1) {
        const selectedProjId = this.getSelectedProject ? this.getSelectedProject() : null;
        if (selectedProjId) {
          const matched = projects.find((p) => p.id === selectedProjId);
          if (matched) {
            return this._getChildrenForProject(matched.root, undefined);
          }
        }
        // All projects: top-level node per project
        return projects.map((p) => new ProjectGroupTreeItem(p));
      }

      // Single project: exact existing behaviour
      const singleRoot = projects.length === 1 ? projects[0].root : rootPath;
      return this._getChildrenForProject(singleRoot, undefined);
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
