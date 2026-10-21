import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as os from 'os';
import { spawnSync } from 'child_process';

export type ProjectKind = 'project' | '_workspace' | 'sub_workspace';

export interface ProjectInfo {
  id: string;
  path: string;
  kind: ProjectKind;
  root: string;
  tasksDir: string;
  uuid?: string | null;
}

export interface SubWorkspaceInfo {
  uuid?: string | null;
  slug: string;
  path: string;
  kind: 'sub_workspace';
}

export class UnknownProjectError extends Error {
  public status = 404;
  public data = { error: 'unknown-project' };
  constructor(message = 'unknown-project') {
    super(message);
    this.name = 'UnknownProjectError';
  }
}

export class ProjectRequiredError extends Error {
  public status = 400;
  public data = { error: 'project-required' };
  constructor(message = 'project-required') {
    super(message);
    this.name = 'ProjectRequiredError';
  }
}

export class OutsideWorkspaceError extends Error {
  public status = 400;
  public data = { error: 'outside-workspace-root' };
  constructor(message = 'outside-workspace-root') {
    super(message);
    this.name = 'OutsideWorkspaceError';
  }
}

export const EXCLUDE_DIR_NAMES = new Set([
  'node_modules',
  'build',
  'dist',
  'target',
  'venv',
  '.venv',
  'scratch',
  'fixtures',
  'references',
]);

export function sanitizeSlug(name: string): string {
  let slug = String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!slug) {
    slug = 'workspace';
  } else if (slug.length === 1) {
    slug = `${slug}-1`;
  }
  if (!/^[a-z0-9]/.test(slug)) {
    slug = `ws-${slug}`;
  }
  if (slug.length > 48) {
    slug = slug.slice(0, 48).replace(/-+$/g, '');
  }
  if (slug.length < 2) {
    slug = `${slug}0`;
  }
  return slug;
}

export function findGitRepoRoot(targetPath: string): string | null {
  let cur = path.resolve(targetPath);
  while (true) {
    if (fs.existsSync(path.join(cur, '.git'))) {
      return cur;
    }
    const parent = path.dirname(cur);
    if (parent === cur) {
      break;
    }
    cur = parent;
  }
  return null;
}

export function isGitIgnored(targetPath: string, _wsPath?: string): boolean {
  try {
    const absTarget = path.resolve(targetPath);
    if (fs.existsSync(path.join(absTarget, '.git'))) {
      return false;
    }
    const repo = findGitRepoRoot(absTarget);
    if (!repo) {
      return false;
    }
    const rel = path.relative(repo, absTarget);
    if (!rel) {
      return false;
    }
    const proc = spawnSync('git', ['check-ignore', '-q', rel], {
      cwd: repo,
      stdio: 'ignore',
    });
    return proc.status === 0;
  } catch {
    return false;
  }
}

export function computeTreeHash(tasksDir: string): string {
  try {
    if (!fs.existsSync(tasksDir) || !fs.statSync(tasksDir).isDirectory()) {
      return '';
    }
  } catch {
    return '';
  }

  const h = crypto.createHash('sha256');
  const entries: Array<[string, number, number]> = [];

  const walk = (dir: string) => {
    let items: fs.Dirent[];
    try {
      items = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const item of items) {
      if (item.name.startsWith('.')) {
        continue;
      }
      const fullPath = path.join(dir, item.name);
      if (item.isDirectory()) {
        walk(fullPath);
      } else if (item.isFile() && (item.name.endsWith('.md') || item.name.endsWith('.json'))) {
        try {
          const st = fs.statSync(fullPath);
          const rel = path.relative(tasksDir, fullPath).replace(/\\/g, '/');
          entries.push([rel, st.mtimeMs, st.size]);
        } catch {}
      }
    }
  };

  try {
    walk(tasksDir);
    entries.sort((a, b) => a[0].localeCompare(b[0]));
    for (const [rel, mtime, size] of entries) {
      h.update(`${rel}:${mtime}:${size}\n`, 'utf-8');
    }
  } catch {}

  return h.digest('hex');
}

