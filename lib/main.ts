import { UIMessage } from '@messages/sender'
import { PluginMessage, sendMsgToUI } from '@messages/sender'
import { renderToMasterGo } from '@mastergo/html-mastergo'

mg.showUI(__html__, { width: 460, height: 560 })

type SizeLikeNode = SceneNode & {
  x?: number
  y?: number
  width?: number
  height?: number
}

type AutoLayoutLikeNode = SceneNode & {
  children?: readonly SceneNode[]
  insertChild?: (index: number, child: SceneNode) => SceneNode
  appendChild?: (child: SceneNode) => void
  flexMode?: 'NONE' | 'HORIZONTAL' | 'VERTICAL'
  flexWrap?: 'WRAP' | 'NO_WRAP'
  itemSpacing?: number
  mainAxisAlignItems?: 'FLEX_START' | 'FLEX_END' | 'CENTER' | 'SPACING_BETWEEN'
  crossAxisAlignItems?: 'FLEX_START' | 'FLEX_END' | 'CENTER'
  mainAxisSizingMode?: 'FIXED' | 'AUTO'
  crossAxisSizingMode?: 'FIXED' | 'AUTO'
  paddingTop?: number
  paddingRight?: number
  paddingBottom?: number
  paddingLeft?: number
}

type AutoLayoutChildLike = SceneNode & {
  layoutPositioning?: 'AUTO' | 'ABSOLUTE'
  x?: number
  y?: number
}

type GroupLikeNode = AutoLayoutLikeNode & SizeLikeNode & {
  type?: string
  parent: (BaseNode & {
    children?: readonly SceneNode[]
    insertChild?: (index: number, child: SceneNode) => void
    appendChild?: (child: SceneNode) => void
  }) | null
  name: string
  opacity?: number
  blendMode?: string
  effects?: readonly Effect[]
  cornerRadius?: number | PluginAPI['mixed']
  topLeftRadius?: number
  topRightRadius?: number
  bottomLeftRadius?: number
  bottomRightRadius?: number
  isLocked?: boolean
  isVisible?: boolean
  removed: boolean
}

type WrapperLikeNode = GroupLikeNode & {
  type?: string
}

type ChildBox = {
  node: SceneNode
  x: number
  y: number
  width: number
  height: number
  right: number
  bottom: number
}

const isFiniteNumber = (value: unknown) => typeof value === 'number' && Number.isFinite(value)
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

const sanitizeLayerJson = (input: unknown): Record<string, unknown> | null => {
  const walk = (node: unknown): Record<string, unknown> | null => {
    if (!isRecord(node)) return null
    const out: Record<string, unknown> = {}
    Object.entries(node).forEach(([key, value]) => {
      if (key === 'children') return
      if (typeof value !== 'undefined') {
        out[key] = value
      }
    })
    if (Array.isArray((node as { children?: unknown[] }).children)) {
      const cleanedChildren = ((node as { children?: unknown[] }).children || [])
        .map((child) => walk(child))
        .filter((child): child is Record<string, unknown> => Boolean(child))
      if (cleanedChildren.length > 0) {
        out.children = cleanedChildren
      } else if (typeof out.type === 'string' && ['FRAME', 'GROUP', 'SECTION'].includes(String(out.type))) {
        out.children = []
      }
    }
    return out
  }
  return walk(input)
}

const getNodeBox = (node: SceneNode): ChildBox | null => {
  const n = node as SizeLikeNode
  const x = n.x
  const y = n.y
  const width = n.width
  const height = n.height
  if (!isFiniteNumber(x) || !isFiniteNumber(y) || !isFiniteNumber(width) || !isFiniteNumber(height)) {
    return null
  }
  if ((width as number) <= 0 || (height as number) <= 0) {
    return null
  }
  return {
    node,
    x: x as number,
    y: y as number,
    width: width as number,
    height: height as number,
    right: (x as number) + (width as number),
    bottom: (y as number) + (height as number),
  }
}

const median = (arr: number[]) => {
  if (!arr.length) return 0
  const sorted = [...arr].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2
  }
  return sorted[mid]
}

const canBeAutoLayoutContainer = (node: SceneNode): node is AutoLayoutLikeNode => {
  const n = node as AutoLayoutLikeNode
  return Array.isArray(n.children) && typeof n.flexMode !== 'undefined'
}

const canReparentChildren = (node: unknown): node is {
  children: readonly SceneNode[]
  insertChild: (index: number, child: SceneNode) => void
  appendChild: (child: SceneNode) => void
} => {
  const n = node as {
    children?: readonly SceneNode[]
    insertChild?: (index: number, child: SceneNode) => void
    appendChild?: (child: SceneNode) => void
  }
  return Array.isArray(n.children) && typeof n.insertChild === 'function' && typeof n.appendChild === 'function'
}

const setContainerAutoLayoutBase = (node: AutoLayoutLikeNode, direction: 'HORIZONTAL' | 'VERTICAL') => {
  node.flexMode = direction
  node.flexWrap = 'NO_WRAP'
  node.mainAxisSizingMode = 'FIXED'
  node.crossAxisSizingMode = 'FIXED'
  node.mainAxisAlignItems = 'FLEX_START'
  node.crossAxisAlignItems = 'FLEX_START'
}

const tryForceStackAutoLayout = (node: AutoLayoutLikeNode) => {
  const children = [...(node.children || [])]
  if (!children.length) return false

  const childBoxes = children.map(getNodeBox).filter((item): item is ChildBox => Boolean(item))
  if (!childBoxes.length) return false

  const minX = Math.min(...childBoxes.map((b) => b.x))
  const minY = Math.min(...childBoxes.map((b) => b.y))
  const maxRight = Math.max(...childBoxes.map((b) => b.right))
  const maxBottom = Math.max(...childBoxes.map((b) => b.bottom))

  const spreadX = maxRight - minX
  const spreadY = maxBottom - minY
  const direction: 'HORIZONTAL' | 'VERTICAL' = spreadX > spreadY ? 'HORIZONTAL' : 'VERTICAL'
  const sorted = [...childBoxes].sort((a, b) => (
    direction === 'HORIZONTAL' ? a.x - b.x : a.y - b.y
  ))

  const gaps: number[] = []
  for (let i = 0; i < sorted.length - 1; i += 1) {
    const prev = sorted[i]
    const next = sorted[i + 1]
    const prevEnd = direction === 'HORIZONTAL' ? prev.right : prev.bottom
    const nextStart = direction === 'HORIZONTAL' ? next.x : next.y
    gaps.push(Math.max(0, nextStart - prevEnd))
  }

  setContainerAutoLayoutBase(node, direction)
  node.itemSpacing = Math.max(0, Math.round(median(gaps.filter((g) => g > 0.5))))
  node.paddingLeft = Math.max(0, Math.round(minX))
  node.paddingTop = Math.max(0, Math.round(minY))
  const containerBox = getNodeBox(node)
  node.paddingRight = containerBox
    ? Math.max(0, Math.round(containerBox.width - maxRight))
    : 0
  node.paddingBottom = containerBox
    ? Math.max(0, Math.round(containerBox.height - maxBottom))
    : 0

  if (typeof node.insertChild === 'function') {
    sorted.forEach((b, index) => {
      node.insertChild!(index, b.node)
    })
  }

  let changed = 0
  sorted.forEach((b) => {
    const child = b.node as AutoLayoutChildLike
    if (child.removed) return
    child.layoutPositioning = 'AUTO'
    child.x = 0
    child.y = 0
    changed += 1
  })
  return changed > 0
}

