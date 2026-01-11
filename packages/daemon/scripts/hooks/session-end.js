#!/usr/bin/env node
// Hook script for SessionEnd events (session closed)
// Writes session-ended signal to ~/.claude/session-signals/<session_id>.ended.json
// Also cleans up all signals for this session

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
      // Add ended_at timestamp
      const endedData = {
        ...data,
        ended_at: Date.now().toString()
      };

      // Write session-ended signal
      const endedFile = path.join(SIGNALS_DIR, `${sessionId}.ended.json`);
      fs.writeFileSync(endedFile, JSON.stringify(endedData));

      // Clean up other signals for this session
      const permissionFile = path.join(SIGNALS_DIR, `${sessionId}.permission.json`);
      if (fs.existsSync(permissionFile)) {
        fs.unlinkSync(permissionFile);
      }

      const stopFile = path.join(SIGNALS_DIR, `${sessionId}.stop.json`);
      if (fs.existsSync(stopFile)) {
        fs.unlinkSync(stopFile);
      }
    }
  } catch (error) {
    // Silently fail - hooks shouldn't interrupt Claude Code
  }
});
