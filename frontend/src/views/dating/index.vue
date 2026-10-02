<template>
  <section class="page" data-module="dating">
    <header class="page-head">
      <div>
        <h2>测年送检管理</h2>
        <p class="page-desc">维护测年送检单，围绕送检编号、样品来源、承接实验室、测年方法做登记、筛选与状态流转；送检材料按承接实验室分组打包送实验室。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记测年送检单</button>
        <button class="btn" type="button" @click="exportRows">导出送检材料</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <!-- 导出结果：缺日期给清单、无记录给说明、成功给文件包，绝不产出空文件 -->
    <div v-if="exportResult" class="export-panel" :class="exportPanelClass">
      <template v-if="exportResult.kind === 'empty'">
        <p class="export-title">没有可导出的记录</p>
        <p class="export-text">{{ exportResult.message }}</p>
        <button class="btn ghost" type="button" @click="dismissExport">知道了</button>
      </template>

      <template v-else-if="exportResult.kind === 'missing-dates'">
        <p class="export-title">以下送检单缺失送检日期，请先补齐再打包</p>
        <p class="export-text">本次按列表共核对 {{ exportResult.totalScanned }} 条，缺失 {{ exportResult.missing.length }} 条，未生成任何文件。</p>
        <table class="data-table missing-table">
          <thead>
            <tr>
              <th>送检编号</th>
              <th>样品来源</th>
              <th>承接实验室</th>
              <th>补齐送检日期</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="item in exportResult.missing" :key="item.id">
              <td>{{ item.no || '—' }}</td>
              <td>{{ item.source || '—' }}</td>
              <td>{{ item.lab || '—' }}</td>
              <td class="fill-cell">
                <input v-model="dateDraft[item.id]" type="date" />
                <button class="btn small" type="button" @click="fillDate(item.id)">补齐并重新打包</button>
              </td>
            </tr>
          </tbody>
        </table>
        <button class="btn ghost" type="button" @click="dismissExport">暂不打包</button>
      </template>

      <template v-else>
        <p class="export-title">送检材料已按承接实验室分组打包（共核对 {{ exportResult.totalScanned }} 条）</p>
        <ul class="package-list">
          <li v-for="item in exportResult.packages" :key="item.pkg.batchNo" class="package-item">
            <div class="package-meta">
              <strong>{{ item.pkg.lab }}</strong>
              <span class="tag">{{ item.reused ? '复用已有文件包' : '新文件包' }}</span>
              <span>批次号 {{ item.pkg.batchNo }}</span>
              <span>{{ item.pkg.count }} 条：{{ item.pkg.entryNos.join('、') }}</span>
            </div>
            <div class="package-actions">
              <button class="btn small primary" type="button" @click="downloadOne(item.pkg)">
                下载 {{ item.pkg.filename }}
              </button>
            </div>
          </li>
        </ul>
        <p class="export-text">同一批材料重复导出只会保留同一个文件包（按承接实验室 + 送检编号组合识别），文件名带实验室名与批次号。</p>
      </template>
    </div>

    <!-- 已生成文件包：重复导出同一批材料只留一个文件包 -->
    <section v-if="packages.length" class="package-registry">
      <h3>已生成文件包（{{ packages.length }} 个）</h3>
      <ul class="package-list">
        <li v-for="pkg in packages" :key="pkg.batchNo" class="package-item compact">
          <div class="package-meta">
            <strong>{{ pkg.lab }}</strong>
            <span>批次号 {{ pkg.batchNo }}</span>
            <span>{{ pkg.count }} 条</span>
            <span>导出 {{ pkg.exports }} 次</span>
          </div>
          <div class="package-actions">
            <button class="btn small" type="button" @click="downloadOne(pkg)">{{ pkg.filename }}</button>
          </div>
        </li>
      </ul>
    </section>

    <!-- 测年方法口径：已出报告的单子沿用老校正年代，不重算 -->
    <section class="caliber-panel">
      <h3>测年方法口径</h3>
      <p class="export-text">
        当前口径：<strong>{{ caliber.method }}</strong>（v{{ caliber.version }}，{{ caliber.note }}）。
        口径调整只影响尚未出报告的送检单；已出报告的 {{ reported.length }} 单沿用老数据里的校正年代，不重算、不覆写。
      </p>
      <div class="caliber-row">
        <label class="filter-item">
          <span>调整为</span>
          <select v-model="caliberDraft.method">
            <option v-for="method in methodOptions" :key="method" :value="method">{{ method }}</option>
          </select>
        </label>
        <label class="filter-item grow">
          <span>调整说明</span>
          <input v-model="caliberDraft.note" placeholder="例如：AMS 实验室更新校正曲线" />
        </label>
        <button class="btn" type="button" @click="applyCaliber">应用新口径</button>
      </div>
      <ul v-if="reported.length" class="locked-list">
        <li v-for="item in reported" :key="Number(item.id)">
          <span>{{ item['送检编号'] }}</span>
          <span>{{ item['测年方法'] }}</span>
          <span>校正年代：{{ item['校正年代'] || '—' }}</span>
          <span class="tag locked">出报告口径 {{ String(item['校正口径'] ?? '老数据') }}（已锁定，不重算）</span>
        </li>
      </ul>
    </section>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td
            v-for="column in columns"
            :key="column"
            :class="{ 'missing-cell': column === '送检日期' && !hasDate(row) }"
          >
            {{ column === '送检日期' && !hasDate(row) ? '缺失（待补齐）' : (row[column] ?? '—') }}
          </td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无测年送检数据，可先登记测年送检单</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条测年送检记录，导出材料与此列表完全一致（含当前筛选）</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'

