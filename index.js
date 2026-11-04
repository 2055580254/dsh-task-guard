/**
 * dsh-task-guard · Host 半边
 *
 * 三个需求分别落在三个机制上：
 *   1) 方案 → 准许 → 执行：tools/pre-execute 闸门 + task_plan（userQuestions.ask 弹准许）
 *   2) 全局边界 / skill 限制 / 习惯补充：systemPrompt.section 注入协议 + 边界合并 + habits.json 权重
 *   3) 下一条指令判定：agent/inbox/inserted 侦测 + task_instruction 判定 + 判定前禁止变更类工具
 *
 * 设计约束（踩过的坑）：
 *   - 用局部 ctx.get('服务名') / root.inject 取服务，不用对象级 inject：老宿主缺服务时对象级
 *     inject 会让整个 apply 永远不执行，且不报错。
 *   - 闸门自身必须放行 PROTOCOL_TOOLS，否则锁死。
 *   - 闸门内任何异常都要 next() 放行：闸门坏了不能把工具全废掉。
 */

import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

import {
  PHASE,
  PROTOCOL_TOOLS,
  STEP_STATUS,
  advanceStep,
  applyProfile,
  boundaryConflicts,
  clip,
  currentStep,
  decideGate,
  emptyHabits,
  emptyState,
  habitHints,
  habitList,
  habitPromotions,
  hasNextStep,
  INSTRUCTION_KINDS,
  initSteps,
  learnFromApproval,
  learnFromRejection,
  learnFromTermination,
  looksLikeApproval,
  looksLikeTermination,
  mergeBoundaries,
  messageText,
  normalizeConfig,
  normalizeInstruction,
  normalizePlan,
  readOnlySet,
  renderHabits,
  renderProgress,
  renderState,
  stepStats,
} from './lib/policy.js'

/* ------------------------------------------------------------------ 工具函数 ---- */

function makeLog(ctx) {
  return (level, message) => {
    try {
      const logger = ctx.logger ?? ctx.root?.logger
      if (logger && typeof logger[level] === 'function') logger[level](`[task-guard] ${message}`)
      else if (level === 'error' || level === 'warn') console.error(`[task-guard] ${message}`)
    } catch {
      /* 日志失败不影响主流程 */
    }
  }
}

function agentKey(agent) {
  try {
    if (agent && agent.id !== undefined && agent.id !== null) return String(agent.id)
  } catch {
    /* ignore */
  }
  return 'global'
}

function scopeKey(scope) {
  if (!scope) return null
  if (typeof scope === 'string') return scope
  try {
    if (scope.id !== undefined && scope.id !== null) return String(scope.id)
  } catch {
    /* ignore */
  }
  return null
}

function withTimeout(promise, ms, signal) {
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (fn, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        if (signal && typeof signal.removeEventListener === 'function') signal.removeEventListener('abort', onAbort)
      } catch {
        /* ignore */
      }
      fn(value)
    }
    const onAbort = () => finish(reject, Object.assign(new Error('aborted'), { name: 'AbortError' }))
    const timer = setTimeout(() => finish(reject, Object.assign(new Error('approval timeout'), { code: 'TIMEOUT' })), ms)
    if (timer && typeof timer.unref === 'function') timer.unref()
    if (signal) {
      if (signal.aborted) onAbort()
      else if (typeof signal.addEventListener === 'function') signal.addEventListener('abort', onAbort, { once: true })
    }
    Promise.resolve(promise).then((value) => finish(resolve, value), (error) => finish(reject, error))
  })
}

const textBlock = (text) => [{ type: 'text', text: String(text ?? '') }]

const renderValue = (value) => textBlock(typeof value === 'string' ? value : JSON.stringify(value, null, 2))

/* ------------------------------------------------------------------ 状态仓库 ---- */

class Store {
  constructor(cfg) {
    this.cfg = cfg
    this.map = new Map()
    this.asking = new Set()
    this.answeredAt = new Map()
    // 最近一次「人类准许」的生效边界：子代理 inherit 策略沿用它继续干
    this.lastApproved = null
    // callId → 会话 key：记录哪些放行计过预算，失败时好回滚
    this.counted = new Map()
  }

  get(key) {
    const k = key ?? 'global'
    let st = this.map.get(k)
    if (st === undefined) {
      st = emptyState(k)
      this.map.set(k, st)
    }
    return st
  }

  peek(key) {
    return this.map.get(key ?? 'global')
  }

  reset(key) {
    const k = key ?? 'global'
    const fresh = emptyState(k)
    this.map.set(k, fresh)
    return fresh
  }

  drop(key) {
    this.map.delete(key ?? 'global')
    this.answeredAt.delete(key ?? 'global')
  }

  prune() {
    // 只保留最近 200 个会话状态，防止长跑进程无限增长
    if (this.map.size <= 200) return
    const entries = [...this.map.entries()].sort((a, b) => (a[1].createdAt ?? 0) - (b[1].createdAt ?? 0))
    for (const [key] of entries.slice(0, this.map.size - 200)) this.map.delete(key)
  }
}

/* ------------------------------------------------------------------ 习惯库 ---- */

function habitFilePath(cfg) {
  if (cfg.habitPath) return path.resolve(cfg.habitPath)
  const profileDir = process.env.DSH_PROFILE_DIR
  const base = profileDir && String(profileDir).trim() !== ''
    ? path.join(String(profileDir), 'task-guard')
    : path.join(os.homedir(), '.dsh', 'task-guard')
  return path.join(base, 'habits.json')
}

function makeHabitState(cfg, log) {
  const state = {
    path: habitFilePath(cfg),
    data: emptyHabits(),
    ready: false,
    queue: Promise.resolve(),
  }

  state.load = async () => {
    try {
      const raw = await fsp.readFile(state.path, 'utf8')
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed === 'object') {
        state.data = { ...emptyHabits(), ...parsed, entries: parsed.entries && typeof parsed.entries === 'object' ? parsed.entries : {} }
      }
      log('info', `习惯库已载入：${state.path}（${habitList(state.data).length} 条）`)
    } catch (error) {
      if (error && error.code !== 'ENOENT') log('warn', `习惯库读取失败（按空库继续）：${error.message ?? error}`)
    } finally {
      state.ready = true
    }
  }

  state.save = () => {
    state.queue = state.queue.then(async () => {
      try {
        await fsp.mkdir(path.dirname(state.path), { recursive: true })
        await fsp.writeFile(state.path, `${JSON.stringify(state.data, null, 2)}\n`, 'utf8')
      } catch (error) {
        log('warn', `习惯库写入失败：${error.message ?? error}`)
      }
    })
    return state.queue
  }

  state.update = (next) => {
    state.data = next
    return state.save()
  }

  return state
}

/* ------------------------------------------------------------------ 主入口 ---- */

