/**
 * dsh-task-guard · 纯策略层
 *
 * 这一层刻意不 import 任何 Host 运行时（ctx / 服务 / 事件），
 * 只做「状态归一化 + 边界合并 + 准入判定 + 习惯权重」这四件纯函数的事。
 * 好处：可以直接用 node 跑单元测试（scripts/selftest.mjs），
 * 闸门逻辑出错时不必启动 DSH 才能复现。
 */

/* ------------------------------------------------------------------ 常量 ---- */

export const PHASE = Object.freeze({
  IDLE: 'idle',
  AWAITING: 'awaiting_approval',
  APPROVED: 'approved',
  EXECUTING: 'executing',
  /** 分步执行：某一步做完，等用户授权下一步（1.2.0） */
  STEP_AWAITING: 'awaiting_step',
  REJECTED: 'rejected',
  TERMINATED: 'terminated',
})

/** 单步生命周期。 */
export const STEP_STATUS = Object.freeze({
  PENDING: 'pending',
  ACTIVE: 'active',
  DONE: 'done',
  SKIPPED: 'skipped',
})

/** 协议工具：任何时候都放行，否则闸门会把自己锁死。 */
export const PROTOCOL_TOOLS = Object.freeze(['task_plan', 'task_instruction', 'task_step', 'task_guard_status'])

/** 默认视为「只读/无副作用」的工具：立项前的探查与提问必须畅通。 */
export const DEFAULT_READ_ONLY_TOOLS = Object.freeze([
  'read', 'glob', 'grep', 'read_image', 'acp_read_original_image',
  'acp_status', 'acp_cache', 'search_context', 'decompress', 'compress',
  'web_search', 'web_fetch', 'advanced_search', 'multi_search', 'domain_search',
  'platform_search', 'research', 'cache_search', 'video_search', 'weather', 'free_search_test',
  'list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource',
  'cordis_inspect_list', 'cordis_inspect_query',
  'todo_write', 'job_list', 'job_output', 'schedule_list', 'schedule_delete',
  'ask_user_question', 'present',
])

/** 默认跳过闸门的工具（协议自身 + 人机问答 + 交付）。 */
export const DEFAULT_SKIP_TOOLS = Object.freeze([
  'task_plan', 'task_instruction', 'task_guard_status',
  'ask_user_question', 'present',
])

/** 默认受保护的路径前缀：任何变更类工具的参数命中就拒绝。 */
export const DEFAULT_PROTECTED_PATHS = Object.freeze([
  'C:\\Windows', 'C:\\Program Files', 'C:\\Program Files (x86)', 'C:\\ProgramData',
  'C:\\Users\\All Users',
  '/etc', '/usr', '/bin', '/sbin', '/boot', '/dev', '/proc', '/sys',
])

/** 默认危险命令片段（对 shell 类工具的 command 参数做子串匹配，大小写不敏感）。 */
export const DEFAULT_DANGEROUS_COMMANDS = Object.freeze([
  'rm -rf /', 'rm -rf ~', 'mkfs', 'dd if=', ':(){', 'shutdown /s', 'Stop-Computer',
  'Remove-Item -Recurse -Force C:\\', 'del /f /s /q C:\\', 'format /fs',
])

/** 终止类用户措辞（只在消息很短时直接生效，避免误伤「不要停止」这类句式）。 */
export const DEFAULT_TERMINATION_PATTERNS = Object.freeze([
  '^停止$', '^终止$', '^取消$', '^取消任务$', '^取消这个任务$', '^停$', '^停下$', '^别做了$', '^不用了$',
  '^停了?吧$', '^stop$', '^abort$', '^cancel$', '^terminate$',
  '^算了$', '^算了?吧$', '^不做了$', '^别弄了$', '^别改了$', '^收工$', '^先停一下$', '^停一下$', '^先停$',
])

/**
 * 严格档（profile=strict）在没写 allowedTools 时用的默认工具面：
 * 只给「读 + 写文件」这一组，pwsh / plugin_manager 之类必须显式写进 allowedTools 才放开。
 */
export const DEFAULT_STRICT_TOOLS = Object.freeze([
  'read', 'glob', 'grep', 'write', 'edit', 'multi_edit', 'todo_write',
  'task_plan', 'task_instruction', 'task_step', 'task_guard_status',
])

/** strict 档默认禁掉的执行类工具（显式写进 allowedTools 才会被移除）。 */
export const DEFAULT_STRICT_FORBIDDEN = Object.freeze(['pwsh', 'bash', 'shell', 'plugin_manager', 'job_kill', 'purge_apply', 'purge_revert'])

/** 准许类用户措辞（无 userQuestions 的降级路径用）。 */
export const DEFAULT_APPROVAL_PATTERNS = Object.freeze([
  '^准许$', '^批准$', '^同意$', '^可以$', '^行$', '^执行$', '^准许执行$', '^通过$',
  '^ok$', '^okay$', '^yes$', '^approve$', '^approved$', '^go$',
])

/* ------------------------------------------------------------------ 配置 ---- */

/**
 * 把 cordis.patch.yml 里那份 config 洗成完整可用的配置对象。
 * 缺字段一律给默认值；类型不对就用默认值，绝不因配置写错而让插件抛异常。
 */
/**
 * gateSubagents 归一化成三档：
 *   inherit —— 子代理沿用「最近一次人类准许」的边界继续干（默认，最实用：不会死锁）
 *   gate    —— 子代理也要自己立项（拿不到弹窗，等于必须走文字准许）
 *   allow   —— 子代理完全不管（等价旧版 gateSubagents:false）
 */
