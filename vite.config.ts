import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  copyFileSync,
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import type { Plugin } from 'vite'

const execFileAsync = promisify(execFile)
const rootDir = path.dirname(fileURLToPath(import.meta.url))
const libraryDir = path.join(rootDir, 'gmail-resume-attachments')
const restoredDeletedDir = path.join(rootDir, 'deleted-resume-downloads')
const indexPath = path.join(libraryDir, 'resume-index.json')
const reviewsPath = path.join(libraryDir, 'review-records.json')
const reviewBackupDir = path.join(libraryDir, 'review-backups')
const keyringPasswordPath = path.join(rootDir, '.gmail-oauth', 'gog-keyring-password')

type LibraryItem = {
  id: string
  filename: string
  displayName: string
  category: 'resume' | 'other'
  ext: string
  mimeType: string
  size: number
  path: string
  fileExists: boolean
  fileModifiedAt: string
  from: string
  subject: string
  date: string
  downloadedAt: string
  sourceKey?: string
  legacyKey?: string
  relativePath?: string
  messageId?: string
  threadId?: string
  attachmentId?: string
  localOnly?: boolean
  updatedAt?: string
  deletedAt?: string
  deletionReason?: string
  restoredAt?: string
  restoredFromDeleted?: boolean
}

type LibraryIndex = {
  version: 1
  generatedAt: string
  updatedAt: string
  outDir: string
  counts?: {
    total: number
    resume: number
    other: number
  }
  items: LibraryItem[]
}

const mimeByExt: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.rtf': 'application/rtf',
}
const supportedAttachmentExts = new Set(Object.keys(mimeByExt))

let syncInFlight: Promise<SyncResult> | null = null
let restoreInFlight: Promise<RestoreResult> | null = null

type SyncResult = {
  ok: true
  account: string
  stdout: string
  stderr: string
  library: LibraryIndex
  summary: {
    total: number
    resumes: number
    other: number
    downloaded: number
    alreadyDownloaded: number
    skipped: number
    messages: number
  }
}

type RestoreResult = {
  ok: true
  account: string
  stdout: string
  stderr: string
  library: LibraryIndex
  summary: {
    candidates: number
    restored: number
    alreadyAvailable: number
    skipped: number
    failed: number
  }
}

type ReviewRecord = {
  score: number | null
  note: string
  updatedAt: string
}

type RatingBand = 'priority' | 'review' | 'hold'
type BandOrders = Record<RatingBand, string[]>

type ReviewState = {
  version: 1
  updatedAt: string
  records: Record<string, ReviewRecord>
  bandOrders: BandOrders
}

function sendJson(res: ServerResponse, status: number, payload: unknown) {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(payload, null, 2))
}

function sendError(res: ServerResponse, status: number, message: string) {
  sendJson(res, status, { error: message })
}

function readRequestBody(req: IncomingMessage) {
  return new Promise<string>((resolve, reject) => {
    let body = ''
    req.setEncoding('utf8')
    req.on('data', (chunk) => {
      body += chunk
      if (body.length > 1024 * 1024) reject(new Error('Request body is too large.'))
    })
    req.on('end', () => resolve(body))
    req.on('error', reject)
  })
}

function stableId(value: string) {
  return createHash('sha1').update(value).digest('hex').slice(0, 16)
}

function displayName(filename: string) {
  return path.basename(filename, path.extname(filename)) || '未命名附件'
}

function classifyAttachment(filename: string): 'resume' | 'other' {
  const lower = filename.toLowerCase()
  const otherPatterns = [
    /作品|作品集|项目|项目介绍|报告|方案|案例|portfolio/i,
    /offer|入职|指南|协议|证明|证书|成绩单|推荐信/i,
  ]
  return otherPatterns.some((pattern) => pattern.test(lower)) ? 'other' : 'resume'
}

function emptyBandOrders(): BandOrders {
  return { priority: [], review: [], hold: [] }
}

function emptyReviewState(): ReviewState {
  return { version: 1, updatedAt: '', records: {}, bandOrders: emptyBandOrders() }
}

function cleanOrder(values: unknown) {
  if (!Array.isArray(values)) return []
  return [...new Set(values.filter((value): value is string => typeof value === 'string' && value.length > 0))]
}

