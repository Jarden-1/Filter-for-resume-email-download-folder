#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

const DEFAULT_INDEX = path.resolve('gmail-resume-attachments', 'resume-index.json');
const DEFAULT_OUT_DIR = path.resolve('deleted-resume-downloads');
const LOG_FILENAME = 'restore-log.json';
const RETRYABLE_STATUS = new Set([7, 8]);
const MAX_GOG_ATTEMPTS = 4;

function parseArgs(argv) {
  const args = {
    account: process.env.GOG_ACCOUNT || '',
    indexPath: DEFAULT_INDEX,
    outDir: DEFAULT_OUT_DIR,
    dryRun: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      i += 1;
      if (i >= argv.length) throw new Error(`Missing value for ${arg}`);
      return argv[i];
    };

    if (arg === '--account' || arg === '-a') args.account = next();
    else if (arg === '--index') args.indexPath = path.resolve(next());
    else if (arg === '--out-dir' || arg === '-o') args.outDir = path.resolve(next());
    else if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!args.account) {
    throw new Error('Missing --account. You can also set GOG_ACCOUNT.');
  }
  return args;
}

function printHelp() {
  console.log(`Usage:
  node scripts/restore-deleted-resumes.mjs --account you@gmail.com [options]

Options:
  -o, --out-dir <dir>     Output folder. Default: deleted-resume-downloads
      --index <file>      Resume index path. Default: gmail-resume-attachments/resume-index.json
      --dry-run           Print what would be restored without downloading.

Safety:
  Restores only items marked deleted in the local index, and only resume-category attachments.
`);
}

function runGog(args) {
  const fullArgs = [
    '--gmail-no-send',
    '--enable-commands-exact=gmail.attachment',
    ...args,
  ];

  let lastError = '';
  for (let attempt = 1; attempt <= MAX_GOG_ATTEMPTS; attempt += 1) {
    const result = spawnSync('gog', fullArgs, {
      encoding: 'utf8',
      maxBuffer: 1024 * 1024 * 50,
    });

    if (result.status === 0) return result.stdout;

    lastError = (result.stderr || result.stdout || `gog exited with ${result.status}`).trim();
    const retryable =
      RETRYABLE_STATUS.has(result.status) || /timeout|temporarily|try again/i.test(lastError);
    if (!retryable || attempt === MAX_GOG_ATTEMPTS) break;

    console.error(`gog failed temporarily; retrying ${attempt + 1}/${MAX_GOG_ATTEMPTS}...`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500 * attempt);
  }

  throw new Error(lastError);
}

