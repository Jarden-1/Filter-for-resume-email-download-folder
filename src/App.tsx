import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertCircle,
  Archive,
  ArrowDown,
  ArrowUp,
  CheckCircle2,
  Clock3,
  Download,
  ExternalLink,
  FileQuestion,
  FileText,
  Inbox,
  Mail,
  RefreshCcw,
  Search,
  Star,
  Trash2,
} from 'lucide-react'
import './App.css'

type Category = 'resume' | 'other'
type RatingBand = 'priority' | 'review' | 'hold'
type ViewMode = 'resumes' | 'other' | 'deleted'
type RatedFilter = 'all' | 'rated' | 'unrated'
type NoteFilter = 'all' | 'noted' | 'empty'
type SortMode = 'manual' | 'date' | 'name' | 'score' | 'size'
type BandOrders = Record<RatingBand, string[]>

type LibraryItem = {
  id: string
  filename: string
  displayName: string
  category: Category
  ext: string
  mimeType: string
  size: number
  fileExists: boolean
  fileModifiedAt: string
  from: string
  subject: string
  date: string
  downloadedAt: string
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

type ReviewRecord = {
  score: number | null
  note: string
  updatedAt: string
}

type ReviewState = {
  version: 1
  updatedAt?: string
  records: Record<string, ReviewRecord>
  bandOrders: BandOrders
}

type Filters = {
  keyword: string
  band: 'all' | RatingBand
  rated: RatedFilter
  note: NoteFilter
  sort: SortMode
}

type SyncResponse =
  | {
      ok: true
      account: string
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
  | {
      status: 'running'
      message: string
    }
  | {
      error: string
    }

type DeleteResponse =
  | {
      ok: true
      deleted: boolean
      item: {
        id: string
        filename: string
        displayName: string
      }
      library: LibraryIndex
    }
  | {
      error: string
    }

type RestoreResponse =
  | {
      ok: true
      account: string
      library: LibraryIndex
      summary: {
        candidates: number
        restored: number
        alreadyAvailable: number
        skipped: number
        failed: number
      }
    }
  | {
      status: 'running'
      message: string
    }
  | {
      error: string
    }

const REVIEW_STORAGE_KEY = 'resume-screening-tool:reviews:v2'

const emptyLibrary: LibraryIndex = {
  version: 1,
  generatedAt: '',
  updatedAt: '',
  outDir: '',
  counts: { total: 0, resume: 0, other: 0 },
  items: [],
}

const initialFilters: Filters = {
  keyword: '',
  band: 'all',
  rated: 'all',
  note: 'all',
  sort: 'date',
}

const bandMeta: Record<
  RatingBand,
  { label: string; short: string; range: string; tone: string }
> = {
  priority: { label: '重点推进', short: '重点', range: '80-100', tone: 'priority' },
  review: { label: '继续观察', short: '观察', range: '60-79', tone: 'review' },
  hold: { label: '暂缓考虑', short: '暂缓', range: '0-59', tone: 'hold' },
}

const ratingBands = Object.keys(bandMeta) as RatingBand[]

const bandDefaultScore: Record<RatingBand, number> = {
  priority: 90,
  review: 70,
  hold: 50,
}

function getBand(score: number | null): RatingBand | null {
  if (score === null) return null
  if (score >= 80) return 'priority'
  if (score >= 60) return 'review'
  return 'hold'
}

function formatDate(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '未记录'
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date)
}

function formatBytes(value: number) {
  if (!Number.isFinite(value) || value <= 0) return '未知'
  const units = ['B', 'KB', 'MB', 'GB']
  let size = value
  let unit = 0
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024
    unit += 1
  }
  return `${size >= 10 || unit === 0 ? size.toFixed(0) : size.toFixed(1)} ${units[unit]}`
}

function normalizeScore(value: string) {
  if (value.trim() === '') return null
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return null
  return Math.max(0, Math.min(100, Math.round(numeric)))
}

function fileUrl(item: LibraryItem, download = false) {
  return `/api/file/${encodeURIComponent(item.id)}${download ? '?download=1' : ''}`
}

function emptyReview(): ReviewRecord {
  return { score: null, note: '', updatedAt: '' }
}

function emptyBandOrders(): BandOrders {
  return { priority: [], review: [], hold: [] }
}

function emptyReviewState(): ReviewState {
  return { version: 1, records: {}, bandOrders: emptyBandOrders() }
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
  if (!candidate.records || typeof candidate.records !== 'object') {
    return emptyReviewState()
  }

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
    updatedAt: typeof candidate.updatedAt === 'string' ? candidate.updatedAt : undefined,
    records,
    bandOrders: coerceBandOrders(candidate.bandOrders),
  }
}

