import { watch, type FSWatcher } from "chokidar";
import { EventEmitter } from "node:events";
import { readFile, unlink, readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  tailJSONL,
  extractMetadata,
  extractSessionId,
  extractEncodedDir,
} from "./parser.js";
import { deriveStatus, statusChanged } from "./status.js";
import { getGitInfoCached, type GitInfo } from "./git.js";
import type { LogEntry, SessionMetadata, StatusResult } from "./types.js";
import { log } from "./log.js";

const CLAUDE_PROJECTS_DIR = `${process.env.HOME}/.claude/projects`;
const PENDING_PERMISSIONS_DIR = `${process.env.HOME}/.claude/pending-permissions`;

export interface PendingPermission {
  session_id: string;
  tool_name: string;
  tool_input?: Record<string, unknown>;
  pending_since: string;
}

export interface SessionState {
  sessionId: string;
  filepath: string;
  encodedDir: string;
  cwd: string;
  gitBranch: string | null;
  originalPrompt: string;
  startedAt: string;
  status: StatusResult;
  entries: LogEntry[];
  bytePosition: number;
  // GitHub repo info
  gitRepoUrl: string | null;   // https://github.com/owner/repo
  gitRepoId: string | null;    // owner/repo (for grouping)
  // Set when branch changed since last update
  branchChanged?: boolean;
  // Pending permission from PermissionRequest hook
  pendingPermission?: PendingPermission;
}

export interface SessionEvent {
  type: "created" | "updated" | "deleted";
  session: SessionState;
  previousStatus?: StatusResult;
}

export class SessionWatcher extends EventEmitter {
  private watcher: FSWatcher | null = null;
  private permissionWatcher: FSWatcher | null = null;
  private sessions = new Map<string, SessionState>();
  private pendingPermissions = new Map<string, PendingPermission>();
  private debounceTimers = new Map<string, NodeJS.Timeout>();
  private debounceMs: number;
  private staleCheckInterval: NodeJS.Timeout | null = null;

  constructor(options: { debounceMs?: number } = {}) {
    super();
    this.debounceMs = options.debounceMs ?? 200;
  }

  /**
   * Check if a session has a pending permission request.
   */
  hasPendingPermission(sessionId: string): boolean {
    return this.pendingPermissions.has(sessionId);
  }

  /**
   * Get pending permission for a session.
   */
  getPendingPermission(sessionId: string): PendingPermission | undefined {
    return this.pendingPermissions.get(sessionId);
  }

  async start(): Promise<void> {
    // Use directory watching instead of glob - chokidar has issues with
    // directories that start with dashes when using glob patterns
    this.watcher = watch(CLAUDE_PROJECTS_DIR, {
      ignored: /agent-.*\.jsonl$/,  // Ignore agent sub-session files
      persistent: true,
      ignoreInitial: false,
      depth: 2,
    });

    this.watcher
      .on("add", (path) => {
        if (!path.endsWith(".jsonl")) return;
        log("Watcher", `New file detected: ${path.split("/").slice(-2).join("/")}`);
        this.handleFile(path, "add");
      })
      .on("change", (path) => {
        if (!path.endsWith(".jsonl")) return;
        this.debouncedHandleFile(path);
      })
      .on("unlink", (path) => this.handleDelete(path))
      .on("error", (error) => this.emit("error", error));

    // Watch pending permissions directory for PermissionRequest hook output
    this.permissionWatcher = watch(PENDING_PERMISSIONS_DIR, {
      persistent: true,
      ignoreInitial: false,
      depth: 0,
    });

    this.permissionWatcher
      .on("add", (path) => {
        if (!path.endsWith(".json")) return;
        this.handlePendingPermission(path);
      })
      .on("change", (path) => {
        if (!path.endsWith(".json")) return;
        this.handlePendingPermission(path);
      })
      .on("unlink", (path) => {
        if (!path.endsWith(".json")) return;
        this.handlePendingPermissionRemoved(path);
      })
      .on("error", () => {
        // Ignore errors - directory may not exist if hook isn't set up
      });

    // Wait for initial scan to complete
    await new Promise<void>((resolve) => {
      this.watcher!.on("ready", resolve);
    });

    // Load any existing pending permissions
    await this.loadExistingPendingPermissions();

    // Start periodic stale check to detect sessions that have gone idle
    // This catches cases where the turn ends but no turn_duration event is written
    this.staleCheckInterval = setInterval(() => {
      this.checkStaleSessions();
    }, 10_000); // Check every 10 seconds
  }

