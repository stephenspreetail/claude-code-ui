# Claude Code Session Tracker

A real-time dashboard for monitoring Claude Code sessions across multiple projects. See what Claude is working on, which sessions need approval, and track PR/CI status.

## Features

- **Real-time updates** via Durable Streams
- **Kanban board** showing sessions by status (Working, Needs Approval, Waiting, Idle)
- **AI-powered summaries** of session activity using Claude Sonnet
- **PR & CI tracking** - see associated PRs and their CI status
- **Multi-repo support** - sessions grouped by GitHub repository

## Architecture

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│  Claude Code    │     │     Daemon      │     │       UI        │
│   Sessions      │────▶│   (Watcher)     │────▶│   (React)       │
│  ~/.claude/     │     │                 │     │                 │
│   projects/     │     │  Durable Stream │     │  TanStack DB    │
└─────────────────┘     └─────────────────┘     └─────────────────┘
```

### Daemon (`packages/daemon`)

Watches `~/.claude/projects/` for session log changes and:
- Parses JSONL log files incrementally
- Derives session status using XState state machine
- Generates AI summaries via Claude Sonnet API
- Detects git branches and polls for PR/CI status
- Publishes state updates to Durable Streams

### UI (`packages/ui`)

React app using TanStack Router and Radix UI:
- Subscribes to Durable Streams for real-time updates
- Groups sessions by GitHub repository
- Shows session cards with goal, summary, branch/PR info
- Hover cards with recent output preview

## Session Status State Machine

The daemon uses an XState state machine to determine session status:

```
                    ┌─────────────────┐
                    │      idle       │
                    └────────┬────────┘
                             │ USER_PROMPT
                             ▼
┌─────────────────┐  TOOL_RESULT  ┌─────────────────┐
│ waiting_for_    │◄──────────────│     working     │
│   approval      │               └────────┬────────┘
└────────┬────────┘                        │
         │                    ┌────────────┼────────────┐
         │                    │            │            │
         │              TURN_END    ASSISTANT_   STALE_
         │                    │      TOOL_USE   TIMEOUT
         │                    ▼            │            │
         │            ┌─────────────────┐  │            │
         │            │ waiting_for_   │◄─┘            │
         └───────────▶│     input      │◄──────────────┘
           IDLE_      └─────────────────┘
          TIMEOUT
```

### States

| State | Description | UI Column |
|-------|-------------|-----------|
| `idle` | No activity for 5+ minutes | Idle |
| `working` | Claude is actively processing | Working |
| `waiting_for_approval` | Tool use needs user approval | Needs Approval |
| `waiting_for_input` | Claude finished, waiting for user | Waiting |

### Events (from log entries)

| Event | Source | Description |
|-------|--------|-------------|
| `USER_PROMPT` | User entry with string content | User sent a message |
| `TOOL_RESULT` | User entry with tool_result array | User approved/ran tool |
| `ASSISTANT_STREAMING` | Assistant entry (no tool_use) | Claude is outputting |
| `ASSISTANT_TOOL_USE` | Assistant entry with tool_use | Claude requested a tool |
| `TURN_END` | System entry (turn_duration/stop_hook_summary) | Turn completed |

### Timeout Fallbacks

For older Claude Code versions or sessions without hooks:
- **5 seconds**: If tool_use pending → `waiting_for_approval`
- **60 seconds**: If no turn-end marker → `waiting_for_input`
- **5 minutes**: No activity → `idle`

## Development

```bash
# Install dependencies
pnpm install

# Start both daemon and UI
pnpm start

# Or run separately:
pnpm serve  # Start daemon on port 4450
pnpm dev    # Start UI dev server
```

## Environment Variables

The daemon needs an Anthropic API key for AI summaries:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
```

## Dependencies

- **@durable-streams/*** - Real-time state synchronization
- **@tanstack/db** - Reactive database for UI
- **xstate** - State machine for status detection
- **chokidar** - File system watching
- **@radix-ui/themes** - UI components
