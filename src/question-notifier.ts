import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { CliClient } from './cli-client';

export interface QuestionItemLike {
  id: string;
  question?: string;
  title?: string;
  status?: string;
  [key: string]: any;
}

export interface QuestionDiffResult<T extends QuestionItemLike = QuestionItemLike> {
  toNotify: T[];
  newNotifiedSet: Set<string>;
  count: number;
}

export interface DiffQuestionsParams<T extends QuestionItemLike = QuestionItemLike> {
  previousOpenIds?: Set<string> | string[] | null;
  currentQuestions: T[];
  persistedNotifiedIds?: Set<string> | string[] | null;
  isInitialRun?: boolean;
}

/**
 * Pure diffing logic for blocking question notifications and badge counts.
 * Given previous open ids, current open questions, and the persisted notified-ids set,
 * returns { toNotify, newNotifiedSet, count }.
 * On initial run after activation: seeds the notified set with all current ids (no toasts).
 */
export function diffQuestions<T extends QuestionItemLike = QuestionItemLike>(
  previousOpenIdsOrParams: Set<string> | string[] | null | undefined | DiffQuestionsParams<T>,
  currentQuestionsArg?: T[],
  persistedNotifiedIdsArg?: Set<string> | string[] | null,
  isInitialRunArg?: boolean
): QuestionDiffResult<T> {
  let previousOpenIds: Set<string> | string[] | null | undefined;
  let currentQuestions: T[];
  let persistedNotifiedIds: Set<string> | string[] | null | undefined;
  let isInitialRun: boolean;

  if (
    previousOpenIdsOrParams &&
    typeof previousOpenIdsOrParams === 'object' &&
    'currentQuestions' in previousOpenIdsOrParams &&
    Array.isArray((previousOpenIdsOrParams as any).currentQuestions)
  ) {
    const params = previousOpenIdsOrParams as DiffQuestionsParams<T>;
    previousOpenIds = params.previousOpenIds;
    currentQuestions = params.currentQuestions;
    persistedNotifiedIds = params.persistedNotifiedIds;
    isInitialRun = Boolean(params.isInitialRun);
  } else {
    previousOpenIds = previousOpenIdsOrParams as Set<string> | string[] | null | undefined;
    currentQuestions = currentQuestionsArg || [];
    persistedNotifiedIds = persistedNotifiedIdsArg;
    isInitialRun = Boolean(isInitialRunArg);
  }

  const newNotifiedSet = new Set<string>();
  if (persistedNotifiedIds) {
    for (const id of persistedNotifiedIds) {
      if (id) {
        newNotifiedSet.add(String(id));
      }
    }
  }

  const count = currentQuestions.length;

  if (isInitialRun) {
    // First run after activation: seed the notified set with all current ids (no toasts)
    for (const q of currentQuestions) {
      if (q && q.id) {
        newNotifiedSet.add(q.id);
      }
    }
    return {
      toNotify: [],
      newNotifiedSet,
      count,
    };
  }

  // Subsequent runs: questions not in notified set should be toasted
  const toNotify: T[] = [];
  for (const q of currentQuestions) {
    if (!q || !q.id) continue;
    if (!newNotifiedSet.has(q.id)) {
      toNotify.push(q);
      newNotifiedSet.add(q.id);
    }
  }

  return {
    toNotify,
    newNotifiedSet,
    count,
  };
}

export function formatQuestionNotification(q: QuestionItemLike): string {
  const shortQuestion = (q.question || q.title || '').trim().replace(/\r?\n/g, ' ');
  return `New decision ${q.id}: ${shortQuestion}`;
}

export function formatBatchNotification(count: number): string {
  return `${count} new decisions waiting`;
}

export function formatStatusBarTooltip(count: number): string {
  return `${count} open decision${count === 1 ? '' : 's'} — click to open`;
}

