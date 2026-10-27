import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { CliClient, isReadOnlyCommand } from './cli-client';
import {
  TaskTreeProvider,
  TaskTreeItem,
  InitiativeTreeItem,
  DecisionTreeItem,
  ProjectGroupTreeItem,
} from './views/task-tree-provider';
import {
  DecisionsTreeProvider,
  DecisionGroupTreeItem,
  DecisionQuestionTreeItem,
  DecisionProjectTreeItem,
  getDecisionsTreeData,
  getBlockedTaskIds,
  groupOpenQuestions,
} from './views/decisions-tree-provider';
import {
  DashboardPanel,
  HANDLER_MAP,
  CLI_COMMAND_MAP,
  CUSTOM_HANDLERS,
  AGGREGATE_OR_GLOBAL_TYPES,
  resolveMessageTargetRoot,
  dispatchMessage,
  NOTE_ID_RE,
  requireNoteId,
  requireAttachmentName,
  sniffImageContentType,
  RUN_ID_RE,
  requireRunId,
  runId,
  TASK_ATTACHMENT_ID_RE,
  requireTaskAttachmentId,
  runTargetArgs,
  classifyAttachmentContentType,
  TREE_NODE_ID_RE,
  requireTreeNodeId,
  QUESTION_ID_RE,
  requireQuestionId,
  MICRO_ID_RE,
  requireMicrotaskId,
  VALID_KINDS,
  VALID_PRIORITIES,
  VALID_SIZES,
  LABEL_RE,
  extractLabels,
  checkOriginRunContinuable,
  formatContinuationInstructions,
  getActiveTriggerConfigPath,
  generateUnifiedDiff,
  computeTriggerToggle,
  PROPOSAL_ACTION_ID_RE,
  TURN_ID_RE,
  validateTurnId,
  getRotateAfterTokens,
  readPartialAssistantMessages,
  getTurnSortKey,
  compareTurns,
  setShortArgs,
  SET_SHORT_ID_RE,
  requireSetShortId,
  VALIDATE_CLOSE_ID_RE,
  extractValidateCloseTaskIds,
  computeValidateClosePlanHash,
  inspectValidateCloseTasks,
  TASK_WRITE_TYPES,
} from './views/dashboard-panel';
import { shortTitle, deriveShortTitle } from './short-title';
import { WorkspaceManager, detectSharedWorkspaceRoot } from './workspace-manager';
import {
  ProjectResolver,
  ProjectInfo,
  getProjectResolver,
  invalidateProjectResolver,
  sanitizeSlug,
  isGitIgnored,
  computeTreeHash,
  canonicalizeTaskState,
  countTasksByCanonicalState,
  fastCountQuestions,
  fastCountInbox,
  UnknownProjectError,
  ProjectRequiredError,
  OutsideWorkspaceError,
} from './project-resolver';
import {
  QuestionNotifier,
  diffQuestions,
  formatQuestionNotification,
  formatBatchNotification,
  formatStatusBarTooltip,
} from './question-notifier';
import {
  EventWatcher,
  mapEventToAreas,
  mapEventsToAreas,
  shouldNotifyEvent,
  formatEventNotification,
  filterNewEvents,
  getOrchestratorStatus,
} from './event-watcher';