export function apply(root, rawConfig) {
  const cfg = normalizeConfig(rawConfig)
  const log = makeLog(root)
  const store = new Store(cfg)
  const habits = makeHabitState(cfg, log)
  habits.load().catch(() => {})

  const disposers = []
  const keep = (disposer) => {
    if (typeof disposer === 'function') disposers.push(disposer)
    return disposer
  }
  const track = (ctx, label) => {
    try {
      if (typeof ctx.effect === 'function') {
        ctx.effect(() => () => {
          for (const d of disposers.splice(0)) {
            try {
              d()
            } catch {
              /* 单个 disposer 失败不影响其余 */
            }
          }
        }, `task-guard:${label}`)
      }
    } catch (error) {
      log('warn', `注册清理钩子失败（${label}）：${error.message ?? error}`)
    }
  }

  /* ---------------- 1. 准入闸门（tools/pre-execute） ---------------- */

  try {
    keep(root.on('tools/pre-execute', async (exec, next) => {
      try {
        const name = typeof exec?.name === 'string' ? exec.name : ''
        const key = agentKey(exec?.agent)
        const state = store.peek(key) ?? emptyState(key)
        const decision = decideGate({
          name,
          args: exec?.arguments,
          state,
          config: cfg,
          isSubagent: state.isSubagent === true,
          inheritedBoundaries: store.lastApproved ?? null,
        })

        if (decision.kind === 'allow') {
          // 计数：只有真正执行变更类动作才算预算消耗；callId 记账供 tools/result 失败回滚
          if (!readOnlySet(cfg).has(name) && !PROTOCOL_TOOLS.includes(name)) {
            const live = store.peek(key)
            if (live) {
              live.actionCount += 1
              if (live.phase === PHASE.APPROVED) live.phase = PHASE.EXECUTING
              const callId = String(exec?.callId ?? '')
              if (callId !== '') store.counted.set(callId, key)
              if (store.counted.size > 500) store.counted.delete(store.counted.keys().next().value)
            }
          }
          return next()
        }

        log('warn', `拦截 ${name}：${decision.code}${state.lastInstruction ? `（依据指令：${clip(state.lastInstruction.text, 40)}）` : ''}`)
        return {
          kind: 'deny',
          reason: decision.reason,
          info: { name: 'TaskGuardError', code: `TASK_GUARD_${decision.code.toUpperCase().replace(/-/g, '_')}`, reason: decision.reason },
        }
      } catch (error) {
        log('error', `闸门异常，放行本次调用：${error?.message ?? error}`)
        return next()
      }
    }))
    log('info', `准入闸门已启用（mode=${cfg.mode}${cfg.enabled ? '' : '，但 enabled=false'}）`)
  } catch (error) {
    log('error', `注册 tools/pre-execute 失败：${error.message ?? error}`)
  }

  /* ---------------- 1b. 失败不计预算（tools/result） ---------------- */

  try {
    keep(root.on('tools/result', (exec, result) => {
      try {
        if (!result || result.isError !== true) return
        const callId = String(exec?.callId ?? '')
        if (callId === '' || !store.counted.has(callId)) return
        const key = store.counted.get(callId)
        store.counted.delete(callId)
        const live = store.peek(key)
        if (live && live.actionCount > 0) {
          live.actionCount -= 1
          log('info', `工具失败不计预算：${exec?.name ?? '?'}（已回滚，剩余 ${live.actionCount}）`)
        }
      } catch (error) {
        log('warn', `预算回滚失败（忽略）：${error?.message ?? error}`)
      }
    }))
  } catch (error) {
    log('warn', `注册 tools/result 失败：${error.message ?? error}`)
  }

  /* ---------------- 2. 新指令侦测（agent/inbox/inserted） ---------------- */

  try {
    keep(root.on('agent/inbox/inserted', (payload) => {
      try {
        const key = agentKey(payload?.agent)
        const text = messageText(payload?.message)
        if (text === '') return

        // 我们自己弹出的准许提问，答复会以 user message 回灌：不能当成新指令
        if (store.asking.has(key)) return
        const answeredAt = store.answeredAt.get(key) ?? 0
        if (Date.now() - answeredAt < cfg.answerGraceMs) return

        const state = store.get(key)
        if (state.phase === PHASE.IDLE) return // 还没立项 → 不需要判定

        state.lastInstruction = { text: clip(text, 500), at: Date.now(), source: 'inbox' }

        // 需求 3 的硬保证：终止措辞直接落状态，不必等模型判定
        if (looksLikeTermination(text, cfg)) {
          state.phase = PHASE.TERMINATED
          state.pendingInstruction = false
          state.resolvedAt = Date.now()
          state.history.push({ kind: 'terminate', by: 'text', text: clip(text, 200), at: Date.now() })
          habits.update(learnFromTermination(habits.data)).catch(() => {})
          log('warn', `收到终止指令，任务已终止：「${clip(text, 60)}」`)
          return
        }

        // 降级准许路径：问不到用户（无 userQuestions / 子会话）时，用户打字「准许」即生效
        if (state.phase === PHASE.AWAITING && looksLikeApproval(text, cfg)) {
          state.phase = PHASE.APPROVED
          state.approvedAt = Date.now()
          state.pendingInstruction = false
          state.history.push({ kind: 'approve', by: 'text', text: clip(text, 200), at: Date.now() })
          habits.update(learnFromApproval(habits.data, state.plan)).catch(() => {})
          log('info', '收到文字准许，方案进入执行阶段')
          return
        }

        // 分步授权的文字降级路径：弹不出卡时，用户打字「继续/下一步」即授权该步
        if (state.phase === PHASE.STEP_AWAITING && looksLikeApproval(text, cfg)) {
          state.phase = PHASE.EXECUTING
          state.stepApproved = true
          state.stepGateAt = null
          state.pendingInstruction = false
          state.history.push({ kind: 'step-approve', by: 'text', step: state.stepIndex, text: clip(text, 200), at: Date.now() })
          log('info', `收到文字授权，继续第 ${state.stepIndex + 1} 步`)
          return
        }

        state.pendingInstruction = true
        log('info', `检测到新指令，等待 task_instruction 判定：「${clip(text, 60)}」`)
      } catch (error) {
        log('warn', `指令侦测失败（忽略本条）：${error?.message ?? error}`)
      }
    }))
  } catch (error) {
    log('error', `注册 agent/inbox/inserted 失败：${error.message ?? error}`)
  }

  /* ---------------- 3. 会话清理 ---------------- */

  try {
    keep(root.on('agent/disposed', (agent) => {
      try {
        store.drop(agentKey(agent))
      } catch {
        /* ignore */
      }
    }))
  } catch {
    /* 老宿主没有这个事件，忽略 */
  }

  /* ---------------- 4. 工具本体 ---------------- */

  const askApproval = async (exec, key, state, plan, merged) => {
    const uq = root.get?.('userQuestions') ?? (typeof root.get === 'function' ? root.get('userQuestions') : undefined)
    if (!uq || typeof uq.ask !== 'function') return { kind: 'unavailable' }

    const summary = [
      `目标：${plan.goal}`,
      `步骤：${plan.steps.map((s, i) => `${i + 1}. ${s}`).join('  ')}`,
      plan.acceptance.length ? `验收：${plan.acceptance.join('；')}` : '',
      `边界：skill[${merged.allowedSkills.join(',') || '不限'}] 工具[${merged.allowedTools.join(',') || '不限'}]${merged.forbiddenTools.length ? ` 禁[${merged.forbiddenTools.join(',')}]` : ''}${merged.forbiddenPaths.length ? ` 路径禁[${merged.forbiddenPaths.slice(0, 4).join(',')}${merged.forbiddenPaths.length > 4 ? '…' : ''}]` : ''}`,
      merged.maxActions ? `预算：${merged.maxActions} 个动作` : '',
    ].filter(Boolean).join('\n')

    // 弹窗体积控制：问句压成一行，完整方案降到 detail。
    // 1.0.0 把整份方案塞进 question，卡片会撑满界面把按钮顶出可视区。
    const meta = [
      `${plan.steps.length} 步`,
      merged.maxActions ? `预算 ${merged.maxActions}` : '',
      merged.allowedSkills.length ? `skill[${merged.allowedSkills.join(',')}]` : '',
    ].filter(Boolean).join(' · ')
    const questionText = cfg.compactApproval
      ? `方案#${state.planId}｜${clip(plan.goal, cfg.maxApprovalSummaryChars)}${meta ? `（${meta}）` : ''}`
      : `dsh-task-guard 申请执行以下方案，请选择：\n\n${summary}`

    const detailText = cfg.approvalDetail
      ? [
        `目标：${plan.goal}`,
        plan.steps.length ? `步骤：\n${plan.steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}` : '',
        plan.acceptance.length ? `验收：${plan.acceptance.join('；')}` : '',
        `边界：skill[${merged.allowedSkills.join(',') || '不限'}] 工具[${merged.allowedTools.join(',') || '不限'}]${merged.forbiddenTools.length ? ` 禁[${merged.forbiddenTools.join(',')}]` : ''}${merged.forbiddenPaths.length ? ` 路径禁[${merged.forbiddenPaths.slice(0, 6).join(',')}${merged.forbiddenPaths.length > 6 ? '…' : ''}]` : ''}`,
        merged.maxActions ? `预算：${merged.maxActions} 个动作` : '',
        plan.notes.length ? `备注：${plan.notes.join('；')}` : '',
      ].filter(Boolean).join('\n')
      : ''

    store.asking.add(key)
    try {
      const question = {
        id: 'approve',
        header: '方案准许',
        question: questionText,
        options: [
          { label: '准许执行', description: '按方案继续' },
          { label: '修改方案', description: '先别动手' },
          { label: '取消任务', description: '停掉本次' },
        ],
      }
      if (detailText) question.detail = detailText
      const request = {
        agent: exec?.agent,
        questions: [question],
      }
      if (exec?.signal) request.signal = exec.signal
      const answer = await withTimeout(uq.ask(request), cfg.approvalTimeoutMs, exec?.signal)
      const picked = Array.isArray(answer?.answers)
        ? answer.answers.find((a) => a && a.id === 'approve')
        : undefined
      const selected = String(picked?.selected?.[0] ?? '')
      const custom = String(picked?.custom ?? '')
      if (selected.includes('准许') || selected.includes('执行') || /^(ok|yes|approve)/i.test(custom)) return { kind: 'approved' }
      if (selected.includes('修改')) return { kind: 'revise', message: custom }
      if (selected.includes('取消')) return { kind: 'cancelled', message: custom }
      return { kind: 'revise', message: selected || custom }
    } catch (error) {
      const message = String(error?.message ?? error)
      if (error?.name === 'AbortError') return { kind: 'cancelled', message: '调用被取消' }
      if (error?.code === 'TIMEOUT') return { kind: 'timeout' }
      if (/DELEGATED_CALLER|CALLER_NOT_LIVE|not live|no live/i.test(message)) return { kind: 'unavailable' }
      log('warn', `询问准许失败：${message}`)
      return { kind: 'unavailable' }
    } finally {
      store.asking.delete(key)
      store.answeredAt.set(key, Date.now())
    }
  }

  const planTool = {
    name: 'task_plan',
    description:
      '提交任务方案并取得用户准许（dsh-task-guard 的立项闸门）。任何变更类工具（write/edit/pwsh/plugin_manager…）在未获准许前都会被拒绝，'
      + '所以每个新任务的第一个非只读动作必须是本工具。'
      + '入参需写清：goal 目标、steps 步骤、boundaries 边界（allowedSkills 技能白名单 / allowedTools 工具白名单 / forbiddenTools 禁工具 / forbiddenPaths 禁路径 / maxActions 动作预算）、acceptance 验收标准。'
      + '返回 status=approved 才能执行；revise 表示要改方案；rejected 表示用户取消；manual 表示无法弹窗（需用户回复准许或用 /taskguard approve）。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        goal: { type: 'string', description: '一句话目标（必填，写清交付物）' },
        steps: { type: 'array', items: { type: 'string' }, description: '有序步骤（必填，至少一条，写清每步动作与产出）' },
        acceptance: { type: 'array', items: { type: 'string' }, description: '验收标准：怎样算做完' },
        notes: { type: 'array', items: { type: 'string' }, description: '风险/假设/回滚说明' },
        profile: { type: 'string', enum: ['lite', 'standard', 'strict'], description: '严格度标签：lite 轻量／standard 标准／strict 严格' },
        boundaries: {
          type: 'object',
          additionalProperties: false,
          properties: {
            allowedSkills: { type: 'array', items: { type: 'string' }, description: '本任务允许加载的 skill 名（空=沿用全局配置）' },
            allowedTools: { type: 'array', items: { type: 'string' }, description: '本任务允许使用的工具名（空=不限）' },
            forbiddenTools: { type: 'array', items: { type: 'string' }, description: '本任务禁用的工具名（可写 tool* 前缀通配）' },
            forbiddenPaths: { type: 'array', items: { type: 'string' }, description: '禁止改动的路径前缀' },
            maxActions: { type: 'number', description: '动作预算（0=不限）' },
            notes: { type: 'array', items: { type: 'string' }, description: '边界说明（会被习惯库累计）' },
          },
        },
      },
      required: ['goal', 'steps'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          status: { type: 'string', description: 'approved | revise | rejected | manual | busy | invalid' },
          planId: { type: 'string' },
          boundaries: { type: 'object' },
          learnedHints: { type: 'array', items: { type: 'object' } },
          hint: { type: 'string' },
        },
      },
      render: (_args, value) => renderValue(value),
    },
    async execute(args, exec) {
      const key = agentKey(exec?.agent)
      const state = store.get(key)
      const plan = normalizePlan(args)

      // 并发锁：同一会话正在弹窗时不再叠第二张（叠卡会让人分不清点的是哪份方案）
      if (store.asking.has(key)) {
        return {
          status: 'busy',
          planId: state.planId,
          hint: '上一份方案还在等用户点选：不要重复提交。等那张卡出结果（approved / revise / rejected），或让用户执行 /taskguard approve。',
        }
      }

      const conflicts = boundaryConflicts(cfg, plan)
      if (conflicts.length > 0) {
        state.phase = PHASE.IDLE
        return {
          status: 'invalid',
          conflicts,
          hint: '方案不成立：修好上面几条再提交。硬边界（hardForbiddenTools / protectedPaths）不能被方案放宽。',
        }
      }

      const promotions = habitPromotions(habits.data, cfg)
      const merged = mergeBoundaries(cfg, applyProfile(plan.profile, plan.boundaries, cfg), promotions)
      const hints = habitHints(habits.data, cfg)

      state.plan = plan
      state.planRev += 1
      state.planId = `${state.planRev}`
      state.boundaries = merged
      state.phase = PHASE.AWAITING
      state.pendingInstruction = false
      state.actionCount = 0
      state.additions = []
      state.approvedAt = null
      state.resolvedAt = null
      store.prune()

      const verdict = await askApproval(exec, key, state, plan, merged)

      if (verdict.kind === 'approved') {
        state.phase = PHASE.APPROVED
        state.approvedAt = Date.now()
        store.lastApproved = merged
        // 分步计划表：方案里的 steps 落成可跟踪的计划，第一步随方案准许一起授权
        state.steps = initSteps(plan)
        state.stepIndex = 0
        state.stepApproved = state.steps.length > 0
        state.stepGateAt = null
        state.history.push({ kind: 'approve', planId: state.planId, at: Date.now() })
        await habits.update(learnFromApproval(habits.data, plan)).catch(() => {})
        log('info', `方案#${state.planId} 获准：${clip(plan.goal, 60)}（${state.steps.length} 步）`)
        return {
          status: 'approved',
          planId: state.planId,
          boundaries: merged,
          learnedHints: hints,
          steps: state.steps.map((s) => ({ index: s.index + 1, text: s.text, status: s.status })),
          progress: renderProgress(state),
          hint: cfg.stepGating
            ? '准许已生效。按 steps 一步一步做：只做第 1 步，做完调用 task_step(action=complete, summary=…) 标记收尾，再等我授权下一步；不要在一步里把后面几步一起做完。'
            : '准许已生效：按 steps 执行。超出方案范围的动作要先重提 task_plan；收到新用户指令时先调用 task_instruction 判定。',
        }
      }
      if (verdict.kind === 'cancelled') {
        state.phase = PHASE.TERMINATED
        state.resolvedAt = Date.now()
        state.history.push({ kind: 'reject', planId: state.planId, at: Date.now() })
        await habits.update(learnFromRejection(habits.data)).catch(() => {})
        return { status: 'rejected', planId: state.planId, hint: '用户取消：停手，简短说明现状即可结束本轮。' }
      }
      if (verdict.kind === 'timeout') {
        state.phase = PHASE.AWAITING
        return {
          status: 'manual',
          planId: state.planId,
          boundaries: merged,
          hint: `等待准许超时（${Math.round(cfg.approvalTimeoutMs / 1000)}s）。把方案要点直接写给用户，等用户明确准许后继续；也可让用户执行 /taskguard approve。`,
        }
      }
      if (verdict.kind === 'unavailable') {
        state.phase = PHASE.AWAITING
        // 弹不出窗 ≈ 子会话 / 非交互：标记成子代理，后续按 gateSubagents 策略走，
        // 否则子代理会永远卡在 no-approval（1.0.0 的死锁）
        state.isSubagent = true
        const policy = cfg.gateSubagents
        const tail = policy === 'inherit'
          ? '本会话按 inherit 策略可沿用最近一次人类准许的边界继续执行（硬边界仍然生效）。'
          : policy === 'allow'
            ? '本会话按 allow 策略放行，硬边界仍然生效。'
            : '本会话按 gate 策略需要用户明确准许：把方案要点写给用户，等其回复「准许」或执行 /taskguard approve。'
        return {
          status: 'manual',
          planId: state.planId,
          boundaries: merged,
          learnedHints: hints,
          subagent: true,
          hint: `当前上下文无法弹准许窗（子会话/非交互）。${tail}`,
        }
      }
      // revise
      state.phase = PHASE.AWAITING
      return {
        status: 'revise',
        planId: state.planId,
        feedback: verdict.message ?? '',
        boundaries: merged,
        hint: '用户要求修改：先改方案再重新调用 task_plan（会重新征求准许）。不要执行变更类工具。',
      }
    },
  }

  /* ---------------- 分步授权（1.2.0）：每一步做完再要一次准许 ---------------- */

  const stepMeta = (state) => {
    const cur = currentStep(state)
    const stats = stepStats(state)
    return { cur, stats }
  }

  /**
   * 弹「授权下一步」卡。
   * 与 askApproval 一样：问句压成一行（1.0.0 的卡片撑满界面 P0 教训），细节进 detail。
   */
  const askStep = async (exec, key, state) => {
    const uq = root.get?.('userQuestions') ?? (typeof root.get === 'function' ? root.get('userQuestions') : undefined)
    if (!uq || typeof uq.ask !== 'function') return { kind: 'unavailable' }

    const { cur, stats } = stepMeta(state)
    if (!cur) return { kind: 'continue' }

    const questionText = cfg.compactApproval
      ? `第 ${cur.index + 1}/${stats.total} 步｜${clip(cur.text, cfg.maxApprovalSummaryChars)}`
      : `下一步做这个，继续？\n\n${cur.index + 1}. ${cur.text}`

    const prev = stats.total > 0
      ? (state.steps[cur.index - 1] ?? null)
      : null
    const detailText = cfg.approvalDetail
      ? [
        renderProgress(state),
        prev ? `上一步完成情况：${prev.summary || '（未写 summary）'}` : '',
        '选「继续」我就只做这一步，做完再回来要授权。',
      ].filter(Boolean).join('\n')
      : ''

    store.asking.add(key)
    try {
      const question = {
        id: 'step',
        header: '下一步授权',
        question: questionText,
        options: [
          { label: '继续下一步', description: '只做这一步' },
          { label: '跳过这步', description: '直接跳下一个' },
          { label: '结束任务', description: '现在就收工' },
        ],
      }
      if (detailText) question.detail = detailText
      const request = { agent: exec?.agent, questions: [question] }
      if (exec?.signal) request.signal = exec.signal
      const answer = await withTimeout(uq.ask(request), cfg.approvalTimeoutMs, exec?.signal)
      const picked = Array.isArray(answer?.answers) ? answer.answers.find((a) => a && a.id === 'step') : undefined
      const selected = String(picked?.selected?.[0] ?? '')
      const custom = String(picked?.custom ?? '')
      if (selected.includes('跳过')) return { kind: 'skip', message: custom }
      if (selected.includes('结束') || selected.includes('收工')) return { kind: 'stop', message: custom }
      if (selected.includes('继续') || /^(ok|yes|go|next)/i.test(custom)) return { kind: 'continue', message: custom }
      return { kind: 'continue', message: selected || custom }
    } catch (error) {
      const message = String(error?.message ?? error)
      if (error?.name === 'AbortError') return { kind: 'stop', message: '调用被取消' }
      if (error?.code === 'TIMEOUT') return { kind: 'timeout' }
      if (/DELEGATED_CALLER|CALLER_NOT_LIVE|not live|no live/i.test(message)) return { kind: 'unavailable' }
      log('warn', `询问下一步授权失败：${message}`)
      return { kind: 'unavailable' }
    } finally {
      store.asking.delete(key)
      store.answeredAt.set(key, Date.now())
    }
  }

  /** 请示当前步；返回给模型的 status 对象。 */
  const requestStep = async (exec, key, state) => {
    const { cur, stats } = stepMeta(state)
    const progress = renderProgress(state)
    if (!cur) {
      state.phase = PHASE.APPROVED
      state.stepApproved = false
      return { status: 'all-done', progress, hint: '没有剩余步骤：向用户汇报成果与验收情况；要改或加东西就重新 task_plan。' }
    }

    state.phase = PHASE.STEP_AWAITING
    state.stepApproved = false
    if (!state.stepGateAt) state.stepGateAt = Date.now()
    const next = { index: cur.index + 1, total: stats.total, text: cur.text }

    if (cfg.stepApprovalMode !== 'ask') {
      return {
        status: 'awaiting_approval',
        progress,
        next,
        hint: `下一步等授权：把「第 ${next.index}/${next.total} 步：${clip(cur.text, 60)}」告诉用户，得到明确「继续」后调用 task_step(action=start)。`,
      }
    }

    const verdict = await askStep(exec, key, state)
    if (verdict.kind === 'continue') {
      state.phase = PHASE.EXECUTING
      state.stepApproved = true
      if (cur.status !== STEP_STATUS.ACTIVE) cur.status = STEP_STATUS.ACTIVE
      if (!cur.startedAt) cur.startedAt = Date.now()
      state.stepGateAt = null
      state.history.push({ kind: 'step-approve', by: 'question', step: state.stepIndex, at: Date.now() })
      return {
        status: 'approved',
        progress: renderProgress(state),
        next,
        hint: `用户准许了第 ${next.index} 步：只做这一步，做完调用 task_step(action=complete, summary=…)，不要顺手做后面几步。`,
      }
    }
    if (verdict.kind === 'skip') {
      advanceStep(state, STEP_STATUS.SKIPPED, '用户选择跳过')
      state.history.push({ kind: 'step-skip', by: 'question', step: cur.index, at: Date.now() })
      return requestStep(exec, key, state)
    }
    if (verdict.kind === 'stop') {
      state.phase = PHASE.TERMINATED
      state.stepApproved = false
      state.stepGateAt = null
      state.resolvedAt = Date.now()
      state.history.push({ kind: 'terminate', by: 'question', step: cur.index, at: Date.now() })
      await habits.update(learnFromTermination(habits.data)).catch(() => {})
      return {
        status: 'stopped',
        progress: renderProgress(state),
        hint: '用户选择收工：停止动手，只做收尾汇报（做到哪、留下什么、怎么接）。',
      }
    }
    if (verdict.kind === 'timeout') {
      return {
        status: 'awaiting_approval',
        progress,
        next,
        hint: `等授权超时（${Math.round(cfg.approvalTimeoutMs / 1000)}s）。把「第 ${next.index} 步：${clip(cur.text, 60)}，是否继续」写给用户；用户回复「继续」后调用 task_step(action=start)，也可让用户执行 /taskguard next。`,
      }
    }
    return {
      status: 'awaiting_approval',
      progress,
      next,
      subagent: true,
      hint: `当前上下文弹不出授权卡（子会话/非交互）。把第 ${next.index} 步写给用户，等明确「继续」后调用 task_step(action=start)。`,
    }
  }

  /** 一步收尾之后的统一动作：全做完 / 继续 / 进等授权。 */
  const afterAdvance = async (exec, key, state, advanced) => {
    const progress = renderProgress(state)
    const stats = stepStats(state)
    if (advanced.finished || !advanced.nextStep) {
      state.phase = PHASE.APPROVED
      state.stepApproved = false
      state.stepGateAt = null
      return {
        status: 'all-done',
        progress,
        stats,
        hint: '全部步骤已收尾：向用户汇报成果与验收（acceptance）情况；要改方案或加需求就重新 task_plan。',
      }
    }

    const next = { index: advanced.nextStep.index + 1, total: stats.total, text: advanced.nextStep.text }

    if (!cfg.stepGating) {
      state.phase = PHASE.EXECUTING
      state.stepApproved = true
      return {
        status: 'continuing',
        progress,
        stats,
        next,
        hint: `stepGating 已关闭：接着做第 ${next.index} 步「${clip(next.text, 60)}」。`,
      }
    }

    // 关键：进入「等待授权下一步」，闸门在这一阶段拦所有变更类工具
    state.phase = PHASE.STEP_AWAITING
    state.stepApproved = false
    state.stepGateAt = Date.now()
    const asked = await requestStep(exec, key, state)
    return { ...asked, stats }
  }

  const stepTool = {
    name: 'task_step',
    description:
      '分步执行（dsh-task-guard，1.2.0）：把 task_plan 的 steps 当计划表一步一步干，每步做完要用户授权下一步。'
      + 'action=progress 看进度条与计划表；complete 标记当前步完成（带 summary）并立刻请示下一步；'
      + 'start 请求/确认当前步的授权（用户说「继续」时用）；skip 跳过当前步；reset 把计划表退回第 1 步。'
      + '在「等待授权下一步」阶段，所有变更类工具都会被闸门拒绝，必须先过本工具。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: {
          type: 'string',
          enum: ['progress', 'complete', 'start', 'skip', 'reset'],
          description: 'progress 看进度｜complete 本步做完并请示下一步｜start 请求当前步授权｜skip 跳过当前步｜reset 计划表回到第 1 步',
        },
        summary: { type: 'string', description: 'action=complete 时写本步实际做了什么、产出在哪（会记入 progress 与下一步的授权卡）' },
        note: { type: 'string', description: '备注（可选）' },
      },
      required: ['action'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          status: { type: 'string', description: 'ok | approved | awaiting_approval | continuing | all-done | stopped | step-done | no-plan | blocked' },
          progress: { type: 'string' },
          next: { type: 'object' },
          stats: { type: 'object' },
          hint: { type: 'string' },
        },
      },
      render: (_args, value) => renderValue(value),
    },
    async execute(args, exec) {
      const key = agentKey(exec?.agent)
      const state = store.get(key)
      const action = typeof args?.action === 'string' ? args.action : 'progress'

      if (action === 'progress') {
        if (!state.plan) return { status: 'no-plan', hint: '还没有方案：先调用 task_plan 立项并取得准许。' }
        const { cur } = stepMeta(state)
        return {
          status: 'ok',
          progress: renderProgress(state),
          stats: stepStats(state),
          phase: state.phase,
          current: cur ? { index: cur.index + 1, text: cur.text, status: cur.status } : null,
          steps: state.steps.map((s) => ({ index: s.index + 1, text: s.text, status: s.status, summary: s.summary })),
        }
      }

      if (!state.plan) return { status: 'no-plan', hint: '还没有方案：先调用 task_plan 立项并取得准许。' }

      if (state.phase === PHASE.TERMINATED) {
        return { status: 'blocked', hint: '任务已终止：要接着做先 task_instruction(kind=resume)，要换事就重新 task_plan。' }
      }

      if (action === 'reset') {
        state.steps = initSteps(state.plan)
        state.stepIndex = 0
        state.stepApproved = state.steps.length > 0
        state.stepGateAt = null
        state.phase = PHASE.APPROVED
        state.history.push({ kind: 'step-reset', planId: state.planId, at: Date.now() })
        return { status: 'ok', progress: renderProgress(state), stats: stepStats(state), hint: '计划表已回到第 1 步（第一步视为已授权）。' }
      }

      if (!cfg.stepGating) {
        // 关掉分步授权时，complete 只做记账
        const cur0 = currentStep(state)
        if (action === 'complete' && cur0) {
          const advanced = advanceStep(state, STEP_STATUS.DONE, args?.summary)
          state.stepApproved = !advanced.finished
          return afterAdvance(exec, key, state, advanced)
        }
        return { status: 'continuing', progress: renderProgress(state), stats: stepStats(state), hint: 'stepGating=false：按计划自由推进。' }
      }

      if (action === 'complete') {
        const cur = currentStep(state)
        if (!cur) {
          return { status: 'all-done', progress: renderProgress(state), stats: stepStats(state), hint: '没有剩余步骤了。' }
        }
        const advanced = advanceStep(state, STEP_STATUS.DONE, args?.summary)
        state.history.push({ kind: 'step-done', step: cur.index, summary: clip(args?.summary ?? '', 200), at: Date.now() })
        log('info', `第 ${cur.index + 1} 步完成：${clip(cur.text, 50)}`)
        const result = await afterAdvance(exec, key, state, advanced)
        return { status: result.status === 'approved' ? 'approved' : result.status, ...result }
      }

      if (action === 'skip') {
        const cur = currentStep(state)
        if (!cur) return { status: 'all-done', progress: renderProgress(state), hint: '没有可跳过的步骤。' }
        advanceStep(state, STEP_STATUS.SKIPPED, args?.summary ?? args?.note ?? '跳过')
        state.history.push({ kind: 'step-skip', step: cur.index, at: Date.now() })
        // 跳过之后不再连环弹卡：交由模型向用户请示
        state.phase = cfg.stepGating ? PHASE.STEP_AWAITING : PHASE.EXECUTING
        state.stepApproved = !cfg.stepGating
        state.stepGateAt = Date.now()
        const nxt = currentStep(state)
        return {
          status: 'awaiting_approval',
          progress: renderProgress(state),
          stats: stepStats(state),
          next: nxt ? { index: nxt.index + 1, total: state.steps.length, text: nxt.text } : null,
          hint: nxt
            ? `已跳过第 ${cur.index + 1} 步。下一步是第 ${nxt.index + 1} 步「${clip(nxt.text, 60)}」：得到用户准许后 task_step(action=start)。`
            : '已跳过最后一步：全部步骤收尾，向用户汇报。',
        }
      }

      // start / 授权确认
      const cur = currentStep(state)
      if (!cur) {
        return { status: 'all-done', progress: renderProgress(state), stats: stepStats(state), hint: '没有剩余步骤：向用户汇报成果。' }
      }
      if (state.phase === PHASE.EXECUTING && state.stepApproved) {
        return {
          status: 'continuing',
          progress: renderProgress(state),
          stats: stepStats(state),
          next: { index: cur.index + 1, total: state.steps.length, text: cur.text },
          hint: `第 ${cur.index + 1} 步已授权：直接做这一步，做完调用 task_step(action=complete)。`,
        }
      }
      return { ...(await requestStep(exec, key, state)), stats: stepStats(state) }
    },
  }

  const instructionTool = {
    name: 'task_instruction',
    description:
      '判定任务进行中收到的下一条用户指令，并落状态（dsh-task-guard 需求 3）。'
      + 'kind=terminate 终止当前任务（立即收尾，不再动手）；append 在原任务上追加要求后继续，不要重新立项；'
      + 'resume 从终止态恢复原方案继续（用户说「继续刚才那个」时用）；'
      + 'new_task 视为全新任务，回到立项；question 只是提问，回答后继续原任务。'
      + '检测到新指令而未调用本工具时，变更类工具会被闸门拒绝。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        kind: { type: 'string', enum: INSTRUCTION_KINDS, description: 'terminate | append | resume | new_task | question' },
        instruction: { type: 'string', description: '用户原话的要点（保留关键约束，不要改写数字/路径/命令）' },
        additions: { type: 'array', items: { type: 'string' }, description: 'kind=append 时，追加进本次任务的具体项' },
        reason: { type: 'string', description: '判定依据（为什么算终止/追加/新任务/提问）' },
      },
      required: ['kind', 'instruction'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          status: { type: 'string', description: 'terminated | continuing | needs_plan | answering | invalid' },
          additions: { type: 'array', items: { type: 'string' } },
          hint: { type: 'string' },
        },
      },
      render: (_args, value) => renderValue(value),
    },
    async execute(args, exec) {
      const key = agentKey(exec?.agent)
      const state = store.get(key)
      const info = normalizeInstruction(args)
      if (!info.kind) {
        return { status: 'invalid', allowedKinds: INSTRUCTION_KINDS, hint: `kind 必须是 ${INSTRUCTION_KINDS.join(' / ')} 之一。` }
      }

      state.lastInstruction = { text: info.instruction || info.kind, kind: info.kind, at: Date.now(), reason: info.reason }
      state.history.push({ kind: info.kind, text: clip(info.instruction, 200), at: Date.now() })

      if (info.kind === 'terminate') {
        state.phase = PHASE.TERMINATED
        state.pendingInstruction = false
        state.resolvedAt = Date.now()
        await habits.update(learnFromTermination(habits.data)).catch(() => {})
        try {
          if (typeof exec?.concludeTurn === 'function') exec.concludeTurn()
        } catch (error) {
          log('warn', `结束本轮失败（不影响终止）：${error?.message ?? error}`)
        }
        log('warn', `任务终止：${clip(info.instruction || info.reason || '用户指令', 60)}`)
        return {
          status: 'terminated',
          planId: state.planId,
          hint: '任务已终止：不要再执行任何变更类工具，只输出收尾说明（做到哪、留下什么、怎么接）。',
        }
      }

      if (info.kind === 'resume') {
        if (!state.plan) {
          state.pendingInstruction = false
          return { status: 'needs_plan', hint: '没有可恢复的方案：先调用 task_plan 立项。' }
        }
        if (state.phase === PHASE.APPROVED || state.phase === PHASE.EXECUTING) {
          state.pendingInstruction = false
          return { status: 'continuing', additions: state.additions, hint: '本来就在执行：直接接着原 steps 干。' }
        }
        state.phase = PHASE.APPROVED
        state.pendingInstruction = false
        state.resolvedAt = null
        state.actionCount = 0
        // resume 不重排计划表：接着当前这一步继续（若正在等授权，则回到等授权）
        state.stepApproved = state.steps.length > 0 && currentStep(state) !== null
        if (!state.boundaries) {
          state.boundaries = mergeBoundaries(
            cfg,
            applyProfile(state.plan.profile, state.plan.boundaries, cfg),
            habitPromotions(habits.data, cfg),
          )
        }
        store.lastApproved = state.boundaries
        state.history.push({ kind: 'resume', planId: state.planId, at: Date.now() })
        log('info', `任务已恢复：方案#${state.planId}`)
        return {
          status: 'continuing',
          additions: state.additions,
          hint: '已从终止态恢复原方案（预算已重置）：按原 steps 继续，不需要重新立项、不用重述方案。',
        }
      }

      if (info.kind === 'append') {
        const inTask = state.phase === PHASE.APPROVED || state.phase === PHASE.EXECUTING || state.phase === PHASE.STEP_AWAITING
        if (!inTask) {
          state.pendingInstruction = false
          return { status: 'needs_plan', hint: '当前没有已准许的任务：把追加内容并进一次新的 task_plan。' }
        }
        const items = info.additions.length > 0 ? info.additions : [info.instruction].filter(Boolean)
        state.additions.push(...items)
        // 在等授权下一步时追加：把新要求挂在当前步之后，阶段不变（仍等那一步的授权）
        if (state.phase !== PHASE.STEP_AWAITING) state.phase = PHASE.EXECUTING
        state.pendingInstruction = false
        return {
          status: 'continuing',
          additions: state.additions,
          progress: renderProgress(state),
          hint: '继续原任务：把追加项接在当前步骤之后，不需要重新立项，也不要重述整份方案。',
        }
      }

      if (info.kind === 'new_task') {
        state.history.push({ kind: 'archive', planId: state.planId, at: Date.now() })
        state.plan = null
        state.boundaries = null
        state.additions = []
        state.pendingInstruction = false
        state.phase = PHASE.IDLE
        state.actionCount = 0
        state.steps = []
        state.stepIndex = 0
        state.stepApproved = false
        state.stepGateAt = null
        return { status: 'needs_plan', hint: '新任务：先调用 task_plan 立项并取得准许。' }
      }

      // question
      state.pendingInstruction = false
      return { status: 'answering', hint: '只是提问：直接回答，回答完继续原任务，阶段不变。' }
    },
  }

  const statusTool = {
    name: 'task_guard_status',
    description: '查看/重置 dsh-task-guard 状态：当前阶段与方案、生效边界、习惯库、帮助。action 省略=show。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['show', 'steps', 'reset', 'habits', 'habits-reset', 'boundaries', 'help'], description: 'show 默认｜steps 计划表进度｜reset 清空本会话状态｜habits 习惯库｜habits-reset 清空习惯库｜boundaries 当前边界｜help 用法' },
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: { text: { type: 'string' }, state: { type: 'object' } } },
      render: (_args, value) => renderValue(value?.text ?? value),
    },
    async execute(args, exec) {
      const key = agentKey(exec?.agent)
      const action = typeof args?.action === 'string' ? args.action : 'show'
      if (action === 'reset') {
        const state = store.reset(key)
        return { text: '已重置：阶段回到 idle，边界清空。下次动手前先 task_plan。', state: { phase: state.phase } }
      }
      if (action === 'habits-reset') {
        await habits.update(emptyHabits())
        return { text: '习惯库已清空：自动提升的边界一并撤销，只剩配置里的硬边界。', habits: [] }
      }
      if (action === 'habits') {
        return { text: renderHabits(habits.data, cfg), habits: habitList(habits.data) }
      }
      if (action === 'steps') {
        const state = store.peek(key)
        const progress = renderProgress(state ?? emptyState(key))
        return {
          text: progress || '没有计划表：task_plan 通过后才会展开。',
          progress,
          steps: (state?.steps ?? []).map((s) => ({ index: s.index + 1, text: s.text, status: s.status, summary: s.summary })),
          phase: state?.phase ?? 'idle',
        }
      }
      if (action === 'boundaries') {
        const state = store.peek(key)
        const b = state?.boundaries ?? mergeBoundaries(cfg, {}, habitPromotions(habits.data, cfg))
        return { text: JSON.stringify(b, null, 2), boundaries: b }
      }
      if (action === 'help') {
        return {
          text: [
            'dsh-task-guard 用法：',
            '1) 新任务：task_plan(goal, steps, boundaries, acceptance) → 用户准许 → 只做第 1 步',
            '2) 每步做完：task_step(action=complete, summary=…) → 用户授权下一步 → task_step(action=start)',
            '3) 看进度：task_step(action=progress) 或 /taskguard step',
            '4) 任务中来新指令：task_instruction(kind=terminate|append|resume|new_task|question)',
            '5) 查看/重置：task_guard_status(action=show|steps|reset|habits|habits-reset|boundaries)',
            '6) 斜杠命令：/taskguard show|step|next|approve|deny|reset|habits|boundaries|mode enforce|advisory',
          ].join('\n'),
        }
      }
      const state = store.peek(key) ?? emptyState(key)
      return {
        text: renderState(state, { disabled: !cfg.enabled, advisory: cfg.mode === 'advisory' }),
        state: { phase: state.phase, planId: state.planId, pendingInstruction: state.pendingInstruction, additions: state.additions },
      }
    },
  }

  const registerTools = (ctx) => {
    for (const definition of [planTool, instructionTool, stepTool, statusTool]) {
      try {
        const disposer = ctx.tools.register(definition)
        if (typeof disposer === 'function') keep(disposer)
        log('info', `已注册工具 ${definition.name}`)
      } catch (error) {
        log('error', `注册工具 ${definition.name} 失败：${error.message ?? error}`)
      }
    }
  }

  try {
    if (typeof root.inject === 'function') root.inject(['tools'], (ctx) => registerTools(ctx))
    else registerTools(root)
  } catch (error) {
    log('error', `注入 tools 服务失败：${error.message ?? error}`)
    registerTools(root)
  }

  /* ---------------- 5. System prompt：协议段 + 动态状态 ---------------- */

  const PROTOCOL_TEXT = [
    '## 任务闸门协议（dsh-task-guard，强制）',
    '本会话装有 task-guard：变更类工具（write/edit/pwsh/plugin_manager/job_kill 等）在「未获准许」或「新指令未判定」时会被直接拒绝，拒绝原因会写明缺哪一步。按三段执行：',
    '',
    '### 一、立项（每个新任务的第一步）',
    '- 只读探查（read/glob/grep/web/检查类 MCP）永远放行，可以先用它们摸清情况。',
    '- 动手之前必须调用 task_plan：goal（目标与交付物）、steps（有序步骤）、boundaries（allowedSkills / allowedTools / forbiddenTools / forbiddenPaths / maxActions）、acceptance（验收）。',
    '- task_plan 会向用户弹出准许选项：status=approved 才能执行；revise 就先改方案重提；rejected 就停手说明；manual 表示弹不出窗，把方案写给用户等其回复「准许」。',
    '- 不要用自然语言「请允许我…」代替 task_plan —— 闸门只认 task_plan 的结果。',
    '',
    '### 二、执行（分步走）',
    '- 方案里的 steps 就是计划表：一次只做当前这一步，做完立刻 task_step(action=complete, summary=做了什么) 收尾，不要顺手把后面几步一起做完。',
    '- 当前步做完后阶段变 awaiting_step（等待授权下一步）：此时变更类工具会被拒绝，必须先 task_step(action=start) 向用户请示下一步，拿到「继续」再动手。',
    '- task_step 的其它动作：progress 看进度条与计划表；skip 跳过当前步；reset 计划表退回第 1 步。',
    '- 超出方案范围的动作要重新 task_plan（planRev+1）并重新取得准许。',
    '- boundaries 里 forbidden* 的不要碰；allowedSkills 之外的 skill 不要加载；动作预算用满就收尾或重提方案。',
    '- 硬边界（配置里的 hardForbiddenTools / protectedPaths / dangerousCommands）不能被方案放宽。',
    '',
    '### 三、指令判定（收到任何新用户消息时）',
    '- 下一条动作必须是 task_instruction，kind 取：',
    '  terminate —— 停止/取消/不用了/算了/换话题：终止当前任务，只做收尾汇报；',
    '  append —— 在原要求上追加：记录 additions 后继续原任务，不要重新立项；',
    '  resume —— 终止后又让接着做：恢复原方案（不重弹窗、预算重置）；',
    '  new_task —— 明显是另一件事：回到立项；',
    '  question —— 只是提问：回答后继续原任务，阶段不变。',
    '- 判定之前不要执行任何变更类工具（闸门会拦）。',
    '- 终止措辞会被闸门直接记为 terminated：此时不要再动手。',
    '- 子会话/子代理：弹不出准许窗时按配置的 gateSubagents 策略处理（inherit 沿用最近一次人类准许的边界，硬边界仍然生效）。',
  ].join('\n')

  const sp = root.get?.('systemPrompt') ?? (typeof root.get === 'function' ? root.get('systemPrompt') : undefined)
  if (sp && typeof sp.section === 'function') {
    try {
      keep(sp.section({ name: 'task-guard:protocol', order: 10100, interpolate: false, text: PROTOCOL_TEXT }))
      log('info', '已注入 systemPrompt 协议段')
    } catch (error) {
      log('warn', `注入协议段失败：${error.message ?? error}`)
    }
  }

  if (sp && typeof sp.context === 'function') {
    try {
      keep(sp.context({
        name: 'task-guard:state',
        order: 900,
        interpolate: false,
        text: (assembleContext) => {
          try {
            const key = scopeKey(assembleContext?.scope)
            if (key === null) return ''
            const state = store.peek(key)
            if (!state) return ''
            const head = renderState(state, { disabled: !cfg.enabled, advisory: cfg.mode === 'advisory' })
            const progress = renderProgress(state)
            const hints = habitHints(habits.data, cfg)
            const tail = hints.length === 0
              ? ''
              : `\n习惯补充：${hints.map((h) => `${h.kind}=${h.value}×${h.weight}`).join('；')}`
            return `${head}${progress ? `\n${progress}` : ''}${tail}`
          } catch {
            return ''
          }
        },
      }))
      log('info', '已注入动态状态 context')
    } catch (error) {
      log('warn', `注入状态 context 失败：${error.message ?? error}`)
    }
  }

  /* ---------------- 6. 人类斜杠命令 /taskguard ---------------- */

  const commands = root.get?.('commands') ?? (typeof root.get === 'function' ? root.get('commands') : undefined)
  if (commands && typeof commands.register === 'function') {
    try {
      keep(commands.register({
        name: 'taskguard',
        description: 'dsh-task-guard：show|step|next|approve|deny|reset|habits|habits reset|boundaries|mode enforce|advisory',
        input: { hint: 'show | step | next | approve | deny | reset | habits | habits reset | boundaries | mode enforce|advisory' },
        handler: (invocation) => {
          try {
            const key = agentKey(invocation?.agent)
            const state = store.get(key)
            const raw = String(invocation?.rawInput ?? '').trim()
            const [sub, ...rest] = raw === '' ? ['show'] : raw.split(/\s+/)
            const arg = rest.join(' ')

            if (sub === 'approve') {
              if (state.phase !== PHASE.AWAITING && state.phase !== PHASE.REJECTED) {
                return { kind: 'error', text: `当前阶段是 ${state.phase}，没有待准许的方案。先让模型 task_plan。` }
              }
              state.phase = PHASE.APPROVED
              state.approvedAt = Date.now()
              state.pendingInstruction = false
              state.history.push({ kind: 'approve', by: 'command', at: Date.now() })
              habits.update(learnFromApproval(habits.data, state.plan)).catch(() => {})
              return { kind: 'success', text: `方案#${state.planId ?? '?'} 已准许，闸门放行变更类工具。` }
            }
            if (sub === 'step') {
              const progress = renderProgress(state)
              const cur = currentStep(state)
              return {
                kind: 'success',
                text: [
                  progress || '没有计划表：task_plan 通过后才会展开。',
                  '',
                  cur ? `当前：第 ${cur.index + 1} 步「${clip(cur.text, 80)}」（${cur.status}）` : '已无剩余步骤',
                  state.phase === PHASE.STEP_AWAITING ? '下一步等你授权：/taskguard next' : '',
                ].filter(Boolean).join('\n'),
              }
            }
            if (sub === 'next') {
              if (!state.plan) return { kind: 'error', text: '还没有方案：先让模型 task_plan。' }
              const cur = currentStep(state)
              if (!cur) return { kind: 'error', text: '没有剩余步骤了：本轮可以收尾。' }
              state.phase = PHASE.EXECUTING
              state.stepApproved = true
              state.stepGateAt = null
              if (cur.status !== STEP_STATUS.ACTIVE) cur.status = STEP_STATUS.ACTIVE
              if (!cur.startedAt) cur.startedAt = Date.now()
              state.history.push({ kind: 'step-approve', by: 'command', step: state.stepIndex, at: Date.now() })
              return { kind: 'success', text: `已授权第 ${cur.index + 1} 步「${clip(cur.text, 60)}」：模型可以动手做这一步了。` }
            }
            if (sub === 'deny') {
              state.phase = PHASE.TERMINATED
              state.pendingInstruction = false
              habits.update(learnFromRejection(habits.data)).catch(() => {})
              return { kind: 'success', text: '已否决并终止当前任务。' }
            }
            if (sub === 'reset') {
              store.reset(key)
              return { kind: 'success', text: '已重置本会话状态：阶段 idle，边界清空。' }
            }
            if (sub === 'habits') {
              if (arg === 'reset') {
                habits.update(emptyHabits()).catch(() => {})
                return { kind: 'success', text: '习惯库已清空：自动提升的边界一并撤销，只剩配置里的硬边界。' }
              }
              return { kind: 'success', text: renderHabits(habits.data, cfg) }
            }
            if (sub === 'boundaries') {
              const b = state.boundaries ?? mergeBoundaries(cfg, {}, habitPromotions(habits.data, cfg))
              return { kind: 'success', text: JSON.stringify(b, null, 2) }
            }
            if (sub === 'mode') {
              if (arg !== 'enforce' && arg !== 'advisory') return { kind: 'error', text: '用法：/taskguard mode enforce|advisory' }
              cfg.mode = arg
              return { kind: 'success', text: `闸门模式已切换为 ${arg}（临时，重启后回到配置文件里的值）。` }
            }
            if (sub === 'off' || sub === 'on') {
              cfg.enabled = sub === 'on'
              return { kind: 'success', text: `闸门已${cfg.enabled ? '启用' : '停用'}（临时）。` }
            }
            return {
              kind: 'success',
              text: [
                renderState(state, { disabled: !cfg.enabled, advisory: cfg.mode === 'advisory' }),
                '',
                '命令：/taskguard step | next | approve | deny | reset | habits | boundaries | mode enforce|advisory | on | off',
              ].join('\n'),
            }
          } catch (error) {
            return { kind: 'error', text: `taskguard 命令失败：${error?.message ?? error}` }
          }
        },
      }))
      log('info', '已注册斜杠命令 /taskguard')
    } catch (error) {
      log('warn', `注册 /taskguard 失败：${error.message ?? error}`)
    }
  }

  track(root, 'lifecycle')
  log('info', `已加载：enforce=${cfg.requirePlan} classify=${cfg.requireClassify} habits=${habits.path}`)
}

export default apply