function normalizeSubagentMode(value) {
  if (value === 'inherit' || value === 'gate' || value === 'allow') return value
  if (value === false) return 'allow'
  return 'inherit'
}

/**
 * 把 cordis.patch.yml 里那份 config 洗成完整可用的配置对象。
 * 缺字段一律给默认值；类型不对就用默认值，绝不因配置写错而让插件抛异常。
 */
export function normalizeConfig(raw) {
  const src = raw && typeof raw === 'object' ? raw : {}
  const strArray = (value, fallback) => {
    if (!Array.isArray(value)) return [...fallback]
    return value.filter((item) => typeof item === 'string' && item.length > 0)
  }
  const num = (value, fallback, min = 0) => {
    const n = Number(value)
    return Number.isFinite(n) && n >= min ? n : fallback
  }
  const mode = src.mode === 'advisory' ? 'advisory' : 'enforce'

  return {
    enabled: src.enabled !== false,
    mode,
    // 1) 方案准入
    requirePlan: src.requirePlan !== false,
    // 2) 全局边界
    protectedPaths: strArray(src.protectedPaths, DEFAULT_PROTECTED_PATHS),
    dangerousCommands: strArray(src.dangerousCommands, DEFAULT_DANGEROUS_COMMANDS),
    hardForbiddenTools: strArray(src.hardForbiddenTools, []),
    defaultAllowedSkills: strArray(src.defaultAllowedSkills, []),
    defaultAllowedTools: strArray(src.defaultAllowedTools, []),
    // 3) 指令判定
    requireClassify: src.requireClassify !== false,
    detectTerminationFromText: src.detectTerminationFromText !== false,
    detectApprovalFromText: src.detectApprovalFromText !== false,
    terminationPatterns: strArray(src.terminationPatterns, DEFAULT_TERMINATION_PATTERNS),
    approvalPatterns: strArray(src.approvalPatterns, DEFAULT_APPROVAL_PATTERNS),
    // 放行面
    readOnlyTools: strArray(src.readOnlyTools, DEFAULT_READ_ONLY_TOOLS),
    extraReadOnlyTools: strArray(src.extraReadOnlyTools, []),
    skipTools: strArray(src.skipTools, DEFAULT_SKIP_TOOLS),
    extraSkipTools: strArray(src.extraSkipTools, []),
    // 子会话（三档：inherit / gate / allow）
    gateSubagents: normalizeSubagentMode(src.gateSubagents),
    // 分步执行（1.2.0）：一步一步干，每步做完再要一次授权
    stepGating: src.stepGating !== false,
    stepApprovalMode: src.stepApprovalMode === 'manual' ? 'manual' : 'ask',
    maxSteps: num(src.maxSteps, 0),
    // 预算
    maxActionsPerTask: num(src.maxActionsPerTask, 0),
    // 习惯
    habitPath: typeof src.habitPath === 'string' ? src.habitPath : '',
    habitSuggestMinWeight: num(src.habitSuggestMinWeight, 2, 1),
    habitPromoteThreshold: num(src.habitPromoteThreshold, 3, 1),
    // 询问/超时
    approvalTimeoutMs: num(src.approvalTimeoutMs, 300000, 5000),
    answerGraceMs: num(src.answerGraceMs, 1500, 0),
    // 准许框体积控制（问句单行、细节降到 detail，避免卡片撑满界面点不到按钮）
    compactApproval: src.compactApproval !== false,
    maxApprovalSummaryChars: num(src.maxApprovalSummaryChars, 110, 40),
    approvalDetail: src.approvalDetail !== false,
  }
}

export function readOnlySet(cfg) {
  return new Set([...cfg.readOnlyTools, ...cfg.extraReadOnlyTools])
}

export function skipSet(cfg) {
  return new Set([...cfg.skipTools, ...cfg.extraSkipTools])
}

/* ------------------------------------------------------------------ 状态 ---- */

export function emptyState(key) {
  return {
    key: key ?? 'global',
    phase: PHASE.IDLE,
    plan: null,
    planRev: 0,
    planId: null,
    boundaries: null,
    additions: [],
    history: [],
    pendingInstruction: false,
    lastInstruction: null,
    actionCount: 0,
    approvedAt: null,
    resolvedAt: null,
    createdAt: Date.now(),
    // 分步计划表（1.2.0）：steps 由 task_plan 的 steps 展开，逐条跟踪
    steps: [],
    stepIndex: 0,
    stepApproved: false,
    stepGateAt: null,
  }
}

/* --------------------------------------------------------------- 分步状态机 ---- */

/** 从 normalizePlan 的 steps 展开成分步状态表。 */
export function initSteps(plan) {
  const list = Array.isArray(plan?.steps) ? plan.steps : []
  return list.map((text, index) => ({
    index,
    text: String(text ?? ''),
    status: index === 0 ? STEP_STATUS.ACTIVE : STEP_STATUS.PENDING,
    startedAt: index === 0 ? Date.now() : null,
    doneAt: null,
    summary: '',
  }))
}

/** 当前这一步（可能为 null：全做完了）。 */
export function currentStep(state) {
  const steps = Array.isArray(state?.steps) ? state.steps : []
  const i = Number.isFinite(state?.stepIndex) ? Math.max(0, Math.floor(state.stepIndex)) : 0
  return steps[i] ?? null
}

