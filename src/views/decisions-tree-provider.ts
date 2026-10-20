import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { CliClient, QuestionItem, TaskItem } from '../cli-client';
import { shortTitle } from '../short-title';
import { ProjectInfo, getProjectResolver } from '../project-resolver';

export interface DecisionGroupData {
  groupKey: string;
  label: string;
  taskTitle?: string;
  questions: QuestionItem[];
}

export class DecisionProjectTreeItem extends vscode.TreeItem {
  constructor(
    public readonly project: ProjectInfo,
    public readonly count?: number
  ) {
    super(project.id, vscode.TreeItemCollapsibleState.Expanded);
    this.id = `decision-project-${project.id}`;
    this.contextValue = 'decisionProjectGroup';
    this.description = count !== undefined ? `${project.path} (${count})` : project.path;
    this.tooltip = `Project ${project.id} (${project.path}) — kind: ${project.kind}`;
    this.iconPath =
      project.kind === '_workspace'
        ? new vscode.ThemeIcon('root-folder', new vscode.ThemeColor('charts.purple'))
        : new vscode.ThemeIcon('folder-library', new vscode.ThemeColor('charts.blue'));
  }
}

export function getBlockedTaskIds(q: QuestionItem): string[] {
  if (q.blocks_parsed && q.blocks_parsed.length > 0) {
    const ids = q.blocks_parsed
      .map((item: any) => (Array.isArray(item) ? item[0] : (typeof item === 'string' ? item : item?.id || '')))
      .map((s: string) => String(s || '').trim())
      .filter((s: string) => Boolean(s) && s !== '-');
    if (ids.length > 0) return ids;
  }
  if (q.blocks && q.blocks.trim() !== '-') {
    return q.blocks
      .split(',')
      .map((s: string) => s.replace(/\s*\([^)]*\)/, '').trim())
      .filter((s: string) => Boolean(s) && s !== '-');
  }
  return [];
}

export function groupOpenQuestions(
  questions: QuestionItem[],
  taskMap?: Map<string, TaskItem>
): DecisionGroupData[] {
  // Sort oldest first: earliest asked date, then earliest Q id
  const sorted = [...questions].sort((a, b) => {
    const aAsked = a.asked || (a as any).headers?.['asked'] || '';
    const bAsked = b.asked || (b as any).headers?.['asked'] || '';
    if (aAsked && bAsked && aAsked !== bAsked) {
      return aAsked.localeCompare(bAsked);
    }
    return a.id.localeCompare(b.id);
  });

  const groupMap = new Map<string, QuestionItem[]>();

  for (const q of sorted) {
    const blockedIds = getBlockedTaskIds(q);
    if (blockedIds.length === 0) {
      if (!groupMap.has('No task')) {
        groupMap.set('No task', []);
      }
      groupMap.get('No task')!.push(q);
    } else {
      for (const tid of blockedIds) {
        if (!groupMap.has(tid)) {
          groupMap.set(tid, []);
        }
        groupMap.get(tid)!.push(q);
      }
    }
  }

  // Sort group keys: specific tasks first (T001, T002), 'No task' last
  const sortedKeys = Array.from(groupMap.keys()).sort((a, b) => {
    if (a === 'No task') return 1;
    if (b === 'No task') return -1;
    return a.localeCompare(b);
  });

  const groups: DecisionGroupData[] = [];
  for (const key of sortedKeys) {
    const qs = groupMap.get(key) || [];
    const isNoTask = key === 'No task';
    const label = isNoTask ? 'No task' : `Task ${key}`;
    const task = taskMap?.get(key);
    groups.push({
      groupKey: key,
      label,
      taskTitle: task?.title,
      questions: qs,
    });
  }

  return groups;
}

export async function getDecisionsTreeData(
  cliClient: CliClient,
  workspaceRoot: string
): Promise<DecisionGroupData[]> {
  const qRes = await cliClient.listQuestions(workspaceRoot, 'open');
  const questions = qRes && qRes.questions ? qRes.questions : [];

  let taskMap: Map<string, TaskItem> | undefined;
  try {
    const tRes = await cliClient.listTasks(workspaceRoot);
    const allTasks = tRes?.all_tasks || tRes?.emergent_tasks || [];
    taskMap = new Map<string, TaskItem>(allTasks.map((t) => [t.id, t]));
  } catch {
    // If listTasks fails, taskMap remains undefined
  }

  return groupOpenQuestions(questions, taskMap);
}