function safeName(name) {
  return String(name || 'attachment.pdf')
    .replace(/[/:\\?%*"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180) || 'attachment.pdf';
}

function fileMeta(filePath) {
  if (!filePath || !existsSync(filePath)) return { exists: false, size: 0, modifiedAt: '' };
  const stat = statSync(filePath);
  return {
    exists: true,
    size: stat.size,
    modifiedAt: stat.mtime.toISOString(),
  };
}

function isInsideDir(filePath, dir) {
  const relative = path.relative(path.resolve(dir), path.resolve(filePath));
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function uniquePath(dir, filename, occupied) {
  const parsed = path.parse(safeName(filename));
  const basename = parsed.name || 'attachment';
  const ext = parsed.ext || '.pdf';
  let candidate = path.join(dir, `${basename}${ext}`);
  let n = 2;
  while (existsSync(candidate) || occupied.has(path.resolve(candidate))) {
    candidate = path.join(dir, `${basename} (${n})${ext}`);
    n += 1;
  }
  occupied.add(path.resolve(candidate));
  return candidate;
}

function readIndex(indexPath) {
  if (!existsSync(indexPath)) throw new Error(`Index not found: ${indexPath}`);
  return JSON.parse(readFileSync(indexPath, 'utf8'));
}

function saveIndex(indexPath, index) {
  const activeItems = index.items.filter((item) => !item.deletedAt);
  const counts = activeItems.reduce(
    (acc, item) => {
      acc.total += 1;
      acc[item.category === 'other' ? 'other' : 'resume'] += 1;
      return acc;
    },
    { total: 0, resume: 0, other: 0 },
  );
  const payload = {
    ...index,
    updatedAt: new Date().toISOString(),
    counts,
    items: [...index.items].sort((a, b) => {
      if (a.deletedAt && !b.deletedAt) return 1;
      if (!a.deletedAt && b.deletedAt) return -1;
      const aDate = Date.parse(a.date || a.downloadedAt || '') || 0;
      const bDate = Date.parse(b.date || b.downloadedAt || '') || 0;
      if (aDate !== bDate) return bDate - aDate;
      return String(a.filename || '').localeCompare(String(b.filename || ''), 'zh-CN');
    }),
  };
  writeFileSync(indexPath, `${JSON.stringify(payload, null, 2)}\n`);
  return payload;
}

function updateRestoredItem(item, targetPath, indexBaseDir, startedAt) {
  const meta = fileMeta(targetPath);
  item.path = targetPath;
  item.relativePath = path.relative(indexBaseDir, targetPath);
  item.fileExists = meta.exists;
  item.fileModifiedAt = meta.modifiedAt;
  item.size = meta.size || item.size || 0;
  item.restoredAt = startedAt;
  item.restoredFromDeleted = true;
  item.updatedAt = startedAt;
  return meta;
}

function downloadAttachment({ account, messageId, attachmentId, out }) {
  runGog([
    '--account',
    account,
    'gmail',
    'attachment',
    messageId,
    attachmentId,
    `--out=${out}`,
  ]);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  mkdirSync(args.outDir, { recursive: true });

  const startedAt = new Date().toISOString();
  const index = readIndex(args.indexPath);
  const indexBaseDir = index.outDir || path.dirname(args.indexPath);
  const occupied = new Set(
    index.items
      .map((item) => item.path)
      .filter((filePath) => filePath && isInsideDir(filePath, args.outDir))
      .map((filePath) => path.resolve(filePath)),
  );
  const log = {
    generatedAt: startedAt,
    account: args.account,
    indexPath: args.indexPath,
    outDir: args.outDir,
    dryRun: args.dryRun,
    restored: [],
    alreadyAvailable: [],
    skipped: [],
    failed: [],
  };

  const candidates = index.items.filter((item) => item.deletedAt && item.category !== 'other');
  for (const item of candidates) {
    const record = {
      id: item.id,
      filename: item.filename,
      displayName: item.displayName,
      messageId: item.messageId,
      attachmentId: item.attachmentId,
    };

    if (!item.messageId || !item.attachmentId) {
      log.skipped.push({ ...record, reason: 'missing messageId or attachmentId' });
      continue;
    }

    const currentMeta = fileMeta(item.path);
    if (currentMeta.exists && isInsideDir(item.path, args.outDir)) {
      updateRestoredItem(item, item.path, indexBaseDir, startedAt);
      log.alreadyAvailable.push({ ...record, path: item.path });
      console.log(`already available\t${item.filename}\t${item.path}`);
      continue;
    }

    const targetPath = uniquePath(args.outDir, item.filename, occupied);
    try {
      if (!args.dryRun) {
        downloadAttachment({
          account: args.account,
          messageId: item.messageId,
          attachmentId: item.attachmentId,
          out: targetPath,
        });
      }

      if (args.dryRun) {
        log.restored.push({ ...record, path: targetPath, dryRun: true });
        console.log(`would restore\t${item.filename}\t${targetPath}`);
        continue;
      }

      const meta = updateRestoredItem(item, targetPath, indexBaseDir, startedAt);
      if (!meta.exists) throw new Error('download command completed but file was not created');

      log.restored.push({ ...record, path: targetPath, size: meta.size });
      console.log(`restored\t${item.filename}\t${targetPath}`);
    } catch (error) {
      log.failed.push({
        ...record,
        path: targetPath,
        error: error instanceof Error ? error.message : String(error),
      });
      console.error(`failed\t${item.filename}\t${error instanceof Error ? error.message : error}`);
    }
  }

  const savedIndex = args.dryRun ? index : saveIndex(args.indexPath, index);
  const logPath = path.join(args.outDir, LOG_FILENAME);
  writeFileSync(logPath, `${JSON.stringify(log, null, 2)}\n`);

  const summary = {
    candidates: candidates.length,
    restored: log.restored.length,
    alreadyAvailable: log.alreadyAvailable.length,
    skipped: log.skipped.length,
    failed: log.failed.length,
    outDir: args.outDir,
  };
  console.log(`\nDone. ${JSON.stringify(summary)} Log: ${logPath}`);

  if (log.failed.length > 0) process.exitCode = 1;
}

main();