export function stepStats(state) {
  const steps = Array.isArray(state?.steps) ? state.steps : []
  const total = steps.length
  const done = steps.filter((s) => s.status === STEP_STATUS.DONE).length
  const skipped = steps.filter((s) => s.status === STEP_STATUS.SKIPPED).length
  const settled = done + skipped
  return { total, done, skipped, settled, remaining: Math.max(0, total - settled) }
}

export function hasNextStep(state) {
  const stats = stepStats(state)
  return stats.total > 0 && stats.settled < stats.total
}

/**
 * 把当前步收尾（done / skipped）并前移游标。
 * 返回 { state, nextStep, finished }；不做弹窗，纯状态变换。
 */
export function advanceStep(state, status, summary = '') {
  const steps = Array.isArray(state?.steps) ? state.steps : []
  const i = Number.isFinite(state?.stepIndex) ? Math.max(0, Math.floor(state.stepIndex)) : 0
  const step = steps[i]
  if (!step) return { nextStep: null, finished: true }
  step.status = status === STEP_STATUS.SKIPPED ? STEP_STATUS.SKIPPED : STEP_STATUS.DONE
  step.doneAt = Date.now()
  step.summary = String(summary ?? '').slice(0, 400)
  state.stepIndex = i + 1
  const next = steps[state.stepIndex] ?? null
  const finished = next === null
  if (next && status !== STEP_STATUS.SKIPPED) {
    next.status = STEP_STATUS.ACTIVE
    next.startedAt = Date.now()
  }
  state.stepApproved = false
  state.stepGateAt = null
  return { nextStep: next, finished }
}

/** progress 面板：一眼看清做到哪、下一步是什么。 */
export function renderProgress(state) {
  const steps = Array.isArray(state?.steps) ? state.steps : []
  if (steps.length === 0) return ''
  const stats = stepStats(state)
  const filled = Math.round((stats.settled / Math.max(1, stats.total)) * 10)
  const bar = `${'█'.repeat(filled)}${'░'.repeat(Math.max(0, 10 - filled))}`
  const pending = state.phase === PHASE.STEP_AWAITING
  const lines = [`进度 ${stats.settled}/${stats.total} ${bar}`]
  for (const step of steps) {
    const mark = step.status === STEP_STATUS.DONE
      ? '✅'
      : step.status === STEP_STATUS.SKIPPED
        ? '⏭'
        : step.status === STEP_STATUS.ACTIVE
          ? (pending ? '⏸' : '▶')
          : '·'
    const tail = step.summary ? ` — ${clip(step.summary, 60)}` : ''
    lines.push(`${mark} ${step.index + 1}. ${clip(step.text, 80)}${tail}`)
  }
  if (pending) {
    const cur = currentStep(state)
    lines.push(cur ? `⏸ 等授权：第 ${cur.index + 1} 步「${clip(cur.text, 60)}」` : '⏸ 等授权')
  } else if (stats.settled >= stats.total && stats.total > 0) {
    lines.push('全部步骤已收尾')
  }
  return lines.join('\n')
}

/** 归一化 task_plan 的入参。字段缺失不报错，只补空值。 */
export function normalizePlan(args) {
  const src = args && typeof args === 'object' ? args : {}
  const list = (value) => (Array.isArray(value) ? value.filter((x) => typeof x === 'string' && x.trim() !== '').map((x) => x.trim()) : [])
  const b = src.boundaries && typeof src.boundaries === 'object' ? src.boundaries : {}
  return {
    goal: typeof src.goal === 'string' ? src.goal.trim() : '',
    steps: list(src.steps),
    acceptance: list(src.acceptance),
    notes: list(src.notes),
    profile: ['lite', 'standard', 'strict'].includes(src.profile) ? src.profile : 'standard',
    boundaries: {
      allowedSkills: list(b.allowedSkills),
      allowedTools: list(b.allowedTools),
      forbiddenTools: list(b.forbiddenTools),
      forbiddenPaths: list(b.forbiddenPaths),
      maxActions: Number.isFinite(Number(b.maxActions)) && Number(b.maxActions) > 0 ? Math.floor(Number(b.maxActions)) : 0,
      notes: list(b.notes),
    },
  }
}

/* ------------------------------------------------------------------ 边界 ---- */

const uniq = (items) => {
  const seen = new Set()
  const out = []
  for (const item of items) {
    const key = String(item)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(item)
  }
  return out
}

/**
 * 合并三处边界来源，优先级：硬配置 > 方案 > 习惯自动提升。
 * 硬配置只能收紧、不能被方案放宽（这是「全局边界」的执行保证）。
 */
export function mergeBoundaries(config, planBoundaries, promoted = {}) {
  const plan = planBoundaries ?? {}
  const promotedTools = Array.isArray(promoted.forbiddenTools) ? promoted.forbiddenTools : []
  const promotedPaths = Array.isArray(promoted.forbiddenPaths) ? promoted.forbiddenPaths : []

  const forbiddenTools = uniq([...config.hardForbiddenTools, ...promotedTools, ...(plan.forbiddenTools ?? [])])
  const forbiddenPaths = uniq([...config.protectedPaths, ...promotedPaths, ...(plan.forbiddenPaths ?? [])])
  const allowedTools = uniq([...(plan.allowedTools?.length ? plan.allowedTools : config.defaultAllowedTools)])
  const allowedSkills = uniq([...(plan.allowedSkills?.length ? plan.allowedSkills : config.defaultAllowedSkills)])
  const maxActions = Math.min(
    ...[plan.maxActions || 0, config.maxActionsPerTask || 0].filter((n) => n > 0),
    Number.POSITIVE_INFINITY,
  )

  return {
    allowedTools,
    allowedSkills,
    forbiddenTools,
    forbiddenPaths,
    maxActions: Number.isFinite(maxActions) ? maxActions : 0,
    notes: uniq([...(plan.notes ?? [])]),
  }
}

