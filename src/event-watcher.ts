import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { CliClient } from './cli-client';
import { shortTitle } from './short-title';
import { formatQuestionNotification } from './question-notifier';
import { getProjectResolver, invalidateProjectResolver, ProjectInfo } from './project-resolver';

export interface OrchestrationEventLike {
  seq: number;
  id: string;
  ts?: string;
  type: string;
  subject?: string;
  data?: any;
  payload?: any;
  origin_session?: string;
  actor?: string;
}

export interface EventNotificationResult {
  message: string;
  actionTitle?: string;
  actionCommand?: string;
  actionArgs?: any[];
}

export interface EventFilterResult {
  newEvents: OrchestrationEventLike[];
  maxSeq: number;
}

export interface OrchestratorStatus {
  started: boolean;
  tool?: string;
  status?: string;
  paused?: boolean;
  queueLength?: number;
}

/**
 * Pure mapping from a single event to affected dashboard areas.
 * Areas: tasks, questions, inbox, runs, orchestrator, config.
 */
export function mapEventToAreas(event: OrchestrationEventLike): string[] {
  const t = event?.type || '';
  if (t.startsWith('task.')) {
    return ['tasks'];
  }
  if (t.startsWith('question.')) {
    // Questions block tasks and affect decisions
    return ['questions', 'tasks'];
  }
  if (t.startsWith('note.')) {
    return ['inbox'];
  }
  if (t.startsWith('run.')) {
    return ['runs'];
  }
  if (
    t.startsWith('orchestrator.') ||
    t.startsWith('turn.') ||
    t.startsWith('trigger.') ||
    t.startsWith('action.') ||
    t.startsWith('session.')
  ) {
    return ['orchestrator'];
  }
  if (t.startsWith('config.')) {
    return ['config', 'orchestrator'];
  }
  return ['tasks'];
}

/**
 * Pure mapping from a batch of events to a deduplicated, sorted list of affected dashboard areas.
 */
export function mapEventsToAreas(events: OrchestrationEventLike[]): string[] {
  const areasSet = new Set<string>();
  for (const ev of events) {
    const areas = mapEventToAreas(ev);
    for (const a of areas) {
      areasSet.add(a);
    }
  }
  return Array.from(areasSet).sort();
}

/**
 * Determines whether an event should trigger a VS Code notification toast.
 * Important types per Spec §6:
 * - turn finished with a reply
 * - turn failed
 * - proposed action awaiting confirmation
 * - run finished/failed
 */
export function shouldNotifyEvent(event: OrchestrationEventLike): boolean {
  const t = event?.type || '';
  if (t === 'turn.finished') return true;
  if (t === 'turn.failed') return true;
  if (t === 'action.proposed') return true;
  if (
    t === 'trigger.fired' &&
    (event.payload?.state === 'proposed' ||
      event.data?.state === 'proposed' ||
      event.payload?.result?.status === 'proposed' ||
      event.data?.result?.status === 'proposed')
  ) {
    return true;
  }
  if (t === 'run.finished' || t === 'run.failed') return true;
  return false;
}

/**
 * Formats a notification toast for an important event.
 */