export const CANONICAL_COUNT_STATES = [
  'open',
  'in progress',
  'waiting',
  'blocked',
  'paused',
  'bounced',
  'delivered',
  'verified',
  'done',
  'dropped',
] as const;

export function canonicalizeTaskState(rawState?: string | null): string {
  if (!rawState) {
    return 'open';
  }
  let s = String(rawState).trim().toLowerCase();
  s = s.replace(/\s*\(\d{4}-\d{2}-\d{2}\)$/, '').replace(/^`+|`+$/g, '').trim();
  const sNorm = s.replace(/[_-]+/g, ' ');
  if (sNorm === 'open' || sNorm === 'todo' || sNorm === 'draft') return 'open';
  if (sNorm === 'in progress' || sNorm === 'doing' || sNorm === 'started') return 'in progress';
  if (sNorm === 'waiting' || sNorm === 'wait') return 'waiting';
  if (sNorm === 'blocked' || sNorm === 'block') return 'blocked';
  if (sNorm === 'paused' || sNorm === 'pause') return 'paused';
  if (sNorm === 'bounced' || sNorm === 'bounce') return 'bounced';
  if (sNorm === 'delivered' || sNorm === 'deliver') return 'delivered';
  if (sNorm === 'verified' || sNorm === 'verify') return 'verified';
  if (sNorm === 'done' || sNorm === 'done with a caveat' || sNorm === 'completed' || sNorm === 'closed') return 'done';
  if (sNorm === 'dropped' || sNorm === 'drop' || sNorm === 'abandoned' || sNorm === 'cancelled') return 'dropped';
  return sNorm;
}

export function countTasksByCanonicalState(tasks: any[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const st of CANONICAL_COUNT_STATES) {
    counts[st] = 0;
  }
  counts.total = 0;
  for (const t of tasks || []) {
    const rawSt = t?.canonical_state || t?.state;
    const cst = canonicalizeTaskState(rawSt);
    if (cst in counts) {
      counts[cst] += 1;
    }
    counts.total += 1;
  }
  return counts;
}

export function fastCountQuestions(tasksDir: string): number {
  const qDir = path.join(tasksDir, 'questions');
  try {
    if (!fs.existsSync(qDir) || !fs.statSync(qDir).isDirectory()) {
      return 0;
    }
  } catch {
    return 0;
  }
  let count = 0;
  const walk = (dir: string) => {
    let items: fs.Dirent[];
    try {
      items = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const item of items) {
      if (item.name.startsWith('.')) continue;
      if (item.isDirectory()) {
        if (item.name === 'answered' || item.name === 'withdrawn') continue;
        walk(path.join(dir, item.name));
      } else if (item.isFile() && item.name.endsWith('.md')) {
        count += 1;
      }
    }
  };
  walk(qDir);
  return count;
}

export function fastCountInbox(tasksDir: string): number {
  const inboxDir = path.join(tasksDir, '_inbox');
  try {
    if (!fs.existsSync(inboxDir) || !fs.statSync(inboxDir).isDirectory()) {
      return 0;
    }
  } catch {
    return 0;
  }
  let count = 0;
  const walk = (dir: string) => {
    let items: fs.Dirent[];
    try {
      items = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const item of items) {
      if (item.name.startsWith('.')) continue;
      if (item.isDirectory()) {
        if (item.name === 'resolved' || item.name === 'discarded') continue;
        walk(path.join(dir, item.name));
      } else if (item.isFile() && item.name.endsWith('.md')) {
        count += 1;
      }
    }
  };
  walk(inboxDir);
  return count;
}

function expandHome(p: string): string {
  if (p.startsWith('~/') || p === '~') {
    return path.join(os.homedir(), p.slice(1));
  }
  return p;
}

