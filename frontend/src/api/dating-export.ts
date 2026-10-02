import type { EntryRow } from '@/data/types'

// 送检材料打包导出：送检单送实验室时按承接实验室分组，每组打成一份文件，
// 文件里只放送检编号、测年方法、样品来源、送检日期四列，文件名带实验室名与批次号。

const EXPORT_FIELDS = ['送检编号', '测年方法', '样品来源', '送检日期'] as const
const FALLBACK_LAB = '未登记承接实验室'
const REGISTRY_KEY = 'archaeology-field:dating-export-registry'

export type DatingPackage = {
  lab: string
  batchNo: string
  filename: string
  content: string
  duplicated: boolean
  count: number
}

export type DatingExportResult = {
  ok: boolean
  message: string
  packages: DatingPackage[]
  missingDateIds: string[]
}

type RegistryRecord = {
  batchNo: string
  filename: string
  exportedAt: string
}

// 注册表结构：承接实验室 -> 该实验室某批材料指纹 -> 已有文件包。
// 指纹用送检编号集合生成，同一批材料重复导出时命中，不再产生第二份文件。
type PackageRegistry = Record<string, Record<string, RegistryRecord>>

function readRegistry(): PackageRegistry {
  if (typeof window === 'undefined' || !window.localStorage) {
    return {}
  }
  const raw = window.localStorage.getItem(REGISTRY_KEY)
  if (!raw) {
    return {}
  }
  try {
    return JSON.parse(raw) as PackageRegistry
  } catch {
    return {}
  }
}

function writeRegistry(registry: PackageRegistry): void {
  if (typeof window === 'undefined' || !window.localStorage) {
    return
  }
  window.localStorage.setItem(REGISTRY_KEY, JSON.stringify(registry))
}

function fieldText(row: EntryRow, field: string): string {
  const value = row[field]
  return value === undefined || value === null ? '' : String(value).trim()
}

function fingerprint(rows: EntryRow[]): string {
  // 以送检编号集合判定「同一批材料」：同一实验室、送检编号集合一致就算重复提交，
  // 顺序不同或重复点两次都命中同一个文件包。
  const ids = rows.map((row) => fieldText(row, '送检编号')).filter(Boolean).sort()
  return JSON.stringify([...new Set(ids)])
}

function nextBatchNo(lab: string, registry: PackageRegistry, today: string): string {
  // 批次号形如 DATI-20261002-03：按实验室、按当天已分配的序号往后排。
  const prefix = `DATI-${today.replace(/-/g, '')}-`
  const owned = Object.values(registry[lab] ?? {})
  const used = owned
    .map((record) => Number(record.batchNo.slice(prefix.length)))
    .filter((seq) => Number.isInteger(seq) && seq > 0)
  const seq = (used.length ? Math.max(...used) : 0) + 1
  return `${prefix}${String(seq).padStart(2, '0')}`
}

function safeName(name: string): string {
  // 文件名里的路径分隔符等字符清掉，保留中文实验室名。
  return name.replace(/[\\/:*?"<>|]/g, '_').trim() || FALLBACK_LAB
}

function csvCell(value: string): string {
  if (/[",\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`
  }
  return value
}

function buildCsv(rows: EntryRow[]): string {
  const lines = [EXPORT_FIELDS.join(',')]
  for (const row of rows) {
    lines.push(EXPORT_FIELDS.map((field) => csvCell(fieldText(row, field))).join(','))
  }
  return `\uFEFF${lines.join('\n')}`
}

function downloadFile(filename: string, content: string): void {
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function exportDatingMaterials(rows: EntryRow[]): DatingExportResult {
  // 送检条目直接取送检单列表当前筛选结果，两处同源，导出不会多也不会少。
  if (!rows.length) {
    return {
      ok: true,
      message: '当前筛选条件下没有可导出的送检单，未生成文件；请调整筛选条件或先登记送检单。',
      packages: [],
      missingDateIds: [],
    }
  }

  // 送检日期缺失的先挑出来：补齐之前不打包，避免实验室收到没有送检日期的材料。
  const missingDateIds = rows
    .filter((row) => fieldText(row, '送检日期') === '')
    .map((row) => fieldText(row, '送检编号') || `记录#${row.id}`)
  if (missingDateIds.length) {
    return {
      ok: false,
      message: `以下 ${missingDateIds.length} 条送检单缺少送检日期，请补齐后再打包：${missingDateIds.join('、')}`,
      packages: [],
      missingDateIds,
    }
  }

  const groups = new Map<string, EntryRow[]>()
  for (const row of rows) {
    const lab = fieldText(row, '承接实验室') || FALLBACK_LAB
    const group = groups.get(lab)
    if (group) {
      group.push(row)
    } else {
      groups.set(lab, [row])
    }
  }

  const registry = readRegistry()
  const now = new Date()
  const today = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  ].join('-')
  const packages: DatingPackage[] = []

  for (const [lab, labRows] of groups) {
    // 口径说明：测年方法（校正曲线/方法口径）后续调整时，已经出报告的送检单
    // 一律沿用老数据里的「校正年代」，导出与列表都只读存量值，不按新口径重算。
    const stamp = fingerprint(labRows)
    const existing = registry[lab]?.[stamp]
    if (existing) {
      // 同一批材料重复提交：只认已有的那一个文件包，不再下载新文件。
      packages.push({
        lab,
        batchNo: existing.batchNo,
        filename: existing.filename,
        content: '',
        duplicated: true,
        count: labRows.length,
      })
      continue
    }

    const batchNo = nextBatchNo(lab, registry, today)
    const filename = `${safeName(lab)}-送检材料-${batchNo}.csv`
    const record: RegistryRecord = {
      batchNo,
      filename,
      exportedAt: new Date().toISOString(),
    }
    registry[lab] = { ...(registry[lab] ?? {}), [stamp]: record }
    packages.push({
      lab,
      batchNo,
      filename,
      content: buildCsv(labRows),
      duplicated: false,
      count: labRows.length,
    })
  }

  const created = packages.filter((item) => !item.duplicated)
  if (created.length) {
    writeRegistry(registry)
    for (const item of created) {
      downloadFile(item.filename, item.content)
    }
  }

  const createdText = created
    .map((item) => `${item.lab}（批次号 ${item.batchNo}，${item.count} 条）`)
    .join('；')
  const duplicatedText = packages
    .filter((item) => item.duplicated)
    .map((item) => `${item.lab}（批次号 ${item.batchNo}，${item.count} 条）`)
    .join('；')
  const parts: string[] = []
  if (createdText) {
    parts.push(`已打包下载：${createdText}`)
  }
  if (duplicatedText) {
    parts.push(`以下为同一批材料的重复提交，沿用已有文件包，未重复生成：${duplicatedText}`)
  }

  return {
    ok: true,
    message: parts.join('。'),
    packages,
    missingDateIds: [],
  }
}