const normalizeExistingAutoLayoutChildren = (node: AutoLayoutLikeNode) => {
  if (node.flexMode === 'NONE') return 0
  const children = [...(node.children || [])]
  let changed = 0
  children.forEach((child) => {
    const c = child as AutoLayoutChildLike
    if (c.layoutPositioning === 'AUTO') return
    if (child.removed) return
    c.layoutPositioning = 'AUTO'
    c.x = 0
    c.y = 0
    changed += 1
  })
  return changed
}

const axisScore = (boxes: ChildBox[], direction: 'HORIZONTAL' | 'VERTICAL') => {
  if (boxes.length < 2) return { score: 0, gaps: [] as number[], sorted: boxes }
  const sorted = [...boxes].sort((a, b) => (
    direction === 'HORIZONTAL'
      ? (a.x - b.x) || (a.y - b.y)
      : (a.y - b.y) || (a.x - b.x)
  ))
  let overlapHard = 0
  const gaps: number[] = []
  for (let i = 0; i < sorted.length - 1; i += 1) {
    const prev = sorted[i]
    const next = sorted[i + 1]
    const prevEnd = direction === 'HORIZONTAL' ? prev.right : prev.bottom
    const nextStart = direction === 'HORIZONTAL' ? next.x : next.y
    const gap = nextStart - prevEnd
    const overlapTolerance = Math.min(
      direction === 'HORIZONTAL' ? prev.width : prev.height,
      direction === 'HORIZONTAL' ? next.width : next.height,
    ) * 0.35 + 8
    if (gap < -overlapTolerance) {
      overlapHard += 1
    } else {
      gaps.push(Math.max(0, gap))
    }
  }
  const pairCount = Math.max(1, sorted.length - 1)
  const noOverlapRatio = (pairCount - overlapHard) / pairCount
  const crossStarts = sorted.map((b) => (direction === 'HORIZONTAL' ? b.y : b.x))
  const crossEnds = sorted.map((b) => (direction === 'HORIZONTAL' ? b.bottom : b.right))
  const crossSpread = Math.max(...crossEnds) - Math.min(...crossStarts)
  const crossSizeMedian = median(sorted.map((b) => (direction === 'HORIZONTAL' ? b.height : b.width)))
  const crossPenalty = crossSpread > crossSizeMedian * 2.2 ? 0.35 : 0
  const score = noOverlapRatio - crossPenalty
  return { score, gaps, sorted }
}

const tryConvertNodeToAutoLayout = (node: AutoLayoutLikeNode) => {
  const children = [...(node.children || [])]
  if (children.length < 1) {
    return false
  }

  const boxes = children.map(getNodeBox)
  const validBoxes = boxes.filter((item): item is ChildBox => Boolean(item))
  if (validBoxes.length < 1) {
    return false
  }
  const childBoxes = validBoxes
  const minX = Math.min(...childBoxes.map((b) => b.x))
  const minY = Math.min(...childBoxes.map((b) => b.y))
  const maxRight = Math.max(...childBoxes.map((b) => b.right))
  const maxBottom = Math.max(...childBoxes.map((b) => b.bottom))

  let direction: 'HORIZONTAL' | 'VERTICAL' = 'VERTICAL'
  let sorted = childBoxes
  let gaps: number[] = []
  if (childBoxes.length === 1) {
    direction = 'VERTICAL'
    sorted = childBoxes
    gaps = []
  } else {
    const hx = axisScore(childBoxes, 'HORIZONTAL')
    const vy = axisScore(childBoxes, 'VERTICAL')
    if (Math.max(hx.score, vy.score) < 0.12) {
      return false
    }
    if (hx.score >= vy.score) {
      direction = 'HORIZONTAL'
      sorted = hx.sorted
      gaps = hx.gaps
    } else {
      direction = 'VERTICAL'
      sorted = vy.sorted
      gaps = vy.gaps
    }
  }
  const itemSpacing = Math.max(0, Math.round(median(gaps.filter((g) => g > 0.5))))

  const paddingLeft = Math.max(0, Math.round(minX))
  const paddingTop = Math.max(0, Math.round(minY))
  const containerBox = getNodeBox(node)
  const paddingRight = containerBox ? Math.max(0, Math.round(containerBox.width - maxRight)) : 0
  const paddingBottom = containerBox ? Math.max(0, Math.round(containerBox.height - maxBottom)) : 0

  node.flexMode = direction
  node.flexWrap = 'NO_WRAP'
  node.mainAxisSizingMode = 'FIXED'
  node.crossAxisSizingMode = 'FIXED'
  node.mainAxisAlignItems = 'FLEX_START'
  node.crossAxisAlignItems = 'FLEX_START'
  node.itemSpacing = itemSpacing
  node.paddingLeft = paddingLeft
  node.paddingTop = paddingTop
  node.paddingRight = paddingRight
  node.paddingBottom = paddingBottom

  if (typeof node.insertChild === 'function') {
    sorted.forEach((b, index) => {
      node.insertChild!(index, b.node)
    })
  }
  let convertedChildren = 0
  sorted.forEach((b) => {
    const child = b.node as AutoLayoutChildLike
    child.layoutPositioning = 'AUTO'
    child.x = 0
    child.y = 0
    convertedChildren += 1
  })
  return convertedChildren > 0
}

const applyAutoLayoutHeuristics = (rootNode: SceneNode) => {
  let converted = 0
  let forced = 0
  let normalized = 0
  let checked = 0
  let groupScanned = 0
  let groupRemovedEmpty = 0
  let groupFlattened = 0
  let groupConvertedToFrame = 0
  let nestedScanned = 0
  let nestedRemovedEmpty = 0
  let nestedFlattenSingle = 0
  let nestedFlattenSingleForced = 0
  let nestedFlattenMulti = 0
  let nestedFlattenMultiForced = 0
  let nestedMergedAuto = 0

  const maxPasses = 12
  for (let pass = 0; pass < maxPasses; pass += 1) {
    const passGroup = cleanupRedundantGroups(rootNode)
    groupScanned += passGroup.scanned
    groupRemovedEmpty += passGroup.removedEmpty
    groupFlattened += passGroup.flattened
    groupConvertedToFrame += passGroup.convertedToFrame

    let passConverted = 0
    let passForced = 0
    let passNormalized = 0
    let passChecked = 0
    const walk = (node: SceneNode) => {
      if (canBeAutoLayoutContainer(node)) {
        passChecked += 1
        passNormalized += normalizeExistingAutoLayoutChildren(node)
        if (node.flexMode === 'NONE' && tryConvertNodeToAutoLayout(node)) {
          passConverted += 1
        } else if (node.flexMode === 'NONE' && tryForceStackAutoLayout(node)) {
          passForced += 1
        }
      }
      const withChildren = node as AutoLayoutLikeNode
      if (Array.isArray(withChildren.children) && withChildren.children.length) {
        ;[...withChildren.children].forEach((child) => walk(child))
      }
    }
    walk(rootNode)
    const passNested = optimizeNestedContainers(rootNode)

    converted += passConverted
    forced += passForced
    normalized += passNormalized
    checked += passChecked
    nestedScanned += passNested.scanned
    nestedRemovedEmpty += passNested.removedEmpty
    nestedFlattenSingle += passNested.flattenSingle
    nestedFlattenSingleForced += passNested.flattenSingleForced
    nestedFlattenMulti += passNested.flattenMulti
    nestedFlattenMultiForced += passNested.flattenMultiForced
    nestedMergedAuto += passNested.mergedAuto

    const passChanged = (
      passConverted +
      passForced +
      passNormalized +
      passGroup.removedEmpty +
      passGroup.flattened +
      passGroup.convertedToFrame +
      passNested.removedEmpty +
      passNested.flattenSingle +
      passNested.flattenSingleForced +
      passNested.flattenMulti +
      passNested.flattenMultiForced +
      passNested.mergedAuto
    ) > 0

    if (!passChanged) {
      break
    }
  }

  return {
    converted,
    forced,
    normalized,
    checked,
    groupStats: {
      scanned: groupScanned,
      removedEmpty: groupRemovedEmpty,
      flattened: groupFlattened,
      convertedToFrame: groupConvertedToFrame,
    },
    nestedStats: {
      scanned: nestedScanned,
      removedEmpty: nestedRemovedEmpty,
      flattenSingle: nestedFlattenSingle,
      flattenSingleForced: nestedFlattenSingleForced,
      flattenMulti: nestedFlattenMulti,
      flattenMultiForced: nestedFlattenMultiForced,
      mergedAuto: nestedMergedAuto,
    },
  }
}