/**
 * profile 档位真正生效（1.0.0 里它只是个存进方案的死参数）：
 *   lite     —— 不设动作预算，边界原样放行（日常轻活，少打扰）
 *   standard —— 原样（默认）
 *   strict   —— 强制动作预算（方案没写就用全局值或 40），执行类工具必须显式写进
 *               allowedTools 才放开，否则默认收进 forbiddenTools
 */
export function applyProfile(profile, planBoundaries, config) {
  const cfg = config ?? normalizeConfig({})
  const b = {
    allowedSkills: [...(planBoundaries?.allowedSkills ?? [])],
    allowedTools: [...(planBoundaries?.allowedTools ?? [])],
    forbiddenTools: [...(planBoundaries?.forbiddenTools ?? [])],
    forbiddenPaths: [...(planBoundaries?.forbiddenPaths ?? [])],
    maxActions: Number(planBoundaries?.maxActions ?? 0) || 0,
    notes: [...(planBoundaries?.notes ?? [])],
  }
  const tag = ['lite', 'standard', 'strict'].includes(profile) ? profile : 'standard'

  if (tag === 'lite') {
    b.maxActions = 0
    if (b.notes.length === 0) b.notes = ['profile=lite：不设动作预算']
    return b
  }

  if (tag === 'strict') {
    if (!b.maxActions) b.maxActions = cfg.maxActionsPerTask || 40
    if (b.allowedTools.length === 0) {
      b.allowedTools = [...DEFAULT_STRICT_TOOLS]
    } else {
      b.allowedTools = uniq([...b.allowedTools, ...DEFAULT_STRICT_TOOLS.filter((t) => PROTOCOL_TOOLS.includes(t))])
    }
    // 执行类工具：没被显式声明进 allowedTools 的一律收进 forbiddenTools
    for (const tool of DEFAULT_STRICT_FORBIDDEN) {
      if (!b.allowedTools.includes(tool)) b.forbiddenTools = uniq([...b.forbiddenTools, tool])
    }
    b.notes = uniq([...b.notes, 'profile=strict：动作预算与工具面已按严格档收紧'])
    return b
  }

  return b
}

/** 方案里试图放宽硬边界的情形，逐条列出来（拒绝执行并让模型改方案）。 */
export function boundaryConflicts(config, planOrBoundaries) {
  const plan = planOrBoundaries ?? {}
  // 允许传整份方案（含 goal/steps/boundaries），也允许只传 boundaries
  const b = plan.boundaries && typeof plan.boundaries === 'object' ? plan.boundaries : plan
  const conflicts = []
  const allowedTools = b.allowedTools ?? []
  for (const tool of config.hardForbiddenTools) {
    for (const allowed of allowedTools) {
      if (matchesToolPattern(allowed, [tool]) || matchesToolPattern(tool, [allowed])) {
        conflicts.push(`allowedTools 里出现了硬禁工具「${tool}」（方案不能放宽硬边界）`)
      }
    }
  }
  for (const tool of b.forbiddenTools ?? []) {
    if (allowedTools.includes(tool)) conflicts.push(`工具「${tool}」同时出现在 allowedTools 与 forbiddenTools`)
  }
  for (const p of b.forbiddenPaths ?? []) {
    if (typeof p !== 'string' || p.trim() === '') conflicts.push('forbiddenPaths 含非法项')
  }
  if (typeof plan.goal === 'string' && plan.goal.trim() === '') conflicts.push('goal 为空：方案必须写清目标')
  if (Array.isArray(plan.steps) && plan.steps.length === 0) conflicts.push('steps 为空：方案必须列出步骤')
  return conflicts
}


/* ------------------------------------------------------------------ 判定 ---- */

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

/** 递归收集参数里的字符串值（限深度，避免大对象拖慢闸门）。 */
export function collectStrings(value, depth = 0, acc = []) {
  if (depth > 3 || acc.length > 200) return acc
  if (typeof value === 'string') {
    acc.push(value)
    return acc
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, depth + 1, acc)
    return acc
  }
  if (isPlainObject(value)) {
    for (const key of Object.keys(value)) collectStrings(value[key], depth + 1, acc)
    return acc
  }
  return acc
}

/* ---------------------------------------------------- 参数分类（防误拦） ----
 * 1.0.0 把「所有字符串」都当路径/命令扫，于是 write 的 content 里写一句
 * 系统目录路径、或一条删盘命令，就被 protected-path / dangerous-command 拦死。
 * 现在按 key 分类：
 *   path    型：file_path / path / cwd / dest …（受保护路径与危险命令都扫）
 *   command 型：command / cmd / script …（受保护路径与危险命令都扫）
 *   content 型：content / new_string / text / prompt …（正文，一律豁免）
 * 未识别的 key 归入 path 型（MCP 工具的自定义参数仍然兜得住）。
 */

const PATH_KEY_RE = /(^|_)(file_?paths?|paths?|dirs?|directory|cwd|workdir|root|dest|destination|target|output|out|save_?to|location|locations|uri|url|urls|src|source)$/i
const COMMAND_KEY_RE = /^(command|commands|cmd|cmdline|command_?line|script|shell|powershell|pwsh|bash|sh|exec|run|argv|args_?line|invocation)$/i
const CONTENT_KEY_RE = /^(content|contents|body|new_?string|old_?string|text|markdown|md|prompt|message|msg|summary|description|desc|notes?|comment|comments|code|source_?code|patch|diff|replacement|data|json|html|xml|yaml|toml|lines?|reads?)$/i

