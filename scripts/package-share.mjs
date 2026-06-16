#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const outDir = path.join(root, 'share');
const stamp = new Date().toISOString().slice(0, 10);
const includeData = process.argv.includes('--include-data');
const showHelp = process.argv.includes('--help') || process.argv.includes('-h');

if (showHelp) {
  console.log(`Usage:
  node scripts/package-share.mjs
  node scripts/package-share.mjs --include-data

By default, the share package excludes OAuth files, downloaded resumes, restored deleted resumes, review records, and build artifacts.
Use --include-data only when you intentionally want to share the local resume library and review records.`);
  process.exit(0);
}

const zipName = includeData
  ? `resume-screening-tool-with-data-${stamp}.zip`
  : `resume-screening-tool-${stamp}.zip`;
const zipPath = path.join(outDir, zipName);

mkdirSync(outDir, { recursive: true });
if (existsSync(zipPath)) {
  rmSync(zipPath);
}

const args = [
  '-r',
  zipPath,
  '.',
  '-x',
  'node_modules/*',
  'dist/*',
  'share/*',
  '.gmail-oauth/*',
  '.git/*',
  '.DS_Store',
  '*/.DS_Store',
];

if (!includeData) {
  args.push(
    'gmail-resume-attachments/*',
    'deleted-resume-downloads/*',
  );
}

const result = spawnSync('zip', args, {
  cwd: root,
  stdio: 'inherit',
});

if (result.status !== 0) {
  process.exit(result.status || 1);
}

console.log(`\nCreated: ${zipPath}`);