function coerceBandOrders(value: unknown): BandOrders {
  if (!value || typeof value !== 'object') return emptyBandOrders()
  const candidate = value as Partial<BandOrders>
  return {
    priority: cleanOrder(candidate.priority),
    review: cleanOrder(candidate.review),
    hold: cleanOrder(candidate.hold),
  }
}

function coerceReviewState(value: unknown): ReviewState {
  if (!value || typeof value !== 'object') return emptyReviewState()
  const candidate = value as Partial<ReviewState>
  if (!candidate.records || typeof candidate.records !== 'object') return emptyReviewState()

  const records: Record<string, ReviewRecord> = {}
  for (const [id, record] of Object.entries(candidate.records)) {
    if (!record || typeof record !== 'object') continue
    const maybeRecord = record as Partial<ReviewRecord>
    const score =
      typeof maybeRecord.score === 'number' && Number.isFinite(maybeRecord.score)
        ? Math.max(0, Math.min(100, Math.round(maybeRecord.score)))
        : null
    records[id] = {
      score,
      note: typeof maybeRecord.note === 'string' ? maybeRecord.note : '',
      updatedAt: typeof maybeRecord.updatedAt === 'string' ? maybeRecord.updatedAt : '',
    }
  }

  return {
    version: 1,
    updatedAt: typeof candidate.updatedAt === 'string' ? candidate.updatedAt : '',
    records,
    bandOrders: coerceBandOrders(candidate.bandOrders),
  }
}

function readReviewState() {
  if (!existsSync(reviewsPath)) return emptyReviewState()
  return coerceReviewState(JSON.parse(readFileSync(reviewsPath, 'utf8')))
}

function reviewRecordTime(record: ReviewRecord) {
  return Date.parse(record.updatedAt) || 0
}

function backupReviewState() {
  if (!existsSync(reviewsPath)) return
  mkdirSync(reviewBackupDir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  copyFileSync(reviewsPath, path.join(reviewBackupDir, `review-records-${stamp}.json`))

  const backups = readdirSync(reviewBackupDir)
    .filter((name) => name.startsWith('review-records-') && name.endsWith('.json'))
    .sort()
  for (const name of backups.slice(0, Math.max(0, backups.length - 30))) {
    rmSync(path.join(reviewBackupDir, name), { force: true })
  }
}

function writeReviewState(nextState: unknown) {
  const now = new Date().toISOString()
  const incoming = coerceReviewState(nextState)
  const current = readReviewState()
  const records = { ...current.records }

  for (const [id, record] of Object.entries(incoming.records)) {
    const existing = records[id]
    if (!existing || reviewRecordTime(record) >= reviewRecordTime(existing)) {
      records[id] = record
    }
  }

  const payload: ReviewState = {
    version: 1,
    updatedAt: now,
    records,
    bandOrders: incoming.bandOrders,
  }
  mkdirSync(libraryDir, { recursive: true })
  backupReviewState()
  writeFileSync(reviewsPath, `${JSON.stringify(payload, null, 2)}\n`)
  return payload
}

function localAttachmentFiles(dir = libraryDir) {
  if (!existsSync(dir)) return []
  const files: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue
    const entryPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...localAttachmentFiles(entryPath))
      continue
    }
    if (!entry.isFile()) continue
    if (
      entry.name === 'resume-index.json' ||
      entry.name === 'download-log.json' ||
      entry.name === 'review-records.json'
    ) continue
    if (!supportedAttachmentExts.has(path.extname(entry.name).toLowerCase())) continue
    files.push(entryPath)
  }
  return files
}

