<template>
  <main class="app">
    <h1>HTML 转 MasterGo</h1>

    <div class="size-switch" role="radiogroup" aria-label="导入尺寸">
      <span class="size-label">导入尺寸</span>
      <button class="size-chip" :class="{ active: pagePreset === 'pc' }" @click="pagePreset = 'pc'">PC端</button>
      <button class="size-chip" :class="{ active: pagePreset === 'tablet' }" @click="pagePreset = 'tablet'">平板</button>
      <button class="size-chip" :class="{ active: pagePreset === 'mobile' }" @click="pagePreset = 'mobile'">移动端</button>
      <button class="size-chip" :class="{ active: pagePreset === 'custom' }" @click="pagePreset = 'custom'">自定义</button>
      <input
        v-model.number="customPageWidth"
        class="size-custom-input"
        type="number"
        min="320"
        max="3840"
        step="1"
        placeholder="宽度"
        :disabled="pagePreset !== 'custom'"
        @focus="pagePreset = 'custom'"
        @blur="normalizeCustomWidth"
      />
      <span class="size-unit">px</span>
    </div>

    <div class="mode-switch" role="tablist" aria-label="导入模式">
      <button
        class="mode-tab"
        :class="{ active: activeImportTab === 'direct' }"
        role="tab"
        :aria-selected="activeImportTab === 'direct'"
        @click="activeImportTab = 'direct'"
      >
        代码 / 链接导入
      </button>
      <button
        class="mode-tab"
        :class="{ active: activeImportTab === 'upload' }"
        role="tab"
        :aria-selected="activeImportTab === 'upload'"
        @click="activeImportTab = 'upload'"
      >
        上传HTML文件
      </button>
    </div>

    <section v-if="activeImportTab === 'direct'" class="panel">
      <textarea
        v-model="htmlInput"
        class="editor editable-editor"
        spellcheck="false"
        placeholder="请输入网页链接（如 https://example.com）或粘贴 HTML 代码，系统将自动识别"
      />
      <p class="sub-hint">支持这两种输入：网页链接 / HTML 代码。</p>
      <div class="import-actions">
        <button class="btn primary" :disabled="isGenerating || isFetching" @click="convertSmartInput">
          {{ isFetching ? '抓取中...' : (isGenerating ? '导入中...' : '导入') }}
        </button>
        <label class="switch-inline">
          <input v-model="enableAutoLayout" type="checkbox" />
          自动布局（实验）
        </label>
      </div>
    </section>

    <section v-else class="panel">
      <div class="upload-panel">
        <input
          ref="fileInputRef"
          class="file-input"
          type="file"
          accept=".html,.htm,text/html"
          @change="onHtmlFileChange"
        />
        <div class="upload-actions">
          <span class="file-name">{{ selectedHtmlFileName || '未选择文件' }}</span>
          <button class="btn primary" :disabled="isGenerating || !selectedHtmlFile" @click="importHtmlFile">
            {{ isGenerating ? '导入中...' : '上传并导入' }}
          </button>
        </div>
      </div>
    </section>

    <p class="status">{{ status }}</p>
    <details class="collapse" open>
      <summary>诊断日志（复制给我排查）</summary>
      <div class="log-actions">
        <button class="btn ghost" @click="copyLog">复制日志</button>
        <button class="btn ghost" @click="clearLog">清空日志</button>
      </div>
      <textarea :value="logText" class="editor log-editor" readonly />
    </details>
    <div ref="mountRef" class="hidden-mount"></div>
  </main>
</template>

<script lang="ts" setup>
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { htmlToMG, postProcess } from '@mastergo/html-mastergo'
import { toPng, toSvg } from 'html-to-image'
import html2canvas from 'html2canvas'
import { PluginMessage, sendMsgToPlugin, UIMessage } from '@messages/sender'

const htmlInput = ref('')
const cssInput = ref('')
const cssLinksInput = ref('')
const pagePreset = ref<'pc' | 'tablet' | 'mobile' | 'custom'>('pc')
const PRESET_WIDTH_MAP = {
  pc: 1920,
  tablet: 1024,
  mobile: 390,
} as const
const customPageWidth = ref(1920)
const MIN_CUSTOM_WIDTH = 320
const MAX_CUSTOM_WIDTH = 3840
const normalizeWidth = (value: unknown) => {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return PRESET_WIDTH_MAP.pc
  const rounded = Math.round(parsed)
  return Math.min(MAX_CUSTOM_WIDTH, Math.max(MIN_CUSTOM_WIDTH, rounded))
}
const pageWidth = computed(() => (
  pagePreset.value === 'custom'
    ? normalizeWidth(customPageWidth.value)
    : PRESET_WIDTH_MAP[pagePreset.value]
))
const baseUrl = ref('')
const lastInputUrl = ref('')
const activeImportTab = ref<'direct' | 'upload'>('direct')
const enableAutoLayout = ref(true)
const status = ref('等待输入网页链接或 HTML')
const isGenerating = ref(false)
const isFetching = ref(false)
const mountRef = ref<HTMLDivElement | null>(null)
const fileInputRef = ref<HTMLInputElement | null>(null)
const selectedHtmlFile = ref<File | null>(null)
const selectedHtmlFileName = ref('')
const logLines = ref<string[]>([])

function appendLog(message: string) {
  const now = new Date()
  const hh = String(now.getHours()).padStart(2, '0')
  const mm = String(now.getMinutes()).padStart(2, '0')
  const ss = String(now.getSeconds()).padStart(2, '0')
  logLines.value.push(`[${hh}:${mm}:${ss}] ${message}`)
}

