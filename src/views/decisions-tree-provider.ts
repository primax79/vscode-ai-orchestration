import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { CliClient, QuestionItem, TaskItem } from '../cli-client';

export interface DecisionGroupData {
  groupKey: string;
  label: string;
  taskTitle?: string;
  questions: QuestionItem[];
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
    public readonly taskTitle?: string
  ) {
    const isNoTask = groupKey === 'No task';
    const label = isNoTask ? 'No task' : `Task ${groupKey}`;
    super(label, vscode.TreeItemCollapsibleState.Expanded);

    this.id = `decision-group-${groupKey}`;
    this.contextValue = isNoTask ? 'decisionGroupNoTask' : 'decisionGroupTask';
    this.iconPath = isNoTask
      ? new vscode.ThemeIcon('inbox')
      : new vscode.ThemeIcon('checklist');

    if (!isNoTask && taskTitle) {
      this.description = taskTitle;
      this.tooltip = `Task ${groupKey}: ${taskTitle} (${questions.length} open question${questions.length === 1 ? '' : 's'})`;
    } else {
      this.description = `(${questions.length})`;
      this.tooltip = isNoTask
        ? `Unlinked decisions (${questions.length} open)`
        : `Task ${groupKey} (${questions.length} open question${questions.length === 1 ? '' : 's'})`;
    }
  }
}

export class DecisionQuestionTreeItem extends vscode.TreeItem {
  constructor(
    public readonly question: QuestionItem,
    public readonly workspaceRoot: string
  ) {
    const shortQuestion = question.question || question.title || '';
    const cleanQuestion = shortQuestion.trim().replace(/\r?\n/g, ' ');
    super(`${question.id} — ${cleanQuestion}`, vscode.TreeItemCollapsibleState.None);

    this.id = `decision-question-${question.id}`;
    this.contextValue = 'questionItem';

    // Description: blocked task ids (or "no task")
    const blockedIds = getBlockedTaskIds(question);
    this.description = blockedIds.length > 0 ? blockedIds.join(', ') : 'no task';

    // Tooltip: recommended option + asked-by + date
    const recOpt = question.options?.find((o: any) => o.label === question.recommended);
    let recStr = question.recommended || '-';
    if (recOpt) {
      recStr = `${recOpt.label}${recOpt.title ? ` — ${recOpt.title}` : ''}`;
    }
    const askedBy = question.asked_by || (question as any).headers?.['asked-by'] || '-';
    const askedDate = question.asked || (question as any).headers?.['asked'] || '-';
    this.tooltip = `Recommended: ${recStr}\nAsked by: ${askedBy}\nDate: ${askedDate}`;

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

  constructor(
    private cliClient: CliClient,
    private getRootPath?: () => string
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
    this._onDidChangeTreeData.fire();
    this.updateBadge();
  }

  public async updateBadge(): Promise<void> {
    const rootPath = this.getRootPath
      ? this.getRootPath()
      : (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0
          ? vscode.workspace.workspaceFolders[0].uri.fsPath
          : null);

    if (!rootPath || !fs.existsSync(path.join(rootPath, 'tasks'))) {
      this.updateBadgeFromCount(0);
      return;
    }

    try {
      const res = await this.cliClient.listQuestions(rootPath, 'open');
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
    if (!this.cachedGroups) {
      this.cachedGroups = await getDecisionsTreeData(this.cliClient, root);
    }
    return this.cachedGroups;
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
      if (element instanceof DecisionGroupTreeItem) {
        return element.questions.map((q) => new DecisionQuestionTreeItem(q, rootPath));
      }

      if (element instanceof DecisionQuestionTreeItem) {
        return [];
      }

      // Root level: load groups
      const groups = await this.getDecisionsData(rootPath);
      const totalQuestions = groups.reduce((acc, g) => acc + g.questions.length, 0);
      this.updateBadgeFromCount(totalQuestions);

      if (groups.length === 0) {
        const item = new vscode.TreeItem('No decisions waiting on user');
        item.iconPath = new vscode.ThemeIcon('pass', new vscode.ThemeColor('charts.green'));
        return [item];
      }

      return groups.map((g) => new DecisionGroupTreeItem(g.groupKey, g.questions, g.taskTitle));
    } catch (err: any) {
      const errItem = new vscode.TreeItem(`Error: ${err.message || err}`);
      errItem.iconPath = new vscode.ThemeIcon('error');
      return [errItem];
    }
  }
}
