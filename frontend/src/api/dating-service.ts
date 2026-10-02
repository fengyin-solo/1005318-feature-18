import { listEntries, runAction } from '@/api/local-service'
import { listRows, saveRows } from '@/data/local-store'
import type { ActionResult, EntryRow } from '@/data/types'

// 测年送检单的领域操作：送实验室打包材料、测年方法口径管理。
// 与列表页共用 listEntries，保证「导出条目」和「送检单列表」永远同源、不多不少。

const CALIBER_KEY = 'archaeology-field:dating-caliber'
const PACKAGE_KEY = 'archaeology-field:dating-packages'

const LAB_FIELD = '承接实验室'
const STATUS_FIELD = 'status'
const REPORTED_STATUS = '已出报告'
const LOCK_TAG = '校正口径'
const AGE_FIELD = '校正年代'

// 打包材料只取约定的四列，顺序即文件列顺序。
export const MATERIAL_FIELDS = ['送检编号', '测年方法', '样品来源', '送检日期'] as const

const CALIBER_METHODS = ['AMS碳十四测年', '常规碳十四测年', '光释光测年(OSL)', '铀系测年']

export type DatingCaliber = {
  method: string
  version: number
  note: string
  updatedAt: string
}

export type MaterialPackage = {
  batchNo: string
  lab: string
  filename: string
  count: number
  entryIds: number[]
  entryNos: string[]
  createdAt: string
  lastExportAt: string
  exports: number
  content: string
}

export type ReadyPackage = { pkg: MaterialPackage; reused: boolean }

export type ExportResult =
  | { kind: 'empty'; totalScanned: number; message: string }
  | {
      kind: 'missing-dates'
      totalScanned: number
      missing: { id: number; no: string; source: string; lab: string }[]
      message: string
    }
  | { kind: 'ready'; totalScanned: number; packages: ReadyPackage[] }

const DEFAULT_CALIBER: DatingCaliber = {
  method: CALIBER_METHODS[0],
  version: 1,
  note: '系统初始口径',
  updatedAt: '',
}

function readJSON<T>(key: string, fallback: T): T {
  if (typeof window === 'undefined' || !window.localStorage) return fallback
  const raw = window.localStorage.getItem(key)
  if (!raw) return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

function writeJSON(key: string, value: unknown): void {
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(key, JSON.stringify(value))
  }
}

export function caliberMethods(): string[] {
  return [...CALIBER_METHODS]
}

export function currentCaliber(): DatingCaliber {
  return { ...DEFAULT_CALIBER, ...readJSON<Partial<DatingCaliber>>(CALIBER_KEY, {}) }
}

// 已经出报告的送检单：校正年代沿用老数据，口径调整绝不重算、不覆写。
export function reportedEntries(): EntryRow[] {
  return listRows('dating').filter((row) => String(row[STATUS_FIELD]) === REPORTED_STATUS)
}

export type CaliberAdjustment = {
  caliber: DatingCaliber
  reportedLocked: { no: string; age: string; tag: string }[]
  openCount: number
}

export function adjustCaliber(input: { method: string; note: string }): CaliberAdjustment {
  const method = input.method.trim()
  const previous = currentCaliber()
  const caliber: DatingCaliber = {
    method: method || previous.method,
    version: previous.version + 1,
    note: input.note.trim() || `口径由 v${previous.version} 调整`,
    updatedAt: new Date().toISOString(),
  }
  writeJSON(CALIBER_KEY, caliber)

  // 关键口径规则：已出报告的单子只读出老校正年代，不做任何写回；
  // 未出报告的单子等报告登记时再按新口径校正。
  const rows = listRows('dating')
  const reportedLocked = rows
    .filter((row) => String(row[STATUS_FIELD]) === REPORTED_STATUS)
    .map((row) => ({
      no: String(row['送检编号'] ?? ''),
      age: String(row[AGE_FIELD] ?? ''),
      tag: String(row[LOCK_TAG] ?? `v${previous.version}`),
    }))
  const openCount = rows.filter((row) => String(row[STATUS_FIELD]) !== REPORTED_STATUS).length
  return { caliber, reportedLocked, openCount }
}

// 测年动作统一走这里：登记报告时把「出报告时的口径版本」钉在单子上，
// 之后再调口径，这单的校正年代也不会被重算。
export function datingAction(id: number, action: string): ActionResult {
  const result = runAction('dating', id, action)
  if (result.ok && action === '登记报告') {
    const rows = listRows('dating')
    const index = rows.findIndex((row) => Number(row.id) === id)
    if (index >= 0) {
      const next = [...rows]
      next[index] = { ...next[index], [LOCK_TAG]: `v${currentCaliber().version}` }
      saveRows('dating', next)
    }
  }
  return result
}