export {
  HANDLER_MAP,
  CLI_COMMAND_MAP,
  CUSTOM_HANDLERS,
  AGGREGATE_OR_GLOBAL_TYPES,
  resolveMessageTargetRoot,
  dispatchMessage,
  NOTE_ID_RE,
  requireNoteId,
  requireAttachmentName,
  sniffImageContentType,
  RUN_ID_RE,
  requireRunId,
  runId,
  TASK_ATTACHMENT_ID_RE,
  requireTaskAttachmentId,
  runTargetArgs,
  classifyAttachmentContentType,
  TREE_NODE_ID_RE,
  requireTreeNodeId,
  QUESTION_ID_RE,
  requireQuestionId,
  MICRO_ID_RE,
  requireMicrotaskId,
  VALID_KINDS,
  VALID_PRIORITIES,
  VALID_SIZES,
  LABEL_RE,
  extractLabels,
  checkOriginRunContinuable,
  formatContinuationInstructions,
  getActiveTriggerConfigPath,
  generateUnifiedDiff,
  computeTriggerToggle,
  PROPOSAL_ACTION_ID_RE,
  TURN_ID_RE,
  validateTurnId,
  getRotateAfterTokens,
  readPartialAssistantMessages,
  getTurnSortKey,
  compareTurns,
  DashboardPanel,
  CliClient,
  isReadOnlyCommand,
  TaskTreeProvider,
  TaskTreeItem,
  InitiativeTreeItem,
  DecisionTreeItem,
  ProjectGroupTreeItem,
  DecisionsTreeProvider,
  DecisionGroupTreeItem,
  DecisionQuestionTreeItem,
  DecisionProjectTreeItem,
  getDecisionsTreeData,
  getBlockedTaskIds,
  groupOpenQuestions,
  QuestionNotifier,
  diffQuestions,
  formatQuestionNotification,
  formatBatchNotification,
  formatStatusBarTooltip,
  EventWatcher,
  mapEventToAreas,
  mapEventsToAreas,
  shouldNotifyEvent,
  formatEventNotification,
  filterNewEvents,
  getOrchestratorStatus,
  shortTitle,
  deriveShortTitle,
  setShortArgs,
  SET_SHORT_ID_RE,
  requireSetShortId,
  VALIDATE_CLOSE_ID_RE,
  extractValidateCloseTaskIds,
  computeValidateClosePlanHash,
  inspectValidateCloseTasks,
  TASK_WRITE_TYPES,
  WorkspaceManager,
  detectSharedWorkspaceRoot,
  ProjectResolver,
  ProjectInfo,
  getProjectResolver,
  invalidateProjectResolver,
  sanitizeSlug,
  isGitIgnored,
  computeTreeHash,
  canonicalizeTaskState,
  countTasksByCanonicalState,
  fastCountQuestions,
  fastCountInbox,
  UnknownProjectError,
  ProjectRequiredError,
  OutsideWorkspaceError,
};