const hasVisibleFill = (node: SceneNode) => {
  const withFills = node as SceneNode & { fills?: readonly Paint[] }
  const fills = withFills.fills
  if (!Array.isArray(fills) || fills.length === 0) {
    return false
  }
  return fills.some((paint) => {
    const p = paint as Paint & { visible?: boolean; opacity?: number }
    if (p.visible === false) {
      return false
    }
    if ((p.opacity ?? 1) <= 0) {
      return false
    }
    if (p.type === 'SOLID') {
      const solid = p as SolidPaint
      const alpha = solid.opacity ?? 1
      return alpha > 0
    }
    return true
  })
}

const hasVisibleStroke = (node: SceneNode) => {
  const withStrokes = node as SceneNode & { strokes?: readonly Paint[] }
  const strokes = withStrokes.strokes
  if (!Array.isArray(strokes) || strokes.length === 0) {
    return false
  }
  return strokes.some((paint) => {
    const p = paint as Paint & { visible?: boolean; opacity?: number }
    if (p.visible === false) {
      return false
    }
    return (p.opacity ?? 1) > 0
  })
}

const hasVisibleEffect = (node: SceneNode) => {
  const withEffects = node as SceneNode & { effects?: readonly Effect[] }
  const effects = withEffects.effects
  if (!Array.isArray(effects) || effects.length === 0) {
    return false
  }
  return effects.some((effect) => {
    const e = effect as Effect & { visible?: boolean; opacity?: number }
    if (e.visible === false) {
      return false
    }
    return (e.opacity ?? 1) > 0
  })
}

const isGroupNode = (node: SceneNode): node is GroupLikeNode => {
  const group = node as GroupLikeNode
  return group.type === 'GROUP'
}

const isWrapperNode = (node: SceneNode): node is WrapperLikeNode => {
  const wrapper = node as WrapperLikeNode
  return wrapper.type === 'GROUP' || wrapper.type === 'FRAME' || wrapper.type === 'SECTION'
}

const isNeutralGroup = (node: SceneNode): node is GroupLikeNode => {
  const group = node as GroupLikeNode
  if (group.type !== 'GROUP') return false
  if (hasVisibleFill(node) || hasVisibleStroke(node) || hasVisibleEffect(node)) return false
  if (isFiniteNumber(group.opacity) && (group.opacity as number) < 0.999) return false
  if (
    typeof group.blendMode === 'string' &&
    group.blendMode !== 'NORMAL' &&
    group.blendMode !== 'PASS_THROUGH'
  ) {
    return false
  }
  const corners = [group.topLeftRadius, group.topRightRadius, group.bottomLeftRadius, group.bottomRightRadius]
    .filter(isFiniteNumber) as number[]
  if (corners.some((radius) => radius > 0.5)) return false
  if (isFiniteNumber(group.cornerRadius) && (group.cornerRadius as number) > 0.5) return false
  return true
}

const flattenSingleChildGroup = (group: GroupLikeNode) => {
  if (!canReparentChildren(group.parent)) return false
  const children = [...(group.children || [])]
  if (children.length !== 1) return false
  const child = children[0] as SizeLikeNode
  const parent = group.parent
  const groupX = isFiniteNumber(group.x) ? (group.x as number) : 0
  const groupY = isFiniteNumber(group.y) ? (group.y as number) : 0
  const childX = isFiniteNumber(child.x) ? (child.x as number) : 0
  const childY = isFiniteNumber(child.y) ? (child.y as number) : 0
  const index = parent.children.findIndex((node) => node.id === group.id)
  const targetIndex = index >= 0 ? index : parent.children.length
  parent.insertChild(targetIndex, child as SceneNode)
  child.x = groupX + childX
  child.y = groupY + childY
  group.remove()
  return true
}

const flattenMultiChildGroup = (group: GroupLikeNode) => {
  if (!isNeutralGroup(group)) return false
  if (!canReparentChildren(group.parent)) return false
  const children = [...(group.children || [])]
  if (children.length < 2) return false
  const parent = group.parent as AutoLayoutLikeNode & {
    children: readonly SceneNode[]
    insertChild: (index: number, child: SceneNode) => void
  }
  const parentIsAuto = Boolean(parent.flexMode && parent.flexMode !== 'NONE')
  if (parentIsAuto) {
    const groupAsChild = group as AutoLayoutChildLike
    if (groupAsChild.layoutPositioning === 'ABSOLUTE') return false
  }
  const groupX = isFiniteNumber(group.x) ? (group.x as number) : 0
  const groupY = isFiniteNumber(group.y) ? (group.y as number) : 0
  const index = parent.children.findIndex((node) => node.id === group.id)
  const targetIndex = index >= 0 ? index : parent.children.length
  children.forEach((childNode, i) => {
    const child = childNode as SizeLikeNode
    parent.insertChild(targetIndex + i, childNode)
    if (parentIsAuto) {
      const childLike = childNode as AutoLayoutChildLike
      childLike.layoutPositioning = 'AUTO'
      childLike.x = 0
      childLike.y = 0
    } else {
      const childX = isFiniteNumber(child.x) ? (child.x as number) : 0
      const childY = isFiniteNumber(child.y) ? (child.y as number) : 0
      child.x = groupX + childX
      child.y = groupY + childY
    }
  })
  group.remove()
  return true
}

const tryAssign = <T extends object, K extends keyof T>(target: T, key: K, value: T[K]) => {
  try {
    target[key] = value
  } catch {
    // ignore unsupported assignment
  }
}