function readSavedReviewState() {
  try {
    const saved = localStorage.getItem(REVIEW_STORAGE_KEY)
    return saved ? coerceReviewState(JSON.parse(saved)) : emptyReviewState()
  } catch {
    return emptyReviewState()
  }
}

function serializeReviewState(state: ReviewState) {
  return JSON.stringify({
    version: 1,
    records: state.records,
    bandOrders: state.bandOrders,
  })
}

function reviewRecordTime(record: ReviewRecord) {
  return Date.parse(record.updatedAt) || 0
}

function mergeReviewRecords(...sources: Array<Record<string, ReviewRecord>>) {
  const records: Record<string, ReviewRecord> = {}
  for (const source of sources) {
    for (const [id, record] of Object.entries(source)) {
      const existing = records[id]
      if (!existing || reviewRecordTime(record) >= reviewRecordTime(existing)) {
        records[id] = record
      }
    }
  }
  return records
}

function mergeBandOrders(serverOrders: BandOrders, localOrders: BandOrders) {
  const merged = emptyBandOrders()
  for (const band of ratingBands) {
    merged[band] = localOrders[band].length > 0 ? localOrders[band] : serverOrders[band]
  }
  return merged
}

function normalizeBandOrder(order: string[], validIds: string[]) {
  const valid = new Set(validIds)
  const cleaned = cleanOrder(order).filter((id) => valid.has(id))
  const existing = new Set(cleaned)
  return [...cleaned, ...validIds.filter((id) => !existing.has(id))]
}

function placeIdInBand(orders: BandOrders, id: string, band: RatingBand | null) {
  const next = emptyBandOrders()
  for (const key of ratingBands) {
    next[key] = cleanOrder(orders[key]).filter((existingId) => existingId !== id)
  }
  if (band) {
    const originalTargetOrder = cleanOrder(orders[band])
    next[band] = originalTargetOrder.includes(id) ? originalTargetOrder : [...next[band], id]
  }
  return next
}

function orderIndex(order: string[], id: string) {
  const index = order.indexOf(id)
  return index === -1 ? Number.MAX_SAFE_INTEGER : index
}

function mergeVisibleOrderIntoBandOrder(order: string[], validIds: string[], visibleOrder: string[]) {
  const visible = new Set(visibleOrder)
  const normalized = normalizeBandOrder(order, validIds)
  let visibleIndex = 0
  return normalized.map((id) => (visible.has(id) ? visibleOrder[visibleIndex++] : id))
}