function formatErr(error: unknown) {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`
  }
  if (error instanceof Event) {
    const target = error.target as HTMLImageElement | HTMLLinkElement | null
    const targetInfo = target
      ? `${target.tagName} src=${(target as HTMLImageElement).src || ''} href=${(target as HTMLLinkElement).href || ''}`
      : 'unknown-target'
    return `Event(${error.type}) ${targetInfo}`
  }
  return String(error)
}

function extractForceFlattenStats(text: string) {
  const single = text.match(/强压单子容器(\d+)/)
  const multi = text.match(/强压多子容器(\d+)/)
  return {
    single: single ? Number(single[1]) : null,
    multi: multi ? Number(multi[1]) : null,
  }
}

function isTaintedCanvasError(error: unknown) {
  const text = formatErr(error).toLowerCase()
  return text.includes('tainted canvases') || text.includes('securityerror')
}

async function withTimeout<T>(task: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: number | null = null
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = window.setTimeout(() => reject(new Error(`${label} 超时(${ms}ms)`)), ms)
  })
  try {
    return await Promise.race([task, timeoutPromise])
  } finally {
    if (timer !== null) {
      window.clearTimeout(timer)
    }
  }
}

function getNodeComputedStyle(node: Element) {
  const view = node.ownerDocument?.defaultView || window
  return view.getComputedStyle(node)
}

function getDocumentFonts(doc: Document) {
  const withFonts = doc as Document & { fonts?: FontFaceSet }
  return withFonts.fonts ?? null
}

const logText = computed(() => logLines.value.join('\n'))

async function copyLog() {
  try {
    await navigator.clipboard.writeText(logText.value)
    status.value = '日志已复制，可直接粘贴给我'
  } catch {
    status.value = '复制失败，请手动复制日志文本'
  }
}

function clearLog() {
  logLines.value = []
  appendLog('日志已清空')
}

function normalizeCustomWidth() {
  customPageWidth.value = normalizeWidth(customPageWidth.value)
}

function isLikelyHttpUrl(raw: string) {
  const text = raw.trim()
  if (!text || /\s/.test(text)) {
    return false
  }
  try {
    const parsed = new URL(text)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

async function fetchHtmlFromUrl(rawUrl: string) {
  const url = rawUrl.trim()
  if (!url) {
    status.value = '未输入页面链接'
    return
  }
  if (isGenerating.value || isFetching.value) {
    return
  }
  isFetching.value = true
  const originalInput = htmlInput.value
  try {
    appendLog(`开始抓取链接: ${url}`)
    const response = await fetch(url)
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`)
    }
    const text = await response.text()
    htmlInput.value = text
    lastInputUrl.value = url
    if (!baseUrl.value.trim()) {
      const target = new URL(url)
      baseUrl.value = `${target.origin}/`
    }
    status.value = `已抓取 HTML，开始导入: ${url}`
    appendLog(`抓取成功: ${url}, html=${text.length} chars`)
    appendLog('开始执行可编辑导入...')
    await convertEditable()
  } catch (error) {
    status.value = '抓取失败（可能是跨域限制）'
    appendLog(`抓取失败: ${formatErr(error)}`)
  } finally {
    htmlInput.value = originalInput
    isFetching.value = false
  }
}

async function convertSmartInput() {
  const text = htmlInput.value.trim()
  if (!text) {
    status.value = '请输入网页链接或 HTML'
    return
  }
  if (isLikelyHttpUrl(text)) {
    await fetchHtmlFromUrl(text)
    return
  }
  lastInputUrl.value = ''
  await convertEditable()
}

function onHtmlFileChange(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0] || null
  selectedHtmlFile.value = file
  selectedHtmlFileName.value = file?.name || ''
}

async function importHtmlFile() {
  if (!selectedHtmlFile.value) {
    status.value = '请先选择 HTML 文件'
    return
  }
  if (isGenerating.value || isFetching.value) {
    return
  }
  try {
    appendLog(`开始读取文件: ${selectedHtmlFile.value.name}`)
    const text = await selectedHtmlFile.value.text()
    htmlInput.value = text
    appendLog(`文件读取成功: ${selectedHtmlFile.value.name}, html=${text.length} chars`)
    appendLog('开始执行可编辑导入...')
    status.value = `已读取文件，开始导入: ${selectedHtmlFile.value.name}`
    await convertEditable()
  } catch (error) {
    status.value = '文件读取失败'
    appendLog(`文件读取失败: ${formatErr(error)}`)
  }
}

function handlePluginMessage(event: MessageEvent) {
  const payload = event.data?.pluginMessage ?? event.data
  if (!payload || typeof payload !== 'object') {
    return
  }
  const pluginMsg = payload as { type?: string; data?: unknown }
  const type = String(pluginMsg.type || '').toLowerCase()
  if (type === PluginMessage.SUCCESS || type === PluginMessage.ERROR) {
    const text = String(pluginMsg.data || '')
    status.value = text
    appendLog(`主线程回执: ${type} -> ${text}`)
    if (type === PluginMessage.SUCCESS) {
      const stats = extractForceFlattenStats(text)
      if (stats.single !== null || stats.multi !== null) {
        appendLog(`强压统计: 单子容器=${stats.single ?? '-'}, 多子容器=${stats.multi ?? '-'}`)
      }
    }
  }
}