const convertGroupToFrame = (group: GroupLikeNode) => {
  if (!canReparentChildren(group.parent)) return false
  const parent = group.parent
  const groupX = isFiniteNumber(group.x) ? (group.x as number) : 0
  const groupY = isFiniteNumber(group.y) ? (group.y as number) : 0
  const groupWidth = isFiniteNumber(group.width) ? Math.max(1, Math.round(group.width as number)) : 1
  const groupHeight = isFiniteNumber(group.height) ? Math.max(1, Math.round(group.height as number)) : 1
  const children = [...(group.children || [])]
  if (children.length < 2) return false

  const frame = mg.createFrame()
  frame.name = group.name
  frame.x = groupX
  frame.y = groupY
  frame.resize(groupWidth, groupHeight)
  frame.isVisible = group.isVisible ?? true
  frame.isLocked = false
  frame.opacity = isFiniteNumber(group.opacity) ? (group.opacity as number) : 1
  frame.blendMode = ((group.blendMode as BlendMode) || 'PASS_THROUGH')
  const groupAny = group as unknown as {
    fills?: readonly Paint[]
    strokes?: readonly Paint[]
    effects?: readonly Effect[]
    strokeWeight?: number
    strokeAlign?: StrokeAlign
    cornerRadius?: number | PluginAPI['mixed']
    topLeftRadius?: number
    topRightRadius?: number
    bottomLeftRadius?: number
    bottomRightRadius?: number
  }
  tryAssign(frame as unknown as { fills: Paint[] }, 'fills', groupAny.fills ? [...groupAny.fills] : [])
  tryAssign(frame as unknown as { strokes: Paint[] }, 'strokes', groupAny.strokes ? [...groupAny.strokes] : [])
  if (groupAny.effects) {
    tryAssign(frame as unknown as { effects: Effect[] }, 'effects', [...groupAny.effects])
  }
  if (isFiniteNumber(groupAny.strokeWeight)) {
    tryAssign(frame as unknown as { strokeWeight: number }, 'strokeWeight', groupAny.strokeWeight as number)
  }
  if (typeof groupAny.strokeAlign === 'string') {
    tryAssign(frame as unknown as { strokeAlign: StrokeAlign }, 'strokeAlign', groupAny.strokeAlign)
  }
  if (isFiniteNumber(groupAny.cornerRadius)) {
    tryAssign(frame as unknown as { cornerRadius: number }, 'cornerRadius', groupAny.cornerRadius as number)
  }
  if (isFiniteNumber(groupAny.topLeftRadius)) {
    tryAssign(frame as unknown as { topLeftRadius: number }, 'topLeftRadius', groupAny.topLeftRadius as number)
  }
  if (isFiniteNumber(groupAny.topRightRadius)) {
    tryAssign(frame as unknown as { topRightRadius: number }, 'topRightRadius', groupAny.topRightRadius as number)
  }
  if (isFiniteNumber(groupAny.bottomLeftRadius)) {
    tryAssign(frame as unknown as { bottomLeftRadius: number }, 'bottomLeftRadius', groupAny.bottomLeftRadius as number)
  }
  if (isFiniteNumber(groupAny.bottomRightRadius)) {
    tryAssign(frame as unknown as { bottomRightRadius: number }, 'bottomRightRadius', groupAny.bottomRightRadius as number)
  }

  const index = parent.children.findIndex((node) => node.id === group.id)
  const targetIndex = index >= 0 ? index : parent.children.length
  parent.insertChild(targetIndex, frame)

  children.forEach((childNode) => {
    const child = childNode as SizeLikeNode
    const childX = isFiniteNumber(child.x) ? (child.x as number) : 0
    const childY = isFiniteNumber(child.y) ? (child.y as number) : 0
    const absX = groupX + childX
    const absY = groupY + childY
    frame.appendChild(childNode)
    child.x = absX - frame.x
    child.y = absY - frame.y
  })

  group.remove()
  frame.isLocked = group.isLocked ?? false
  return true
}

const isNeutralWrapperContainer = (node: SceneNode) => {
  const wrapper = node as WrapperLikeNode
  if (!isWrapperNode(node)) return false
  if (hasVisibleFill(node) || hasVisibleStroke(node) || hasVisibleEffect(node)) return false
  if (isFiniteNumber(wrapper.opacity) && (wrapper.opacity as number) < 0.999) return false
  if (
    typeof wrapper.blendMode === 'string' &&
    wrapper.blendMode !== 'NORMAL' &&
    wrapper.blendMode !== 'PASS_THROUGH'
  ) {
    return false
  }
  const corners = [wrapper.topLeftRadius, wrapper.topRightRadius, wrapper.bottomLeftRadius, wrapper.bottomRightRadius]
    .filter(isFiniteNumber) as number[]
  if (corners.some((radius) => radius > 0.5)) return false
  if (isFiniteNumber(wrapper.cornerRadius) && (wrapper.cornerRadius as number) > 0.5) return false
  return true
}

const safeJson = (value: unknown) => {
  try {
    return JSON.stringify(value ?? null)
  } catch {
    return ''
  }
}

const GENERIC_WRAPPER_NAMES = new Set([
  'DIV',
  'SECTION',
  'MAIN',
  'ARTICLE',
  'NAV',
  'HEADER',
  'FOOTER',
  'ASIDE',
  'A',
  'P',
  'SPAN',
  'UL',
  'OL',
  'LI',
  'CONTAINER',
  'WRAPPER',
  'CONTENT',
  'BLOCK',
])

const isGenericWrapperName = (name: string) => {
  const text = (name || '').trim().toUpperCase()
  if (!text) return false
  if (GENERIC_WRAPPER_NAMES.has(text)) return true
  return /^[A-Z0-9_-]{1,24}$/.test(text)
}

const readWrapperStyle = (node: WrapperLikeNode) => {
  const n = node as SceneNode & {
    fills?: readonly Paint[]
    strokes?: readonly Paint[]
    effects?: readonly Effect[]
    strokeWeight?: number
    strokeAlign?: StrokeAlign
  }
  return {
    fills: n.fills || [],
    strokes: n.strokes || [],
    effects: n.effects || [],
    strokeWeight: isFiniteNumber(n.strokeWeight) ? (n.strokeWeight as number) : 0,
    strokeAlign: typeof n.strokeAlign === 'string' ? n.strokeAlign : 'INSIDE',
    opacity: isFiniteNumber(node.opacity) ? (node.opacity as number) : 1,
    blendMode: typeof node.blendMode === 'string' ? node.blendMode : 'PASS_THROUGH',
    cornerRadius: isFiniteNumber(node.cornerRadius) ? (node.cornerRadius as number) : 0,
    topLeftRadius: isFiniteNumber(node.topLeftRadius) ? (node.topLeftRadius as number) : 0,
    topRightRadius: isFiniteNumber(node.topRightRadius) ? (node.topRightRadius as number) : 0,
    bottomLeftRadius: isFiniteNumber(node.bottomLeftRadius) ? (node.bottomLeftRadius as number) : 0,
    bottomRightRadius: isFiniteNumber(node.bottomRightRadius) ? (node.bottomRightRadius as number) : 0,
  }
}

const hasEquivalentWrapperStyle = (a: WrapperLikeNode, b: WrapperLikeNode) => {
  const sa = readWrapperStyle(a)
  const sb = readWrapperStyle(b)
  const floatsEqual = (x: number, y: number) => Math.abs(x - y) <= 0.001
  return (
    floatsEqual(sa.opacity, sb.opacity) &&
    sa.blendMode === sb.blendMode &&
    floatsEqual(sa.cornerRadius, sb.cornerRadius) &&
    floatsEqual(sa.topLeftRadius, sb.topLeftRadius) &&
    floatsEqual(sa.topRightRadius, sb.topRightRadius) &&
    floatsEqual(sa.bottomLeftRadius, sb.bottomLeftRadius) &&
    floatsEqual(sa.bottomRightRadius, sb.bottomRightRadius) &&
    floatsEqual(sa.strokeWeight, sb.strokeWeight) &&
    sa.strokeAlign === sb.strokeAlign &&
    safeJson(sa.fills) === safeJson(sb.fills) &&
    safeJson(sa.strokes) === safeJson(sb.strokes) &&
    safeJson(sa.effects) === safeJson(sb.effects)
  )
}

const isSameGeometryWrapperChild = (wrapper: WrapperLikeNode, child: SceneNode) => {
  const w = wrapper as SizeLikeNode
  const c = child as SizeLikeNode
  if (!isFiniteNumber(w.width) || !isFiniteNumber(w.height) || !isFiniteNumber(c.width) || !isFiniteNumber(c.height)) {
    return false
  }
  const childX = isFiniteNumber(c.x) ? (c.x as number) : 0
  const childY = isFiniteNumber(c.y) ? (c.y as number) : 0
  const widthClose = Math.abs((w.width as number) - (c.width as number)) <= 1
  const heightClose = Math.abs((w.height as number) - (c.height as number)) <= 1
  const offsetClose = Math.abs(childX) <= 1 && Math.abs(childY) <= 1
  return widthClose && heightClose && offsetClose
}