  /**
   * Load any existing pending permission files on startup.
   */
  private async loadExistingPendingPermissions(): Promise<void> {
    try {
      const files = await readdir(PENDING_PERMISSIONS_DIR);
      for (const file of files) {
        if (file.endsWith(".json")) {
          await this.handlePendingPermission(join(PENDING_PERMISSIONS_DIR, file));
        }
      }
    } catch {
      // Directory doesn't exist or can't be read - that's fine
    }
  }

  /**
   * Handle a pending permission file being created/updated.
   */
  private async handlePendingPermission(filepath: string): Promise<void> {
    try {
      const content = await readFile(filepath, "utf-8");
      const permission = JSON.parse(content) as PendingPermission;
      const sessionId = permission.session_id;

      if (!sessionId) return;

      log("Watcher", `Pending permission for session ${sessionId}: ${permission.tool_name}`);

      // Store the pending permission
      this.pendingPermissions.set(sessionId, permission);

      // Update the session if it exists
      const session = this.sessions.get(sessionId);
      if (session) {
        const previousStatus = session.status;
        session.pendingPermission = permission;
        // Override status to show pending approval
        session.status = {
          ...session.status,
          status: "waiting",
          hasPendingToolUse: true,
        };

        this.emit("session", {
          type: "updated",
          session,
          previousStatus,
        } satisfies SessionEvent);
      }
    } catch {
      // Ignore parse errors
    }
  }

  /**
   * Handle a pending permission file being removed.
   */
  private handlePendingPermissionRemoved(filepath: string): void {
    // Extract session ID from filename (e.g., abc123.json -> abc123)
    const filename = filepath.split("/").pop() || "";
    const sessionId = filename.replace(".json", "");

    if (!sessionId) return;

    log("Watcher", `Pending permission cleared for session ${sessionId}`);

    // Clear the pending permission
    this.pendingPermissions.delete(sessionId);

    // Update the session if it exists
    const session = this.sessions.get(sessionId);
    if (session && session.pendingPermission) {
      const previousStatus = session.status;
      session.pendingPermission = undefined;
      // Re-derive status from entries
      session.status = deriveStatus(session.entries);

      this.emit("session", {
        type: "updated",
        session,
        previousStatus,
      } satisfies SessionEvent);
    }
  }

  stop(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }

    if (this.permissionWatcher) {
      this.permissionWatcher.close();
      this.permissionWatcher = null;
    }

    // Clear stale check interval
    if (this.staleCheckInterval) {
      clearInterval(this.staleCheckInterval);
      this.staleCheckInterval = null;
    }