export function resolveRegistryConfigDir(explicitConfigDir?: string | null): string | null {
  if (explicitConfigDir) {
    return path.resolve(expandHome(explicitConfigDir));
  }
  const envOrchCfg = (process.env.AI_ORCHESTRATION_CONFIG || '').trim();
  if (envOrchCfg) {
    const p = path.resolve(expandHome(envOrchCfg));
    const isFile = (fs.existsSync(p) && fs.statSync(p).isFile()) || p.endsWith('.toml');
    return isFile ? path.dirname(p) : p;
  }
  const envCfgDir = (process.env.AI_ORCH_CONFIG_DIR || '').trim();
  if (envCfgDir) {
    return path.resolve(expandHome(envCfgDir));
  }
  const envHome = (process.env.AI_ORCH_HOME || '').trim();
  if (envHome) {
    return path.resolve(path.join(expandHome(envHome), '.config', 'ai-orchestration'));
  }
  return null;
}

export function resolveRegistryDbPath(explicitConfigDir?: string | null): string {
  const cfgDir = resolveRegistryConfigDir(explicitConfigDir);
  const base = cfgDir || path.join(os.homedir(), '.config', 'ai-orchestration');
  return path.join(base, 'broker', 'registry.sqlite');
}

export type RunCliFn = (args: string[], cwd?: string) => Promise<any>;

export class ProjectResolver {
  public workspace: string;
  public configDir?: string | null;
  public aiOrchBin?: string | null;

  private _cachedWsPath: string | null = null;
  private _cachedMode: 'registered' | 'discovered' | 'single' = 'single';
  private _cachedProjects: ProjectInfo[] = [];
  private _cachedSubWorkspaces: SubWorkspaceInfo[] = [];

  private _tasksCache = new Map<string, any[]>();
  private _countsCache = new Map<string, Record<string, number>>();

  constructor(workspace: string, configDir?: string | null, aiOrchBin?: string | null) {
    this.workspace = fs.existsSync(workspace) ? fs.realpathSync(workspace) : path.resolve(workspace);
    this.configDir = configDir;
    this.aiOrchBin = aiOrchBin;
  }

  public updateWorkspace(workspace: string, configDir?: string | null, aiOrchBin?: string | null): void {
    const newWs = fs.existsSync(workspace) ? fs.realpathSync(workspace) : path.resolve(workspace);
    if (newWs !== this.workspace) {
      this.workspace = newWs;
      this.invalidate();
    }
    if (configDir !== undefined) {
      this.configDir = configDir;
    }
    if (aiOrchBin !== undefined) {
      this.aiOrchBin = aiOrchBin;
    }
  }

  public invalidate(): void {
    this._cachedWsPath = null;
    this._cachedProjects = [];
    this._cachedSubWorkspaces = [];
    this._tasksCache.clear();
    this._countsCache.clear();
  }

  public invalidateTasksCache(): void {
    this._tasksCache.clear();
    this._countsCache.clear();
  }

  public getWorkspaceInfo(): {
    mode: 'registered' | 'discovered' | 'single';
    projects: ProjectInfo[];
    subWorkspaces: SubWorkspaceInfo[];
  } {
    if (this._cachedWsPath === this.workspace && this._cachedProjects.length > 0) {
      return {
        mode: this._cachedMode,
        projects: [...this._cachedProjects],
        subWorkspaces: [...this._cachedSubWorkspaces],
      };
    }

    const { mode, projects, subWorkspaces } = this._resolveWorkspace();
    this._cachedWsPath = this.workspace;
    this._cachedMode = mode;
    this._cachedProjects = projects;
    this._cachedSubWorkspaces = subWorkspaces;
    return {
      mode,
      projects: [...projects],
      subWorkspaces: [...subWorkspaces],
    };
  }

  public getProjects(): ProjectInfo[] {
    return this.getWorkspaceInfo().projects;
  }

  public getMode(): 'registered' | 'discovered' | 'single' {
    return this.getWorkspaceInfo().mode;
  }

  public isMultiProject(): boolean {
    return this.getProjects().length > 1;
  }