const tryPromoteWrapperStyleToChild = (wrapper: WrapperLikeNode, child: SceneNode) => {
  if (!isWrapperNode(child)) return false
  if (hasVisibleEffect(wrapper)) return false
  const corners = [wrapper.topLeftRadius, wrapper.topRightRadius, wrapper.bottomLeftRadius, wrapper.bottomRightRadius]
    .filter(isFiniteNumber) as number[]
  if (corners.some((radius) => radius > 0.5)) return false
  if (isFiniteNumber(wrapper.cornerRadius) && (wrapper.cornerRadius as number) > 0.5) return false
  if (isFiniteNumber(wrapper.opacity) && Math.abs((wrapper.opacity as number) - 1) > 0.001) return false
  if (
    typeof wrapper.blendMode === 'string' &&
    wrapper.blendMode !== 'NORMAL' &&
    wrapper.blendMode !== 'PASS_THROUGH'
  ) {
    return false
  }

  const wrapperAny = wrapper as SceneNode & {
    fills?: readonly Paint[]
    strokes?: readonly Paint[]
    strokeWeight?: number
    strokeAlign?: StrokeAlign
  }
  const childAny = child as SceneNode & {
    fills?: Paint[]
    strokes?: Paint[]
    strokeWeight?: number
    strokeAlign?: StrokeAlign
  }

  let promoted = false
  if (hasVisibleFill(wrapper) && !hasVisibleFill(child)) {
    if (Array.isArray(wrapperAny.fills) && wrapperAny.fills.length) {
      tryAssign(childAny as { fills: Paint[] }, 'fills', [...wrapperAny.fills])
      promoted = true
    }
  }
  if (hasVisibleStroke(wrapper) && !hasVisibleStroke(child)) {
    if (Array.isArray(wrapperAny.strokes) && wrapperAny.strokes.length) {
      tryAssign(childAny as { strokes: Paint[] }, 'strokes', [...wrapperAny.strokes])
      promoted = true
    }
    if (isFiniteNumber(wrapperAny.strokeWeight)) {
      tryAssign(childAny as { strokeWeight: number }, 'strokeWeight', wrapperAny.strokeWeight as number)
      promoted = true
    }
    if (typeof wrapperAny.strokeAlign === 'string') {
      tryAssign(childAny as { strokeAlign: StrokeAlign }, 'strokeAlign', wrapperAny.strokeAlign)
      promoted = true
    }
  }
  return promoted
}

const tryPromoteWrapperStyleToChildAggressive = (wrapper: WrapperLikeNode, child: SceneNode) => {
  const wrapperAny = wrapper as SceneNode & {
    fills?: readonly Paint[]
    strokes?: readonly Paint[]
    effects?: readonly Effect[]
    strokeWeight?: number
    strokeAlign?: StrokeAlign
  }
  const childAny = child as SceneNode & {
    fills?: Paint[]
    strokes?: Paint[]
    effects?: Effect[]
    strokeWeight?: number
    strokeAlign?: StrokeAlign
    opacity?: number
    blendMode?: BlendMode
    cornerRadius?: number
    topLeftRadius?: number
    topRightRadius?: number
    bottomLeftRadius?: number
    bottomRightRadius?: number
  }

  let promoted = false
  if (Array.isArray(wrapperAny.fills) && wrapperAny.fills.length && !hasVisibleFill(child)) {
    tryAssign(childAny as { fills: Paint[] }, 'fills', [...wrapperAny.fills])
    promoted = true
  }
  if (Array.isArray(wrapperAny.strokes) && wrapperAny.strokes.length && !hasVisibleStroke(child)) {
    tryAssign(childAny as { strokes: Paint[] }, 'strokes', [...wrapperAny.strokes])
    promoted = true
  }
  if (Array.isArray(wrapperAny.effects) && wrapperAny.effects.length && !hasVisibleEffect(child)) {
    tryAssign(childAny as { effects: Effect[] }, 'effects', [...wrapperAny.effects])
    promoted = true
  }
  if (isFiniteNumber(wrapperAny.strokeWeight)) {
    tryAssign(childAny as { strokeWeight: number }, 'strokeWeight', wrapperAny.strokeWeight as number)
    promoted = true
  }
  if (typeof wrapperAny.strokeAlign === 'string') {
    tryAssign(childAny as { strokeAlign: StrokeAlign }, 'strokeAlign', wrapperAny.strokeAlign)
    promoted = true
  }
  if (isFiniteNumber(wrapper.opacity) && Math.abs((wrapper.opacity as number) - 1) > 0.001) {
    tryAssign(childAny as { opacity: number }, 'opacity', wrapper.opacity as number)
    promoted = true
  }
  if (typeof wrapper.blendMode === 'string' && wrapper.blendMode !== 'PASS_THROUGH') {
    tryAssign(childAny as { blendMode: BlendMode }, 'blendMode', wrapper.blendMode as BlendMode)
    promoted = true
  }
  if (isFiniteNumber(wrapper.cornerRadius) && (wrapper.cornerRadius as number) > 0.001) {
    tryAssign(childAny as { cornerRadius: number }, 'cornerRadius', wrapper.cornerRadius as number)
    promoted = true
  }
  if (isFiniteNumber(wrapper.topLeftRadius)) {
    tryAssign(childAny as { topLeftRadius: number }, 'topLeftRadius', wrapper.topLeftRadius as number)
    promoted = true
  }
  if (isFiniteNumber(wrapper.topRightRadius)) {
    tryAssign(childAny as { topRightRadius: number }, 'topRightRadius', wrapper.topRightRadius as number)
    promoted = true
  }
  if (isFiniteNumber(wrapper.bottomLeftRadius)) {
    tryAssign(childAny as { bottomLeftRadius: number }, 'bottomLeftRadius', wrapper.bottomLeftRadius as number)
    promoted = true
  }
  if (isFiniteNumber(wrapper.bottomRightRadius)) {
    tryAssign(childAny as { bottomRightRadius: number }, 'bottomRightRadius', wrapper.bottomRightRadius as number)
    promoted = true
  }
  return promoted
}

const flattenSingleChildWrapper = (wrapper: WrapperLikeNode) => {
  if (!canReparentChildren(wrapper.parent)) return false
  const children = [...(wrapper.children || [])]
  if (children.length !== 1) return false
  const childNode = children[0]
  const childWrapper = isWrapperNode(childNode) ? childNode : null
  const canFlattenAsNeutral = isNeutralWrapperContainer(wrapper)
  const canFlattenByStylePromotion = !canFlattenAsNeutral && tryPromoteWrapperStyleToChild(wrapper, childNode)
  const canFlattenByEquivalentStyle =
    !canFlattenAsNeutral &&
    !canFlattenByStylePromotion &&
    !!childWrapper &&
    hasEquivalentWrapperStyle(wrapper, childWrapper)
  const canFlattenAggressive =
    !canFlattenAsNeutral &&
    !canFlattenByStylePromotion &&
    !canFlattenByEquivalentStyle &&
    !!childWrapper &&
    isSameGeometryWrapperChild(wrapper, childNode)
  const canFlattenByForceGeneric =
    !canFlattenAsNeutral &&
    !canFlattenByStylePromotion &&
    !canFlattenByEquivalentStyle &&
    !canFlattenAggressive &&
    isGenericWrapperName(wrapper.name || '')
  const canFlattenByWrapperChain =
    !canFlattenAsNeutral &&
    !canFlattenByStylePromotion &&
    !canFlattenByEquivalentStyle &&
    !canFlattenAggressive &&
    !canFlattenByForceGeneric &&
    !!childWrapper
  if (
    !canFlattenAsNeutral &&
    !canFlattenByStylePromotion &&
    !canFlattenByEquivalentStyle &&
    !canFlattenAggressive &&
    !canFlattenByForceGeneric &&
    !canFlattenByWrapperChain
  ) {
    return false
  }
  if (canFlattenByForceGeneric) {
    tryPromoteWrapperStyleToChildAggressive(wrapper, childNode)
  }
  return reparentSingleChildWrapper(wrapper)
}