export class DecisionGroupTreeItem extends vscode.TreeItem {
  constructor(
    public readonly groupKey: string,
    public readonly questions: QuestionItem[],
    public readonly taskTitle?: string,
    public readonly workspaceRoot?: string,
    public readonly projectPrefix?: string
  ) {
    const isNoTask = groupKey === 'No task';
    const st = taskTitle ? shortTitle({ title: taskTitle }) : '';
    const qualifiedKey = !isNoTask && projectPrefix ? `${projectPrefix}/${groupKey}` : groupKey;
    const label = isNoTask ? 'No task' : (st ? `Task ${qualifiedKey} (${st})` : `Task ${qualifiedKey}`);
    super(label, vscode.TreeItemCollapsibleState.Expanded);

    this.id = projectPrefix ? `decision-group-${projectPrefix}-${groupKey}` : `decision-group-${groupKey}`;
    this.contextValue = isNoTask ? 'decisionGroupNoTask' : 'decisionGroupTask';
    this.iconPath = isNoTask
      ? new vscode.ThemeIcon('inbox')
      : new vscode.ThemeIcon('checklist');

    if (!isNoTask && taskTitle) {
      this.description = taskTitle;
      this.tooltip = `Task ${qualifiedKey}: ${taskTitle} (${questions.length} open question${questions.length === 1 ? '' : 's'})`;
    } else {
      this.description = `(${questions.length})`;
      this.tooltip = isNoTask
        ? `Unlinked decisions (${questions.length} open)`
        : `Task ${qualifiedKey} (${questions.length} open question${questions.length === 1 ? '' : 's'})`;
    }
  }
}

export class DecisionQuestionTreeItem extends vscode.TreeItem {
  constructor(
    public readonly question: QuestionItem,
    public readonly workspaceRoot: string,
    public readonly projectPrefix?: string
  ) {
    const shortQuestion = question.question || question.title || '';
    const cleanQuestion = shortQuestion.trim().replace(/\r?\n/g, ' ');
    const st = shortTitle(question);
    const idLabel = projectPrefix ? `${projectPrefix}/${question.id}` : question.id;
    const label = st ? `${idLabel} (${st})` : idLabel;
    super(label, vscode.TreeItemCollapsibleState.None);

    this.id = projectPrefix ? `decision-question-${projectPrefix}-${question.id}` : `decision-question-${question.id}`;
    this.contextValue = 'questionItem';

    // Description: blocked task ids (or "no task")
    const blockedIds = getBlockedTaskIds(question);
    this.description = blockedIds.length > 0 ? blockedIds.join(', ') : 'no task';

    // Tooltip: full question + recommended option + asked-by + date
    const recOpt = question.options?.find((o: any) => o.label === question.recommended);
    let recStr = question.recommended || '-';
    if (recOpt) {
      recStr = `${recOpt.label}${recOpt.title ? ` — ${recOpt.title}` : ''}`;
    }
    const askedBy = question.asked_by || (question as any).headers?.['asked-by'] || '-';
    const askedDate = question.asked || (question as any).headers?.['asked'] || '-';
    this.tooltip = `${idLabel}: ${cleanQuestion}\nRecommended: ${recStr}\nAsked by: ${askedBy}\nDate: ${askedDate}`;

    // Icon: question
    this.iconPath = new vscode.ThemeIcon('question');

    // Clicking opens or reveals dashboard on Decisions tab and focuses card
    this.command = {
      command: 'aiOrchestration.openDecision',
      title: 'Open Decision in Dashboard',
      arguments: [question.id],
    };
  }
}

// Alias for backwards compatibility
export { DecisionQuestionTreeItem as DecisionTreeItem };