function App() {
  const [library, setLibrary] = useState<LibraryIndex>(emptyLibrary)
  const [reviewState, setReviewState] = useState<ReviewState>(readSavedReviewState)
  const [view, setView] = useState<ViewMode>('resumes')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [filters, setFilters] = useState<Filters>(initialFilters)
  const [status, setStatus] = useState('正在读取本地简历库。')
  const [loading, setLoading] = useState(true)
  const [syncing, setSyncing] = useState(false)
  const [restoring, setRestoring] = useState(false)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [reviewsLoaded, setReviewsLoaded] = useState(false)
  const [reviewSaveState, setReviewSaveState] = useState<'loading' | 'saving' | 'saved' | 'error'>('loading')
  const [reviewSaveMessage, setReviewSaveMessage] = useState('正在读取评分记录。')
  const lastSavedReviewsRef = useRef('')
  const reviews = reviewState.records
  const bandOrders = reviewState.bandOrders

  const saveReviewState = useCallback(async (state: ReviewState) => {
    const serialized = serializeReviewState(state)
    try {
      const response = await fetch('/api/reviews', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: serialized,
      })
      if (!response.ok) throw new Error(await response.text())
      const saved = coerceReviewState(await response.json())
      lastSavedReviewsRef.current = serializeReviewState(saved)
      localStorage.setItem(REVIEW_STORAGE_KEY, lastSavedReviewsRef.current)
      setReviewSaveState('saved')
      setReviewSaveMessage(
        saved.updatedAt
          ? `评分和排序已保存到项目文件：${formatDate(saved.updatedAt)}`
          : '评分和排序已保存到项目文件。',
      )
    } catch (error) {
      setReviewSaveState('error')
      setReviewSaveMessage(error instanceof Error ? `评分保存失败：${error.message}` : '评分和排序保存失败。')
    }
  }, [])

  const loadReviews = useCallback(async (signal?: AbortSignal) => {
    setReviewSaveState('loading')
    setReviewSaveMessage('正在读取评分记录。')
    try {
      const response = await fetch('/api/reviews', { signal })
      if (!response.ok) throw new Error(await response.text())
      const serverState = coerceReviewState(await response.json())
      const localState = readSavedReviewState()
      const mergedState: ReviewState = {
        version: 1,
        updatedAt: serverState.updatedAt || localState.updatedAt,
        records: mergeReviewRecords(serverState.records, localState.records),
        bandOrders: mergeBandOrders(serverState.bandOrders, localState.bandOrders),
      }

      lastSavedReviewsRef.current = serializeReviewState(serverState)
      setReviewState(mergedState)
      setReviewsLoaded(true)

      if (serializeReviewState(mergedState) === lastSavedReviewsRef.current) {
        setReviewSaveState('saved')
        setReviewSaveMessage('评分和排序会自动保存到项目文件。')
      } else {
        setReviewSaveState('saving')
        setReviewSaveMessage('正在把浏览器里的旧评分和排序迁移到项目文件。')
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return
      setReviewsLoaded(true)
      setReviewSaveState('error')
      setReviewSaveMessage(error instanceof Error ? `评分读取失败：${error.message}` : '评分读取失败。')
    }
  }, [])

  useEffect(() => {
    localStorage.setItem(REVIEW_STORAGE_KEY, serializeReviewState(reviewState))

    if (!reviewsLoaded) return
    const serialized = serializeReviewState(reviewState)
    if (serialized === lastSavedReviewsRef.current) return

    setReviewSaveState('saving')
    const timeout = window.setTimeout(() => {
      void saveReviewState(reviewState)
    }, 450)
    return () => window.clearTimeout(timeout)
  }, [reviewState, reviewsLoaded, saveReviewState])

  const loadLibrary = async (quiet = false, signal?: AbortSignal) => {
    if (!quiet) setLoading(true)
    try {
      const response = await fetch('/api/library?includeDeleted=1', { signal })
      if (!response.ok) throw new Error(await response.text())
      const nextLibrary = (await response.json()) as LibraryIndex
      const deletedCount = nextLibrary.items.filter((item) => item.deletedAt).length
      setLibrary(nextLibrary)
      setStatus(
        `已载入 ${nextLibrary.counts?.resume ?? 0} 份简历，${nextLibrary.counts?.other ?? 0} 个其他附件，${deletedCount} 条已删除记录。`,
      )
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return
      setStatus(error instanceof Error ? error.message : '读取简历库失败。')
    } finally {
      if (!signal?.aborted) setLoading(false)
    }
  }

  useEffect(() => {
    const controller = new AbortController()
    window.setTimeout(() => {
      void loadLibrary(false, controller.signal)
    }, 0)
    return () => controller.abort()
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    window.setTimeout(() => {
      void loadReviews(controller.signal)
    }, 0)
    return () => controller.abort()
  }, [loadReviews])

  const counts = useMemo(() => {
    const activeItems = library.items.filter((item) => !item.deletedAt)
    const deletedItems = library.items.filter((item) => item.deletedAt)
    const resumeItems = activeItems.filter((item) => item.category === 'resume')
    const otherItems = activeItems.filter((item) => item.category === 'other')
    const rated = resumeItems.filter((item) => reviews[item.id]?.score !== null && reviews[item.id]?.score !== undefined)
    return {
      total: activeItems.length,
      resumes: resumeItems.length,
      other: otherItems.length,
      deleted: deletedItems.length,
      rated: rated.length,
      priority: resumeItems.filter((item) => getBand(reviews[item.id]?.score ?? null) === 'priority').length,
      review: resumeItems.filter((item) => getBand(reviews[item.id]?.score ?? null) === 'review').length,
      hold: resumeItems.filter((item) => getBand(reviews[item.id]?.score ?? null) === 'hold').length,
    }
  }, [library.items, reviews])

  const visibleItems = useMemo(() => {
    const category: Category | null =
      view === 'resumes' ? 'resume' : view === 'other' ? 'other' : null
    const keyword = filters.keyword.trim().toLowerCase()

    const filtered = library.items.filter((item) => {
      if (view === 'deleted') {
        if (!item.deletedAt) return false
      } else {
        if (item.deletedAt) return false
        if (item.category !== category) return false
      }
      const review = reviews[item.id] ?? emptyReview()
      const band = getBand(review.score)
      const hasScore = review.score !== null
      const hasNote = review.note.trim().length > 0
      const haystack = [
        item.displayName,
        item.filename,
        item.subject,
        item.from,
        item.ext,
        item.deletedAt ? formatDate(item.deletedAt) : '',
        review.note,
      ]
        .join(' ')
        .toLowerCase()

      if (keyword && !haystack.includes(keyword)) return false
      if (view !== 'deleted' && view === 'resumes' && filters.band !== 'all' && band !== filters.band) return false
      if (view !== 'deleted' && filters.rated === 'rated' && !hasScore) return false
      if (view !== 'deleted' && filters.rated === 'unrated' && hasScore) return false
      if (filters.note === 'noted' && !hasNote) return false
      if (filters.note === 'empty' && hasNote) return false
      return true
    })

    const manualOrder =
      filters.sort === 'manual' && view === 'resumes' && filters.band !== 'all'
        ? normalizeBandOrder(bandOrders[filters.band], filtered.map((item) => item.id))
        : []

    return [...filtered].sort((a, b) => {
      if (manualOrder.length > 0) {
        return manualOrder.indexOf(a.id) - manualOrder.indexOf(b.id)
      }
      if (filters.sort === 'name') {
        return a.displayName.localeCompare(b.displayName, 'zh-CN')
      }
      if (filters.sort === 'size') return b.size - a.size
      if (filters.sort === 'score') {
        const scoreDelta = (reviews[b.id]?.score ?? -1) - (reviews[a.id]?.score ?? -1)
        if (scoreDelta !== 0) return scoreDelta
        const aBand = getBand(reviews[a.id]?.score ?? null)
        const bBand = getBand(reviews[b.id]?.score ?? null)
        if (aBand && aBand === bBand) {
          const order = bandOrders[aBand]
          const orderDelta = orderIndex(order, a.id) - orderIndex(order, b.id)
          if (orderDelta !== 0) return orderDelta
        }
      }
      if (filters.sort === 'date' && view === 'deleted') {
        const aDeleted = Date.parse(a.deletedAt || '') || 0
        const bDeleted = Date.parse(b.deletedAt || '') || 0
        if (aDeleted !== bDeleted) return bDeleted - aDeleted
      }
      const aDate = Date.parse(a.date || a.downloadedAt || a.fileModifiedAt) || 0
      const bDate = Date.parse(b.date || b.downloadedAt || b.fileModifiedAt) || 0
      if (aDate !== bDate) return bDate - aDate
      return a.displayName.localeCompare(b.displayName, 'zh-CN')
    })
  }, [bandOrders, filters, library.items, reviews, view])

  const activeSelectedId = useMemo(() => {
    if (selectedId && library.items.some((item) => item.id === selectedId)) return selectedId
    return visibleItems[0]?.id ?? null
  }, [library.items, selectedId, visibleItems])

  const selectedItem = useMemo(
    () => library.items.find((item) => item.id === activeSelectedId) ?? null,
    [activeSelectedId, library.items],
  )

  const isBusy = loading || syncing || restoring || deletingId !== null
  const selectedReview = selectedItem ? (reviews[selectedItem.id] ?? emptyReview()) : emptyReview()
  const selectedBand = getBand(selectedReview.score)
  const canManualSort = view === 'resumes' && filters.band !== 'all'
  const canReorderVisibleItems = canManualSort && (filters.sort === 'manual' || filters.sort === 'score')

  const selectViewMode = (nextView: ViewMode) => {
    const nextBand = nextView === 'resumes' ? filters.band : 'all'
    setSelectedId((current) => current ?? activeSelectedId)
    setView(nextView)
    setFilters((current) => ({
      ...current,
      sort: nextView === 'resumes' || current.sort !== 'manual' ? current.sort : 'date',
      band: nextBand,
    }))
  }

  const selectResumeBandFilter = (band: Filters['band']) => {
    setSelectedId((current) => current ?? activeSelectedId)
    setView('resumes')
    setFilters((current) => ({
      ...current,
      band,
      sort: band === 'all' && current.sort === 'manual' ? 'date' : band === 'all' ? current.sort : 'manual',
    }))
  }

  const updateReview = (id: string, patch: Partial<ReviewRecord>) => {
    setReviewState((current) => {
      const updatedAt = new Date().toISOString()
      const nextRecord = {
        ...(current.records[id] ?? emptyReview()),
        ...patch,
        updatedAt,
      }
      return {
        ...current,
        updatedAt,
        records: {
          ...current.records,
          [id]: nextRecord,
        },
        bandOrders:
          'score' in patch
            ? placeIdInBand(current.bandOrders, id, getBand(nextRecord.score))
            : current.bandOrders,
      }
    })
  }

  const handleScoreChange = (id: string, value: string) => {
    updateReview(id, {
      score: normalizeScore(value.replace(/[^\d]/g, '').slice(0, 3)),
    })

    if (view === 'resumes' && filters.band !== 'all') {
      setFilters((current) => ({
        ...current,
        sort: 'score',
      }))
    }
  }

  const handleSelectBand = (band: RatingBand) => {
    if (!selectedItem || selectedItem.deletedAt) return
    const itemId = selectedItem.id
    setReviewState((current) => {
      const updatedAt = new Date().toISOString()
      const record = current.records[itemId] ?? emptyReview()
      const score = getBand(record.score) === band && record.score !== null ? record.score : bandDefaultScore[band]
      return {
        ...current,
        updatedAt,
        records: {
          ...current.records,
          [itemId]: {
            ...record,
            score,
            updatedAt,
          },
        },
        bandOrders: placeIdInBand(current.bandOrders, itemId, band),
      }
    })
    setSelectedId(itemId)
  }

  const moveVisibleItem = (itemId: string, direction: -1 | 1) => {
    if (!canReorderVisibleItems || filters.band === 'all') return
    const currentIndex = visibleItems.findIndex((item) => item.id === itemId)
    const target = visibleItems[currentIndex + direction]
    if (currentIndex === -1 || !target) return

    const band = filters.band
    const visibleOrder = visibleItems.map((item) => item.id)
    const reorderedVisibleOrder = [...visibleOrder]
    ;[reorderedVisibleOrder[currentIndex], reorderedVisibleOrder[currentIndex + direction]] = [
      reorderedVisibleOrder[currentIndex + direction],
      reorderedVisibleOrder[currentIndex],
    ]
    setReviewState((current) => {
      const bandItemIds = library.items
        .filter(
          (item) =>
            !item.deletedAt &&
            item.category === 'resume' &&
            getBand((current.records[item.id] ?? emptyReview()).score) === band,
        )
        .map((item) => item.id)
      const updatedAt = new Date().toISOString()
      const currentRecord = current.records[itemId] ?? emptyReview()
      const targetScore = (current.records[target.id] ?? emptyReview()).score ?? bandDefaultScore[band]
      const nextRecords = { ...current.records }
      nextRecords[itemId] = {
        ...currentRecord,
        score: targetScore,
        updatedAt,
      }
      return {
        ...current,
        updatedAt,
        records: nextRecords,
        bandOrders: {
          ...current.bandOrders,
          [band]: mergeVisibleOrderIntoBandOrder(current.bandOrders[band], bandItemIds, reorderedVisibleOrder),
        },
      }
    })
  }

  const handleSync = async () => {
    setSyncing(true)
    setStatus('正在扫描 Gmail 并跳过已下载附件。')
    try {
      const response = await fetch('/api/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ all: true }),
      })
      const payload = (await response.json()) as SyncResponse
      if ('error' in payload) throw new Error(payload.error)
      if ('status' in payload) {
        setStatus(payload.message)
        return
      }

      const deletedCount = payload.library.items.filter((item) => item.deletedAt).length
      setLibrary(payload.library)
      setStatus(
        `Gmail 同步完成：新增 ${payload.summary.downloaded} 个，跳过已下载 ${payload.summary.alreadyDownloaded} 个，当前 ${payload.summary.resumes} 份简历，保留 ${deletedCount} 条已删除记录。`,
      )
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Gmail 同步失败。')
    } finally {
      setSyncing(false)
    }
  }

  const handleRestoreDeleted = async () => {
    setRestoring(true)
    setStatus('正在把已删除简历重新下载到 deleted-resume-downloads 文件夹。')
    try {
      const response = await fetch('/api/restore-deleted', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      const payload = (await response.json()) as RestoreResponse
      if ('error' in payload) throw new Error(payload.error)
      if ('status' in payload) {
        setStatus(payload.message)
        return
      }

      setLibrary(payload.library)
      selectViewMode('deleted')
      setSelectedId(null)
      setStatus(
        `已删除简历恢复完成：新下载 ${payload.summary.restored} 份，已有 ${payload.summary.alreadyAvailable} 份，失败 ${payload.summary.failed} 份。`,
      )
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '重新下载已删除简历失败。')
    } finally {
      setRestoring(false)
    }
  }

  const handleDeleteSelected = async () => {
    if (!selectedItem || deletingId) return
    setDeletingId(selectedItem.id)
    setStatus(`正在移入已删除：${selectedItem.displayName}。`)
    try {
      const response = await fetch(`/api/item/${encodeURIComponent(selectedItem.id)}`, {
        method: 'DELETE',
      })
      const payload = (await response.json()) as DeleteResponse
      if ('error' in payload) throw new Error(payload.error)

      setLibrary(payload.library)
      setStatus(`已移入已删除：${payload.item.displayName}。文件仍保留在本机。`)
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '移入已删除失败。')
    } finally {
      setDeletingId(null)
    }
  }

  const exportReviews = () => {
    const blob = new Blob(
      [
        JSON.stringify(
          {
            app: 'resume-screening-tool',
            exportedAt: new Date().toISOString(),
            reviews,
            bandOrders,
          },
          null,
          2,
        ),
      ],
      { type: 'application/json' },
    )
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `简历评分备注-${new Date().toISOString().slice(0, 10)}.json`
    link.click()
    URL.revokeObjectURL(url)
    setStatus('已导出评分和备注。')
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand-block">
          <p className="eyebrow">Resume Desk</p>
          <h1>简历筛选工作台</h1>
        </div>
        <div className="topbar-actions">
          <button type="button" onClick={() => void loadLibrary()} disabled={isBusy}>
            <RefreshCcw size={17} />
            刷新列表
          </button>
          <button className="primary-button" type="button" onClick={handleSync} disabled={isBusy}>
            <Mail size={17} />
            {syncing ? '同步中' : '同步 Gmail'}
          </button>
          <button type="button" onClick={handleRestoreDeleted} disabled={isBusy || counts.deleted === 0}>
            <Download size={17} />
            {restoring ? '恢复中' : '重新下载已删除'}
          </button>
          <button type="button" onClick={exportReviews} disabled={Object.keys(reviews).length === 0}>
            <Download size={17} />
            导出评分
          </button>
        </div>
      </header>

      <section className="summary-strip" aria-label="简历库统计">
        <button
          type="button"
          className={view === 'resumes' && filters.band === 'all' ? 'summary-card active' : 'summary-card'}
          onClick={() => selectResumeBandFilter('all')}
        >
          <span>{counts.resumes}</span>
          <small>简历</small>
        </button>
        <button
          type="button"
          className={view === 'other' ? 'summary-card active' : 'summary-card'}
          onClick={() => selectViewMode('other')}
        >
          <span>{counts.other}</span>
          <small>其他附件</small>
        </button>
        <button
          type="button"
          className={view === 'deleted' ? 'summary-card active tone-deleted' : 'summary-card tone-deleted'}
          onClick={() => selectViewMode('deleted')}
        >
          <span>{counts.deleted}</span>
          <small>已删除</small>
        </button>
        <div className="summary-card">
          <span>{counts.rated}</span>
          <small>已评分</small>
        </div>
        <button
          type="button"
          className={
            view === 'resumes' && filters.band === 'priority'
              ? 'summary-card active tone-priority'
              : 'summary-card tone-priority'
          }
          onClick={() => selectResumeBandFilter('priority')}
        >
          <span>{counts.priority}</span>
          <small>重点推进</small>
        </button>
        <button
          type="button"
          className={
            view === 'resumes' && filters.band === 'review'
              ? 'summary-card active tone-review'
              : 'summary-card tone-review'
          }
          onClick={() => selectResumeBandFilter('review')}
        >
          <span>{counts.review}</span>
          <small>继续观察</small>
        </button>
        <button
          type="button"
          className={
            view === 'resumes' && filters.band === 'hold'
              ? 'summary-card active tone-hold'
              : 'summary-card tone-hold'
          }
          onClick={() => selectResumeBandFilter('hold')}
        >
          <span>{counts.hold}</span>
          <small>暂缓考虑</small>
        </button>
      </section>

      <section className="workspace">
        <aside className="sidebar" aria-label="附件列表">
          <div className="panel-title">
            <div>
              <h2>{view === 'resumes' ? '候选简历' : view === 'other' ? '其他附件' : '已删除'}</h2>
              <p>{visibleItems.length} 个结果</p>
            </div>
            {view === 'resumes' ? <Inbox size={20} /> : view === 'other' ? <Archive size={20} /> : <Trash2 size={20} />}
          </div>

          <div className="filters">
            <label className="search-field">
              <Search size={16} />
              <input
                value={filters.keyword}
                placeholder="搜索文件名、邮件、备注"
                onChange={(event) =>
                  setFilters((current) => ({ ...current, keyword: event.target.value }))
                }
              />
            </label>
            <div className="filter-grid">
              {view === 'resumes' ? (
                <label>
                  档位
                  <select
                    value={filters.band}
                    onChange={(event) => selectResumeBandFilter(event.target.value as Filters['band'])}
                  >
                    <option value="all">全部</option>
                    <option value="priority">重点推进</option>
                    <option value="review">继续观察</option>
                    <option value="hold">暂缓考虑</option>
                  </select>
                </label>
              ) : null}
              {view !== 'deleted' ? (
              <label>
                评分
                <select
                  value={filters.rated}
                  onChange={(event) =>
                    setFilters((current) => ({
                      ...current,
                      rated: event.target.value as RatedFilter,
                    }))
                  }
                >
                  <option value="all">全部</option>
                  <option value="rated">已评分</option>
                  <option value="unrated">未评分</option>
                </select>
              </label>
              ) : null}
              <label>
                备注
                <select
                  value={filters.note}
                  onChange={(event) =>
                    setFilters((current) => ({
                      ...current,
                      note: event.target.value as NoteFilter,
                    }))
                  }
                >
                  <option value="all">全部</option>
                  <option value="noted">有备注</option>
                  <option value="empty">无备注</option>
                </select>
              </label>
              <label>
                排序
                <select
                  value={filters.sort}
                  onChange={(event) =>
                    setFilters((current) => ({
                      ...current,
                      sort: event.target.value as SortMode,
                    }))
                  }
                >
                  <option value="date">{view === 'deleted' ? '删除时间' : '邮件时间'}</option>
                  <option value="manual" disabled={!canManualSort}>自定义排序</option>
                  <option value="score">评分优先</option>
                  <option value="name">文件名</option>
                  <option value="size">文件大小</option>
                </select>
              </label>
              <button
                type="button"
                className="ghost-button"
                onClick={() => setFilters(initialFilters)}
              >
                清空筛选
              </button>
            </div>
          </div>

          <div className="item-list">
            {visibleItems.map((item, index) => {
              const review = reviews[item.id] ?? emptyReview()
              const band = getBand(review.score)
              const canMoveUp = canReorderVisibleItems && index > 0
              const canMoveDown = canReorderVisibleItems && index < visibleItems.length - 1
              return (
                <div
                  key={item.id}
                  className={[
                    'item-row',
                    item.deletedAt ? 'deleted' : '',
                    item.id === activeSelectedId ? 'active' : '',
                    canReorderVisibleItems ? 'sortable' : '',
                  ].filter(Boolean).join(' ')}
                >
                  <button
                    type="button"
                    className="item-row-select"
                    onClick={() => setSelectedId(item.id)}
                  >
                    <span className={item.deletedAt ? 'rank deleted' : item.category === 'resume' ? 'rank' : 'rank other'}>
                      {index + 1}
                    </span>
                    <span className="item-row-main">
                      <strong>{item.displayName}</strong>
                      <small>
                        {item.deletedAt
                          ? `${item.fileExists ? '文件可预览 · ' : ''}删除于 ${formatDate(item.deletedAt)}`
                          : item.subject || item.from || formatDate(item.date)}
                      </small>
                    </span>
                    <span className={`score-pill ${item.deletedAt ? 'deleted' : band ?? 'unrated'}`}>
                      {item.deletedAt ? '删' : review.score ?? '-'}
                    </span>
                  </button>
                  {canReorderVisibleItems ? (
                    <span className="sort-controls" aria-label={`${item.displayName} 排序`}>
                      <button
                        type="button"
                        className="sort-button"
                        title="上移"
                        aria-label={`上移 ${item.displayName}`}
                        disabled={!canMoveUp}
                        onClick={() => moveVisibleItem(item.id, -1)}
                      >
                        <ArrowUp size={14} />
                      </button>
                      <button
                        type="button"
                        className="sort-button"
                        title="下移"
                        aria-label={`下移 ${item.displayName}`}
                        disabled={!canMoveDown}
                        onClick={() => moveVisibleItem(item.id, 1)}
                      >
                        <ArrowDown size={14} />
                      </button>
                    </span>
                  ) : null}
                </div>
              )
            })}
            {visibleItems.length === 0 ? (
              <div className="empty-list">
                <FileQuestion size={30} />
                <h3>{loading ? '正在载入' : '没有匹配结果'}</h3>
              </div>
            ) : null}
          </div>
        </aside>

        <section className="preview-panel" aria-label="文件预览">
          <div className="preview-toolbar">
            <div>
              <h2>{selectedItem?.displayName ?? '未选择文件'}</h2>
              <p>{selectedItem ? `${selectedItem.ext.toUpperCase()} · ${formatBytes(selectedItem.size)}` : ' '}</p>
            </div>
            {selectedItem ? (
              <div className="toolbar-buttons">
                {selectedItem.fileExists ? (
                  <>
                    <a className="button-link" href={fileUrl(selectedItem)} target="_blank" rel="noreferrer">
                      <ExternalLink size={17} />
                      打开
                    </a>
                    <a className="button-link" href={fileUrl(selectedItem, true)}>
                      <Download size={17} />
                      下载
                    </a>
                  </>
                ) : null}
                <button
                  className="danger-button"
                  type="button"
                  onClick={() => void handleDeleteSelected()}
                  disabled={Boolean(selectedItem.deletedAt) || deletingId === selectedItem.id}
                >
                  <Trash2 size={17} />
                  {deletingId === selectedItem.id ? '移动中' : '移入已删除'}
                </button>
              </div>
            ) : null}
          </div>

          <div className="preview-body">
            {selectedItem?.fileExists && selectedItem.ext === '.pdf' ? (
              <iframe title={selectedItem.filename} src={fileUrl(selectedItem)} />
            ) : selectedItem?.deletedAt ? (
              <div className="preview-empty deleted-preview">
                <Trash2 size={42} />
                <h3>已移入已删除</h3>
                <p>{selectedItem.filename}</p>
              </div>
            ) : selectedItem ? (
              <div className="preview-empty">
                <FileText size={42} />
                <h3>{selectedItem.fileExists ? '当前格式使用外部应用打开' : '本地文件不存在'}</h3>
                <p>{selectedItem.filename}</p>
              </div>
            ) : (
              <div className="preview-empty">
                <FileText size={42} />
                <h3>选择左侧文件</h3>
              </div>
            )}
          </div>
        </section>

        <aside className="detail-panel" aria-label="评分和来源">
          {selectedItem ? (
            <>
              <div className="panel-title compact">
                <div>
                  <h2>{selectedItem.deletedAt ? '删除记录' : '评审'}</h2>
                <p>
                  {selectedItem.deletedAt
                      ? `${selectedItem.fileExists ? '文件可预览 · ' : ''}删除于 ${formatDate(selectedItem.deletedAt)}`
                      : selectedBand
                        ? bandMeta[selectedBand].label
                        : '未评分'}
                  </p>
                </div>
                {selectedItem.deletedAt ? (
                  <Trash2 className="state-icon deleted" size={20} />
                ) : selectedItem.fileExists ? (
                  <CheckCircle2 className="state-icon ok" size={20} />
                ) : (
                  <AlertCircle className="state-icon warn" size={20} />
                )}
              </div>

              {!selectedItem.deletedAt ? (
              <label className="field">
                分数
                <input
                  className="score-input"
                  value={selectedReview.score ?? ''}
                  inputMode="numeric"
                  placeholder="0-100"
                  onChange={(event) =>
                    handleScoreChange(selectedItem.id, event.target.value)
                  }
                />
              </label>
              ) : null}

              {!selectedItem.deletedAt ? (
              <div className="band-display" aria-label="评分档位">
                {ratingBands.map((band) => (
                  <button
                    type="button"
                    key={band}
                    className={`band-card ${band} ${selectedBand === band ? 'current' : ''}`}
                    aria-pressed={selectedBand === band}
                    aria-label={`选择档位：${bandMeta[band].label}，默认 ${bandDefaultScore[band]} 分`}
                    title={`选择为${bandMeta[band].label}`}
                    onClick={() => handleSelectBand(band)}
                  >
                    <strong>{bandMeta[band].label}</strong>
                    <small>{bandMeta[band].range}</small>
                  </button>
                ))}
              </div>
              ) : null}

              {!selectedItem.deletedAt ? (
              <label className="field">
                备注
                <textarea
                  value={selectedReview.note}
                  placeholder="候选亮点、顾虑、下一步"
                  onChange={(event) =>
                    updateReview(selectedItem.id, { note: event.target.value })
                  }
                />
              </label>
              ) : (
                <div className="deleted-note">
                  <Clock3 size={17} />
                  <span>
                    {selectedItem.fileExists
                      ? '文件仍保留在本机；记录显示在已删除列表中，可继续预览。'
                      : '这条记录会保留在已删除列表中；同步 Gmail 时会跳过它。'}
                  </span>
                </div>
              )}

              <div className="source-panel">
                <h3>
                  <Mail size={16} />
                  邮件来源
                </h3>
                <dl>
                  <dt>主题</dt>
                  <dd>{selectedItem.subject || '未记录'}</dd>
                  <dt>发件人</dt>
                  <dd>{selectedItem.from || '未记录'}</dd>
                  <dt>时间</dt>
                  <dd>{formatDate(selectedItem.date || selectedItem.downloadedAt)}</dd>
                  {selectedItem.deletedAt ? (
                    <>
                      <dt>删除</dt>
                      <dd>{formatDate(selectedItem.deletedAt)}</dd>
                      <dt>文件状态</dt>
                      <dd>
                        {selectedItem.restoredAt
                          ? `已恢复于 ${formatDate(selectedItem.restoredAt)}`
                          : selectedItem.fileExists
                            ? '原文件保留在本机'
                            : '未恢复文件'}
                      </dd>
                    </>
                  ) : null}
                  <dt>文件</dt>
                  <dd>{selectedItem.filename}</dd>
                </dl>
              </div>
            </>
          ) : (
            <div className="detail-empty">
              <Star size={32} />
              <h2>暂无详情</h2>
            </div>
          )}
        </aside>
      </section>

      <footer className="statusbar">
        <span>{status}</span>
        <span className={`review-save-state ${reviewSaveState}`}>{reviewSaveMessage}</span>
        <span>{library.updatedAt ? `索引更新时间 ${formatDate(library.updatedAt)}` : '本地索引未生成'}</span>
      </footer>
    </main>
  )
}

export default App