export function formatEventNotification(event: OrchestrationEventLike): EventNotificationResult | null {
  const t = event?.type || '';
  const payload = event.payload || event.data || {};
  const subject = event.subject || '';

  if (t === 'turn.finished') {
    const turnNum = payload.turns;
    return {
      message: `Orchestrator turn finished with a reply${turnNum ? ` (#${turnNum})` : ''}`,
      actionTitle: 'Open Dashboard',
      actionCommand: 'aiOrchestration.openDashboard',
    };
  }

  if (t === 'turn.failed') {
    const reason = payload.reason || payload.error || 'Turn failed';
    return {
      message: `Orchestrator turn failed: ${reason}`,
      actionTitle: 'Open Dashboard',
      actionCommand: 'aiOrchestration.openDashboard',
    };
  }

  if (
    t === 'action.proposed' ||
    (t === 'trigger.fired' &&
      (payload.state === 'proposed' || payload.result?.status === 'proposed'))
  ) {
    const actionType = payload.action || payload.type || payload.result?.type || 'action';
    return {
      message: `Proposed action awaiting confirmation: ${actionType}`,
      actionTitle: 'Open Dashboard',
      actionCommand: 'aiOrchestration.openDashboard',
    };
  }

  if (t === 'run.finished') {
    const runId = subject || payload.run_id || '';
    const status = payload.status || 'finished';
    const verdict = payload.verdict;
    const taskTitle = payload.short_title || payload.task_short_title || (payload.task ? shortTitle({ title: payload.task }) : '');
    const runLabel = taskTitle ? `Run ${runId} (${taskTitle})` : `Run ${runId}`;
    if (status === 'failed') {
      return {
        message: `${runLabel} failed`,
        actionTitle: 'Open Dashboard',
        actionCommand: 'aiOrchestration.openDashboard',
      };
    }
    const verdictText = verdict ? ` (verdict: ${verdict})` : '';
    return {
      message: `${runLabel} finished: ${status}${verdictText}`,
      actionTitle: 'Open Dashboard',
      actionCommand: 'aiOrchestration.openDashboard',
    };
  }

  if (t === 'run.failed') {
    const runId = subject || payload.run_id || '';
    const err = payload.error || payload.reason || '';
    const taskTitle = payload.short_title || payload.task_short_title || (payload.task ? shortTitle({ title: payload.task }) : '');
    const runLabel = taskTitle ? `Run ${runId} (${taskTitle})` : `Run ${runId}`;
    return {
      message: `${runLabel} failed${err ? `: ${err}` : ''}`,
      actionTitle: 'Open Dashboard',
      actionCommand: 'aiOrchestration.openDashboard',
    };
  }

  return null;
}

/**
 * Pure function to filter new events and update the max sequence number.
 */
export function filterNewEvents(
  events: OrchestrationEventLike[],
  lastSeq: number,
  notifiedSeqs?: Set<number>
): EventFilterResult {
  let maxSeq = lastSeq;
  const newEvents: OrchestrationEventLike[] = [];

  for (const ev of events) {
    if (!ev || typeof ev.seq !== 'number') continue;
    if (ev.seq > lastSeq) {
      if (!notifiedSeqs || !notifiedSeqs.has(ev.seq)) {
        newEvents.push(ev);
      }
      if (ev.seq > maxSeq) {
        maxSeq = ev.seq;
      }
    }
  }

  return { newEvents, maxSeq };
}

/**
 * Reads orchestrator.json and queue state to report orchestrator status.
 */
export function getOrchestratorStatus(root: string): OrchestratorStatus {
  const orchFile = path.join(root, '.ai-orchestration', 'orchestrator.json');
  if (!fs.existsSync(orchFile)) {
    return { started: false };
  }
  try {
    const raw = fs.readFileSync(orchFile, 'utf-8');
    const doc = JSON.parse(raw);
    const status = doc.status || doc.current?.status || 'inactive';
    const tool = doc.current?.tool || doc.routing?.default_orchestrator;
    const paused = status === 'paused';
    let queueLength = 0;
    const queueDir = path.join(root, '.ai-orchestration', 'orchestrator', 'queue');
    if (fs.existsSync(queueDir)) {
      queueLength = fs.readdirSync(queueDir).filter((f) => f.endsWith('.json')).length;
    }
    return {
      started: status !== 'stopped' && status !== 'inactive',
      tool,
      status,
      paused,
      queueLength,
    };
  } catch {
    return { started: false };
  }
}

/**
 * EventWatcher monitors the events chunk manifest (.ai-orchestration/events/chunks.json),
 * fetches new events via `ai-orch events tail --since <lastSeq>`, debounces bursts,
 * keeps last seq in workspaceState per bound folder, forwards events to dashboard webview,
 * and triggers user notifications without refresh loops.
 */
export class EventWatcher implements vscode.Disposable {
  private disposables: vscode.Disposable[] = [];
  private currentBoundRoot: string = '';
  private debounceTimer: NodeJS.Timeout | null = null;
  private inFlight: Promise<void> | null = null;
  private rerunRequested = false;
  private statusBarItem: vscode.StatusBarItem;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly cliClient: CliClient,
    private readonly getBoundRoot: () => string,
    private readonly onEventsReceived: (events: OrchestrationEventLike[], areas: string[], project?: string) => void
  ) {
    this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 8);
    this.statusBarItem.command = 'aiOrchestration.openDashboard';
    this.disposables.push(this.statusBarItem);
  }

  public getStatusBarItem(): vscode.StatusBarItem {
    return this.statusBarItem;
  }

  private _getProjectsForRoot(root: string): ProjectInfo[] {
    try {
      const aiOrchBin = this.cliClient?.resolveCliPath ? this.cliClient.resolveCliPath(root) : null;
      const resolver = getProjectResolver(root, aiOrchBin);
      const projs = resolver.getProjects();
      if (projs && projs.length > 0) return projs;
    } catch {}
    return [
      {
        id: '_workspace',
        path: '.',
        kind: 'project',
        root,
        tasksDir: path.join(root, 'tasks'),
      },
    ];
  }

  /**
   * Binds to a workspace folder and configures the FileSystemWatcher on chunks.json and every project's tasks/ tree.
   */
  public bindFolder(root: string): void {
    if (this.currentBoundRoot === root) {
      this.updateOrchestratorStatusBar();
      return;
    }

    this.currentBoundRoot = root;
    this.cleanupFolderWatchers();

    if (!root || !fs.existsSync(root)) {
      this.updateOrchestratorStatusBar();
      return;
    }

    const projects = this._getProjectsForRoot(root);
    const watchedEventRoots = new Set<string>([root]);
    for (const p of projects) {
      watchedEventRoots.add(p.root);
    }

    for (const evRoot of watchedEventRoots) {
      // Watch .ai-orchestration/events/chunks.json and .ai-orchestration/events directory
      const manifestPattern = new vscode.RelativePattern(evRoot, '.ai-orchestration/events/chunks.json');
      const manifestWatcher = vscode.workspace.createFileSystemWatcher(manifestPattern);

      const onManifestChange = () => this.schedulePoll();
      manifestWatcher.onDidChange(onManifestChange);
      manifestWatcher.onDidCreate(onManifestChange);

      // Also watch for creation/deletion of events directory or orchestrator.json
      const orchPattern = new vscode.RelativePattern(evRoot, '.ai-orchestration/orchestrator.json');
      const orchWatcher = vscode.workspace.createFileSystemWatcher(orchPattern);
      const onOrchChange = () => this.updateOrchestratorStatusBar();
      orchWatcher.onDidChange(onOrchChange);
      orchWatcher.onDidCreate(onOrchChange);
      orchWatcher.onDidDelete(onOrchChange);

      this.folderWatchers.push(manifestWatcher, orchWatcher);
    }

    // Watch every project's tasks/ tree and invalidate resolver cache on tasks/00-INDEX.md changes
    for (const proj of projects) {
      const pRoot = proj.root;
      const pId = proj.id;
      const tasksPattern = new vscode.RelativePattern(pRoot, 'tasks/**');
      const tasksWatcher = vscode.workspace.createFileSystemWatcher(tasksPattern);
      const onTaskFileEvent = (uri?: vscode.Uri) => {
        if (uri && uri.fsPath && uri.fsPath.endsWith('00-INDEX.md')) {
          invalidateProjectResolver(root);
        }
        const rel = uri && uri.fsPath ? path.relative(pRoot, uri.fsPath).replace(/\\/g, '/') : '';
        const isQ = rel.startsWith('tasks/questions/') || rel === 'tasks/questions';
        const isInbox = rel.startsWith('tasks/_inbox/') || rel === 'tasks/_inbox';
        const areas = isQ ? ['questions', 'tasks'] : isInbox ? ['inbox', 'tasks'] : ['tasks'];
        this.onEventsReceived([], areas, pId);
      };
      tasksWatcher.onDidChange(onTaskFileEvent);
      tasksWatcher.onDidCreate(onTaskFileEvent);
      tasksWatcher.onDidDelete(onTaskFileEvent);
      this.folderWatchers.push(tasksWatcher);
    }

    // Initial check: if lastEventSeq is unset, seed it from the engine without toasting past events
    this.initializeSequenceSeed(root);
    this.updateOrchestratorStatusBar();
  }

  private folderWatchers: vscode.Disposable[] = [];

  private cleanupFolderWatchers(): void {
    for (const w of this.folderWatchers) {
      w.dispose();
    }
    this.folderWatchers = [];
  }

  public schedulePoll(delayMs: number = 100): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.pollNewEvents();
    }, delayMs);
  }

  /**
   * Initializes sequence tracking for a folder.
   * If lastEventSeq is undefined in workspaceState, query engine for current last_seq
   * and store it, so startup/reload does not re-notify historical events.
   */
  public async initializeSequenceSeed(root: string): Promise<number> {
    const seqKey = `aiOrchestration.lastEventSeq:${root}`;
    const storedSeq = this.context.workspaceState.get<number | undefined>(seqKey);
    if (storedSeq !== undefined) {
      // Already initialized, check for new events that happened while offline
      this.schedulePoll(50);
      return storedSeq;
    }

    const eventsDir = path.join(root, '.ai-orchestration', 'events');
    if (!fs.existsSync(eventsDir)) {
      await this.context.workspaceState.update(seqKey, 0);
      return 0;
    }

    try {
      const res = await this.cliClient.tailEvents(root, undefined, 1);
      const maxSeq = res?.last_seq ?? 0;
      await this.context.workspaceState.update(seqKey, maxSeq);
      return maxSeq;
    } catch {
      await this.context.workspaceState.update(seqKey, 0);
      return 0;
    }
  }

  /**
   * Tails events since lastSeq, computes areas, notifies webview, and triggers toasts.
   */
  public async pollNewEvents(): Promise<void> {
    if (this.inFlight) {
      this.rerunRequested = true;
      return this.inFlight;
    }

    this.inFlight = (async () => {
      await this.runPoll();
      while (this.rerunRequested) {
        this.rerunRequested = false;
        await this.runPoll();
      }
    })();

    try {
      await this.inFlight;
    } finally {
      this.inFlight = null;
    }
  }

  private async runPoll(): Promise<void> {
    const root = this.getBoundRoot();
    if (!root || !fs.existsSync(root)) return;

    const projects = this._getProjectsForRoot(root);
    const pollTargets: Array<{ root: string; projectId?: string }> = [];
    const seenRoots = new Set<string>();
    const normPath = (p: string) => (fs.existsSync(p) ? fs.realpathSync(p) : path.resolve(p));
    const normBoundRoot = normPath(root);

    for (const p of projects) {
      const np = normPath(p.root);
      if (!seenRoots.has(np)) {
        seenRoots.add(np);
        const targetRoot = np === normBoundRoot ? root : p.root;
        pollTargets.push({ root: targetRoot, projectId: p.id });
      }
    }
    if (!seenRoots.has(normBoundRoot)) {
      pollTargets.push({ root, projectId: projects.length === 1 ? projects[0].id : '_workspace' });
    }

    for (const target of pollTargets) {
      await this._pollSingleRoot(target.root, target.projectId);
    }
  }

  private async _pollSingleRoot(root: string, projectId?: string): Promise<void> {
    const eventsDir = path.join(root, '.ai-orchestration', 'events');
    if (!fs.existsSync(eventsDir)) return;

    const seqKey = `aiOrchestration.lastEventSeq:${root}`;
    const notifiedSeqsKey = `aiOrchestration.notifiedEventSeqs:${root}`;
    const questionsKey = `aiOrchestration.notifiedQuestions:${root}`;

    let lastSeq = this.context.workspaceState.get<number>(seqKey, 0);
    const persistedNotifiedSeqs = this.context.workspaceState.get<number[]>(notifiedSeqsKey, []);
    const notifiedSeqsSet = new Set<number>(persistedNotifiedSeqs);
    const notifiedQuestions = new Set<string>(this.context.workspaceState.get<string[]>(questionsKey, []));

    try {
      const res = await this.cliClient.tailEvents(root, lastSeq);
      const events: OrchestrationEventLike[] = res?.events || [];
      if (!events.length) {
        if (res?.last_seq && res.last_seq > lastSeq) {
          await this.context.workspaceState.update(seqKey, res.last_seq);
        }
        return;
      }

      const { newEvents, maxSeq } = filterNewEvents(events, lastSeq, notifiedSeqsSet);
      if (maxSeq > lastSeq) {
        await this.context.workspaceState.update(seqKey, maxSeq);
      }

      if (!newEvents.length) return;

      const areas = mapEventsToAreas(newEvents);

      // Check notification toasts
      const notifyEventsEnabled = vscode.workspace
        .getConfiguration('aiOrchestration')
        .get<boolean>('notifyEvents', true);
      const notifyQuestionsEnabled = vscode.workspace
        .getConfiguration('aiOrchestration')
        .get<boolean>('notifyNewQuestions', true);

      for (const ev of newEvents) {
        // Handle question toasts with deduplication against 08.7 QuestionNotifier
        if (ev.type === 'question.asked') {
          const qId = ev.subject || ev.payload?.id || ev.data?.id;
          if (qId && !notifiedQuestions.has(qId) && !notifiedSeqsSet.has(ev.seq)) {
            notifiedQuestions.add(qId);
            notifiedSeqsSet.add(ev.seq);

            if (notifyQuestionsEnabled) {
              const qObj = {
                id: qId,
                short_title: ev.payload?.short_title || ev.data?.short_title,
                question: ev.payload?.question || ev.data?.question,
                title: ev.payload?.title || ev.data?.title,
              };
              const msg = formatQuestionNotification(qObj);
              vscode.window.showInformationMessage(msg, 'Open', 'Later').then((action) => {
                if (action === 'Open') {
                  vscode.commands.executeCommand('aiOrchestration.openDashboard', {
                    tab: 'decisions',
                    questionId: qId,
                  });
                }
              });
            }
          }
          continue;
        }

        // Handle general event toasts
        if (notifyEventsEnabled && shouldNotifyEvent(ev) && !notifiedSeqsSet.has(ev.seq)) {
          notifiedSeqsSet.add(ev.seq);
          const notif = formatEventNotification(ev);
          if (notif) {
            const btn = notif.actionTitle || 'Open Dashboard';
            vscode.window.showInformationMessage(notif.message, btn).then((action) => {
              if (action === btn && notif.actionCommand) {
                vscode.commands.executeCommand(notif.actionCommand, ...(notif.actionArgs || []));
              }
            });
          }
        }
      }

      // Persist bounded sets in workspaceState
      const boundedSeqs = Array.from(notifiedSeqsSet).slice(-500);
      await this.context.workspaceState.update(notifiedSeqsKey, boundedSeqs);
      await this.context.workspaceState.update(questionsKey, Array.from(notifiedQuestions));

      // Forward to webview & views via callback
      this.onEventsReceived(newEvents, areas, projectId);

      if (areas.includes('orchestrator')) {
        this.updateOrchestratorStatusBar();
      }
    } catch {
      // Non-blocking; watcher will retry on next manifest change
    }
  }

  public updateOrchestratorStatusBar(): void {
    const root = this.getBoundRoot();
    if (!root || !fs.existsSync(root)) {
      this.statusBarItem.hide();
      return;
    }

    const info = getOrchestratorStatus(root);
    if (!info.started) {
      this.statusBarItem.hide();
      return;
    }

    if (info.paused) {
      this.statusBarItem.text = '$(debug-pause) Orch: paused';
      this.statusBarItem.tooltip = 'Orchestrator is paused — click to open dashboard';
      this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
      this.statusBarItem.show();
      return;
    }

    const tool = info.tool || 'orchestrator';
    const queueText = (info.queueLength ?? 0) > 0 ? ` (Q: ${info.queueLength})` : '';
    this.statusBarItem.text = `$(hubot) ${tool}${queueText}`;
    this.statusBarItem.tooltip = `Orchestrator: ${tool} (${info.status || 'active'})${
      (info.queueLength ?? 0) > 0 ? ` — ${info.queueLength} queued turn(s)` : ''
    } — click to open dashboard`;
    this.statusBarItem.backgroundColor = undefined;
    this.statusBarItem.show();
  }

  public dispose(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    this.cleanupFolderWatchers();
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables = [];
  }
}
