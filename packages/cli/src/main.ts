#!/usr/bin/env node
/**
 * `pc` — agent-first research workflow CLI.
 *
 * This is the entry point. It wires up the Commander.js command tree
 * and dispatches to command modules in commands/.
 */

import { registerDashboardCommand } from './commands/dashboard.js';
import { Command } from 'commander';
import { registerConfigCommand } from './commands/config.js';
import { registerRebuildCommand } from './commands/rebuild.js';
import { registerProjectCommand } from './commands/project.js';
import { registerRepoCommand } from './commands/repo.js';
import {
  registerSearchCommand,
  registerListCommand,
  registerGetCommand,
} from './commands/search.js';
import { registerS2Command } from './commands/s2/index.js';
import { registerExportCommand } from './commands/export.js';
import { registerImportCommand } from './commands/import.js';
import { registerDedupeCommand } from './commands/dedupe.js';
import { registerOpenCommand } from './commands/open.js';
import { registerCheckCommand } from './commands/check.js';
import { registerNewCommand, registerDiffCommand } from './commands/new.js';
import { registerWorkflowCommands } from './commands/workflow.js';

const VERSION = '0.1.0';

const program = new Command()
  .name('pc')
  .description('Agent-first research workflow CLI')
  .version(VERSION);

// Global flag: --human for human-readable output (default is JSON for agents)
program.option('--human', 'Use human-readable output instead of JSON', false);

// Helper to read the human flag from the root program
const opts = {
  human: () => program.opts()['human'] as boolean,
};

// Register commands
registerConfigCommand(program, opts);
registerRebuildCommand(program, opts);
registerProjectCommand(program, opts);
registerRepoCommand(program, opts);
registerSearchCommand(program, opts);
registerListCommand(program, opts);
registerGetCommand(program, opts);
registerS2Command(program, opts);
registerExportCommand(program, opts);
registerImportCommand(program, opts);
registerDedupeCommand(program, opts);
registerOpenCommand(program, opts);
registerCheckCommand(program, opts);
registerNewCommand(program, opts);
registerDiffCommand(program, opts);
registerWorkflowCommands(program, opts);

registerDashboardCommand(program);

// Parse and execute
program.parseAsync(process.argv).catch((err: Error) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