/**
 * 按用途收集参数里的字符串。
 * mode='path'    → 收路径型 + 命令型 + 未识别 key（跳过 content 型）
 * mode='command' → 只收命令型；若一个都没有，退回 path 模式的结果（兼容自定义工具）
 */
export function collectArgStrings(args, mode = 'path', depth = 0, key = '', acc = []) {
  if (depth > 3 || acc.length > 200) return acc
  if (typeof args === 'string') {
    const k = String(key ?? '')
    if (k !== '' && CONTENT_KEY_RE.test(k) && !PATH_KEY_RE.test(k) && !COMMAND_KEY_RE.test(k)) return acc
    if (mode === 'command' && !COMMAND_KEY_RE.test(k)) return acc
    acc.push(args)
    return acc
  }
  if (Array.isArray(args)) {
    for (const item of args) collectArgStrings(item, mode, depth + 1, key, acc)
    return acc
  }
  if (isPlainObject(args)) {
    for (const k of Object.keys(args)) collectArgStrings(args[k], mode, depth + 1, k, acc)
    return acc
  }
  return acc
}

const normPath = (p) => String(p).replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()

/**
 * 路径前缀命中判定：要求左右都有边界，避免 archive 目录前缀命中 archive2、
 * 或紧贴在其它字母后面的伪路径被误杀。
 */
