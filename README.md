# VS Code AI Orchestration & Task Manager

Visual task backlog manager, execution control plane, and independent multi-agent verification extension for VS Code.

Powered by [`ai-orchestration`](../ai-orchestration/).

---

## Features

1. **Activity Bar Icon & Sidebar Views:**
   - **Next Up:** Priority execution queue (`P0`/`P1` tasks with one-click handoff prompt copy).
   - **Initiatives:** Structured initiatives (`NN-<slug>`) and subtask counts.
   - **Decisions Waiting:** Tasks awaiting human or architectural decisions.
2. **Interactive Webview Dashboard:**
   - Full Kanban board by task state (`open`, `in progress`, `waiting`, `delivered`, `verified`, `done`).
   - Task detail & specification editor with validation guards.
   - One-click state transitions (`Start`, `Mark Delivered`, `Approve Verified`, `Bounce with Feedback`, `Close Done`).
3. **Multi-Assistant Skill & MCP Installer:**
   - Deploy orchestration skills and register MCP servers across Kilo, Claude, and Codex in one click.
4. **Environment Health Doctor:**
   - Real-time diagnostic showing CLI binary statuses, skill drift hash matrix, and conflict warnings.
5. **Project Orchestrator Configurator:**
   - Visual editor for `orchestration.toml` (Global & Project) and 1-click `AGENTS.md` sync.
6. **Automatic File Synchronization:**
   - Built-in file system watcher on `**/tasks/**/*.{md,toml}` automatically refreshes sidebar views and the dashboard whenever task files change on disk.

---

## Installation

Install the packaged `.vsix` into VS Code:

```bash
code --install-extension ./vscode-ai-orchestration-0.1.0.vsix
```

Or from the VS Code Extensions view (`Cmd+Shift+X` / `Ctrl+Shift+X`):
1. Click the `...` (Views and More Actions) menu in the top right.
2. Select **Install from VSIX...**
3. Pick `vscode-ai-orchestration-0.1.0.vsix`.

---

## Quickstart on Any Project

1. Open any repository or workspace in VS Code.
2. If the project already has a `tasks/` directory (following `ai-orchestration` / `task-pipeline`), the **Next Up**, **Initiatives**, and **Decisions Waiting** views populate automatically in the sidebar.
3. Click the **Layers icon** in the status bar or run **`AI Orchestration: Open Task Dashboard`** from the Command Palette (`Cmd+Shift+P`) to open the full interactive Backlog & Kanban board.

## Commands

| Command | Title |
| :--- | :--- |
| `aiOrchestration.openDashboard` | AI Orchestration: Open Task Dashboard |
| `aiOrchestration.syncIndex` | AI Orchestration: Sync 00-INDEX.md |
| `aiOrchestration.validateTasks` | AI Orchestration: Validate Tasks |
| `aiOrchestration.refresh` | AI Orchestration: Refresh Tasks |

## License

[MIT](LICENSE)
