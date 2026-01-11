#!/usr/bin/env node
// Setup script for claude-code-ui daemon hooks
// Installs hooks for accurate session state detection:
// - UserPromptSubmit: detect when user starts a turn (working)
// - PermissionRequest: detect when waiting for user approval
// - Stop: detect when Claude finishes responding (waiting)
// - SessionEnd: detect when session closes (idle)

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import os from 'os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SETTINGS_FILE = path.join(os.homedir(), '.claude', 'settings.json');
const SIGNALS_DIR = path.join(os.homedir(), '.claude', 'session-signals');
const HOOKS_DIR = path.join(__dirname, 'hooks');

console.log('Setting up claude-code-ui hooks...');

// Create signals directory
try {
  fs.mkdirSync(SIGNALS_DIR, { recursive: true });
  console.log(`Created ${SIGNALS_DIR}`);
} catch (error) {
  console.error(`Error creating signals directory: ${error.message}`);
  process.exit(1);
}

// Ensure hooks directory exists
if (!fs.existsSync(HOOKS_DIR)) {
  fs.mkdirSync(HOOKS_DIR, { recursive: true });
}

// Check if settings.json exists
const settingsDir = path.dirname(SETTINGS_FILE);
if (!fs.existsSync(settingsDir)) {
  fs.mkdirSync(settingsDir, { recursive: true });
}

if (!fs.existsSync(SETTINGS_FILE)) {
  console.log('Creating new settings.json...');
  fs.writeFileSync(SETTINGS_FILE, '{}');
}

// Backup settings
const backupFile = `${SETTINGS_FILE}.backup`;
try {
  fs.copyFileSync(SETTINGS_FILE, backupFile);
  console.log(`Backed up settings to ${backupFile}`);
} catch (error) {
  console.error(`Warning: Could not create backup: ${error.message}`);
}

// Read existing settings
let settings;
try {
  const settingsContent = fs.readFileSync(SETTINGS_FILE, 'utf8');
  settings = JSON.parse(settingsContent || '{}');
} catch (error) {
  console.error(`Error reading settings.json: ${error.message}`);
  settings = {};
}

// Build the hooks configuration
// Use .js extension for Node.js scripts (cross-platform)
const USER_PROMPT_HOOK = path.join(HOOKS_DIR, 'user-prompt-submit.js');
const PERMISSION_HOOK = path.join(HOOKS_DIR, 'permission-request.js');
const STOP_HOOK = path.join(HOOKS_DIR, 'stop.js');
const SESSION_END_HOOK = path.join(HOOKS_DIR, 'session-end.js');

// Initialize hooks object if it doesn't exist
if (!settings.hooks) {
  settings.hooks = {};
}

// Add all hooks
settings.hooks.UserPromptSubmit = [{
  matcher: "",
  hooks: [{
    type: "command",
    command: `node "${USER_PROMPT_HOOK}"`
  }]
}];

settings.hooks.PermissionRequest = [{
  matcher: "",
  hooks: [{
    type: "command",
    command: `node "${PERMISSION_HOOK}"`
  }]
}];

settings.hooks.Stop = [{
  matcher: "",
  hooks: [{
    type: "command",
    command: `node "${STOP_HOOK}"`
  }]
}];

settings.hooks.SessionEnd = [{
  matcher: "",
  hooks: [{
    type: "command",
    command: `node "${SESSION_END_HOOK}"`
  }]
}];

// Write updated settings
try {
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
  console.log(`\nAdded hooks to ${SETTINGS_FILE}:`);
  console.log('  - UserPromptSubmit (detect turn started → working)');
  console.log('  - PermissionRequest (detect approval needed)');
  console.log('  - Stop (detect turn ended → waiting)');
  console.log('  - SessionEnd (detect session closed → idle)');
  console.log('\nSetup complete! The daemon will now accurately track session states.');
  console.log('\nNote: You may need to restart any running Claude Code sessions for hooks to take effect.');
} catch (error) {
  console.error(`Error writing settings.json: ${error.message}`);
  process.exit(1);
}