async function waitForImages(root: HTMLElement) {
  const images = Array.from(root.querySelectorAll('img'))
  if (!images.length) {
    return { loaded: 0, failed: 0, failedUrls: [] as string[] }
  }

  const IMAGE_TIMEOUT_MS = 8000
  const imageTasks = images.map((img) => {
    const src = img.currentSrc || img.src || ''
    const run = () => {
      if (!src || src === 'data:') {
        return Promise.reject(new Error('empty image src'))
      }
      if (img.complete && img.naturalWidth > 0) {
        return Promise.resolve()
      }
      if (img.complete && img.naturalWidth === 0) {
        return Promise.reject(new Error('image load failed'))
      }
      return new Promise<void>((resolve, reject) => {
        const timer = window.setTimeout(() => {
          cleanup()
          reject(new Error('image load timeout'))
        }, IMAGE_TIMEOUT_MS)
        const onLoad = () => {
          cleanup()
          resolve()
        }
        const onError = () => {
          cleanup()
          reject(new Error('image load failed'))
        }
        const cleanup = () => {
          window.clearTimeout(timer)
          img.removeEventListener('load', onLoad)
          img.removeEventListener('error', onError)
        }
        img.addEventListener('load', onLoad)
        img.addEventListener('error', onError)
      })
    }
    return { src, run }
  })

  const results = await Promise.allSettled(imageTasks.map((task) => task.run()))

  const loaded = results.filter((item) => item.status === 'fulfilled').length
  const failed = results.length - loaded
  const failedUrls = results
    .map((result, index) => ({ result, index }))
    .filter((item) => item.result.status === 'rejected')
    .map((item) => imageTasks[item.index].src)
  return { loaded, failed, failedUrls: [...new Set(failedUrls)] }
}