function matchPathBoundary(hay, needle) {
  if (needle === '') return false
  let from = 0
  while (from <= hay.length) {
    const idx = hay.indexOf(needle, from)
    if (idx < 0) return false
    const before = idx === 0 ? '' : hay[idx - 1]
    const after = hay[idx + needle.length]
    const okBefore = before === '' || !/[a-z0-9_]/i.test(before)
    const okAfter = after === undefined || after === '' || /[\\/"'\s,;:)\]}>|&=]/.test(after)
    if (okBefore && okAfter) return true
    from = idx + 1
  }
  return false
}

/** 参数里是否出现受保护路径（只扫路径型/命令型参数，正文豁免）。 */
export function hitsProtectedPath(args, protectedPaths) {
  if (!protectedPaths || protectedPaths.length === 0) return null
  for (const text of collectArgStrings(args, 'path')) {
    const hay = normPath(text)
    for (const guard of protectedPaths) {
      if (!guard) continue
      const needle = normPath(guard)
      if (matchPathBoundary(hay, needle)) return { guard, text }
    }
  }
  return null
}

/** 参数里是否出现危险命令片段（只扫命令型参数；没有命令型参数时退回 path 型）。 */
export function hitsDangerousCommand(args, patterns) {
  if (!patterns || patterns.length === 0) return null
  let candidates = collectArgStrings(args, 'command')
  if (candidates.length === 0) candidates = collectArgStrings(args, 'path')
  const commands = candidates.filter((s) => s.length > 2 && s.length < 4000)
  for (const command of commands) {
    const lower = command.toLowerCase()
    for (const pattern of patterns) {
      if (pattern && lower.includes(String(pattern).toLowerCase())) return { pattern, command }
    }
  }
  return null
}

/** skill 工具的白名单校验。 */
export function skillNameOf(name, args) {
  if (name !== 'skill') return null
  const raw = args && typeof args === 'object' ? args.name ?? args.skill ?? args.id : null
  return typeof raw === 'string' && raw !== '' ? raw : null
}

export function matchesToolPattern(name, patterns) {
  for (const pattern of patterns ?? []) {
    if (pattern === name) return pattern
    if (pattern.endsWith('*') && name.startsWith(pattern.slice(0, -1))) return pattern
  }
  return null
}

/**
 * 边界闸：工具黑/白名单、skill 白名单、受保护路径、危险命令、动作预算。
 * 命中返回 deny 决策，全通过返回 null。人类会话与子代理共用这一段。
 */
export function boundaryVerdict(input) {
  const { name, args, boundaries, actionCount = 0, config } = input ?? {}
  const cfg = config ?? normalizeConfig({})
  const b = boundaries ?? {}

  const hitForbidden = matchesToolPattern(name, b.forbiddenTools)
  if (hitForbidden) {
    return {
      kind: 'deny',
      code: 'forbidden-tool',
      reason: `【task-guard】${name} 命中方案边界 forbiddenTools（${hitForbidden}），本次不执行。需要例外请重新 task_plan 并说明原因。`,
    }
  }
  if ((b.allowedTools?.length ?? 0) > 0 && !matchesToolPattern(name, b.allowedTools)) {
    return {
      kind: 'deny',
      code: 'tool-not-allowed',
      reason: `【task-guard】${name} 不在方案 allowedTools 白名单（${b.allowedTools.join(', ')}）内。要么改方案，要么换用白名单内的工具。`,
    }
  }

  const skill = skillNameOf(name, args)
  if (skill && (b.allowedSkills?.length ?? 0) > 0 && !b.allowedSkills.includes(skill)) {
    return {
      kind: 'deny',
      code: 'skill-not-allowed',
      reason: `【task-guard】skill「${skill}」不在白名单（${b.allowedSkills.join(', ')}）内。需要它就先重提方案把 skill 加进 boundaries.allowedSkills。`,
    }
  }

  const pathHit = hitsProtectedPath(args, b.forbiddenPaths)
  if (pathHit) {
    return {
      kind: 'deny',
      code: 'protected-path',
      reason: `【task-guard】参数命中受保护路径「${pathHit.guard}」（片段：${String(pathHit.text).slice(0, 120)}）。确认要动它的话，让用户在方案里显式放开。`,
    }
  }

  const danger = hitsDangerousCommand(args, cfg.dangerousCommands)
  if (danger) {
    return {
      kind: 'deny',
      code: 'dangerous-command',
      reason: `【task-guard】命令命中危险片段「${danger.pattern}」，已拦截。确实需要执行时请让用户在方案里写明并改用更收敛的命令。`,
    }
  }

  const budget = Number(b.maxActions ?? 0) || Number(cfg.maxActionsPerTask ?? 0) || 0
  if (budget > 0 && actionCount >= budget) {
    return {
      kind: 'deny',
      code: 'budget-exhausted',
      reason: `【task-guard】已用满本次方案的动作预算（${budget} 次）。收尾汇报，或重新 task_plan 提高预算。`,
    }
  }

  return null
}

/**
 * 子代理在 inherit 策略下用的边界：继承最近一次人类准许的边界，
 * 再叠上不可放宽的硬边界（hardForbiddenTools / protectedPaths）。
 */
export function subagentBoundaries(config, inherited) {
  const cfg = config ?? normalizeConfig({})
  const base = inherited ?? {}
  return {
    allowedSkills: uniq([...(base.allowedSkills?.length ? base.allowedSkills : cfg.defaultAllowedSkills)]),
    allowedTools: uniq([...(base.allowedTools?.length ? base.allowedTools : cfg.defaultAllowedTools)]),
    forbiddenTools: uniq([...(base.forbiddenTools ?? []), ...cfg.hardForbiddenTools]),
    forbiddenPaths: uniq([...(base.forbiddenPaths ?? []), ...cfg.protectedPaths]),
    maxActions: Number(base.maxActions ?? 0) || Number(cfg.maxActionsPerTask ?? 0) || 0,
    notes: [...(base.notes ?? [])],
  }
}

/**
 * 闸门核心判定。
 * 返回 { kind:'allow'|'deny', code, reason } —— code 便于测试与排障。
 *
 * input.isSubagent 由 Host 侧按会话推断（该会话 task_plan 弹窗不可用即视为子代理），
 * input.inheritedBoundaries 是最近一次人类准许的生效边界。
 */
export function decideGate(input) {
  const { name, args, state, config, isSubagent = false, inheritedBoundaries } = input ?? {}
  const cfg = config ?? normalizeConfig({})
  const st = state ?? emptyState('global')

  if (!name || typeof name !== 'string') return { kind: 'allow', code: 'no-name' }
  if (!cfg.enabled) return { kind: 'allow', code: 'disabled' }
  if (cfg.mode === 'advisory') return { kind: 'allow', code: 'advisory' }
  if (PROTOCOL_TOOLS.includes(name)) return { kind: 'allow', code: 'protocol-tool' }
  if (skipSet(cfg).has(name)) return { kind: 'allow', code: 'skip-tool' }
  if (readOnlySet(cfg).has(name)) return { kind: 'allow', code: 'read-only' }

  // 0) 子代理三档策略（1.0.0 里 gateSubagents 是死配置，子代理一律锁死）
  if (isSubagent) {
    if (cfg.gateSubagents === 'allow') return { kind: 'allow', code: 'subagent-allow' }
    if (cfg.gateSubagents === 'inherit') {
      const eff = subagentBoundaries(cfg, inheritedBoundaries)
      const hit = boundaryVerdict({ name, args, boundaries: eff, actionCount: 0, config: cfg })
      if (hit) {
        return { ...hit, reason: `${hit.reason}\n（子代理按 inherit 策略沿用最近一次人类准许的边界）` }
      }
      return { kind: 'allow', code: 'subagent-inherit' }
    }
    // gate 档：继续往下走，会被 no-approval 拦住并提示先 task_plan
  }

  // 1) 终止态：不再允许任何变更
  if (st.phase === PHASE.TERMINATED) {
    return {
      kind: 'deny',
      code: 'terminated',
      reason: [
        '【task-guard】当前任务已被终止（terminated），不再执行变更类工具。',
        st.lastInstruction ? `终止依据：「${st.lastInstruction.text}」` : '',
        '只做收尾汇报；用户要是接着说「继续刚才那个」，先 task_instruction(kind=resume) 恢复原方案；',
        '若用户提出的是另一件事，重新调用 task_plan 立项。',
      ].filter(Boolean).join('\n'),
    }
  }

  // 2) 新指令未判定（需求 3 的硬闸门）
  if (cfg.requireClassify && st.pendingInstruction) {
    return {
      kind: 'deny',
      code: 'pending-instruction',
      reason: [
        '【task-guard】收到一条尚未判定的新指令，先判定再动手。',
        st.lastInstruction ? `原始指令：「${st.lastInstruction.text}」` : '',
        '调用 task_instruction，kind 取 terminate / append / resume / new_task / question：',
        '  terminate → 终止当前任务；append → 记录追加项后继续原任务；resume → 从终止态恢复原方案；',
        '  new_task → 回到立项；question → 只回答。',
      ].filter(Boolean).join('\n'),
    }
  }

  // 3) 方案准入（需求 1 的硬闸门）
  //    awaiting_step 视为「已立项已准许」，只是下一步还没授权：交给 3b) 的分步闸门处理
  if (cfg.requirePlan
    && st.phase !== PHASE.APPROVED
    && st.phase !== PHASE.EXECUTING
    && st.phase !== PHASE.STEP_AWAITING) {
    const hint = st.phase === PHASE.AWAITING
      ? '方案已提交，正在等待用户准许：不要重复提交，也不要在准许前执行。'
      : st.phase === PHASE.REJECTED
        ? '用户已取消该方案：停止执行，先把情况说清；要改方案就重新 task_plan。'
        : '尚未立项：先调用 task_plan（目标 / 步骤 / 边界 / skill 白名单）取得用户准许。'
    return {
      kind: 'deny',
      code: 'no-approval',
      reason: `【task-guard】阶段=${st.phase}，未获准许，拒绝执行 ${name}。\n${hint}`,
    }
  }

  // 3b) 分步授权（1.2.0）：某一步刚做完，下一步还没被授权 → 不许接着干
  if (cfg.stepGating && st.phase === PHASE.STEP_AWAITING) {
    const cur = currentStep(st)
    return {
      kind: 'deny',
      code: 'step-approval',
      reason: [
        '【task-guard】上一一步已收尾，下一步还没得到授权（awaiting_step），拒绝执行 ' + `${name}。`,
        cur ? `待授权：第 ${cur.index + 1} 步「${clip(cur.text, 80)}」` : '',
        '调用 task_step(action=start) 向用户请示这一步；用户已明确说「继续/下一步」就打 task_step(action=start) 记录后继续；',
        '要收工就打 task_step(action=skip) 跳过，或 task_instruction(kind=terminate) 终止。',
      ].filter(Boolean).join('\n'),
    }
  }

  // 4) 边界与预算：工具 / skill / 路径 / 命令 / 预算，统一走 boundaryVerdict
  const hit = boundaryVerdict({ name, args, boundaries: st.boundaries, actionCount: st.actionCount, config: cfg })
  if (hit) return hit

  return { kind: 'allow', code: 'approved' }
}

/* ------------------------------------------------------------------ 指令 ---- */

function matchesAny(text, patterns) {
  const t = String(text ?? '').trim()
  if (t === '') return false
  for (const pattern of patterns ?? []) {
    try {
      if (new RegExp(pattern, 'i').test(t)) return true
    } catch {
      /* 用户写坏的正则直接跳过 */
    }
  }
  return false
}

/** 短消息里的终止措辞（去掉标点后判定），避免误伤长句。 */
export function looksLikeTermination(text, config) {
  const cfg = config ?? normalizeConfig({})
  if (!cfg.detectTerminationFromText) return false
  const t = String(text ?? '').trim().replace(/[。！!？?，,、~～\s]+$/u, '')
  if (t === '' || t.length > 16) return false
  return matchesAny(t, cfg.terminationPatterns)
}

export function looksLikeApproval(text, config) {
  const cfg = config ?? normalizeConfig({})
  if (!cfg.detectApprovalFromText) return false
  const t = String(text ?? '').trim().replace(/[。！!？?，,、~～\s]+$/u, '')
  if (t === '' || t.length > 16) return false
  return matchesAny(t, cfg.approvalPatterns)
}

/** 从 user message 里抠出纯文本（Host 侧传进来的是 content block 数组）。 */
export function messageText(message) {
  if (!message) return ''
  if (typeof message === 'string') return message
  const blocks = Array.isArray(message.content) ? message.content : []
  const parts = []
  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('\n').trim()
}

export function clip(text, max = 160) {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim()
  return t.length > max ? `${t.slice(0, max)}…` : t
}

/** task_instruction 的入参归一化 + 合法值校验。 */
export const INSTRUCTION_KINDS = Object.freeze(['terminate', 'append', 'resume', 'new_task', 'question'])

export function normalizeInstruction(args) {
  const src = args && typeof args === 'object' ? args : {}
  const kind = INSTRUCTION_KINDS.includes(src.kind) ? src.kind : null
  const list = Array.isArray(src.additions)
    ? src.additions.filter((x) => typeof x === 'string' && x.trim() !== '').map((x) => x.trim())
    : []
  return {
    kind,
    instruction: typeof src.instruction === 'string' ? clip(src.instruction, 400) : '',
    additions: list,
    reason: typeof src.reason === 'string' ? clip(src.reason, 240) : '',
  }
}

/* ------------------------------------------------------------------ 习惯 ---- */

export function emptyHabits() {
  return { version: 1, updatedAt: null, approvals: 0, rejections: 0, terminations: 0, entries: {} }
}

function bump(entries, kind, value, weight = 1) {
  if (!value) return
  const key = `${kind}:${value}`
  const prev = entries[key]
  const now = Date.now()
  entries[key] = prev
    ? { ...prev, weight: prev.weight + weight, lastAt: now }
    : { kind, value, weight, firstAt: now, lastAt: now }
}

/** 用户准许一个方案后，把这个方案里「限制性」的项记进习惯库。 */
export function learnFromApproval(habits, plan) {
  const h = habits && typeof habits === 'object' ? habits : emptyHabits()
  const entries = h.entries && typeof h.entries === 'object' ? h.entries : {}
  const b = plan?.boundaries ?? {}
  for (const skill of b.allowedSkills ?? []) bump(entries, 'skill', skill)
  for (const tool of b.forbiddenTools ?? []) bump(entries, 'forbiddenTool', tool)
  for (const p of b.forbiddenPaths ?? []) bump(entries, 'forbiddenPath', p)
  for (const note of b.notes ?? []) bump(entries, 'note', clip(note, 120))
  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    approvals: (Number(h.approvals) || 0) + 1,
    rejections: Number(h.rejections) || 0,
    terminations: Number(h.terminations) || 0,
    entries,
  }
}