import {
  adjustCaliber,
  caliberMethods,
  currentCaliber,
  datingAction,
  downloadMaterialPackage,
  fillSendDate,
  prepareMaterialExport,
  registeredPackages,
  reportedEntries,
  type ExportResult,
  type MaterialPackage,
} from '@/api/dating-service'
import { listEntries, moduleMeta } from '@/api/local-service'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('dating')
const columns = ["送检编号", "样品来源", "承接实验室", "测年方法", "送检日期", "校正年代", "报告收到日", "送检状态"]
const actions = ["提交送检", "登记报告", "作废送检"]
const statuses = ["待送检", "已送检", "已出报告", "已作废"]
const stats = [{"label": "待送检批次", "value": 0}, {"label": "已送检批次", "value": 0}, {"label": "本月出报告数", "value": 0}]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)

const exportResult = ref<ExportResult | null>(null)
const packages = ref<MaterialPackage[]>([])
const dateDraft = reactive<Record<number, string>>({})

const caliber = ref(currentCaliber())
const methodOptions = caliberMethods()
const caliberDraft = reactive({ method: caliber.value.method, note: '' })
const reported = ref<EntryRow[]>(reportedEntries())

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

const exportPanelClass = computed(() => {
  if (!exportResult.value) return ''
  if (exportResult.value.kind === 'ready') return 'is-ready'
  if (exportResult.value.kind === 'missing-dates') return 'is-warning'
  return 'is-empty'
})

function hasDate(row: EntryRow): boolean {
  return String(row['送检日期'] ?? '').trim() !== ''
}

function resetFilters() {
  filters.value = {}
  reload()
}

// 导出与列表同源：prepareMaterialExport 内部走的就是列表用的 listEntries，
// 所以列表显示几条，打包就有几条，不会多也不会少。
function exportRows() {
  errorMessage.value = ''
  try {
    exportResult.value = prepareMaterialExport(filters.value)
    packages.value = registeredPackages()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '送检材料导出失败'
  }
}

function fillDate(id: number) {
  const date = dateDraft[id] ?? ''
  const result = fillSendDate(id, date)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  errorMessage.value = ''
  delete dateDraft[id]
  reload()
  // 补齐后自动按当前筛选重新打包：缺日期的单子都补齐后即可一次性下载。
  exportResult.value = prepareMaterialExport(filters.value)
  packages.value = registeredPackages()
}

function downloadOne(pkg: MaterialPackage) {
  downloadMaterialPackage(pkg)
  packages.value = registeredPackages()
}

function dismissExport() {
  exportResult.value = null
}

function openCreate() {
  errorMessage.value = '测年送检单登记入口尚未接入审批流'
}

function applyCaliber() {
  const result = adjustCaliber({ method: caliberDraft.method, note: caliberDraft.note })
  caliber.value = result.caliber
  caliberDraft.method = result.caliber.method
  caliberDraft.note = ''
  reported.value = reportedEntries()
  if (result.reportedLocked.length) {
    errorMessage.value = `口径已升至 v${result.caliber.version}；${result.reportedLocked.length} 单已出报告，沿用老校正年代未重算。`
  } else {
    errorMessage.value = `口径已升至 v${result.caliber.version}，将在后续登记报告时按新口径校正。`
  }
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = datingAction(Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
  reported.value = reportedEntries()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    packages.value = registeredPackages()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '测年送检列表读取失败'
  }
}

onMounted(reload)
</script>

<style scoped>
.export-panel {
  border: 1px solid var(--border);
  border-left-width: 4px;
  border-radius: 8px;
  background: #fff;
  padding: 12px 14px;
  margin-bottom: 12px;
}
.export-panel.is-ready { border-left-color: #15803d; }
.export-panel.is-warning { border-left-color: #b45309; }
.export-panel.is-empty { border-left-color: #64748b; }
.export-title { font-weight: 600; margin: 0 0 6px; }
.export-text { color: var(--muted); font-size: 13px; margin: 6px 0; }
.missing-table { margin: 8px 0; }
.fill-cell { display: flex; gap: 8px; align-items: center; }
.fill-cell input { padding: 4px 6px; }
.btn.small { padding: 4px 10px; font-size: 12px; }
.btn.primary.small { background: var(--brand); border-color: var(--brand); color: #fff; }
.package-registry,
.caliber-panel {
  background: #fff;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 10px 14px;
  margin-bottom: 12px;
}
.package-registry h3,
.caliber-panel h3 { margin: 4px 0 8px; font-size: 14px; }
.package-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
.package-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  border: 1px dashed var(--border);
  border-radius: 6px;
  padding: 8px 10px;
}
.package-item.compact { padding: 6px 10px; }
.package-meta { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; font-size: 13px; }
.tag {
  font-size: 12px;
  background: #eef2f7;
  border-radius: 999px;
  padding: 1px 10px;
  color: var(--muted);
}
.tag.locked { background: #fef3c7; color: #92400e; }
.caliber-row { display: flex; gap: 10px; align-items: flex-end; }
.caliber-row .grow { flex: 1; }
.locked-list {
  list-style: none;
  margin: 8px 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
  color: var(--muted);
}
.locked-list li { display: flex; flex-wrap: wrap; gap: 12px; }
.missing-cell { color: #b42318; }
</style>
