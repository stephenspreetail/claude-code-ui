#!/usr/bin/env node
// Hook script for PermissionRequest events
// Writes pending permission info to ~/.claude/session-signals/<session_id>.permission.json
// This allows the daemon to detect when Claude Code is waiting for user approval

import fs from 'fs';
import path from 'path';
import os from 'os';

const SIGNALS_DIR = path.join(os.homedir(), '.claude', 'session-signals');

// Ensure signals directory exists
fs.mkdirSync(SIGNALS_DIR, { recursive: true });

// Read JSON from stdin
let input = '';
process.stdin.setEncoding('utf8');

process.stdin.on('data', chunk => {
  input += chunk;
});

process.stdin.on('end', () => {
  try {
    const data = JSON.parse(input);
    const sessionId = data.session_id;

    if (sessionId) {
      // Add pending_since timestamp
      const permissionData = {
        ...data,
        pending_since: Date.now().toString()
      };

      // Write pending permission signal
      const permissionFile = path.join(SIGNALS_DIR, `${sessionId}.permission.json`);
      fs.writeFileSync(permissionFile, JSON.stringify(permissionData));
    }
  } catch (error) {
    // Silently fail - hooks shouldn't interrupt Claude Code
  }
});