export function learnFromRejection(habits) {
  const h = habits && typeof habits === 'object' ? habits : emptyHabits()
  return {
    ...emptyHabits(),
    ...h,
    updatedAt: new Date().toISOString(),
    rejections: (Number(h.rejections) || 0) + 1,
    entries: h.entries ?? {},
  }
}

export function learnFromTermination(habits) {
  const h = habits && typeof habits === 'object' ? habits : emptyHabits()
  return {
    ...emptyHabits(),
    ...h,
    updatedAt: new Date().toISOString(),
    terminations: (Number(h.terminations) || 0) + 1,
    entries: h.entries ?? {},
  }
}

export function habitList(habits) {
  const entries = habits?.entries && typeof habits.entries === 'object' ? habits.entries : {}
  return Object.values(entries)
    .filter((e) => e && typeof e.kind === 'string' && typeof e.value === 'string')
    .sort((a, b) => (b.weight || 0) - (a.weight || 0))
}

/** 达到权重门槛的习惯：限制类自动并入（只收紧），技能类只做提示（不自动放宽）。 */
export function habitPromotions(habits, config) {
  const cfg = config ?? normalizeConfig({})
  const promoted = { forbiddenTools: [], forbiddenPaths: [] }
  for (const entry of habitList(habits)) {
    if ((entry.weight || 0) < cfg.habitPromoteThreshold) continue
    if (entry.kind === 'forbiddenTool') promoted.forbiddenTools.push(entry.value)
    if (entry.kind === 'forbiddenPath') promoted.forbiddenPaths.push(entry.value)
  }
  return promoted
}

