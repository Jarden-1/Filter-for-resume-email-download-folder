#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

const DEFAULT_QUERY = [
  'has:attachment',
  '(filename:pdf OR filename:doc OR filename:docx OR filename:xls OR filename:xlsx OR filename:rtf)',
].join(' ');

const DEFAULT_EXTENSIONS = new Set(['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.rtf']);
const INDEX_FILENAME = 'resume-index.json';
const LOG_FILENAME = 'download-log.json';
const RETRYABLE_STATUS = new Set([7, 8]);
const MAX_GOG_ATTEMPTS = 4;

function parseArgs(argv) {
  const args = {
    account: process.env.GOG_ACCOUNT || '',
    query: DEFAULT_QUERY,
    outDir: path.resolve('gmail-resume-attachments'),
    max: 100,
    all: false,
    extensions: DEFAULT_EXTENSIONS,
    dryRun: false,
    forceRedownload: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      i += 1;
      if (i >= argv.length) throw new Error(`Missing value for ${arg}`);
      return argv[i];
    };

    if (arg === '--account' || arg === '-a') args.account = next();
    else if (arg === '--query' || arg === '-q') args.query = next();
    else if (arg === '--out-dir' || arg === '-o') args.outDir = path.resolve(next());
    else if (arg === '--max') args.max = Number.parseInt(next(), 10);
    else if (arg === '--all') args.all = true;
    else if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--force-redownload') args.forceRedownload = true;
    else if (arg === '--extensions') {
      args.extensions = new Set(
        next()
          .split(',')
          .map((ext) => ext.trim().toLowerCase())
          .filter(Boolean)
          .map((ext) => (ext.startsWith('.') ? ext : `.${ext}`)),
      );
    } else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!args.account) {
    throw new Error('Missing --account. You can also set GOG_ACCOUNT.');
  }
  if (!Number.isFinite(args.max) || args.max <= 0) {
    throw new Error('--max must be a positive number.');
  }
  return args;
}

function printHelp() {
  console.log(`Usage:
  node scripts/download-gmail-resume-attachments.mjs --account you@gmail.com [options]

Options:
  -q, --query <query>           Gmail query. Defaults to resume/CV/简历 attachments.
  -o, --out-dir <dir>           Output directory. Default: gmail-resume-attachments
      --max <n>                 Max search results per page. Default: 100
      --all                     Fetch all search result pages.
      --extensions <list>       Comma-separated file extensions to keep.
      --force-redownload        Download again even when an indexed file exists.
      --dry-run                 Print matching attachments without downloading.

Safety:
  Only uses gog gmail messages search/raw/attachment with --gmail-no-send.
`);
}