  public resolveProject(projectId?: string | null): ProjectInfo {
    const { projects } = this.getWorkspaceInfo();

    if (projectId === undefined || projectId === null || !String(projectId).trim()) {
      if (projects.length === 1) {
        const proj = projects[0];
        this._verifyInsideWorkspace(proj);
        return proj;
      }
      throw new ProjectRequiredError('project-required');
    }

    const reqId = String(projectId).trim();

    if (projects.length === 1) {
      const p = projects[0];
      const wsName = path.basename(this.workspace);
      const allowedAliases = new Set([p.id, '_workspace', wsName, sanitizeSlug(wsName), '.']);
      if (allowedAliases.has(reqId)) {
        this._verifyInsideWorkspace(p);
        return p;
      }
    }

    for (const p of projects) {
      if (p.id === reqId) {
        this._verifyInsideWorkspace(p);
        return p;
      }
    }

    throw new UnknownProjectError('unknown-project');
  }

  private _verifyInsideWorkspace(proj: ProjectInfo): void {
    const wsReal = fs.existsSync(this.workspace) ? fs.realpathSync(this.workspace) : path.resolve(this.workspace);
    const projReal = fs.existsSync(proj.root) ? fs.realpathSync(proj.root) : path.resolve(proj.root);
    const rel = path.relative(wsReal, projReal);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new OutsideWorkspaceError('outside-workspace-root');
    }
  }

  public projectRoot(projectId?: string | null): string {
    return this.resolveProject(projectId).root;
  }

  public tasksDir(projectId?: string | null): string {
    return this.resolveProject(projectId).tasksDir;
  }

  public async loadProjectTasks(proj: ProjectInfo, runCli: RunCliFn): Promise<any[]> {
    const th = computeTreeHash(proj.tasksDir);
    const cacheKey = `${proj.tasksDir}\u0000${th}`;
    if (this._tasksCache.has(cacheKey)) {
      return this._tasksCache.get(cacheKey)!;
    }

    try {
      if (!fs.existsSync(proj.tasksDir) || !fs.statSync(proj.tasksDir).isDirectory()) {
        this._tasksCache.set(cacheKey, []);
        return [];
      }
    } catch {
      this._tasksCache.set(cacheKey, []);
      return [];
    }

    try {
      const data = await runCli(['tasks', 'list', '--tasks-dir', proj.tasksDir, '--json'], proj.root);
      let tasks: any[] = [];
      if (data && typeof data === 'object') {
        tasks = data.all_tasks || data.emergent_tasks || data.tasks || [];
        const emergentMap = new Map<string, any>();
        for (const et of data.emergent_tasks || []) {
          if (et && typeof et === 'object' && et.id && et.coordinates) {
            emergentMap.set(String(et.id), et.coordinates);
          }
        }
        const treeMap = new Map<string, any>();
        if (data.tree && typeof data.tree === 'object') {
          for (const [nid, n] of Object.entries<any>(data.tree)) {
            if (n && typeof n === 'object' && n.coordinates) {
              treeMap.set(nid, n.coordinates);
            }
          }
        }
        for (const t of tasks) {
          const tid = String(t?.id || '');
          if (!t.coordinates) {
            if (emergentMap.has(tid) && emergentMap.get(tid)) {
              t.coordinates = emergentMap.get(tid);
            } else if (treeMap.has(tid) && treeMap.get(tid)) {
              t.coordinates = treeMap.get(tid);
            }
          }
        }
      }
      this._tasksCache.set(cacheKey, tasks);
      return tasks;
    } catch {
      return [];
    }
  }

  public async getProjectCounts(proj: ProjectInfo, runCli: RunCliFn): Promise<Record<string, number>> {
    const th = computeTreeHash(proj.tasksDir);
    const cacheKey = `${proj.tasksDir}\u0000${th}`;
    if (this._countsCache.has(cacheKey)) {
      return this._countsCache.get(cacheKey)!;
    }

    const tasks = await this.loadProjectTasks(proj, runCli);
    const counts = countTasksByCanonicalState(tasks);
    this._countsCache.set(cacheKey, counts);
    return counts;
  }

  private _resolveWorkspace(): {
    mode: 'registered' | 'discovered' | 'single';
    projects: ProjectInfo[];
    subWorkspaces: SubWorkspaceInfo[];
  } {
    const wsPath = this.workspace;

    // Step 1: Registered workspace
    const regResult = this._tryRegisteredWorkspace(wsPath);
    if (regResult !== null) {
      return regResult;
    }

    // Step 2: Read-only discovery
    const discResult = this._tryDiscoveredWorkspace(wsPath);
    if (discResult !== null) {
      return discResult;
    }

    // Step 3: Single plain project folder
    return this._singlePlainProject(wsPath);
  }

  private _hasRootTasks(wsPath: string): boolean {
    try {
      const idx = path.join(wsPath, 'tasks', '00-INDEX.md');
      if (fs.existsSync(idx) && fs.statSync(idx).isFile()) {
        return true;
      }
      const tDir = path.join(wsPath, 'tasks');
      if (fs.existsSync(tDir) && fs.statSync(tDir).isDirectory()) {
        return true;
      }
    } catch {}
    return false;
  }

  private _tryRegisteredWorkspace(wsPath: string): {
    mode: 'registered';
    projects: ProjectInfo[];
    subWorkspaces: SubWorkspaceInfo[];
  } | null {
    // 1a. Try CLI: ai-orch workspace show <root> --json or ai-orch projects list <root> --json
    if (this.aiOrchBin && fs.existsSync(this.aiOrchBin)) {
      const cfgDir = resolveRegistryConfigDir(this.configDir);
      const pythonExe = process.platform === 'win32' ? 'python' : 'python3';

      // Try workspace show first (accepts slug or uuid, or path if supported)
      // and projects list (accepts path, slug, or uuid and checks exact canonical_path)
      const listArgs = [this.aiOrchBin, 'projects', 'list', wsPath, '--json'];
      if (cfgDir) {
        listArgs.push('--config-dir', cfgDir);
      }
      try {
        const proc = spawnSync(pythonExe, listArgs, {
          cwd: wsPath,
          encoding: 'utf-8',
          env: process.env,
        });
        if (proc.status === 0 && proc.stdout) {
          const data = JSON.parse(proc.stdout.trim());
          if (data && data.ok && Array.isArray(data.items)) {
            // Verify via workspace show <workspace_uuid> that canonical_path is actually wsPath
            // (because find_workspace_for_arg also matches parent workspaces if wsPath is inside one)
            let isExactWorkspace = true;
            if (data.workspace_uuid) {
              const showArgs = [this.aiOrchBin, 'workspace', 'show', String(data.workspace_uuid), '--json'];
              if (cfgDir) {
                showArgs.push('--config-dir', cfgDir);
              }
              const showProc = spawnSync(pythonExe, showArgs, {
                cwd: wsPath,
                encoding: 'utf-8',
                env: process.env,
              });
              if (showProc.status === 0 && showProc.stdout) {
                const showData = JSON.parse(showProc.stdout.trim());
                const cpath = showData?.workspace?.canonical_path;
                if (cpath) {
                  const resolvedCpath = fs.existsSync(cpath) ? fs.realpathSync(cpath) : path.resolve(cpath);
                  isExactWorkspace = resolvedCpath === wsPath;
                }
              }
            }

            if (isExactWorkspace) {
              const projects: ProjectInfo[] = [];
              const subWorkspaces: SubWorkspaceInfo[] = [];
              let hasWorkspaceSlug = false;

              for (const item of data.items) {
                const kind: ProjectKind = item.kind || 'project';
                const slug = String(item.slug || item.id);
                const relP = item.path || '.';
                const pRoot = path.resolve(wsPath, relP);
                if (kind === 'sub_workspace') {
                  subWorkspaces.push({
                    uuid: item.uuid ?? null,
                    slug,
                    path: relP,
                    kind: 'sub_workspace',
                  });
                  projects.push({
                    id: slug,
                    path: relP,
                    kind: 'sub_workspace',
                    root: pRoot,
                    tasksDir: path.join(pRoot, 'tasks'),
                    uuid: item.uuid ?? null,
                  });
                } else {
                  if (slug === '_workspace') {
                    hasWorkspaceSlug = true;
                  }
                  projects.push({
                    id: slug,
                    path: relP,
                    kind: slug === '_workspace' ? '_workspace' : kind,
                    root: pRoot,
                    tasksDir: path.join(pRoot, 'tasks'),
                    uuid: item.uuid ?? null,
                  });
                }
              }

              if (!hasWorkspaceSlug && this._hasRootTasks(wsPath)) {
                projects.unshift({
                  id: '_workspace',
                  path: '.',
                  kind: '_workspace',
                  root: wsPath,
                  tasksDir: path.join(wsPath, 'tasks'),
                  uuid: null,
                });
              }

              return { mode: 'registered', projects, subWorkspaces };
            }
          }
        }
      } catch {}
    }

    // 1b. Fallback: check SQLite registry directly via python3 -c if db exists
    const dbPath = resolveRegistryDbPath(this.configDir);
    if (fs.existsSync(dbPath)) {
      try {
        const pyScript = `
import json, pathlib, sqlite3, sys
db_path, ws_str = sys.argv[1], sys.argv[2]
ws_path = pathlib.Path(ws_str).resolve()
conn = sqlite3.connect(db_path, timeout=1.0)
conn.row_factory = sqlite3.Row
row = conn.execute("SELECT * FROM workspaces WHERE canonical_path = ?", (str(ws_path),)).fetchone()
if not row:
    sys.exit(1)
ws_uuid = row["uuid"]
proj_rows = [dict(r) for r in conn.execute("SELECT uuid, slug, rel_path FROM projects WHERE workspace_uuid = ? ORDER BY slug ASC", (ws_uuid,)).fetchall()]
other_ws = [dict(r) for r in conn.execute("SELECT uuid, slug, canonical_path FROM workspaces WHERE uuid != ?", (ws_uuid,)).fetchall()]
print(json.dumps({"ws_uuid": ws_uuid, "projects": proj_rows, "other_ws": other_ws}))
`;
        const pythonExe = process.platform === 'win32' ? 'python' : 'python3';
        const proc = spawnSync(pythonExe, ['-c', pyScript, dbPath, wsPath], {
          encoding: 'utf-8',
        });
        if (proc.status === 0 && proc.stdout) {
          const parsed = JSON.parse(proc.stdout.trim());
          const projects: ProjectInfo[] = [];
          const subWorkspaces: SubWorkspaceInfo[] = [];
          let hasWorkspaceSlug = false;

          for (const pr of parsed.projects || []) {
            const slug = String(pr.slug);
            const relP = pr.rel_path || '.';
            const pRoot = path.resolve(wsPath, relP);
            const kind: ProjectKind = slug === '_workspace' ? '_workspace' : 'project';
            if (slug === '_workspace') {
              hasWorkspaceSlug = true;
            }
            projects.push({
              id: slug,
              path: relP,
              kind,
              root: pRoot,
              tasksDir: path.join(pRoot, 'tasks'),
              uuid: pr.uuid ?? null,
            });
          }

          if (!hasWorkspaceSlug && this._hasRootTasks(wsPath)) {
            projects.unshift({
              id: '_workspace',
              path: '.',
              kind: '_workspace',
              root: wsPath,
              tasksDir: path.join(wsPath, 'tasks'),
              uuid: null,
            });
          }

          for (const ow of parsed.other_ws || []) {
            const owPath = fs.existsSync(ow.canonical_path)
              ? fs.realpathSync(ow.canonical_path)
              : path.resolve(ow.canonical_path);
            const rel = path.relative(wsPath, owPath).replace(/\\/g, '/');
            if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
              subWorkspaces.push({
                uuid: ow.uuid ?? null,
                slug: ow.slug,
                path: rel,
                kind: 'sub_workspace',
              });
              projects.push({
                id: ow.slug,
                path: rel,
                kind: 'sub_workspace',
                root: owPath,
                tasksDir: path.join(owPath, 'tasks'),
                uuid: ow.uuid ?? null,
              });
            }
          }

          return { mode: 'registered', projects, subWorkspaces };
        }
      } catch {}
    }

    return null;
  }

  private _tryDiscoveredWorkspace(wsPath: string): {
    mode: 'discovered';
    projects: ProjectInfo[];
    subWorkspaces: SubWorkspaceInfo[];
  } | null {
    const candidateFolders: string[] = [];

    if (this._hasRootTasks(wsPath)) {
      candidateFolders.push(wsPath);
    }

    const walk = (dir: string) => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const d = entry.name;
        if (d.startsWith('.') || EXCLUDE_DIR_NAMES.has(d)) continue;

        const folderP = path.resolve(dir, d);
        const parts = folderP.split(path.sep);
        if (parts.includes('.kilo') || parts.includes('worktrees')) {
          continue;
        }

        if (isGitIgnored(folderP, wsPath)) {
          continue;
        }

        const hasIndex =
          fs.existsSync(path.join(folderP, 'tasks', '00-INDEX.md')) ||
          fs.existsSync(path.join(folderP, 'tasks', 'AGENTS.md')) ||
          fs.existsSync(path.join(folderP, 'tasks', 'CONTEXT.md'));
        if (hasIndex) {
          candidateFolders.push(folderP);
        }

        walk(folderP);
      }
    };

    walk(wsPath);

    const innerCandidates = candidateFolders.filter((f) => f !== wsPath);
    if (innerCandidates.length > 0) {
      const usedSlugs = new Set<string>();
      const projects: ProjectInfo[] = [];

      const sortedCandidates = [...candidateFolders].sort((a, b) => {
        const aOrder = a === wsPath ? 0 : 1;
        const bOrder = b === wsPath ? 0 : 1;
        if (aOrder !== bOrder) return aOrder - bOrder;
        return a.localeCompare(b);
      });

      for (const folder of sortedCandidates) {
        let pId: string;
        let relP: string;
        let kind: ProjectKind;

        if (folder === wsPath) {
          pId = '_workspace';
          relP = '.';
          kind = '_workspace';
        } else {
          relP = path.relative(wsPath, folder).replace(/\\/g, '/');
          const rawSlug = sanitizeSlug(path.basename(folder));
          pId = rawSlug;
          let suffix = 2;
          while (usedSlugs.has(pId)) {
            pId = `${rawSlug}-${suffix}`;
            suffix += 1;
          }
          kind = 'project';
        }

        usedSlugs.add(pId);
        projects.push({
          id: pId,
          path: relP,
          kind,
          root: folder,
          tasksDir: path.join(folder, 'tasks'),
          uuid: null,
        });
      }

      return { mode: 'discovered', projects, subWorkspaces: [] };
    }

    return null;
  }

  private _singlePlainProject(wsPath: string): {
    mode: 'single';
    projects: ProjectInfo[];
    subWorkspaces: SubWorkspaceInfo[];
  } {
    const slug = sanitizeSlug(path.basename(wsPath));
    const proj: ProjectInfo = {
      id: slug,
      path: '.',
      kind: 'project',
      root: wsPath,
      tasksDir: path.join(wsPath, 'tasks'),
      uuid: null,
    };
    return { mode: 'single', projects: [proj], subWorkspaces: [] };
  }
}

const resolverRegistry = new Map<string, ProjectResolver>();

export function getProjectResolver(workspaceRoot: string, aiOrchBin?: string | null, configDir?: string | null): ProjectResolver {
  const normRoot = fs.existsSync(workspaceRoot) ? fs.realpathSync(workspaceRoot) : path.resolve(workspaceRoot);
  let res = resolverRegistry.get(normRoot);
  if (!res) {
    res = new ProjectResolver(normRoot, configDir, aiOrchBin);
    resolverRegistry.set(normRoot, res);
  } else {
    if (aiOrchBin !== undefined) res.aiOrchBin = aiOrchBin;
    if (configDir !== undefined) res.configDir = configDir;
  }
  return res;
}

export function invalidateProjectResolver(workspaceRoot?: string): void {
  if (!workspaceRoot) {
    for (const r of resolverRegistry.values()) {
      r.invalidate();
    }
    return;
  }
  const normRoot = fs.existsSync(workspaceRoot) ? fs.realpathSync(workspaceRoot) : path.resolve(workspaceRoot);
  const res = resolverRegistry.get(normRoot);
  if (res) {
    res.invalidate();
  }
}