const reparentSingleChildWrapper = (wrapper: WrapperLikeNode) => {
  if (!canReparentChildren(wrapper.parent)) return false
  const children = [...(wrapper.children || [])]
  if (children.length !== 1) return false
  const childNode = children[0]
  const child = childNode as SizeLikeNode & AutoLayoutChildLike
  const parent = wrapper.parent as AutoLayoutLikeNode & {
    children: readonly SceneNode[]
    insertChild: (index: number, child: SceneNode) => void
  }
  const wrapperAsChild = wrapper as AutoLayoutChildLike
  const wrapperX = isFiniteNumber(wrapper.x) ? (wrapper.x as number) : 0
  const wrapperY = isFiniteNumber(wrapper.y) ? (wrapper.y as number) : 0
  const childX = isFiniteNumber(child.x) ? (child.x as number) : 0
  const childY = isFiniteNumber(child.y) ? (child.y as number) : 0
  const index = parent.children.findIndex((node) => node.id === wrapper.id)
  const targetIndex = index >= 0 ? index : parent.children.length
  parent.insertChild(targetIndex, child as SceneNode)
  if (parent.flexMode && parent.flexMode !== 'NONE') {
    const forceAbsolute = wrapperAsChild.layoutPositioning === 'ABSOLUTE' || child.layoutPositioning === 'ABSOLUTE'
    if (forceAbsolute) {
      child.layoutPositioning = 'ABSOLUTE'
      child.x = wrapperX + childX
      child.y = wrapperY + childY
    } else {
      child.layoutPositioning = 'AUTO'
      child.x = 0
      child.y = 0
    }
  } else {
    child.x = wrapperX + childX
    child.y = wrapperY + childY
  }
  wrapper.remove()
  return true
}

const forceFlattenSingleChildWrapper = (wrapper: WrapperLikeNode) => {
  if (!canReparentChildren(wrapper.parent)) return false
  const children = [...(wrapper.children || [])]
  if (children.length !== 1) return false
  const childNode = children[0]
  const childWrapper = isWrapperNode(childNode) ? childNode : null
  const canForce =
    isGenericWrapperName(wrapper.name || '') ||
    (!!childWrapper && isGenericWrapperName(childWrapper.name || ''))
  if (!canForce) return false
  tryPromoteWrapperStyleToChildAggressive(wrapper, childNode)
  return reparentSingleChildWrapper(wrapper)
}

const flattenMultiChildWrapper = (wrapper: WrapperLikeNode) => {
  if (!canReparentChildren(wrapper.parent)) return false
  if (!isNeutralWrapperContainer(wrapper)) return false
  const children = [...(wrapper.children || [])]
  if (children.length < 2) return false
  if (wrapper.flexMode && wrapper.flexMode !== 'NONE') return false
  const parent = wrapper.parent as AutoLayoutLikeNode & {
    children: readonly SceneNode[]
    insertChild: (index: number, child: SceneNode) => void
  }
  const parentIsAuto = Boolean(parent.flexMode && parent.flexMode !== 'NONE')
  if (parentIsAuto) {
    const wrapperAsChild = wrapper as AutoLayoutChildLike
    if (wrapperAsChild.layoutPositioning === 'ABSOLUTE') return false
  }
  const wrapperX = isFiniteNumber(wrapper.x) ? (wrapper.x as number) : 0
  const wrapperY = isFiniteNumber(wrapper.y) ? (wrapper.y as number) : 0
  const index = parent.children.findIndex((node) => node.id === wrapper.id)
  const targetIndex = index >= 0 ? index : parent.children.length
  children.forEach((childNode, i) => {
    const child = childNode as SizeLikeNode & AutoLayoutChildLike
    const childX = isFiniteNumber(child.x) ? (child.x as number) : 0
    const childY = isFiniteNumber(child.y) ? (child.y as number) : 0
    parent.insertChild(targetIndex + i, childNode)
    if (parentIsAuto) {
      if (child.layoutPositioning === 'ABSOLUTE') {
        child.layoutPositioning = 'ABSOLUTE'
        child.x = wrapperX + childX
        child.y = wrapperY + childY
      } else {
        child.layoutPositioning = 'AUTO'
        child.x = 0
        child.y = 0
      }
    } else {
      child.x = wrapperX + childX
      child.y = wrapperY + childY
    }
  })
  wrapper.remove()
  return true
}

const forceFlattenMultiChildWrapper = (wrapper: WrapperLikeNode) => {
  if (!canReparentChildren(wrapper.parent)) return false
  const children = [...(wrapper.children || [])]
  if (children.length < 2) return false
  if (!isGenericWrapperName(wrapper.name || '')) return false

  const parent = wrapper.parent as AutoLayoutLikeNode & {
    children: readonly SceneNode[]
    insertChild: (index: number, child: SceneNode) => void
  }
  const parentIsAuto = Boolean(parent.flexMode && parent.flexMode !== 'NONE')
  const wrapperAsChild = wrapper as AutoLayoutChildLike
  const wrapperX = isFiniteNumber(wrapper.x) ? (wrapper.x as number) : 0
  const wrapperY = isFiniteNumber(wrapper.y) ? (wrapper.y as number) : 0
  const index = parent.children.findIndex((node) => node.id === wrapper.id)
  const targetIndex = index >= 0 ? index : parent.children.length

  children.forEach((childNode, i) => {
    const child = childNode as SizeLikeNode & AutoLayoutChildLike
    const childX = isFiniteNumber(child.x) ? (child.x as number) : 0
    const childY = isFiniteNumber(child.y) ? (child.y as number) : 0
    parent.insertChild(targetIndex + i, childNode)
    if (parentIsAuto) {
      const forceAbsolute = wrapperAsChild.layoutPositioning === 'ABSOLUTE' || child.layoutPositioning === 'ABSOLUTE'
      if (forceAbsolute) {
        child.layoutPositioning = 'ABSOLUTE'
        child.x = wrapperX + childX
        child.y = wrapperY + childY
      } else {
        child.layoutPositioning = 'AUTO'
        child.x = 0
        child.y = 0
      }
    } else {
      child.x = wrapperX + childX
      child.y = wrapperY + childY
    }
  })
  wrapper.remove()
  return true
}

const isZeroPaddingAutoLayout = (node: AutoLayoutLikeNode) => {
  const paddings = [node.paddingTop, node.paddingRight, node.paddingBottom, node.paddingLeft]
  return paddings.every((value) => !isFiniteNumber(value) || Math.abs(value as number) <= 0.5)
}