function runGog(args, { json = true } = {}) {
  const fullArgs = [
    '--gmail-no-send',
    '--enable-commands-exact=gmail.messages.search,gmail.raw,gmail.attachment',
    ...args,
  ];
  if (json) fullArgs.push('--json');

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

function parseJson(stdout) {
  try {
    return JSON.parse(stdout);
  } catch (error) {
    throw new Error(`Could not parse gog JSON output: ${error.message}\n${stdout.slice(0, 1000)}`);
  }
}

function resultList(parsed) {
  if (Array.isArray(parsed)) return parsed;
  for (const key of ['messages', 'threads', 'results', 'items']) {
    if (Array.isArray(parsed?.[key])) return parsed[key];
  }
  if (Array.isArray(parsed?.result)) return parsed.result;
  return [];
}

function nextPageToken(parsed) {
  return parsed?.nextPageToken || parsed?.next_page_token || parsed?.pageToken || '';
}

function headerValue(headers = [], name) {
  const found = headers.find((header) => header?.name?.toLowerCase() === name.toLowerCase());
  return found?.value || '';
}

function walkParts(part, found = []) {
  if (!part) return found;
  const filename = part.filename || '';
  const attachmentId = part.body?.attachmentId || '';
  if (filename && attachmentId) {
    found.push({
      filename,
      attachmentId,
      mimeType: part.mimeType || '',
      size: part.body?.size || 0,
    });
  }
  for (const child of part.parts || []) walkParts(child, found);
  return found;
}

function safeName(name) {
  return name
    .replace(/[/:\\?%*"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180);
}

function displayName(filename) {
  return safeName(filename).replace(/\.[^.]+$/i, '') || '未命名附件';
}

function stableId(value) {
  return createHash('sha1').update(value).digest('hex').slice(0, 16);
}

function legacyKey(messageId, filename, size) {
  return `${messageId}:${filename}:${size}`;
}

function sourceKey(messageId, attachmentId) {
  return `${messageId}:${attachmentId}`;
}

function uniquePath(dir, filename) {
  const parsed = path.parse(safeName(filename) || 'attachment');
  let candidate = path.join(dir, `${parsed.name}${parsed.ext}`);
  let n = 2;
  while (existsSync(candidate)) {
    candidate = path.join(dir, `${parsed.name} (${n})${parsed.ext}`);
    n += 1;
  }
  return candidate;
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

function classifyAttachment(filename) {
  const lower = filename.toLowerCase();
  const otherPatterns = [
    /作品|作品集|项目|项目介绍|报告|方案|案例|portfolio/i,
    /offer|入职|指南|协议|证明|证书|成绩单|推荐信/i,
  ];
  if (otherPatterns.some((pattern) => pattern.test(lower))) return 'other';
  return 'resume';
}

function emptyIndex(outDir) {
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    outDir,
    items: [],
  };
}

function readJsonFile(filePath) {
  if (!existsSync(filePath)) return null;
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

function migrateLogToIndex(outDir) {
  const log = readJsonFile(path.join(outDir, LOG_FILENAME));
  const index = emptyIndex(outDir);
  if (!log?.downloaded || !Array.isArray(log.downloaded)) return index;

  index.generatedAt = log.generatedAt || index.generatedAt;
  for (const item of log.downloaded) {
    const messageId = item.id || item.messageId || '';
    const filename = item.filename || path.basename(item.path || 'attachment');
    const size = Number(item.size || fileMeta(item.path).size || 0);
    if (!messageId || !filename) continue;

    const itemLegacyKey = legacyKey(messageId, filename, size);
    const meta = fileMeta(item.path);
    index.items.push({
      id: stableId(itemLegacyKey),
      sourceKey: '',
      legacyKey: itemLegacyKey,
      category: classifyAttachment(filename),
      filename,
      displayName: displayName(filename),
      ext: path.extname(filename).toLowerCase(),
      mimeType: item.mimeType || '',
      size: size || meta.size,
      path: item.path || '',
      relativePath: item.path ? path.relative(outDir, item.path) : '',
      fileExists: meta.exists,
      fileModifiedAt: meta.modifiedAt,
      messageId,
      threadId: item.threadId || '',
      attachmentId: '',
      from: item.from || '',
      subject: item.subject || '',
      date: item.date || '',
      downloadedAt: log.generatedAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  }
  return index;
}

function loadIndex(outDir) {
  const indexPath = path.join(outDir, INDEX_FILENAME);
  const existing = readJsonFile(indexPath);
  if (!existing?.items || !Array.isArray(existing.items)) {
    return migrateLogToIndex(outDir);
  }

  return {
    ...emptyIndex(outDir),
    ...existing,
    outDir,
    items: existing.items.map((item) => {
      const meta = fileMeta(item.path);
      return {
        ...item,
        category: item.category === 'other' ? 'other' : 'resume',
        displayName: item.displayName || displayName(item.filename || 'attachment'),
        ext: item.ext || path.extname(item.filename || '').toLowerCase(),
        fileExists: meta.exists,
        fileModifiedAt: meta.modifiedAt || item.fileModifiedAt || '',
        updatedAt: item.updatedAt || existing.updatedAt || new Date().toISOString(),
      };
    }),
  };
}

function saveIndex(outDir, index) {
  const visibleItems = index.items.filter((item) => !item.deletedAt);
  const counts = visibleItems.reduce(
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
    items: index.items.sort((a, b) => {
      if (a.deletedAt && !b.deletedAt) return 1;
      if (!a.deletedAt && b.deletedAt) return -1;
      const aDate = Date.parse(a.date || a.downloadedAt || '') || 0;
      const bDate = Date.parse(b.date || b.downloadedAt || '') || 0;
      if (aDate !== bDate) return bDate - aDate;
      return a.filename.localeCompare(b.filename, 'zh-CN');
    }),
  };
  writeFileSync(path.join(outDir, INDEX_FILENAME), `${JSON.stringify(payload, null, 2)}\n`);
  return payload;
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

function upsertMaps(index) {
  const bySourceKey = new Map();
  const byLegacyKey = new Map();
  for (const item of index.items) {
    if (item.sourceKey) bySourceKey.set(item.sourceKey, item);
    if (item.legacyKey) byLegacyKey.set(item.legacyKey, item);
  }
  return { bySourceKey, byLegacyKey };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  mkdirSync(args.outDir, { recursive: true });

  const startedAt = new Date().toISOString();
  const index = loadIndex(args.outDir);
  const seenMessageIds = new Set();
  const log = {
    generatedAt: startedAt,
    account: args.account,
    query: args.query,
    outDir: args.outDir,
    dryRun: args.dryRun,
    messages: [],
    downloaded: [],
    alreadyDownloaded: [],
    skipped: [],
  };

  let page = '';
  do {
    const searchArgs = [
      '--account',
      args.account,
      'gmail',
      'messages',
      'search',
      args.query,
      `--max=${args.max}`,
    ];
    if (page) searchArgs.push(`--page=${page}`);
    const search = parseJson(runGog(searchArgs));
    const messages = resultList(search);

    for (const message of messages) {
      const messageId = message.id || message.messageId;
      if (!messageId || seenMessageIds.has(messageId)) continue;
      seenMessageIds.add(messageId);

      const raw = parseJson(runGog([
        '--account',
        args.account,
        'gmail',
        'raw',
        messageId,
        '--format=full',
      ]));
      const gmailMessage = raw.message || raw;
      const headers = gmailMessage.payload?.headers || [];
      const entry = {
        id: gmailMessage.id || messageId,
        threadId: gmailMessage.threadId || message.threadId || '',
        from: headerValue(headers, 'From'),
        subject: headerValue(headers, 'Subject'),
        date: headerValue(headers, 'Date'),
      };
      log.messages.push(entry);

      for (const attachment of walkParts(gmailMessage.payload)) {
        const ext = path.extname(attachment.filename).toLowerCase();
        const itemLegacyKey = legacyKey(messageId, attachment.filename, attachment.size);
        const itemSourceKey = sourceKey(messageId, attachment.attachmentId);
        const record = {
          ...entry,
          filename: attachment.filename,
          mimeType: attachment.mimeType,
          size: attachment.size,
          attachmentId: attachment.attachmentId,
          sourceKey: itemSourceKey,
          legacyKey: itemLegacyKey,
          category: classifyAttachment(attachment.filename),
        };

        if (!args.extensions.has(ext)) {
          log.skipped.push({ ...record, reason: `extension ${ext || '(none)'} not allowed` });
          continue;
        }

        const { bySourceKey, byLegacyKey } = upsertMaps(index);
        const existing = bySourceKey.get(itemSourceKey) || byLegacyKey.get(itemLegacyKey);
        const existingFile = existing ? fileMeta(existing.path) : { exists: false };
        if (existing?.deletedAt && !args.forceRedownload) {
          existing.sourceKey = existing.sourceKey || itemSourceKey;
          existing.attachmentId = existing.attachmentId || attachment.attachmentId;
          existing.fileExists = false;
          existing.fileModifiedAt = '';
          existing.updatedAt = startedAt;
          log.alreadyDownloaded.push({
            ...record,
            path: existing.path,
            deletedAt: existing.deletedAt,
            skippedBecauseDeleted: true,
          });
          console.log(`deleted locally\t${attachment.filename}\t${existing.path}`);
          continue;
        }
        if (existing && existingFile.exists && !args.forceRedownload) {
          existing.sourceKey = existing.sourceKey || itemSourceKey;
          existing.attachmentId = existing.attachmentId || attachment.attachmentId;
          existing.category = classifyAttachment(attachment.filename);
          existing.fileExists = true;
          existing.fileModifiedAt = existingFile.modifiedAt;
          existing.updatedAt = startedAt;
          log.alreadyDownloaded.push({ ...record, path: existing.path });
          console.log(`already have\t${attachment.filename}\t${existing.path}`);
          continue;
        }

        const out = uniquePath(args.outDir, attachment.filename);
        if (!args.dryRun) {
          downloadAttachment({
            account: args.account,
            messageId,
            attachmentId: attachment.attachmentId,
            out,
          });
        }

        const meta = fileMeta(out);
        const indexed = {
          id: stableId(itemLegacyKey),
          sourceKey: itemSourceKey,
          legacyKey: itemLegacyKey,
          category: classifyAttachment(attachment.filename),
          filename: attachment.filename,
          displayName: displayName(attachment.filename),
          ext,
          mimeType: attachment.mimeType,
          size: attachment.size || meta.size,
          path: out,
          relativePath: path.relative(args.outDir, out),
          fileExists: meta.exists,
          fileModifiedAt: meta.modifiedAt,
          messageId,
          threadId: entry.threadId,
          attachmentId: attachment.attachmentId,
          from: entry.from,
          subject: entry.subject,
          date: entry.date,
          downloadedAt: startedAt,
          updatedAt: startedAt,
        };

        const existingIndex = index.items.findIndex((item) => item.id === indexed.id);
        if (existingIndex >= 0) index.items[existingIndex] = indexed;
        else index.items.push(indexed);

        log.downloaded.push({ ...record, path: out, dryRun: args.dryRun });
        console.log(`${args.dryRun ? 'would download' : 'downloaded'}\t${attachment.filename}\t${out}`);
      }
    }

    page = args.all ? nextPageToken(search) : '';
  } while (page);

  const savedIndex = args.dryRun ? index : saveIndex(args.outDir, index);
  const logPath = path.join(args.outDir, LOG_FILENAME);
  writeFileSync(logPath, `${JSON.stringify(log, null, 2)}\n`);

  const visibleItems = savedIndex.items.filter((item) => !item.deletedAt);
  const summary = {
    messages: log.messages.length,
    downloaded: log.downloaded.length,
    alreadyDownloaded: log.alreadyDownloaded.length,
    skipped: log.skipped.length,
    indexed: visibleItems.length,
    resumes: visibleItems.filter((item) => item.category === 'resume').length,
    other: visibleItems.filter((item) => item.category === 'other').length,
  };
  console.log(`\nDone. ${JSON.stringify(summary)} Log: ${logPath}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