function syncLocalFilesIntoIndex(index: LibraryIndex) {
  const now = new Date().toISOString()
  const byPath = new Map(
    index.items.filter((item) => item.path).map((item) => [path.resolve(item.path), item]),
  )
  const byRelativePath = new Map(
    index.items
      .filter((item) => item.relativePath)
      .map((item) => [item.relativePath as string, item]),
  )
  let changed = false

  for (const filePath of localAttachmentFiles()) {
    const resolvedPath = path.resolve(filePath)
    const relativePath = path.relative(libraryDir, resolvedPath)
    const filename = path.basename(filePath)
    const stat = statSync(filePath)
    const ext = path.extname(filename).toLowerCase()
    const existing = byPath.get(resolvedPath) || byRelativePath.get(relativePath)

    if (existing) {
      if (
        !existing.fileExists ||
        existing.size !== stat.size ||
        existing.fileModifiedAt !== stat.mtime.toISOString() ||
        existing.path !== resolvedPath ||
        existing.relativePath !== relativePath
      ) {
        existing.path = resolvedPath
        existing.relativePath = relativePath
        existing.fileExists = true
        existing.fileModifiedAt = stat.mtime.toISOString()
        existing.size = stat.size
        existing.updatedAt = now
        changed = true
      }
      continue
    }

    const item: LibraryItem = {
      id: stableId(`local:${relativePath}`),
      filename,
      displayName: displayName(filename),
      category: classifyAttachment(filename),
      ext,
      mimeType: mimeByExt[ext] || '',
      size: stat.size,
      path: resolvedPath,
      relativePath,
      fileExists: true,
      fileModifiedAt: stat.mtime.toISOString(),
      from: '本地文件夹',
      subject: '手动放入本地附件目录',
      date: stat.mtime.toISOString(),
      downloadedAt: stat.mtime.toISOString(),
      updatedAt: now,
      localOnly: true,
    }
    index.items.push(item)
    byPath.set(resolvedPath, item)
    byRelativePath.set(relativePath, item)
    changed = true
  }

  return changed
}

function readLibraryIndex({ includeDeleted = false } = {}): LibraryIndex {
  let parsed: LibraryIndex
  if (!existsSync(indexPath)) {
    parsed = {
      version: 1,
      generatedAt: '',
      updatedAt: '',
      outDir: libraryDir,
      counts: { total: 0, resume: 0, other: 0 },
      items: [],
    }
  } else {
    parsed = JSON.parse(readFileSync(indexPath, 'utf8')) as LibraryIndex
  }

  const items: LibraryItem[] = (parsed.items || []).map((item) => {
    const fileExists = existsSync(item.path)
    const fileStat = fileExists ? statSync(item.path) : null
    const category: 'resume' | 'other' = item.category === 'other' ? 'other' : 'resume'
    return {
      ...item,
      category,
      fileExists,
      fileModifiedAt: fileStat?.mtime.toISOString() || item.fileModifiedAt || '',
      size: fileStat?.size || item.size || 0,
    }
  })
  const indexWithFreshFiles = {
    ...parsed,
    outDir: libraryDir,
    items,
  }
  if (syncLocalFilesIntoIndex(indexWithFreshFiles)) {
    parsed = writeLibraryIndex(indexWithFreshFiles)
  } else {
    parsed = indexWithFreshFiles
  }
  const activeItems = parsed.items.filter((item) => !item.deletedAt)
  const returnedItems = includeDeleted ? parsed.items : activeItems
  const counts = activeItems.reduce(
    (acc, item) => {
      acc.total += 1
      if (item.category === 'other') acc.other += 1
      else acc.resume += 1
      return acc
    },
    { total: 0, resume: 0, other: 0 },
  )

  return {
    ...parsed,
    outDir: libraryDir,
    counts,
    items: returnedItems,
  }
}

function itemById(id: string) {
  return readLibraryIndex({ includeDeleted: true }).items.find((item) => item.id === id)
}

function writeLibraryIndex(index: LibraryIndex) {
  const now = new Date().toISOString()
  const visibleItems = index.items.filter((item) => !item.deletedAt)
  const counts = visibleItems.reduce(
    (acc, item) => {
      acc.total += 1
      if (item.category === 'other') acc.other += 1
      else acc.resume += 1
      return acc
    },
    { total: 0, resume: 0, other: 0 },
  )

  const payload = {
    ...index,
    updatedAt: now,
    counts,
    items: [...index.items].sort((a, b) => {
      if (a.deletedAt && !b.deletedAt) return 1
      if (!a.deletedAt && b.deletedAt) return -1
      const aDate = Date.parse(a.date || a.downloadedAt || '') || 0
      const bDate = Date.parse(b.date || b.downloadedAt || '') || 0
      if (aDate !== bDate) return bDate - aDate
      return a.filename.localeCompare(b.filename, 'zh-CN')
    }),
  }
  writeFileSync(indexPath, `${JSON.stringify(payload, null, 2)}\n`)
  return payload
}