export class QuestionNotifier implements vscode.Disposable {
  private previousOpenIds: Set<string> = new Set<string>();
  private initializedFolders: Set<string> = new Set<string>();
  private statusBarItem: vscode.StatusBarItem;
  private debounceTimer: NodeJS.Timeout | null = null;
  private disposables: vscode.Disposable[] = [];

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly cliClient: CliClient,
    private readonly getBoundRoot: () => string
  ) {
    // Status Bar Item: $(question) N with tooltip "N open decisions — click to open"
    // Choice: when N = 0, show $(question) 0 with neutral background for clear visibility.
    this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 9);
    this.statusBarItem.command = 'aiOrchestration.openDecisions';
    this.statusBarItem.text = '$(question) 0';
    this.statusBarItem.tooltip = formatStatusBarTooltip(0);
    this.statusBarItem.show();
    this.disposables.push(this.statusBarItem);
  }

  public getStatusBarItem(): vscode.StatusBarItem {
    return this.statusBarItem;
  }

  public scheduleCheck(delayMs: number = 500, onComplete?: () => void): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(async () => {
      this.debounceTimer = null;
      await this.checkQuestions(false);
      if (onComplete) {
        onComplete();
      }
    }, delayMs);
  }

  public async checkQuestions(forceInitial: boolean = false): Promise<QuestionDiffResult> {
    const root = this.getBoundRoot();
    if (!root || !fs.existsSync(root)) {
      this.updateStatusBar(0);
      return { toNotify: [], newNotifiedSet: new Set(), count: 0 };
    }
    const tasksDir = path.join(root, 'tasks');
    if (!fs.existsSync(tasksDir)) {
      this.updateStatusBar(0);
      return { toNotify: [], newNotifiedSet: new Set(), count: 0 };
    }

    const stateKey = `aiOrchestration.notifiedQuestions:${root}`;
    const persistedIds = this.context.workspaceState.get<string[]>(stateKey, []);
    const isInitialRun = forceInitial || !this.initializedFolders.has(root);

    try {
      const res = await this.cliClient.listQuestions(root, 'open');
      const questions = res?.questions || [];

      const result = diffQuestions(
        this.previousOpenIds,
        questions,
        persistedIds,
        isInitialRun
      );

      this.initializedFolders.add(root);
      this.previousOpenIds = new Set(questions.map((q: any) => q.id));

      // Persist notified IDs in workspaceState (key per bound workspace folder)
      await this.context.workspaceState.update(stateKey, Array.from(result.newNotifiedSet));

      // Update status bar badge & warning background
      this.updateStatusBar(result.count);

      // Trigger VS Code notification toasts if enabled
      if (result.toNotify.length > 0) {
        const notifyEnabled = vscode.workspace
          .getConfiguration('aiOrchestration')
          .get<boolean>('notifyNewQuestions', true);

        if (notifyEnabled) {
          if (result.toNotify.length === 1) {
            const q = result.toNotify[0];
            const message = formatQuestionNotification(q);
            vscode.window
              .showInformationMessage(message, 'Open', 'Later')
              .then((action) => {
                if (action === 'Open') {
                  vscode.commands.executeCommand('aiOrchestration.openDashboard', {
                    tab: 'decisions',
                    questionId: q.id,
                  });
                }
              });
          } else {
            const message = formatBatchNotification(result.toNotify.length);
            vscode.window
              .showInformationMessage(message, 'Open')
              .then((action) => {
                if (action === 'Open') {
                  vscode.commands.executeCommand('aiOrchestration.openDashboard', {
                    tab: 'decisions',
                  });
                }
              });
          }
        }
      }

      return result;
    } catch {
      this.updateStatusBar(0);
      return { toNotify: [], newNotifiedSet: new Set(), count: 0 };
    }
  }

  public updateStatusBar(count: number): void {
    this.statusBarItem.text = `$(question) ${count}`;
    this.statusBarItem.tooltip = formatStatusBarTooltip(count);
    if (count > 0) {
      this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    } else {
      this.statusBarItem.backgroundColor = undefined;
    }
    this.statusBarItem.show();
  }

  public dispose(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables = [];
  }
}