export function habitHints(habits, config) {
  const cfg = config ?? normalizeConfig({})
  return habitList(habits)
    .filter((e) => (e.weight || 0) >= cfg.habitSuggestMinWeight)
    .slice(0, 12)
    .map((e) => ({ kind: e.kind, value: e.value, weight: e.weight }))
}

/* ------------------------------------------------------------------ 渲染 ---- */

const PHASE_LABEL = {
  idle: '未立项',
  awaiting_approval: '等待准许',
  approved: '已准许',
  executing: '执行中',
  awaiting_step: '等待授权下一步',
  rejected: '方案被取消',
  terminated: '已终止',
}

export function renderState(state, options = {}) {
  const st = state ?? emptyState('global')
  const lines = []
  const plan = st.plan
  lines.push(`[task-guard] 阶段=${PHASE_LABEL[st.phase] ?? st.phase}（${st.phase}）${plan ? `｜方案#${st.planId ?? st.planRev}` : ''}${plan ? `｜目标：${clip(plan.goal, 120)}` : ''}`)
  if (st.additions.length > 0) {
    lines.push(`追加项 ${st.additions.length} 条：${st.additions.map((a) => clip(a, 60)).join('；')}`)
  }
  const b = st.boundaries
  if (b) {
    const parts = []
    if (b.allowedSkills?.length) parts.push(`skills[${b.allowedSkills.join(',')}]`)
    if (b.allowedTools?.length) parts.push(`tools[${b.allowedTools.join(',')}]`)
    if (b.forbiddenTools?.length) parts.push(`禁工具[${b.forbiddenTools.join(',')}]`)
    if (b.forbiddenPaths?.length) parts.push(`禁路径[${b.forbiddenPaths.join(',')}]`)
    if (b.maxActions) parts.push(`预算 ${st.actionCount}/${b.maxActions}`)
    if (parts.length) lines.push(`边界：${parts.join('  ')}`)
  }
  if (st.steps?.length > 0) {
    const stats = stepStats(st)
    const cur = currentStep(st)
    const head = `进度 ${stats.settled}/${stats.total}`
    lines.push(st.phase === PHASE.STEP_AWAITING
      ? `${head}｜⏸ 第 ${(cur?.index ?? 0) + 1} 步「${clip(cur?.text ?? '', 60)}」等授权 → 调用 task_step(action=start) 请示，或 task_step(action=skip) 跳过`
      : `${head}｜当前第 ${Math.min(stats.total, (cur?.index ?? stats.total) + 1)} 步「${clip(cur?.text ?? '（已全部收尾）', 60)}」`)
  }
  if (st.pendingInstruction && st.lastInstruction) {
    const kinds = st.phase === PHASE.TERMINATED ? 'resume/append/new_task/question' : 'terminate/append/resume/new_task/question'
    lines.push(`⚠ 待判定指令：「${clip(st.lastInstruction.text, 120)}」→ 先调用 task_instruction（${kinds}）`)
  }
  if (options.disabled) lines.push('（闸门当前 disabled：只做提示不拦）')
  else if (options.advisory) lines.push('（闸门当前 advisory：只做提示不拦）')
  return lines.join('\n')
}

export function renderHabits(habits, config) {
  const cfg = config ?? normalizeConfig({})
  const list = habitList(habits)
  if (list.length === 0) return '习惯库为空（还没有被准许过任何方案）。'
  const lines = [`习惯库：准许 ${habits?.approvals ?? 0} 次｜取消 ${habits?.rejections ?? 0} 次｜终止 ${habits?.terminations ?? 0} 次`]
  for (const e of list) {
    const flag = (e.weight || 0) >= cfg.habitPromoteThreshold ? '（已自动并入边界）' : ''
    lines.push(`- [${e.kind}] ${e.value} ×${e.weight}${flag}`)
  }
  return lines.join('\n')
}