function deleteLibraryItem(id: string) {
  const index = readLibraryIndex({ includeDeleted: true })
  const item = index.items.find((candidate) => candidate.id === id)
  if (!item) throw new Error('没有找到要删除的文件。')
  if (item.deletedAt) {
    return {
      item,
      library: readLibraryIndex({ includeDeleted: true }),
      alreadyDeleted: true,
    }
  }

  const now = new Date().toISOString()
  if (item.path && existsSync(item.path)) {
    const stat = statSync(item.path)
    item.fileExists = true
    item.fileModifiedAt = stat.mtime.toISOString()
    item.size = stat.size
  } else {
    item.fileExists = false
    item.fileModifiedAt = ''
  }
  item.deletedAt = now
  item.deletionReason = 'web'
  item.updatedAt = now
  writeLibraryIndex(index)

  return {
    item,
    library: readLibraryIndex({ includeDeleted: true }),
    alreadyDeleted: false,
  }
}

function gogEnv() {
  const env = { ...process.env }
  if (existsSync(keyringPasswordPath)) {
    env.GOG_KEYRING_PASSWORD = readFileSync(keyringPasswordPath, 'utf8').trim()
  }
  return env
}

async function detectAccount(explicitAccount?: string) {
  if (explicitAccount) return explicitAccount
  if (process.env.GOG_ACCOUNT) return process.env.GOG_ACCOUNT

  const { stdout } = await execFileAsync('gog', ['auth', 'list', '--json'], {
    cwd: rootDir,
    env: gogEnv(),
    maxBuffer: 1024 * 1024 * 10,
  })
  const parsed = JSON.parse(stdout) as {
    accounts?: Array<{ email?: string; services?: string[] }>
  }
  const account = parsed.accounts?.find((item) => item.services?.includes('gmail'))?.email
  if (!account) throw new Error('没有找到已授权的 Gmail 账号，请先完成 gog auth 登录。')
  return account
}

async function runSync(account: string, all: boolean) {
  const args = [
    path.join(rootDir, 'scripts', 'download-gmail-resume-attachments.mjs'),
    '--account',
    account,
  ]
  if (all) args.push('--all')

  const { stdout, stderr } = await execFileAsync('node', args, {
    cwd: rootDir,
    env: gogEnv(),
    maxBuffer: 1024 * 1024 * 80,
    timeout: 0,
  })
  const library = readLibraryIndex({ includeDeleted: true })
  const activeItems = library.items.filter((item) => !item.deletedAt)
  const logPath = path.join(libraryDir, 'download-log.json')
  const log = existsSync(logPath)
    ? JSON.parse(readFileSync(logPath, 'utf8')) as {
        downloaded?: unknown[]
        alreadyDownloaded?: unknown[]
        skipped?: unknown[]
      messages?: unknown[]
    }
    : {}
  const activeResumes = activeItems.filter((item) => item.category === 'resume')
  const activeOther = activeItems.filter((item) => item.category === 'other')

  return {
    ok: true as const,
    account,
    stdout,
    stderr,
    library,
    summary: {
      total: library.counts?.total || activeItems.length,
      resumes: library.counts?.resume || activeResumes.length,
      other: library.counts?.other || activeOther.length,
      downloaded: log.downloaded?.length || 0,
      alreadyDownloaded: log.alreadyDownloaded?.length || 0,
      skipped: log.skipped?.length || 0,
      messages: log.messages?.length || 0,
    },
  }
}

async function runRestoreDeleted(account: string) {
  const args = [
    path.join(rootDir, 'scripts', 'restore-deleted-resumes.mjs'),
    '--account',
    account,
    '--out-dir',
    restoredDeletedDir,
    '--index',
    indexPath,
  ]

  const { stdout, stderr } = await execFileAsync('node', args, {
    cwd: rootDir,
    env: gogEnv(),
    maxBuffer: 1024 * 1024 * 80,
    timeout: 0,
  })
  const library = readLibraryIndex({ includeDeleted: true })
  const logPath = path.join(restoredDeletedDir, 'restore-log.json')
  const log = existsSync(logPath)
    ? JSON.parse(readFileSync(logPath, 'utf8')) as {
        restored?: unknown[]
        alreadyAvailable?: unknown[]
        skipped?: unknown[]
        failed?: unknown[]
      }
    : {}
  const deletedResumes = library.items.filter((item) => item.deletedAt && item.category !== 'other')

  return {
    ok: true as const,
    account,
    stdout,
    stderr,
    library,
    summary: {
      candidates: deletedResumes.length,
      restored: log.restored?.length || 0,
      alreadyAvailable: log.alreadyAvailable?.length || 0,
      skipped: log.skipped?.length || 0,
      failed: log.failed?.length || 0,
    },
  }
}

