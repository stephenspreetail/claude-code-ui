#!/usr/bin/env node
// Hook script for UserPromptSubmit events (user sends message)
// Writes working signal to ~/.claude/session-signals/<session_id>.working.json
// This definitively marks the session as "working" when user starts a turn

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
      // Add working_since timestamp
      const workingData = {
        ...data,
        working_since: Date.now().toString()
      };

      // Write working signal
      const workingFile = path.join(SIGNALS_DIR, `${sessionId}.working.json`);
      fs.writeFileSync(workingFile, JSON.stringify(workingData));

      // Clear stop signal since new turn is starting
      const stopFile = path.join(SIGNALS_DIR, `${sessionId}.stop.json`);
      if (fs.existsSync(stopFile)) {
        fs.unlinkSync(stopFile);
      }
    }
  } catch (error) {
    // Silently fail - hooks shouldn't interrupt Claude Code
  }
});
