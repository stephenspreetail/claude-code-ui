#!/usr/bin/env node
// Hook script for Stop events (Claude's turn ended)
// Writes turn-ended signal to ~/.claude/session-signals/<session_id>.stop.json
// Also clears any pending permission for this session

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
      // Add stopped_at timestamp
      const stopData = {
        ...data,
        stopped_at: Date.now().toString()
      };

      // Write stop signal
      const stopFile = path.join(SIGNALS_DIR, `${sessionId}.stop.json`);
      fs.writeFileSync(stopFile, JSON.stringify(stopData));

      // Clear working and permission signals since turn ended
      const workingFile = path.join(SIGNALS_DIR, `${sessionId}.working.json`);
      if (fs.existsSync(workingFile)) {
        fs.unlinkSync(workingFile);
      }

      const permissionFile = path.join(SIGNALS_DIR, `${sessionId}.permission.json`);
      if (fs.existsSync(permissionFile)) {
        fs.unlinkSync(permissionFile);
      }
    }
  } catch (error) {
    // Silently fail - hooks shouldn't interrupt Claude Code
  }
});