function csvCell(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`
  }
  return value
}

function buildCsv(rows: EntryRow[]): string {
  const lines = [MATERIAL_FIELDS.join(',')]
  for (const row of rows) {
    lines.push(MATERIAL_FIELDS.map((field) => csvCell(String(row[field] ?? '').trim())).join(','))
  }
  // Excel 兼容：UTF-8 BOM + CRLF。
  return `\uFEFF${lines.join('\r\n')}`
}

// 同一实验室 + 同一组送检编号 = 同一批材料，批次号只由这两项决定，
// 因此重复提交两次导出永远命中同一个文件包。
function batchSignature(lab: string, nos: string[]): string {
  return `${lab}__${nos.join('|')}`
}

function batchHash(text: string): string {
  let hash = 5381
  for (let i = 0; i < text.length; i++) {
    hash = (hash * 33 + text.charCodeAt(i)) >>> 0
  }
  return hash.toString(36).padStart(8, '0')
}

function fileSafe(name: string): string {
  const cleaned = name.replace(/[\\/:*?"<>|\s]+/g, '')
  return cleaned.slice(0, 24) || '未填写承接实验室'
}

function loadRegistry(): MaterialPackage[] {
  return readJSON<MaterialPackage[]>(PACKAGE_KEY, [])
}

function saveRegistry(packages: MaterialPackage[]): void {
  writeJSON(PACKAGE_KEY, packages)
}

export function registeredPackages(): MaterialPackage[] {
  return loadRegistry().sort((a, b) => (a.lastExportAt < b.lastExportAt ? 1 : -1))
}

export function prepareMaterialExport(filters: Record<string, string> = {}): ExportResult {
  // 与送检单列表完全同源（含相同筛选条件），列表几条就导几条。
  const items = listEntries('dating', filters).items
  if (items.length === 0) {
    const hasFilter = Object.values(filters).some((value) => value.trim() !== '')
    return {
      kind: 'empty',
      totalScanned: 0,
      message: hasFilter
        ? '当前筛选条件下没有可导出的测年送检单，请调整筛选条件后再打包。'
        : '暂无测年送检单可打包：还没有登记任何送检记录，未生成任何文件。',
    }
  }

  // 送检日期缺失先挑出来，整批暂停打包，补齐后再来。
  const missing = items
    .filter((row) => String(row['送检日期'] ?? '').trim() === '')
    .map((row) => ({
      id: Number(row.id),
      no: String(row['送检编号'] ?? ''),
      source: String(row['样品来源'] ?? ''),
      lab: String(row[LAB_FIELD] ?? ''),
    }))
  if (missing.length > 0) {
    return {
      kind: 'missing-dates',
      totalScanned: items.length,
      missing,
      message: `有 ${missing.length} 条送检单缺失送检日期，已挑出，请先补齐送检日期再打包，本次未生成任何文件。`,
    }
  }

  // 按承接实验室分组，组内按 id 排序，保证同批材料每次内容一致。
  const groups = new Map<string, EntryRow[]>()
  for (const row of [...items].sort((a, b) => Number(a.id) - Number(b.id))) {
    const lab = String(row[LAB_FIELD] ?? '').trim() || '未填写承接实验室'
    const group = groups.get(lab) ?? []
    group.push(row)
    groups.set(lab, group)
  }

  const registry = loadRegistry()
  const ready: ReadyPackage[] = []
  let changed = false
  const now = new Date().toISOString()

  for (const [lab, rows] of groups) {
    const entryIds = rows.map((row) => Number(row.id))
    const entryNos = rows.map((row) => String(row['送检编号'] ?? ''))
    const signature = batchSignature(lab, entryNos)
    // 批次指纹已包含实验室与全部送检编号，同名批次号天然唯一；实验室名由文件名承载。
    const batchNo = `BN-${batchHash(signature)}`
    const filename = `送检材料_${fileSafe(lab)}_${batchNo}.csv`

    const existing = registry.find(
      (item) => item.lab === lab && item.entryNos.join('|') === entryNos.join('|'),
    )
    if (existing) {
      existing.lastExportAt = now
      existing.exports += 1
      changed = true
      ready.push({ pkg: { ...existing }, reused: true })
      continue
    }

    const pkg: MaterialPackage = {
      batchNo,
      lab,
      filename,
      count: rows.length,
      entryIds,
      entryNos,
      createdAt: now,
      lastExportAt: now,
      exports: 1,
      content: buildCsv(rows),
    }
    registry.push(pkg)
    changed = true
    ready.push({ pkg, reused: false })
  }

  if (changed) saveRegistry(registry)
  return { kind: 'ready', totalScanned: items.length, packages: ready }
}

// 送检日期缺失的单子在这里补齐，补齐后可立即重新打包。
export function fillSendDate(id: number, date: string): ActionResult {
  const value = date.trim()
  if (!value) {
    return { ok: false, message: '送检日期不能为空，请选择日期后再补齐' }
  }
  const rows = listRows('dating')
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的测年送检单` }
  }
  const next = [...rows]
  next[index] = { ...next[index], 送检日期: value }
  saveRows('dating', next)
  return { ok: true, message: `送检单 ${next[index]['送检编号']} 的送检日期已补齐为 ${value}` }
}

export function downloadMaterialPackage(pkg: MaterialPackage): void {
  const blob = new Blob([pkg.content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = pkg.filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}
