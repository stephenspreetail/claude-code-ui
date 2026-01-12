# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Real-time dashboard for monitoring Claude Code sessions across multiple projects. Shows sessions by status (Working, Needs Approval, Waiting, Idle) with AI-powered summaries and PR/CI tracking.

## Commands

```bash
# Install dependencies
pnpm install

# Configure Claude Code hooks (required for accurate status detection)
pnpm run setup

# Start both daemon and UI
pnpm start

# Run daemon only (port 4450)
pnpm serve

# Run UI dev server only
pnpm dev

# Run daemon tests
pnpm --filter @claude-code-ui/daemon test

# Run single test file
pnpm --filter @claude-code-ui/daemon test src/tracking.test.ts

# Lint UI
pnpm --filter @claude-code-ui/ui lint
```

Requires `ANTHROPIC_API_KEY` env var for AI summaries.

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                              DATA SOURCES                                       │
│                                                                                 │
│  ~/.claude/projects/                    ~/.claude/session-signals/              │
│  ┌─────────────────────┐                ┌─────────────────────┐                │
│  │ {encoded-path}/     │                │ {sessionId}.working │ ← user-prompt  │
│  │   {sessionId}.jsonl │                │ {sessionId}.permission │ ← permission │
│  │                     │                │ {sessionId}.stop    │ ← stop hook    │
│  │ JSONL log entries:  │                │ {sessionId}.ended   │ ← session-end  │
│  │ • user prompts      │                └─────────┬───────────┘                │
│  │ • assistant msgs    │                          │                            │
│  │ • tool use/results  │                          │ (authoritative             │
│  │ • system events     │                          │  status signals)           │
│  └─────────┬───────────┘                          │                            │
│            │                                      │                            │
└────────────┼──────────────────────────────────────┼────────────────────────────┘
             │ chokidar                             │ chokidar
             │ file events                          │ file events
             ▼                                      ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│                         DAEMON (packages/daemon)                                │
│                                                                                 │
│  ┌─────────────────────────────────────────────────────────────────────────┐   │
│  │                   watcher.ts (SessionWatcher extends EventEmitter)      │   │
│  │                                                                         │   │
│  │  • chokidar watches both directories                                    │   │
│  │  • debounces file changes (200ms)                                       │   │
│  │  • tracks byte position for incremental reads                           │   │
│  │                                                                         │   │
│  │  On file change, calls directly:                                        │   │
│  │  ┌─────────────┐    ┌──────────────────────┐                            │   │
│  │  │ parser.ts   │    │ status.ts            │                            │   │
│  │  │ • tailJSONL │    │ • deriveStatus()     │                            │   │
│  │  │ • extract   │    │   ↓                  │                            │   │
│  │  │   Metadata  │    │ status-machine.ts    │                            │   │
│  │  └─────────────┘    │ (XState machine)     │                            │   │
│  │                     └──────────────────────┘                            │   │
│  │                                                                         │   │
│  │  Then emits: this.emit("session", { type, session })                    │   │
│  └────────────────────────────┬────────────────────────────────────────────┘   │
│                               │                                                │
│                               │ Node.js EventEmitter                           │
│                               ▼                                                │
│  ┌─────────────────────────────────────────────────────────────────────────┐   │
│  │                          serve.ts (main entry)                          │   │
│  │                                                                         │   │
│  │  watcher.on("session", async (event) => {                               │   │
│  │      // calls summarizer for AI summaries                               │   │
│  │      // publishes to stream server                                      │   │
│  │  })                                                                     │   │
│  │                     │                         │                         │   │
│  │                     ▼                         ▼                         │   │
│  │        ┌─────────────────┐       ┌───────────────────────┐              │   │
│  │        │ summarizer.ts   │       │ server.ts             │              │   │
│  │        │ • Claude API    │       │ • Durable Streams     │              │   │
│  │        │ • goal/summary  │       │ • HTTP :4450/sessions │              │   │
│  │        └─────────────────┘       └───────────┬───────────┘              │   │
│  └──────────────────────────────────────────────┼──────────────────────────┘   │
│                                                 │                              │
└─────────────────────────────────────────────────┼──────────────────────────────┘
                                                  │
                                                  │ SSE (Server-Sent Events)
                                                  ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│                            UI (packages/ui)                                     │