export function activate(context: vscode.ExtensionContext) {
  const outputChannel = vscode.window.createOutputChannel('AI Orchestration');
  const cliClient = new CliClient(outputChannel);
  const workspaceManager = new WorkspaceManager(context, (root) => cliClient.resolveCliPath(root));

  // Status Bar Item
  const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 10);
  statusBarItem.command = 'aiOrchestration.openDashboard';
  statusBarItem.text = '$(layers) AI Tasks';
  statusBarItem.tooltip = 'Click to open AI Orchestration Task Backlog & Dashboard';
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  // Tree View Providers (bound to current workspace folder)
  const getBoundRoot = () => workspaceManager.getBoundWorkspaceFolder();
  const getSelectedProject = () => workspaceManager.getSelectedProject();
  const questionNotifier = new QuestionNotifier(context, cliClient, getBoundRoot);
  context.subscriptions.push(questionNotifier);

  const eventWatcher = new EventWatcher(context, cliClient, getBoundRoot, (events, areas, project) => {
    if (DashboardPanel.currentPanel) {
      DashboardPanel.currentPanel.notifyAreasChanged(areas, project);
    }
    if (areas.includes('tasks')) {
      nextUpProvider.refresh();
      initiativesProvider.refresh();
      useCasesProvider.refresh();
      updateStatusBarCount();
    }
    if (areas.includes('questions')) {
      decisionsProvider.refresh();
      questionNotifier.checkQuestions(false);
    }
  });
  context.subscriptions.push(eventWatcher);

  const nextUpProvider = new TaskTreeProvider(cliClient, 'nextUp', getBoundRoot, getSelectedProject);
  const initiativesProvider = new TaskTreeProvider(cliClient, 'initiatives', getBoundRoot, getSelectedProject);
  const useCasesProvider = new TaskTreeProvider(cliClient, 'useCases', getBoundRoot, getSelectedProject);
  const decisionsProvider = new DecisionsTreeProvider(
    cliClient,
    getBoundRoot,
    () => {
      questionNotifier.checkQuestions(false);
    },
    getSelectedProject
  );

  const decisionsTreeView = vscode.window.createTreeView('aiOrchestration.decisionsView', {
    treeDataProvider: decisionsProvider,
  });
  decisionsProvider.bindTreeView(decisionsTreeView);

  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('aiOrchestration.nextUpView', nextUpProvider),
    vscode.window.registerTreeDataProvider('aiOrchestration.initiativesView', initiativesProvider),
    vscode.window.registerTreeDataProvider('aiOrchestration.useCasesView', useCasesProvider),
    decisionsTreeView
  );

  // Every trigger (watchers, commands, dashboard writes) goes through one debounced refresh,
  // so a burst of file events costs one round of CLI calls.
  let refreshTimer: NodeJS.Timeout | null = null;
  const refreshAll = (project?: string) => {
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      refreshAllNow(project);
    }, 300);
  };
  context.subscriptions.push(new vscode.Disposable(() => refreshTimer && clearTimeout(refreshTimer)));

  const refreshAllNow = (project?: string) => {
    nextUpProvider.refresh();
    initiativesProvider.refresh();
    useCasesProvider.refresh();
    decisionsProvider.refresh();
    if (DashboardPanel.currentPanel) {
      DashboardPanel.currentPanel.notifyTasksChanged(project);
      DashboardPanel.currentPanel.notifyQuestionsChanged(project);
    }
    updateStatusBarCount();
    questionNotifier.checkQuestions(false);
  };

  const updateStatusBarCount = async () => {
    const root = workspaceManager.getBoundWorkspaceFolder();
    if (!root || !fs.existsSync(root)) return;
    try {
      const aiOrchBin = cliClient.resolveCliPath(root);
      const resolver = getProjectResolver(root, aiOrchBin);
      const projects = resolver.getProjects();
      if (projects.length > 1) {
        const counts = await Promise.all(
          projects.map(async (p) => {
            if (!fs.existsSync(p.tasksDir)) return 0;
            try {
              const res = await cliClient.listTasks(p.root);
              return (res.emergent_tasks || []).filter((t) => t.state !== 'done').length;
            } catch {
              return 0;
            }
          })
        );
        const totalActive = counts.reduce((a, b) => a + b, 0);
        statusBarItem.text = `$(layers) AI Tasks: ${totalActive}`;
        return;
      }

      const res = await cliClient.listTasks(root);
      const active = (res.emergent_tasks || []).filter((t) => t.state !== 'done').length;
      statusBarItem.text = `$(layers) AI Tasks: ${active}`;
    } catch {}
  };

  // Commands
  context.subscriptions.push(
    vscode.commands.registerCommand('aiOrchestration.openDashboard', async (options?: { tab?: string; questionId?: string } | string) => {
      const folders = vscode.workspace.workspaceFolders;
      if (!folders || folders.length === 0) {
        vscode.window.showWarningMessage('No workspace open to show AI Orchestration dashboard');
        return;
      }

      let boundRoot: string;
      if (folders.length > 1) {
        const folderPaths = folders.map((f) => f.uri.fsPath);
        const bin = cliClient.resolveCliPath(folderPaths[0]);
        const sharedRoot = detectSharedWorkspaceRoot(folderPaths, bin);
        if (sharedRoot) {
          boundRoot = sharedRoot;
          await workspaceManager.setBoundWorkspaceFolder(boundRoot);
        } else {
          const picked = await workspaceManager.pickWorkspaceFolder();
          if (!picked) {
            return;
          }
          boundRoot = picked;
        }
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

      if (options && DashboardPanel.currentPanel) {
        const questionId = typeof options === 'string' ? options : options.questionId;
        const tab = typeof options === 'object' && options.tab ? options.tab : 'decisions';
        DashboardPanel.currentPanel.postMessage({
          type: 'navigate',
          tab,
          questionId,
        });
      }
    }),

    vscode.commands.registerCommand('aiOrchestration.selectProject', async (projectArg?: string | null) => {
      const root = workspaceManager.getBoundWorkspaceFolder();
      if (!root || !fs.existsSync(root)) return;

      if (projectArg !== undefined) {
        const nextVal = projectArg === 'all' || projectArg === '' ? null : projectArg;
        await workspaceManager.setSelectedProject(nextVal);
        refreshAll();
        return;
      }

      const aiOrchBin = cliClient.resolveCliPath(root);
      const resolver = getProjectResolver(root, aiOrchBin);
      const projects = resolver.getProjects();
      const current = workspaceManager.getSelectedProject();
      const runCli = (args: string[], cwd?: string) => cliClient.runJsonCommand<any>(args, cwd || root);
      const projectCounts = await Promise.all(projects.map((p) => resolver.getProjectCounts(p, runCli)));
      const getProjStats = (c?: Record<string, number>) => {
        const counts = c || {};
        const waiting = (counts.waiting || 0) + (counts.blocked || 0);
        const open = (counts.open || 0) + (counts.todo || 0) + (counts.bounced || 0);
        const progress = (counts['in progress'] || 0) + (counts.in_progress || 0) + (counts.delivered || 0) + (counts.verified || 0);
        const nonClosed = waiting + open + progress;
        return { waiting, open, progress, nonClosed };
      };
      const projWithStats = projects.map((p, idx) => ({ p, stats: getProjStats(projectCounts[idx]) }));
      const totals = projWithStats.reduce(
        (acc, x) => {
          acc.waiting += x.stats.waiting;
          acc.open += x.stats.open;
          acc.progress += x.stats.progress;
          acc.nonClosed += x.stats.nonClosed;
          return acc;
        },
        { waiting: 0, open: 0, progress: 0, nonClosed: 0 }
      );
      projWithStats.sort((a, b) => {
        if (a.p.kind === '_workspace' && b.p.kind !== '_workspace') return -1;
        if (b.p.kind === '_workspace' && a.p.kind !== '_workspace') return 1;
        if (a.stats.nonClosed > 0 && b.stats.nonClosed === 0) return -1;
        if (b.stats.nonClosed > 0 && a.stats.nonClosed === 0) return 1;
        if (a.stats.nonClosed !== b.stats.nonClosed) return b.stats.nonClosed - a.stats.nonClosed;
        return a.p.id.localeCompare(b.p.id);
      });

      const isEmptyProj = (x: { p: (typeof projects)[number]; stats: ReturnType<typeof getProjStats> }) =>
        x.p.kind !== '_workspace' && x.stats.nonClosed === 0;
      const emptyCount = projWithStats.filter(isEmptyProj).length;
      let showEmpty = false;

      while (true) {
        const nonEmpty = projWithStats.filter((x) => !isEmptyProj(x) || x.p.id === current);
        const visibleList = showEmpty || nonEmpty.length === 0 ? projWithStats : nonEmpty;
        const allCountLabel =
          !showEmpty && emptyCount > 0 && visibleList.length < projects.length
            ? `${visibleList.length}/${projects.length}`
            : `${projects.length}`;

        const items: Array<{ label: string; description?: string; detail?: string; projectId: string | null }> = [
          {
            label: `All projects (${allCountLabel}) — ${totals.nonClosed} (waiting: ${totals.waiting}, open: ${totals.open}, progress: ${totals.progress})`,
            description: 'Common workspace view',
            detail: !current ? '(Currently selected)' : undefined,
            projectId: null,
          },
          ...visibleList.map(({ p, stats }) => ({
            label: `${p.id} — ${stats.nonClosed} (waiting: ${stats.waiting}, open: ${stats.open}, progress: ${stats.progress})`,
            description: p.path,
            detail: current === p.id ? '(Currently selected)' : undefined,
            projectId: p.id,
          })),
        ];

        if (emptyCount > 0) {
          items.push({
            label: showEmpty
              ? `$(eye-closed) Hide empty projects (${emptyCount})`
              : `$(eye) Show empty projects (+${emptyCount})`,
            description: showEmpty
              ? 'Hide projects with 0 active tasks'
              : 'Include projects with 0 active tasks',
            projectId: '__toggle_empty__',
          });
        }

        const picked = await vscode.window.showQuickPick(items, {
          placeHolder: 'Filter tree views by project',
          title: 'AI Orchestration: Select Project',
        });

        if (!picked) return;
        if (picked.projectId === '__toggle_empty__') {
          showEmpty = !showEmpty;
          continue;
        }
        await workspaceManager.setSelectedProject(picked.projectId);
        refreshAll();
        return;
      }
    }),

    vscode.commands.registerCommand('aiOrchestration.openDecision', async (questionId?: string) => {
      await vscode.commands.executeCommand('aiOrchestration.openDashboard', {
        tab: 'decisions',
        questionId,
      });
    }),

    vscode.commands.registerCommand('aiOrchestration.openDecisions', async () => {
      await vscode.commands.executeCommand('aiOrchestration.openDashboard', {
        tab: 'decisions',
      });
    }),

    vscode.commands.registerCommand('aiOrchestration.refresh', () => {
      const root = workspaceManager.getBoundWorkspaceFolder();
      if (root) {
        invalidateProjectResolver(root);
      }
      refreshAll();
    }),

    vscode.commands.registerCommand('aiOrchestration.syncIndex', async () => {
      const root = workspaceManager.getBoundWorkspaceFolder();
      if (!root || !fs.existsSync(root)) {
        vscode.window.showWarningMessage('No workspace open to sync 00-INDEX.md');
        return;
      }
      try {
        const selectedProj = workspaceManager.getSelectedProject();
        const aiOrchBin = cliClient.resolveCliPath(root);
        const resolver = getProjectResolver(root, aiOrchBin);
        const projects = resolver.getProjects();
        let targetRoot = root;
        if (projects.length === 1) {
          targetRoot = projects[0].root;
        } else if (selectedProj) {
          const found = projects.find((p) => p.id === selectedProj);
          if (found) targetRoot = found.root;
        }
        await cliClient.syncIndex(targetRoot);
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
        const st = shortTitle(item.task);
        const label = st ? `${item.task.id} (${st})` : item.task.id;
        vscode.window.showInformationMessage(`Copied handoff prompt for ${label}`);
      }
    }),

    vscode.commands.registerCommand('aiOrchestration.openTaskFile', (item?: TaskTreeItem) => {
      if (item && item.task.file_path && fs.existsSync(item.task.file_path)) {
        vscode.window.showTextDocument(vscode.Uri.file(item.task.file_path));
      }
    })
  );

  // File System Watchers on tasks/ and tasks/questions/** for bound folder and its projects
  let activeWatchers: vscode.Disposable[] = [];
  const setupWatcherForBoundFolder = () => {
    while (activeWatchers.length) {
      const d = activeWatchers.pop();
      if (d) d.dispose();
    }
    const bound = workspaceManager.getBoundWorkspaceFolder();
    if (bound && fs.existsSync(bound)) {
      eventWatcher.bindFolder(bound);

      const aiOrchBin = cliClient.resolveCliPath(bound);
      const resolver = getProjectResolver(bound, aiOrchBin);
      let projects = resolver.getProjects();
      if (!projects || projects.length === 0) {
        projects = [
          {
            id: '_workspace',
            path: '.',
            kind: 'project',
            root: bound,
            tasksDir: path.join(bound, 'tasks'),
          },
        ];
      }

      const indexWatcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(bound, '**/tasks/00-INDEX.md')
      );
      const onIndexChange = () => {
        invalidateProjectResolver(bound);
        refreshAll();
      };
      indexWatcher.onDidChange(onIndexChange);
      indexWatcher.onDidCreate(onIndexChange);
      indexWatcher.onDidDelete(onIndexChange);
      activeWatchers.push(indexWatcher);

      // File watchers stay on even with the event stream: hand edits and git pulls emit no events.
      for (const proj of projects) {
        const pRoot = proj.root;
        const pId = proj.id;

        const tasksWatcher = vscode.workspace.createFileSystemWatcher(
          new vscode.RelativePattern(pRoot, 'tasks/**/*.{md,toml}')
        );
        tasksWatcher.onDidChange(() => refreshAll(pId));
        tasksWatcher.onDidCreate(() => refreshAll(pId));
        tasksWatcher.onDidDelete(() => refreshAll(pId));

        const questionsWatcher = vscode.workspace.createFileSystemWatcher(
          new vscode.RelativePattern(pRoot, 'tasks/questions/**')
        );
        let questionsDebounceTimer: NodeJS.Timeout | null = null;
        const onQuestionsChangedDebounced = () => {
          if (questionsDebounceTimer) {
            clearTimeout(questionsDebounceTimer);
          }
          questionsDebounceTimer = setTimeout(() => {
            questionsDebounceTimer = null;
            refreshAll(pId);
          }, 500);
        };
        questionsWatcher.onDidChange(onQuestionsChangedDebounced);
        questionsWatcher.onDidCreate(onQuestionsChangedDebounced);
        questionsWatcher.onDidDelete(onQuestionsChangedDebounced);

        activeWatchers.push(
          tasksWatcher,
          questionsWatcher,
          new vscode.Disposable(() => {
            if (questionsDebounceTimer) {
              clearTimeout(questionsDebounceTimer);
              questionsDebounceTimer = null;
            }
          })
        );
      }
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
  decisionsProvider.updateBadge();
  questionNotifier.checkQuestions(true);
  const initialBound = workspaceManager.getBoundWorkspaceFolder();
  if (initialBound) {
    eventWatcher.bindFolder(initialBound);
  }
  outputChannel.appendLine('AI Orchestration extension activated.');
}

export function deactivate() {
  if (DashboardPanel.currentPanel) {
    DashboardPanel.currentPanel.dispose();
  }
}