function extractCssImageUrls(backgroundImageValue: string) {
  const urls: string[] = []
  const regex = /url\((['"]?)(.*?)\1\)/g
  let match: RegExpExecArray | null = regex.exec(backgroundImageValue)
  while (match) {
    const raw = (match[2] || '').trim()
    if (raw && !raw.startsWith('data:')) {
      urls.push(raw)
    }
    match = regex.exec(backgroundImageValue)
  }
  return urls
}

async function waitForBackgroundImages(root: HTMLElement) {
  const nodes = [root, ...Array.from(root.querySelectorAll<HTMLElement>('*')).slice(0, 2200)]
  const urlSet = new Set<string>()
  const view = root.ownerDocument?.defaultView || window
  nodes.forEach((node) => {
    const style = getNodeComputedStyle(node)
    extractCssImageUrls(style.backgroundImage || '').forEach((url) => urlSet.add(url))
  })
  const urls = [...urlSet]
  if (!urls.length) {
    return { loaded: 0, failed: 0, failedUrls: [] as string[] }
  }

  const BG_TIMEOUT_MS = 5000
  const results = await Promise.allSettled(
    urls.map(
      (src) =>
        new Promise<void>((resolve, reject) => {
          const img = new view.Image()
          const timer = view.setTimeout(() => {
            cleanup()
            reject(new Error('bg image timeout'))
          }, BG_TIMEOUT_MS)
          const cleanup = () => {
            view.clearTimeout(timer)
            img.onload = null
            img.onerror = null
          }
          img.onload = () => {
            cleanup()
            resolve()
          }
          img.onerror = () => {
            cleanup()
            reject(new Error('bg image failed'))
          }
          img.src = src
        }),
    ),
  )

  const loaded = results.filter((item) => item.status === 'fulfilled').length
  const failed = results.length - loaded
  const failedUrls = results
    .map((result, index) => ({ result, index }))
    .filter((item) => item.result.status === 'rejected')
    .map((item) => urls[item.index])
  return { loaded, failed, failedUrls }
}

async function loadExternalCssLinks(urls: string[], doc: Document) {
  const uniqueUrls = [...new Set(urls.filter(Boolean))]
  if (!uniqueUrls.length) {
    return { loaded: 0, failed: 0, failedUrls: [] as string[] }
  }

  const view = doc.defaultView || window
  const results = await Promise.allSettled(
    uniqueUrls.map((url) => new Promise<void>((resolve, reject) => {
      const link = doc.createElement('link')
      link.rel = 'stylesheet'
      link.href = url

      const timer = view.setTimeout(() => {
        cleanup()
        reject(new Error(`timeout: ${url}`))
      }, 8000)

      const cleanup = () => {
        view.clearTimeout(timer)
        link.removeEventListener('load', onLoad)
        link.removeEventListener('error', onError)
      }
      const onLoad = () => {
        cleanup()
        resolve()
      }
      const onError = () => {
        cleanup()
        reject(new Error(`error: ${url}`))
      }

      link.addEventListener('load', onLoad)
      link.addEventListener('error', onError)
      doc.head.appendChild(link)
    })),
  )

  const loaded = results.filter((item) => item.status === 'fulfilled').length
  const failed = results.length - loaded
  const failedUrls = results
    .map((item, index) => ({ item, index }))
    .filter((item) => item.item.status === 'rejected')
    .map((item) => uniqueUrls[item.index])
  return { loaded, failed, failedUrls }
}

function isNoiseCss(cssText: string) {
  const lower = cssText.toLowerCase()
  return (
    lower.includes('simpread') ||
    lower.includes('sr-rd') ||
    lower.includes('chrome-extension://') ||
    lower.includes('eagle-drag-images') ||
    lower.includes('trancy')
  )
}

function toAbsoluteUrl(value: string, activeBase: string) {
  if (!value || !activeBase) {
    return value
  }
  if (value.startsWith('data:') || value.startsWith('javascript:') || value.startsWith('#')) {
    return value
  }
  try {
    return new URL(value, activeBase).toString()
  } catch {
    return value
  }
}

function rewriteNextImageProxy(url: string) {
  try {
    const u = new URL(url)
    if (u.pathname !== '/_next/image') {
      return url
    }
    const raw = u.searchParams.get('url')
    if (!raw) {
      return url
    }
    return decodeURIComponent(raw)
  } catch {
    return url
  }
}

function parseHostFromUrl(value: string) {
  if (!value) return ''
  try {
    return new URL(value).hostname.toLowerCase()
  } catch {
    return ''
  }
}

function isBaiduHost(host: string) {
  return host === 'baidu.com' || host.endsWith('.baidu.com')
}

function applySiteSpecificThemeFixes(frameDoc: Document, rootEl: HTMLElement, activeBase: string) {
  const host = parseHostFromUrl(activeBase || lastInputUrl.value.trim())
  if (!isBaiduHost(host)) {
    return
  }

  const stripClass = (el: Element | null) => {
    if (!el) return
    const classNames = (el.getAttribute('class') || '')
      .split(/\s+/)
      .map((item) => item.trim())
      .filter(Boolean)
      .filter((item) => !/(^|-)skin(-|$)|night|dark|theme/i.test(item))
    if (classNames.length) {
      el.setAttribute('class', classNames.join(' '))
    } else {
      el.removeAttribute('class')
    }
  }

  stripClass(frameDoc.documentElement)
  stripClass(frameDoc.body)
  stripClass(rootEl)

  Array.from(frameDoc.querySelectorAll<HTMLElement>('[class*="skin"], [id*="skin"], [class*="bg"], [id*="bg"]'))
    .slice(0, 300)
    .forEach((node) => {
      const style = getNodeComputedStyle(node)
      const isFloating = style.position === 'fixed' || style.position === 'absolute'
      const rect = node.getBoundingClientRect()
      const isLarge = rect.width >= rootEl.getBoundingClientRect().width * 0.7 && rect.height >= 140
      const blackLike = /(rgb\(0,\s*0,\s*0\)|rgba\(0,\s*0,\s*0|#000)/i.test(style.backgroundColor || '')
      if (isFloating && isLarge && blackLike) {
        node.style.display = 'none'
      }
    })

  const forceLightStyle = frameDoc.createElement('style')
  forceLightStyle.textContent = `
    html, body {
      background-color: #f5f5f6 !important;
      background-image: none !important;
    }
    #s_wrap, #wrapper_wrapper, #head_wrapper {
      background-image: none !important;
    }
    #s_skin_layer, #s-main-bg, .s-skin-layer, .s-skin-container, .s-skin-bg, .s-bg-img {
      display: none !important;
      background: none !important;
    }
  `
  frameDoc.head.appendChild(forceLightStyle)
  appendLog('站点修正: baidu 皮肤层已禁用（强制浅色背景）')
}

type ParsedHtmlPayload = {
  rootHtml: string
  inlineCss: string
  cssLinks: string[]
  inferredBaseUrl: string
}

function parseHtmlPayload(raw: string): ParsedHtmlPayload {
  const parser = new DOMParser()
  const doc = parser.parseFromString(raw, 'text/html')

  const baseHref = doc.querySelector('base')?.getAttribute('href')?.trim() ?? ''
  let inferredBaseUrl = baseHref
  if (!inferredBaseUrl) {
    const absRef = doc.querySelector('link[href^="http"],script[src^="http"]') as HTMLLinkElement | HTMLScriptElement | null
    if (absRef) {
      const url = absRef.getAttribute('href') || absRef.getAttribute('src') || ''
      try {
        inferredBaseUrl = new URL(url).origin
      } catch {
        inferredBaseUrl = ''
      }
    }
  }

  const manualBase = baseUrl.value.trim()
  const activeBase = manualBase || inferredBaseUrl

  const cssLinks = Array.from(doc.querySelectorAll<HTMLLinkElement>('link[rel~="stylesheet"][href]'))
    .map((link) => (link.getAttribute('href') || '').trim())
    .filter((href) => href && !href.includes('chrome-extension://'))
    .map((href) => toAbsoluteUrl(href, activeBase))

  const inlineCss = Array.from(doc.querySelectorAll('style'))
    .map((style) => style.textContent || '')
    .filter((text) => text.trim() && !isNoiseCss(text))
    .join('\n')

  const root = doc.querySelector('#root')
  const rootHtml = root?.outerHTML?.trim() || doc.body?.innerHTML?.trim() || raw

  return {
    rootHtml,
    inlineCss,
    cssLinks,
    inferredBaseUrl,
  }
}

function absolutizeAssetUrls(root: HTMLElement, activeBase: string) {
  if (!activeBase) {
    return
  }
  const attrs = ['src', 'href', 'poster']
  const nodes = Array.from(root.querySelectorAll<HTMLElement>('*'))
  for (const node of nodes) {
    for (const attr of attrs) {
      const value = node.getAttribute(attr)
      if (!value || value.startsWith('data:') || value.startsWith('javascript:') || value.startsWith('#')) {
        continue
      }
      try {
        const abs = new URL(value, activeBase).toString()
        node.setAttribute(attr, abs)
      } catch {
        // ignore invalid URLs
      }
    }
  }
}

function rewriteImageProxyUrls(root: HTMLElement) {
  let rewritten = 0
  const imgs = Array.from(root.querySelectorAll<HTMLImageElement>('img'))
  imgs.forEach((img) => {
    const src = img.getAttribute('src') || ''
    if (src) {
      const nextSrc = rewriteNextImageProxy(src)
      if (nextSrc !== src) {
        img.setAttribute('src', nextSrc)
        rewritten += 1
      }
    }
    const srcset = img.getAttribute('srcset') || ''
    if (srcset) {
      const nextSrcset = srcset
        .split(',')
        .map((item) => {
          const trimmed = item.trim()
          if (!trimmed) return trimmed
          const parts = trimmed.split(/\s+/)
          const next = rewriteNextImageProxy(parts[0] || '')
          if (next !== (parts[0] || '')) {
            rewritten += 1
          }
          parts[0] = next
          return parts.join(' ')
        })
        .join(', ')
      img.setAttribute('srcset', nextSrcset)
    }
  })
  return rewritten
}

function normalizePositionedElements(root: HTMLElement) {
  const rootRect = root.getBoundingClientRect()
  const allNodes = Array.from(root.querySelectorAll<HTMLElement>('*'))
  allNodes.forEach((node) => {
    const style = getNodeComputedStyle(node)
    if (style.position === 'fixed') {
      const rect = node.getBoundingClientRect()
      node.style.position = 'absolute'
      node.style.top = `${Math.max(0, rect.top - rootRect.top)}px`
      node.style.left = `${Math.max(0, rect.left - rootRect.left)}px`
      if (!node.style.width || node.style.width === 'auto') {
        node.style.width = `${rect.width}px`
      }
      if (!node.style.height || node.style.height === 'auto') {
        node.style.height = `${rect.height}px`
      }
    } else if (style.position === 'sticky') {
      node.style.position = 'relative'
      node.style.top = '0px'
    }
  })
}

function stripFullscreenDarkMasks(root: HTMLElement) {
  const rootRect = root.getBoundingClientRect()
  const nodes = Array.from(root.querySelectorAll<HTMLElement>('*'))
  let removed = 0
  nodes.forEach((node) => {
    const style = getNodeComputedStyle(node)
    const rect = node.getBoundingClientRect()
    const bg = style.backgroundColor || ''
    const isDarkBg =
      bg.includes('rgb(0, 0, 0)') ||
      bg.includes('rgb(0 0 0)') ||
      bg.includes('rgba(0, 0, 0') ||
      bg.includes('rgba(0 0 0')
    const bigEnough =
      rect.width >= rootRect.width * 0.9 &&
      rect.height >= rootRect.height * 0.45
    const floated = style.position === 'fixed' || style.position === 'absolute'
    const highLayer = Number(style.zIndex || '0') >= 1
    if (isDarkBg && bigEnough && floated && highLayer) {
      node.remove()
      removed += 1
    }
  })
  return removed
}

function dataUrlToSvgString(dataUrl: string) {
  const commaIndex = dataUrl.indexOf(',')
  if (commaIndex < 0) {
    throw new Error('SVG dataURL 无效')
  }
  const header = dataUrl.slice(0, commaIndex)
  const body = dataUrl.slice(commaIndex + 1)
  if (header.includes(';base64')) {
    return atob(body)
  }
  return decodeURIComponent(body)
}

function isTransparentColor(value: string) {
  const text = (value || '').trim().toLowerCase()
  if (!text) return true
  if (text === 'transparent') return true
  if (text === 'rgba(0, 0, 0, 0)' || text === 'rgba(0 0 0 / 0)') return true
  const rgba = text.match(/rgba?\(([^)]+)\)/)
  if (!rgba) return false
  const parts = rgba[1].split(',').map((v) => v.trim())
  if (parts.length < 4) return false
  const alpha = Number(parts[3])
  return Number.isFinite(alpha) && alpha <= 0
}

function normalizeFontFamilyToken(raw: string) {
  return raw.trim().replace(/^['"]|['"]$/g, '')
}

function extractFontCandidates(root: HTMLElement) {
  const generic = new Set([
    'serif',
    'sans-serif',
    'monospace',
    'cursive',
    'fantasy',
    'system-ui',
    'ui-sans-serif',
    'ui-serif',
    'ui-monospace',
  ])
  const nodes = [root, ...Array.from(root.querySelectorAll<HTMLElement>('*')).slice(0, 1200)]
  const families = new Set<string>()
  for (const node of nodes) {
    const fontFamily = getNodeComputedStyle(node).fontFamily || ''
    if (!fontFamily) continue
    const first = normalizeFontFamilyToken(fontFamily.split(',')[0] || '')
    if (!first) continue
    if (generic.has(first.toLowerCase())) continue
    families.add(first)
  }
  return [...families]
}

async function preloadFonts(root: HTMLElement) {
  const fonts = getDocumentFonts(root.ownerDocument)
  if (!fonts) {
    return { loaded: 0, failed: [] as string[] }
  }
  const families = extractFontCandidates(root)
  if (!families.length) {
    return { loaded: 0, failed: [] as string[] }
  }
  const results = await Promise.allSettled(
    families.map((family) =>
      withTimeout(fonts.load(`400 16px "${family}"`), 1800, `font:${family}`),
    ),
  )
  const loaded = results.filter((item) => item.status === 'fulfilled').length
  const failed = results
    .map((item, index) => ({ item, index }))
    .filter((entry) => entry.item.status === 'rejected')
    .map((entry) => families[entry.index])
  return { loaded, failed }
}

async function createRenderFrame(mount: HTMLElement, width: number) {
  const frame = document.createElement('iframe')
  frame.style.position = 'fixed'
  frame.style.left = '-30000px'
  frame.style.top = '-30000px'
  frame.style.width = `${width}px`
  frame.style.height = '960px'
  frame.style.border = '0'
  frame.style.opacity = '0'
  frame.style.pointerEvents = 'none'
  mount.appendChild(frame)

  await new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error('iframe 初始化超时')), 3000)
    frame.onload = () => {
      window.clearTimeout(timer)
      resolve()
    }
    frame.srcdoc = '<!doctype html><html><head><meta charset="UTF-8"></head><body></body></html>'
  })

  const frameDoc = frame.contentDocument
  if (!frameDoc) {
    frame.remove()
    throw new Error('无法创建渲染文档')
  }
  return { frame, frameDoc }
}

async function buildRenderRoot(mount: HTMLElement) {
  const parsed = parseHtmlPayload(htmlInput.value)
  const manualLinks = cssLinksInput.value
    .split('\n')
    .map((item) => item.trim())
    .filter(Boolean)
  const activeBase = baseUrl.value.trim() || parsed.inferredBaseUrl
  const allCssLinks = [...parsed.cssLinks, ...manualLinks.map((item) => toAbsoluteUrl(item, activeBase))]
  appendLog(`开始解析: html=${htmlInput.value.length} chars, 自动CSS=${parsed.cssLinks.length}, 手动CSS=${manualLinks.length}`)
  const hasRelativeAssets = [...parsed.cssLinks, ...manualLinks].some((item) => item.startsWith('/'))
  if (hasRelativeAssets && !activeBase) {
    throw new Error('检测到相对资源路径(/assets...)，请填写“基准 URL”')
  }

  mount.innerHTML = ''
  const renderWidth = Math.max(320, Number(pageWidth.value) || 1366)
  const { frame, frameDoc } = await createRenderFrame(mount, renderWidth)

  const styleEl = frameDoc.createElement('style')
  styleEl.textContent = `
    :root { color-scheme: light !important; }
    html, body {
      margin: 0 !important;
      padding: 0 !important;
      width: ${renderWidth}px !important;
      min-width: ${renderWidth}px !important;
      overflow-x: hidden !important;
    }
    ${parsed.inlineCss}
    ${cssInput.value || ''}
  `
  const rootEl = frameDoc.createElement('div')
  rootEl.className = 'convert-root'
  rootEl.style.width = `${renderWidth}px`
  rootEl.style.margin = '0'
  rootEl.innerHTML = parsed.rootHtml
  absolutizeAssetUrls(rootEl, activeBase)
  const rewrittenImageCount = rewriteImageProxyUrls(rootEl)
  appendLog(`图片URL重写: ${rewrittenImageCount} 项`)
  frameDoc.head.appendChild(styleEl)
  const cssState = await loadExternalCssLinks(allCssLinks, frameDoc)
  appendLog(`外链CSS加载: success=${cssState.loaded}, failed=${cssState.failed}`)
  if (cssState.failedUrls.length) {
    appendLog(`外链CSS失败列表: ${cssState.failedUrls.join(' | ')}`)
  }
  frameDoc.body.appendChild(rootEl)
  applySiteSpecificThemeFixes(frameDoc, rootEl, activeBase)
  appendLog(`渲染视口: iframe=${renderWidth}x960`)
  const bodyBg = getNodeComputedStyle(frameDoc.body).backgroundColor || ''
  const htmlBg = getNodeComputedStyle(frameDoc.documentElement).backgroundColor || ''
  if (isTransparentColor(bodyBg) && isTransparentColor(htmlBg)) {
    frameDoc.body.style.backgroundColor = '#ffffff'
    rootEl.style.backgroundColor = '#ffffff'
    appendLog('背景兜底: 检测到透明背景，已自动补白')
  } else {
    appendLog(`背景检测: body=${bodyBg || 'none'}, html=${htmlBg || 'none'}`)
  }
  const enableLayoutFixes = false
  if (enableLayoutFixes) {
    const removedMasks = stripFullscreenDarkMasks(rootEl)
    appendLog(`遮罩清理: removed=${removedMasks}`)
    normalizePositionedElements(rootEl)
    appendLog('布局干预: enabled')
  } else {
    // Keep source layout unchanged; over-aggressive normalization can cause header collapse.
    appendLog('布局干预: skipped')
  }
  appendLog(`渲染根节点就绪: width=${Math.round(rootEl.getBoundingClientRect().width)}, height=${Math.round(rootEl.getBoundingClientRect().height)}`)
  appendLog('预加载页面字体...')
  const fontLoadState = await preloadFonts(rootEl)
  appendLog(`字体预加载: success=${fontLoadState.loaded}, failed=${fontLoadState.failed.length}`)
  if (fontLoadState.failed.length) {
    appendLog(`字体失败列表(${fontLoadState.failed.length}): ${fontLoadState.failed.slice(0, 12).join(', ')}`)
  }
  const fonts = getDocumentFonts(frameDoc)
  if (fonts && 'ready' in fonts) {
    appendLog('等待字体加载...')
    await fonts.ready
    appendLog('字体加载完成')
  }
  const imageCount = rootEl.querySelectorAll('img').length
  appendLog(`等待图片加载... count=${imageCount}`)
  const imageStart = Date.now()
  let imageState = { loaded: 0, failed: imageCount, failedUrls: [] as string[] }
  try {
    imageState = await withTimeout(waitForImages(rootEl), 10000, 'waitForImages')
  } catch (err) {
    appendLog(`图片阶段总超时，继续转换: ${formatErr(err)}`)
  }
  appendLog(`图片加载: success=${imageState.loaded}, failed=${imageState.failed}, elapsed=${Date.now() - imageStart}ms`)
  appendLog('等待背景图加载...')
  const bgStart = Date.now()
  const bgState = await waitForBackgroundImages(rootEl)
  appendLog(`背景图加载: success=${bgState.loaded}, failed=${bgState.failed}, elapsed=${Date.now() - bgStart}ms`)
  return {
    rootEl,
    cssState,
    imageState,
    cleanup: () => {
      frame.remove()
    },
  }
}

async function rasterizeWithHtml2Canvas(rootEl: HTMLElement, safeMode: boolean) {
  const target = safeMode ? rootEl.cloneNode(true) as HTMLElement : rootEl
  if (safeMode) {
    // Remove external image sources to avoid tainted canvas.
    target.querySelectorAll('img').forEach((img) => {
      img.setAttribute('src', 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==')
      img.removeAttribute('srcset')
    })
    const safetyStyle = document.createElement('style')
    safetyStyle.textContent = `
      * { background-image: none !important; }
      video, canvas, iframe, svg image { display: none !important; }
    `
    target.prepend(safetyStyle)
    target.style.backgroundColor = '#0b1020'
    target.style.color = '#e5e7eb'
    target.style.position = 'fixed'
    target.style.left = '-20000px'
    target.style.top = '-20000px'
    document.body.appendChild(target)
  }

  try {
    const canvas = await html2canvas(target, {
      useCORS: true,
      allowTaint: true,
      scale: 1,
      backgroundColor: null,
      logging: false,
      imageTimeout: 8000,
    })
    const dataUrl = canvas.toDataURL('image/png')
    return {
      dataUrl,
      width: Math.max(1, canvas.width),
      height: Math.max(1, canvas.height),
    }
  } finally {
    if (safeMode) {
      target.remove()
    }
  }
}

async function convertHtml(editable: boolean) {
  if (isGenerating.value) {
    return
  }
  if (!htmlInput.value.trim()) {
    status.value = '请输入 HTML'
    return
  }

  const mount = mountRef.value
  if (!mount) {
    status.value = '运行失败：渲染容器未就绪'
    return
  }

  isGenerating.value = true
  status.value = editable ? '正在可编辑转换...' : '正在高保真截图...'
  appendLog(`启动转换: mode=${editable ? 'editable' : 'snapshot'}, width=${pageWidth.value}, baseUrl=${baseUrl.value || '(auto)'}`)
  let cleanupRender: (() => void) | null = null
  try {
    if (editable) {
      const viewportWidth = Math.max(420, Math.min(520, Math.round((Number(pageWidth.value) || 1200) * 0.3)))
      const viewportHeight = 380
      sendMsgToPlugin({
        type: UIMessage.RESIZE_UI,
        data: {
          width: viewportWidth,
          height: viewportHeight,
        },
      })
      appendLog(`请求调整UI窗口: ${viewportWidth}x${viewportHeight}`)
      await new Promise((resolve) => setTimeout(resolve, 260))
    }
    const renderState = await buildRenderRoot(mount)
    cleanupRender = renderState.cleanup
    const { rootEl, cssState, imageState } = renderState
    if (editable) {
      appendLog('开始执行 htmlToMG...')
      const layerJson = await withTimeout(htmlToMG(rootEl), 30000, 'htmlToMG')
      if (!layerJson) {
        throw new Error('未能从输入 HTML 生成节点')
      }
      appendLog('htmlToMG 完成，开始 postProcess...')
      const processedJson = await withTimeout(postProcess(layerJson), 20000, 'postProcess')
      const finalJson = (processedJson && typeof processedJson === 'object') ? processedJson : layerJson
      if (!(processedJson && typeof processedJson === 'object')) {
        appendLog('postProcess返回异常，已回退使用htmlToMG原始结果')
      }
      appendLog(`自动布局后处理: ${enableAutoLayout.value ? 'on' : 'off'}`)
      appendLog('可编辑转换成功，已发送图层JSON到主线程')
      sendMsgToPlugin({
        type: UIMessage.GENERATE,
        data: {
          json: finalJson,
          backupJson: layerJson,
          options: {
            autoLayout: enableAutoLayout.value,
          },
        },
      })
    } else {
      try {
        const dataUrl = await toPng(rootEl, {
          cacheBust: true,
          pixelRatio: 1,
          imagePlaceholder:
            'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==',
        })
        sendMsgToPlugin({
          type: UIMessage.GENERATE_BITMAP,
          data: {
            dataUrl,
            width: Math.max(1, Math.round(rootEl.getBoundingClientRect().width)),
            height: Math.max(1, Math.round(rootEl.getBoundingClientRect().height)),
            name: 'HTML Snapshot',
          },
        })
        appendLog('高保真PNG渲染成功，已发送位图到主线程')
      } catch (pngErr) {
        appendLog(`高保真PNG失败，切换SVG兜底: ${formatErr(pngErr)}`)
        try {
          const svgDataUrl = await toSvg(rootEl, {
            cacheBust: true,
            imagePlaceholder:
              'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==',
          })
          const svg = dataUrlToSvgString(svgDataUrl)
          sendMsgToPlugin({
            type: UIMessage.GENERATE_SVG,
            data: {
              svg,
              name: 'HTML Snapshot SVG',
            },
          })
          appendLog('高保真SVG渲染成功，已发送SVG到主线程')
        } catch (svgErr) {
          appendLog(`高保真SVG失败，切换html2canvas兜底: ${formatErr(svgErr)}`)
          try {
            const result = await rasterizeWithHtml2Canvas(rootEl, false)
            sendMsgToPlugin({
              type: UIMessage.GENERATE_BITMAP,
              data: {
                dataUrl: result.dataUrl,
                width: result.width,
                height: result.height,
                name: 'HTML Snapshot html2canvas',
              },
            })
            appendLog('html2canvas兜底成功，已发送位图到主线程')
          } catch (canvasErr) {
            if (!isTaintedCanvasError(canvasErr)) {
              throw canvasErr
            }
            appendLog(`html2canvas仍被污染，启用安全模式: ${formatErr(canvasErr)}`)
            const safeResult = await rasterizeWithHtml2Canvas(rootEl, true)
            sendMsgToPlugin({
              type: UIMessage.GENERATE_BITMAP,
              data: {
                dataUrl: safeResult.dataUrl,
                width: safeResult.width,
                height: safeResult.height,
                name: 'HTML Snapshot safe-mode',
              },
            })
            appendLog('安全模式截图成功（已移除跨域图片/背景图）')
          }
        }
      }
    }

    const notices = []
    if (imageState.failed > 0) {
      notices.push(`${imageState.failed} 张图片加载失败`)
    }
    if (cssState.failed > 0) {
      notices.push(`${cssState.failed} 条外链 CSS 加载失败`)
    }
    status.value = notices.length > 0
      ? `已发送到主线程（${notices.join('，')}）`
      : '已发送到主线程，正在绘制...'
  } catch (error) {
    status.value = error instanceof Error ? error.message : '转换失败'
    appendLog(`转换失败: ${formatErr(error)}`)
  } finally {
    if (cleanupRender) {
      cleanupRender()
    }
    isGenerating.value = false
  }
}

async function convertEditable() {
  await convertHtml(true)
}

onMounted(() => {
  window.addEventListener('message', handlePluginMessage)
  appendLog(`测试环境: UI启动, UA=${navigator.userAgent}`)
  appendLog('请复制本日志并反馈，我会按日志定位问题')
})

onUnmounted(() => {
  window.removeEventListener('message', handlePluginMessage)
})
</script>

<style scoped>
.app {
  box-sizing: border-box;
  width: 100%;
  max-width: 980px;
  margin: 0 auto;
  min-height: calc(100vh - 16px);
  padding: 24px 24px 16px;
  background: linear-gradient(180deg, #f7faff 0%, #ffffff 52%);
  border: 1px solid #e3e9f6;
  border-radius: 14px;
  box-shadow: 0 8px 22px rgba(26, 66, 150, 0.08);
  font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif;
  overflow-x: hidden;
}

.app * {
  box-sizing: border-box;
  min-width: 0;
}

h1 {
  margin: 0 0 8px;
  font-size: 18px;
  font-weight: 800;
  letter-spacing: 0.2px;
  line-height: 1.1;
  background: linear-gradient(90deg, #1f5eff 0%, #26b3ff 55%, #6a5bff 100%);
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
}

.hint {
  margin: 10px 0 20px;
  font-size: 12px;
  line-height: 1.5;
  color: #6a7387;
}

.size-switch {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 14px;
}

.size-label {
  font-size: 13px;
  color: #5b6780;
}

.size-chip {
  border: 1px solid #d7e0f4;
  border-radius: 8px;
  background: #ffffff;
  color: #4d5a73;
  padding: 4px 10px;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
}

.size-chip.active {
  border-color: #2f6dff;
  background: #eef4ff;
  color: #2f6dff;
}

.size-custom-input {
  width: 92px;
  height: 28px;
  border: 1px solid #d7e0f4;
  border-radius: 8px;
  background: #fff;
  color: #2d3a52;
  padding: 0 8px;
  font-size: 12px;
  outline: none;
}

.size-custom-input:focus {
  border-color: #2f6dff;
  box-shadow: 0 0 0 2px rgba(47, 109, 255, 0.12);
}

.size-custom-input:disabled {
  background: #f5f7fc;
  color: #9aa6bf;
}

.size-unit {
  font-size: 12px;
  color: #7a859d;
  margin-left: -2px;
}

.mode-switch {
  display: inline-flex;
  gap: 3px;
  padding: 3px;
  border-radius: 8px;
  border: 1px solid #dce7ff;
  background: #f3f7ff;
  margin-bottom: 16px;
}

.mode-tab {
  border: 1px solid transparent;
  border-radius: 7px;
  background: transparent;
  color: #4f5c75;
  padding: 6px 10px;
  font-size: 12px;
  font-weight: 600;
  line-height: 1.2;
  cursor: pointer;
  transition: all 0.2s ease;
}

.mode-tab.active {
  border-color: #2f6dff;
  background: #2f6dff;
  color: #fff;
}

.panel {
  margin-bottom: 10px;
}

.inline-input-action {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
}

.sub-hint {
  margin: 10px 0 0;
  font-size: 12px;
  color: #777;
}

.upload-panel {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.file-input {
  width: 100%;
  height: 38px;
  padding: 6px 10px;
  border: 1px solid #d2dcec;
  border-radius: 10px;
  background: #fff;
  font-size: 12px;
  color: #2d3a52;
}

.upload-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.file-name {
  font-size: 12px;
  color: #6b7487;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.editor {
  box-sizing: border-box;
  width: 100%;
  max-width: 100%;
  min-height: 210px;
  resize: vertical;
  padding: 14px;
  border: 1px solid #d2dcec;
  border-radius: 10px;
  background: #ffffff;
  font-family: Menlo, Monaco, Consolas, "Courier New", monospace;
  font-size: 15px;
  line-height: 1.45;
  white-space: pre;
  overflow-wrap: normal;
  word-break: normal;
}

.editor::placeholder {
  color: #a8b0c0;
}

.editable-editor {
  min-height: 147px;
  font-size: 12px;
}

.import-actions {
  display: flex;
  flex-direction: row;
  justify-content: center;
  align-items: center;
  gap: 12px;
  margin-top: 14px;
  flex-wrap: wrap;
}

.collapse {
  margin-top: 10px;
  border: 1px solid #e3e3e3;
  border-radius: 8px;
  padding: 8px;
  background: #fafafa;
}

.collapse summary {
  cursor: pointer;
  font-size: 12px;
  color: #444;
  user-select: none;
}

.log-actions {
  display: flex;
  gap: 8px;
  margin-top: 8px;
}

.log-actions .btn {
  height: 30px;
  min-width: auto;
  border-radius: 8px;
  padding: 0 10px;
  font-size: 12px;
}

.log-editor {
  min-height: 160px;
  margin-top: 8px;
  font-size: 12px;
  line-height: 1.45;
}

.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 12px;
  width: 100%;
}

.switch-inline {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: #555;
  user-select: none;
}

.switch-inline input {
  margin: 0;
}

.btn {
  border: 1px solid transparent;
  border-radius: 10px;
  padding: 0 14px;
  height: 34px;
  min-width: 78px;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.btn.primary {
  border-color: #2f6dff;
  background: linear-gradient(180deg, #4283ff 0%, #2f6dff 100%);
  color: #fff;
  min-width: 82px;
}

.btn.ghost {
  border: 1px solid #d8deea;
  background: #f6f8fd;
  color: #485770;
}

.status {
  margin-top: 10px;
  font-size: 13px;
  color: #444;
  word-break: break-all;
}

.hidden-mount {
  position: fixed;
  left: 0;
  top: 0;
  opacity: 0;
  z-index: -1;
  pointer-events: none;
}

@media (max-width: 680px) {
  h1 {
    font-size: 18px;
  }

  .hint {
    font-size: 12px;
  }

  .size-switch {
    flex-wrap: wrap;
  }

  .import-actions .btn.primary {
    width: 100%;
  }
}
</style>