│                                                                                 │
│  ┌─────────────────────────────────────────────────────────────────────────┐   │
│  │                    sessionsDb.ts (StreamDB)                             │   │
│  │  • createStreamDB connects to :4450/sessions                            │   │
│  │  • maintains local reactive state                                       │   │
│  │  • syncs updates via Durable Streams protocol                           │   │
│  └────────────────────────────────┬────────────────────────────────────────┘   │
│                                   │                                            │
│                                   ▼                                            │
│  ┌─────────────────────────────────────────────────────────────────────────┐   │
│  │                    useSessions.ts (React Hook)                          │   │
│  │  • useLiveQuery subscribes to db changes                                │   │
│  │  • groupSessionsByRepo organizes by GitHub repo                         │   │
│  │  • calculates activity scores for sorting                               │   │
│  └────────────────────────────────┬────────────────────────────────────────┘   │
│                                   │                                            │
│                                   ▼                                            │
│  ┌─────────────────────────────────────────────────────────────────────────┐   │
│  │                         React Components                                │   │
│  │                                                                         │   │
│  │  routes/index.tsx                                                       │   │
│  │       │                                                                 │   │
│  │       ├── RepoSection.tsx (per GitHub repo)                             │   │
│  │       │       │                                                         │   │
│  │       │       └── KanbanColumn.tsx × 4                                  │   │
│  │       │               │                                                 │   │
│  │       │               └── SessionCard.tsx (per session)                 │   │
│  │       │                                                                 │   │
│  │  Columns: [Working] [Needs Approval] [Waiting] [Idle]                   │   │
│  └─────────────────────────────────────────────────────────────────────────┘   │
│                                                                                 │
└─────────────────────────────────────────────────────────────────────────────────┘
```

### Daemon (`packages/daemon`)

- **watcher.ts**: Uses chokidar to watch `~/.claude/projects/` and `~/.claude/session-signals/` for changes
- **parser.ts**: Incrementally parses JSONL log files, extracts session metadata
- **status-machine.ts**: XState state machine determines session status from log events
- **status.ts**: Wraps the state machine, applies stale timeouts
- **summarizer.ts**: Generates AI summaries via Anthropic API
- **server.ts**: Durable Streams server publishes session state changes
- **schema.ts**: Zod schemas for session data, shared with UI

Hook signals (`~/.claude/session-signals/`) provide authoritative status:
- `{sessionId}.working.json` - User started turn
- `{sessionId}.permission.json` - Tool awaiting approval
- `{sessionId}.stop.json` - Claude's turn ended
- `{sessionId}.ended.json` - Session closed

### UI (`packages/ui`)

- TanStack Router for routing (`src/routes/`)
- TanStack DB + Durable Streams for reactive data (`src/data/sessionsDb.ts`)
- Radix UI Themes for components (`src/components/`)
- `useLiveQuery` hook for all data operations - use query builder methods (`.orderBy()`, `.where()`) instead of JS filtering

## Session Status State Machine

```
waiting_for_input ──USER_PROMPT──→ working
                                     │
                         ASSISTANT_TOOL_USE
                                     ↓
                            waiting_for_approval
                                     │
                               TOOL_RESULT
                                     ↓
                                 working ──TURN_END──→ waiting_for_input
```

Status mapping to UI columns:
- `working` → "Working"
- `waiting_for_approval` → "Needs Approval" (hasPendingToolUse=true)
- `waiting_for_input` → "Waiting"
- idle is derived by UI when lastActivityAt > 5 minutes

## UI Guidelines (from packages/ui/CLAUDE.md)

- Always use Radix UI components - never plain HTML elements with custom styles
- Let Radix and capsize handle typography - don't set fontSize or lineHeight manually
- Use Radix style props (size, color, variant) instead of inline styles
- For code/monospace content, use the `Code` component
- Use TanStack DB's `useLiveQuery` for all data operations - no JS filtering/sorting