function localResumeApi(): Plugin {
  return {
    name: 'local-resume-api',
    configureServer(server) {
      server.middlewares.use('/api/library', (req, res) => {
        if (req.method !== 'GET') {
          sendError(res, 405, 'Method not allowed.')
          return
        }
        const url = new URL(req.url || '/', 'http://resume.local')
        sendJson(res, 200, readLibraryIndex({ includeDeleted: url.searchParams.get('includeDeleted') === '1' }))
      })

      server.middlewares.use('/api/reviews', async (req, res) => {
        if (req.method === 'GET') {
          sendJson(res, 200, readReviewState())
          return
        }

        if (req.method === 'PUT') {
          try {
            const rawBody = await readRequestBody(req)
            const body = rawBody ? JSON.parse(rawBody) as unknown : {}
            sendJson(res, 200, writeReviewState(body))
          } catch (error) {
            sendError(res, 500, error instanceof Error ? error.message : 'Save reviews failed.')
          }
          return
        }

        sendError(res, 405, 'Method not allowed.')
      })

      server.middlewares.use('/api/file', (req, res) => {
        if (req.method !== 'GET') {
          sendError(res, 405, 'Method not allowed.')
          return
        }

        const url = new URL(req.url || '/', 'http://resume.local')
        const id = decodeURIComponent(url.pathname.replace(/^\/+/, ''))
        const item = itemById(id)
        if (!item || !item.fileExists || !existsSync(item.path)) {
          sendError(res, 404, 'File not found.')
          return
        }

        const download = url.searchParams.get('download') === '1'
        const ext = path.extname(item.path).toLowerCase()
        res.statusCode = 200
        res.setHeader('Content-Type', mimeByExt[ext] || item.mimeType || 'application/octet-stream')
        res.setHeader(
          'Content-Disposition',
          `${download ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(item.filename)}`,
        )
        createReadStream(item.path).pipe(res)
      })

      server.middlewares.use('/api/item', (req, res) => {
        if (req.method !== 'DELETE') {
          sendError(res, 405, 'Method not allowed.')
          return
        }

        try {
          const url = new URL(req.url || '/', 'http://resume.local')
          const id = decodeURIComponent(url.pathname.replace(/^\/+/, ''))
          if (!id) {
            sendError(res, 400, 'Missing item id.')
            return
          }
          const result = deleteLibraryItem(id)
          sendJson(res, 200, {
            ok: true,
            deleted: !result.alreadyDeleted,
            item: {
              id: result.item.id,
              filename: result.item.filename,
              displayName: result.item.displayName,
            },
            library: result.library,
          })
        } catch (error) {
          sendError(res, 500, error instanceof Error ? error.message : 'Delete failed.')
        }
      })

      server.middlewares.use('/api/sync', async (req, res) => {
        if (req.method !== 'POST') {
          sendError(res, 405, 'Method not allowed.')
          return
        }

        if (syncInFlight) {
          sendJson(res, 202, { status: 'running', message: 'Gmail 同步正在进行中。' })
          return
        }

        try {
          const rawBody = await readRequestBody(req)
          const body = rawBody ? JSON.parse(rawBody) as { account?: string; all?: boolean } : {}
          const account = await detectAccount(body.account)
          syncInFlight = runSync(account, body.all !== false)
          const result = await syncInFlight
          sendJson(res, 200, result)
        } catch (error) {
          sendError(res, 500, error instanceof Error ? error.message : 'Gmail sync failed.')
        } finally {
          syncInFlight = null
        }
      })

      server.middlewares.use('/api/restore-deleted', async (req, res) => {
        if (req.method !== 'POST') {
          sendError(res, 405, 'Method not allowed.')
          return
        }

        if (restoreInFlight) {
          sendJson(res, 202, { status: 'running', message: '已删除简历正在重新下载中。' })
          return
        }

        try {
          const rawBody = await readRequestBody(req)
          const body = rawBody ? JSON.parse(rawBody) as { account?: string } : {}
          const account = await detectAccount(body.account)
          restoreInFlight = runRestoreDeleted(account)
          const result = await restoreInFlight
          sendJson(res, 200, result)
        } catch (error) {
          sendError(res, 500, error instanceof Error ? error.message : 'Restore deleted resumes failed.')
        } finally {
          restoreInFlight = null
        }
      })
    },
  }
}

export default defineConfig({
  plugins: [localResumeApi(), react()],
})