const mergeNestedAutoLayoutContainer = (parent: AutoLayoutLikeNode, child: AutoLayoutLikeNode) => {
  if (!Array.isArray(parent.children) || !Array.isArray(child.children)) return false
  if (!parent.flexMode || !child.flexMode || parent.flexMode === 'NONE' || child.flexMode === 'NONE') return false
  if (parent.flexMode !== child.flexMode) return false
  if ((child as AutoLayoutChildLike).layoutPositioning === 'ABSOLUTE') return false
  if (!isNeutralWrapperContainer(child as SceneNode)) return false
  if (!isZeroPaddingAutoLayout(child)) return false
  const parentSpacing = Math.max(0, Math.round(parent.itemSpacing ?? 0))
  const childSpacing = Math.max(0, Math.round(child.itemSpacing ?? 0))
  if (Math.abs(parentSpacing - childSpacing) > 1) return false
  if (child.mainAxisAlignItems !== parent.mainAxisAlignItems) return false
  if (child.crossAxisAlignItems !== parent.crossAxisAlignItems) return false
  const grandChildren = [...child.children]
  if (!grandChildren.length) return false
  const index = parent.children.findIndex((node) => node.id === (child as SceneNode).id)
  if (index < 0 || typeof parent.insertChild !== 'function') return false
  grandChildren.forEach((gc, i) => {
    parent.insertChild!(index + i, gc)
    const childLike = gc as AutoLayoutChildLike
    childLike.layoutPositioning = 'AUTO'
    childLike.x = 0
    childLike.y = 0
  })
  ;(child as SceneNode).remove()
  return true
}

const optimizeNestedContainers = (rootNode: SceneNode) => {
  let flattenSingle = 0
  let flattenSingleForced = 0
  let flattenMulti = 0
  let flattenMultiForced = 0
  let mergedAuto = 0
  let removedEmpty = 0
  let scanned = 0

  const walk = (node: SceneNode) => {
    const withChildren = node as AutoLayoutLikeNode
    if (Array.isArray(withChildren.children) && withChildren.children.length) {
      ;[...withChildren.children].forEach((child) => walk(child))
    }
    if (!isWrapperNode(node) || node.id === rootNode.id || node.removed) return
    scanned += 1
    const container = node as AutoLayoutLikeNode
    const children = [...(container.children || [])]
    if (children.length === 0 && isNeutralWrapperContainer(node)) {
      node.remove()
      removedEmpty += 1
      return
    }
    if (children.length === 1) {
      let current: SceneNode = node
      while (isWrapperNode(current) && !current.removed) {
        const currentChildren = [...(((current as AutoLayoutLikeNode).children || []))]
        if (currentChildren.length !== 1) break
        const next = currentChildren[0]
        if (flattenSingleChildWrapper(current)) {
          flattenSingle += 1
        } else if (forceFlattenSingleChildWrapper(current)) {
          flattenSingleForced += 1
        } else {
          break
        }
        if (!isWrapperNode(next)) break
        current = next
      }
      return
    }
    if (children.length > 1 && flattenMultiChildWrapper(node)) {
      flattenMulti += 1
      return
    }
    if (children.length > 1 && forceFlattenMultiChildWrapper(node)) {
      flattenMultiForced += 1
      return
    }
    if (canBeAutoLayoutContainer(node) && node.flexMode !== 'NONE') {
      children.forEach((child) => {
        if (!canBeAutoLayoutContainer(child)) return
        if (mergeNestedAutoLayoutContainer(node, child)) {
          mergedAuto += 1
        }
      })
    }
  }

  walk(rootNode)
  return { flattenSingle, flattenSingleForced, flattenMulti, flattenMultiForced, mergedAuto, removedEmpty, scanned }
}

const cleanupRedundantGroups = (rootNode: SceneNode) => {
  const groups: GroupLikeNode[] = []
  const collect = (node: SceneNode) => {
    const withChildren = node as AutoLayoutLikeNode
    if (Array.isArray(withChildren.children) && withChildren.children.length) {
      ;[...withChildren.children].forEach((child) => collect(child))
    }
    if (node.id !== rootNode.id && isGroupNode(node)) {
      groups.push(node)
    }
  }
  collect(rootNode)

  let scanned = 0
  let removedEmpty = 0
  let flattened = 0
  let convertedToFrame = 0
  groups.forEach((group) => {
    if (group.removed) return
    scanned += 1
    const children = [...(group.children || [])]
    if (children.length === 0) {
      group.remove()
      removedEmpty += 1
      return
    }
    if (children.length === 1) {
      if (isNeutralGroup(group) && flattenSingleChildGroup(group)) {
        flattened += 1
      } else if (convertGroupToFrame(group)) {
        convertedToFrame += 1
      }
      return
    }
    if (isNeutralGroup(group) && flattenMultiChildGroup(group)) {
      flattened += 1
      return
    }
    if (convertGroupToFrame(group)) {
      convertedToFrame += 1
    }
  })

  return { scanned, removedEmpty, flattened, convertedToFrame }
}

const removeLegacyBackgroundNodes = () => {
  const page = (mg as PluginAPI & { currentPage?: PageNode }).currentPage
  if (!page || !Array.isArray(page.children)) {
    return false
  }
  ;[...page.children].forEach((node) => {
    if (node.name === 'Page Background') {
      node.remove()
    }
  })
  return true
}

const applyFallbackBackground = (rootNode: SceneNode) => {
  const withFills = rootNode as SceneNode & { fills?: Paint[] }
  if ('fills' in withFills && Array.isArray(withFills.fills) && !hasVisibleFill(rootNode)) {
    withFills.fills = [
      {
        type: 'SOLID',
        color: { r: 1, g: 1, b: 1 },
        opacity: 1,
      },
    ]
    return
  }
  const page = (mg as PluginAPI & { currentPage?: PageNode }).currentPage
  if (!page) {
    return
  }
  page.bgColor = { r: 1, g: 1, b: 1, a: 1 }
}

const collectLayoutResidualStats = (rootNode: SceneNode) => {
  let containers = 0
  let autoContainers = 0
  let nonAutoContainers = 0
  let absChildrenInAuto = 0
  let neutralWrappers = 0
  let nestedNeutralWrappers = 0

  const walk = (node: SceneNode, parentIsWrapper: boolean) => {
    const wrapper = isWrapperNode(node)
    if (wrapper) {
      const children = [...(((node as AutoLayoutLikeNode).children || []))]
      if (children.length && isNeutralWrapperContainer(node)) {
        neutralWrappers += 1
        if (parentIsWrapper) {
          nestedNeutralWrappers += 1
        }
      }
    }

    if (canBeAutoLayoutContainer(node)) {
      containers += 1
      if (node.flexMode === 'NONE') {
        nonAutoContainers += 1
      } else {
        autoContainers += 1
        ;[...(node.children || [])].forEach((child) => {
          const c = child as AutoLayoutChildLike
          if (c.layoutPositioning === 'ABSOLUTE') {
            absChildrenInAuto += 1
          }
        })
      }
    }

    const withChildren = node as AutoLayoutLikeNode
    if (Array.isArray(withChildren.children) && withChildren.children.length) {
      ;[...withChildren.children].forEach((child) => walk(child, wrapper))
    }
  }

  walk(rootNode, false)
  return {
    containers,
    autoContainers,
    nonAutoContainers,
    absChildrenInAuto,
    neutralWrappers,
    nestedNeutralWrappers,
  }
}