export class DecisionsTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private _onDidChangeTreeData: vscode.EventEmitter<vscode.TreeItem | undefined | null | void> =
    new vscode.EventEmitter<vscode.TreeItem | undefined | null | void>();
  readonly onDidChangeTreeData: vscode.Event<vscode.TreeItem | undefined | null | void> =
    this._onDidChangeTreeData.event;

  public openQuestionsCount = 0;
  public treeView?: vscode.TreeView<vscode.TreeItem>;
  private cachedGroups: DecisionGroupData[] | null = null;
  private cachedGroupsByProject = new Map<string, DecisionGroupData[]>();

  constructor(
    private cliClient: CliClient,
    private getRootPath?: () => string,
    private onRefresh?: () => void,
    private getSelectedProject?: () => string | null
  ) {}

  public bindTreeView(treeView: vscode.TreeView<vscode.TreeItem>) {
    this.treeView = treeView;
    if (this.openQuestionsCount > 0) {
      this.treeView.badge = {
        value: this.openQuestionsCount,
        tooltip: `${this.openQuestionsCount} open decision${this.openQuestionsCount === 1 ? '' : 's'}`,
      };
    }
  }

  public refresh(): void {
    this.cachedGroups = null;
    this.cachedGroupsByProject.clear();
    this._onDidChangeTreeData.fire();
    this.updateBadge();
    if (this.onRefresh) {
      this.onRefresh();
    }
  }

  public async updateBadge(): Promise<void> {
    const rootPath = this.getRootPath
      ? this.getRootPath()
      : (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0
          ? vscode.workspace.workspaceFolders[0].uri.fsPath
          : null);

    if (!rootPath) {
      this.updateBadgeFromCount(0);
      return;
    }

    try {
      const aiOrchBin = this.cliClient?.resolveCliPath ? this.cliClient.resolveCliPath(rootPath) : null;
      const resolver = getProjectResolver(rootPath, aiOrchBin);
      const projects = resolver.getProjects();

      if (projects.length > 1) {
        const selectedProjId = this.getSelectedProject ? this.getSelectedProject() : null;
        const targetProjects = selectedProjId
          ? projects.filter((p) => p.id === selectedProjId)
          : projects;
        const counts = await Promise.all(
          targetProjects.map(async (p) => {
            if (!fs.existsSync(p.tasksDir)) return 0;
            try {
              const res = await this.cliClient.listQuestions(p.root, 'open');
              return res?.questions?.length || 0;
            } catch {
              return 0;
            }
          })
        );
        const total = counts.reduce((a, b) => a + b, 0);
        this.updateBadgeFromCount(total);
        return;
      }

      const singleRoot = projects.length === 1 ? projects[0].root : rootPath;
      if (!fs.existsSync(path.join(singleRoot, 'tasks'))) {
        this.updateBadgeFromCount(0);
        return;
      }
      const res = await this.cliClient.listQuestions(singleRoot, 'open');
      const count = res?.questions?.length || 0;
      this.updateBadgeFromCount(count);
    } catch {
      this.updateBadgeFromCount(0);
    }
  }

  private updateBadgeFromCount(count: number) {
    this.openQuestionsCount = count;
    if (this.treeView) {
      this.treeView.badge = count > 0
        ? {
            value: count,
            tooltip: `${count} open decision${count === 1 ? '' : 's'}`,
          }
        : undefined;
    }
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  public async getDecisionsData(rootPath?: string): Promise<DecisionGroupData[]> {
    const root = rootPath || (this.getRootPath ? this.getRootPath() : undefined);
    if (!root) return [];
    if (this.cachedGroupsByProject.has(root)) {
      return this.cachedGroupsByProject.get(root)!;
    }
    const groups = await getDecisionsTreeData(this.cliClient, root);
    this.cachedGroupsByProject.set(root, groups);
    if (!rootPath || rootPath === (this.getRootPath ? this.getRootPath() : undefined)) {
      this.cachedGroups = groups;
    }
    return groups;
  }

  private async _getChildrenForProject(
    projectRoot: string,
    projectPrefix?: string,
    updateBadge = true
  ): Promise<vscode.TreeItem[]> {
    const tasksDir = path.join(projectRoot, 'tasks');
    if (!fs.existsSync(tasksDir)) {
      const item = new vscode.TreeItem('No tasks/ directory found');
      item.description = 'Run "ai-orch config init-project"';
      return [item];
    }

    const groups = await this.getDecisionsData(projectRoot);
    if (updateBadge) {
      const totalQuestions = groups.reduce((acc, g) => acc + g.questions.length, 0);
      this.updateBadgeFromCount(totalQuestions);
    }

    if (groups.length === 0) {
      const item = new vscode.TreeItem('No decisions waiting on user');
      item.iconPath = new vscode.ThemeIcon('pass', new vscode.ThemeColor('charts.green'));
      return [item];
    }

    return groups.map(
      (g) => new DecisionGroupTreeItem(g.groupKey, g.questions, g.taskTitle, projectRoot, projectPrefix)
    );
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

    try {
      if (element instanceof DecisionGroupTreeItem) {
        const projRoot = element.workspaceRoot || rootPath;
        const projPrefix = element.projectPrefix;
        return element.questions.map((q) => new DecisionQuestionTreeItem(q, projRoot, projPrefix));
      }

      if (element instanceof DecisionQuestionTreeItem) {
        return [];
      }

      if (element instanceof DecisionProjectTreeItem) {
        return this._getChildrenForProject(element.project.root, element.project.id, false);
      }

      const aiOrchBin = this.cliClient?.resolveCliPath ? this.cliClient.resolveCliPath(rootPath) : null;
      const resolver = getProjectResolver(rootPath, aiOrchBin);
      const projects = resolver.getProjects();

      if (projects.length > 1) {
        const selectedProjId = this.getSelectedProject ? this.getSelectedProject() : null;
        if (selectedProjId) {
          const matched = projects.find((p) => p.id === selectedProjId);
          if (matched) {
            return this._getChildrenForProject(matched.root, undefined, true);
          }
        }
        await this.updateBadge();
        return projects.map((p) => new DecisionProjectTreeItem(p));
      }

      const singleRoot = projects.length === 1 ? projects[0].root : rootPath;
      return this._getChildrenForProject(singleRoot, undefined, true);
    } catch (err: any) {
      const errItem = new vscode.TreeItem(`Error: ${err.message || err}`);
      errItem.iconPath = new vscode.ThemeIcon('error');
      return [errItem];
    }
  }
}