    // Clear all debounce timers
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
  }

  /**
   * Clear a pending permission when tool completes (called when tool_result is seen).
   */
  async clearPendingPermission(sessionId: string): Promise<void> {
    if (!this.pendingPermissions.has(sessionId)) return;

    this.pendingPermissions.delete(sessionId);

    // Try to delete the file
    try {
      await unlink(join(PENDING_PERMISSIONS_DIR, `${sessionId}.json`));
    } catch {
      // File may already be deleted
    }
  }

  getSessions(): Map<string, SessionState> {
    return this.sessions;
  }

  /**
   * Periodically check for sessions that have gone stale.
   * This catches cases where Claude finishes responding but no turn_duration
   * event is written to the log file.
   */
  private checkStaleSessions(): void {
    for (const session of this.sessions.values()) {
      // Only check sessions that are currently "working"
      if (session.status.status !== "working") {
        continue;
      }

      // Re-derive status which will apply STALE_TIMEOUT
      const newStatus = deriveStatus(session.entries);

      // If status changed, emit update
      if (statusChanged(session.status, newStatus)) {
        const previousStatus = session.status;
        session.status = newStatus;

        this.emit("session", {
          type: "updated",
          session,
          previousStatus,
        } satisfies SessionEvent);
      }
    }
  }

  private debouncedHandleFile(filepath: string): void {
    // Clear existing timer for this file
    const existing = this.debounceTimers.get(filepath);
    if (existing) {
      clearTimeout(existing);
    }

    // Set new timer
    const timer = setTimeout(() => {
      this.debounceTimers.delete(filepath);
      this.handleFile(filepath, "change");
    }, this.debounceMs);

    this.debounceTimers.set(filepath, timer);
  }

  private async handleFile(
    filepath: string,
    eventType: "add" | "change"
  ): Promise<void> {
    try {
      const sessionId = extractSessionId(filepath);
      const existingSession = this.sessions.get(sessionId);

      // Determine starting byte position
      const fromByte = existingSession?.bytePosition ?? 0;

      // Read new entries
      const { entries: newEntries, newPosition } = await tailJSONL(
        filepath,
        fromByte
      );

      if (newEntries.length === 0 && existingSession) {
        // No new data
        return;
      }

      // Combine with existing entries or start fresh
      const allEntries = existingSession
        ? [...existingSession.entries, ...newEntries]
        : newEntries;

      // Extract metadata (only needed for new sessions)
      let metadata: SessionMetadata | null;
      let gitInfo: GitInfo;

      if (existingSession) {
        metadata = {
          sessionId: existingSession.sessionId,
          cwd: existingSession.cwd,
          gitBranch: existingSession.gitBranch,
          originalPrompt: existingSession.originalPrompt,
          startedAt: existingSession.startedAt,
        };
        // Reuse cached git info
        gitInfo = {
          repoUrl: existingSession.gitRepoUrl,
          repoId: existingSession.gitRepoId,
          branch: existingSession.gitBranch,
          isGitRepo: existingSession.gitRepoUrl !== null || existingSession.gitBranch !== null,
        };
      } else {
        metadata = extractMetadata(allEntries);
        if (!metadata) {
          // Not enough data yet
          return;
        }
        // Look up git info for new sessions
        gitInfo = await getGitInfoCached(metadata.cwd);
      }

      // Always refresh branch for existing sessions (branch may have changed)
      let branchChanged = false;
      if (existingSession) {
        const currentBranch = await getGitInfoCached(metadata.cwd);
        if (currentBranch.branch !== existingSession.gitBranch) {
          gitInfo = currentBranch;
          branchChanged = true;
          log("Watcher", `Branch changed for ${sessionId}: ${existingSession.gitBranch} → ${currentBranch.branch}`);
        }
      }

      // Check if any new entry is a tool_result - if so, clear pending permission
      const hasToolResult = newEntries.some((entry) => {
        if (entry.type === "user") {
          const content = (entry as { message: { content: unknown } }).message.content;
          if (Array.isArray(content)) {
            return content.some((block) => block.type === "tool_result");
          }
        }
        return false;
      });

      if (hasToolResult && this.pendingPermissions.has(sessionId)) {
        await this.clearPendingPermission(sessionId);
      }

      // Derive status from all entries
      let status = deriveStatus(allEntries);
      const previousStatus = existingSession?.status;

      // Check for pending permission from hook
      const pendingPermission = this.pendingPermissions.get(sessionId);
      if (pendingPermission) {
        // Override status to show pending approval
        status = {
          ...status,
          status: "waiting",
          hasPendingToolUse: true,
        };
      }

      // Build session state - prefer branch from git info over log entry
      const session: SessionState = {
        sessionId,
        filepath,
        encodedDir: extractEncodedDir(filepath),
        cwd: metadata.cwd,
        gitBranch: gitInfo.branch || metadata.gitBranch,
        originalPrompt: metadata.originalPrompt,
        startedAt: metadata.startedAt,
        status,
        entries: allEntries,
        bytePosition: newPosition,
        gitRepoUrl: gitInfo.repoUrl,
        gitRepoId: gitInfo.repoId,
        branchChanged,
        pendingPermission,
      };

      // Store session
      this.sessions.set(sessionId, session);

      // Emit event
      const isNew = !existingSession;
      const hasStatusChange = statusChanged(previousStatus, status);
      const hasNewMessages = existingSession && status.messageCount > existingSession.status.messageCount;

      if (isNew) {
        this.emit("session", {
          type: "created",
          session,
        } satisfies SessionEvent);
      } else if (hasStatusChange || hasNewMessages || branchChanged) {
        this.emit("session", {
          type: "updated",
          session,
          previousStatus,
        } satisfies SessionEvent);
      }
    } catch (error) {
      // Ignore ENOENT errors - file may have been deleted
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return;
      }
      this.emit("error", error);
    }
  }

  private handleDelete(filepath: string): void {
    const sessionId = extractSessionId(filepath);
    const session = this.sessions.get(sessionId);

    if (session) {
      this.sessions.delete(sessionId);
      this.emit("session", {
        type: "deleted",
        session,
      } satisfies SessionEvent);
    }
  }
}