const toBytesFromDataUrl = (dataUrl: string) => {
  const body = dataUrl.split(',')[1] || ''
  const binary = atob(body)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

mg.ui.onmessage = async (msg: { type: UIMessage, data: any }) => {
  const { type, data } = msg
  try {
    let rootNode: SceneNode | null = null
    const nonFatalIssues: string[] = []
    let usedBackupJson = false
    let autoLayoutConverted = 0
    let autoLayoutForced = 0
    let autoLayoutNormalized = 0
    let autoLayoutChecked = 0
    let groupScanned = 0
    let groupRemovedEmpty = 0
    let groupFlattened = 0
    let groupConvertedToFrame = 0
    let nestedScanned = 0
    let nestedRemovedEmpty = 0
    let nestedFlattenSingle = 0
    let nestedFlattenSingleForced = 0
    let nestedFlattenMulti = 0
    let nestedFlattenMultiForced = 0
    let nestedMergedAuto = 0
    let layoutContainers = 0
    let layoutAutoContainers = 0
    let layoutNonAutoContainers = 0
    let layoutAbsChildrenInAuto = 0
    let layoutNeutralWrappers = 0
    let layoutNestedNeutralWrappers = 0
    let autoLayoutEnabled = true
    if (type === UIMessage.GENERATE) {
      const payload = data && typeof data === 'object' && 'json' in data ? data.json : data
      const backupPayload = data && typeof data === 'object' && 'backupJson' in data ? data.backupJson : null
      const safePayload = sanitizeLayerJson(payload)
      const safeBackupPayload = sanitizeLayerJson(backupPayload)
      if (!safePayload) {
        throw new Error('生成失败：JSON为空或格式错误')
      }
      autoLayoutEnabled = !(data && typeof data === 'object' && data.options?.autoLayout === false)
      try {
        rootNode = await renderToMasterGo(safePayload)
      } catch (renderError) {
        if (!safeBackupPayload) {
          throw renderError
        }
        rootNode = await renderToMasterGo(safeBackupPayload)
        usedBackupJson = true
      }
    } else if (type === UIMessage.GENERATE_BITMAP) {
      const bytes = typeof data?.dataUrl === 'string' && data.dataUrl.startsWith('data:image/')
        ? toBytesFromDataUrl(data.dataUrl)
        : data?.bytes instanceof Uint8Array
          ? data.bytes
          : new Uint8Array(data?.bytes || [])
      const width = Math.max(1, Number(data?.width) || 1)
      const height = Math.max(1, Number(data?.height) || 1)
      const image = await mg.createImage(bytes)
      const rect = mg.createRectangle()
      rect.resize(width, height)
      rect.fills = [{ type: 'IMAGE', imageRef: image.href, scaleMode: 'FILL' }]
      rect.name = data?.name || 'HTML Snapshot'
      rootNode = rect
    } else if (type === UIMessage.GENERATE_SVG) {
      const svg = String(data?.svg || '')
      if (!svg.trim()) {
        throw new Error('SVG 数据为空')
      }
      rootNode = await mg.createNodeFromSvgAsync(svg)
      rootNode.name = data?.name || 'HTML Snapshot SVG'
    } else if (type === UIMessage.RESIZE_UI) {
      const width = Math.max(360, Math.min(1600, Number(data?.width) || 460))
      const height = Math.max(520, Math.min(1200, Number(data?.height) || 860))
      mg.ui.resize(width, height)
      sendMsgToUI({
        type: PluginMessage.SUCCESS,
        data: `UI resized to ${width}x${height}`,
      })
      return
    } else {
      return
    }

    if (!rootNode) {
      throw new Error('生成失败：未创建任何图层')
    }
    if (type === UIMessage.GENERATE) {
      if (!removeLegacyBackgroundNodes()) {
        nonFatalIssues.push('currentPage 不存在，跳过旧背景节点清理')
      }
      applyFallbackBackground(rootNode)
      if (autoLayoutEnabled) {
        try {
          const stats = applyAutoLayoutHeuristics(rootNode)
          autoLayoutConverted = stats.converted
          autoLayoutForced = stats.forced
          autoLayoutNormalized = stats.normalized
          autoLayoutChecked = stats.checked
          groupScanned = stats.groupStats.scanned
          groupRemovedEmpty = stats.groupStats.removedEmpty
          groupFlattened = stats.groupStats.flattened
          groupConvertedToFrame = stats.groupStats.convertedToFrame
          nestedScanned = stats.nestedStats.scanned
          nestedRemovedEmpty = stats.nestedStats.removedEmpty
          nestedFlattenSingle = stats.nestedStats.flattenSingle
          nestedFlattenSingleForced = stats.nestedStats.flattenSingleForced
          nestedFlattenMulti = stats.nestedStats.flattenMulti
          nestedFlattenMultiForced = stats.nestedStats.flattenMultiForced
          nestedMergedAuto = stats.nestedStats.mergedAuto
        } catch (layoutError) {
          const message = layoutError instanceof Error ? layoutError.message : String(layoutError)
          nonFatalIssues.push(`自动布局后处理失败: ${message}`)
        }
      }
      try {
        const residual = collectLayoutResidualStats(rootNode)
        layoutContainers = residual.containers
        layoutAutoContainers = residual.autoContainers
        layoutNonAutoContainers = residual.nonAutoContainers
        layoutAbsChildrenInAuto = residual.absChildrenInAuto
        layoutNeutralWrappers = residual.neutralWrappers
        layoutNestedNeutralWrappers = residual.nestedNeutralWrappers
      } catch (residualError) {
        const message = residualError instanceof Error ? residualError.message : String(residualError)
        nonFatalIssues.push(`残留统计失败: ${message}`)
      }
    }
    if (rootNode.removed) {
      nonFatalIssues.push('rootNode 已被移除，跳过选中与聚焦')
    } else {
      const currentPage = (mg as PluginAPI & { currentPage?: PageNode }).currentPage
      if (!currentPage) {
        nonFatalIssues.push('currentPage 不存在，跳过选中与聚焦')
      } else {
        try {
          currentPage.selection = [rootNode]
        } catch (selectionError) {
          const message = selectionError instanceof Error ? selectionError.message : String(selectionError)
          nonFatalIssues.push(`selection 设置失败: ${message}`)
        }
        try {
          mg.viewport.scrollAndZoomIntoView([rootNode])
        } catch (zoomError) {
          const message = zoomError instanceof Error ? zoomError.message : String(zoomError)
          nonFatalIssues.push(`视口聚焦失败: ${message}`)
        }
      }
    }

    const nonFatalSuffix = nonFatalIssues.length ? `（非致命问题: ${nonFatalIssues.join('；')}）` : ''

    sendMsgToUI({
      type: PluginMessage.SUCCESS,
      data: type === UIMessage.GENERATE
        ? `已生成到画布${usedBackupJson ? '（已回退原始JSON）' : ''}（自动布局: 新转${autoLayoutConverted} / 兜底栈式${autoLayoutForced} / 修正ABS子项${autoLayoutNormalized} / 扫描容器${autoLayoutChecked}；Group清理: 扫描${groupScanned} / 空组${groupRemovedEmpty} / 单子项扁平${groupFlattened} / 转Frame${groupConvertedToFrame}；嵌套优化: 扫描${nestedScanned} / 空容器${nestedRemovedEmpty} / 单子容器扁平${nestedFlattenSingle} / 强压单子容器${nestedFlattenSingleForced} / 多子容器扁平${nestedFlattenMulti} / 强压多子容器${nestedFlattenMultiForced} / 同向自动布局合并${nestedMergedAuto}；残留统计: 容器${layoutContainers} / 自动布局容器${layoutAutoContainers} / 非自动布局容器${layoutNonAutoContainers} / 自动布局内ABS子项${layoutAbsChildrenInAuto} / 中性容器${layoutNeutralWrappers} / 嵌套中性容器${layoutNestedNeutralWrappers}）${nonFatalSuffix}`
        : `已生成到画布${nonFatalSuffix}`,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : '生成失败'
    sendMsgToUI({
      type: PluginMessage.ERROR,
      data: message,
    })
  }
}
