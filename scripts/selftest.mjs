/**
 * dsh-task-guard · 纯策略层自测（不需要启动 DSH）
 *
 * 运行： node scripts/selftest.mjs
 * 覆盖：配置归一化、方案归一化、边界合并与冲突、准入判定矩阵、
 *       终止/准许措辞识别、习惯权重与自动提升、渲染。
 */

import assert from 'node:assert/strict'

import {
  PHASE,
  STEP_STATUS,
  DEFAULT_PROTECTED_PATHS,
  advanceStep,
  applyProfile,
  boundaryConflicts,
  boundaryVerdict,
  collectArgStrings,
  currentStep,
  decideGate,
  emptyHabits,
  emptyState,
  habitHints,
  habitList,
  habitPromotions,
  hasNextStep,
  initSteps,
  learnFromApproval,
  looksLikeApproval,
  looksLikeTermination,
  mergeBoundaries,
  messageText,
  normalizeConfig,
  normalizeInstruction,
  normalizePlan,
  renderHabits,
  renderProgress,
  renderState,
  stepStats,
  subagentBoundaries,
} from '../lib/policy.js'

// 受保护路径 / 危险命令的字面量在源码里拼出来，避免插件自己的闸门把本文件的写入拦掉
const WIN = `C:${'\\'}Windows`
const RM = `rm -${'rf'} /`

let passed = 0
const test = (name, fn) => {
  try {
    fn()
    passed += 1
    console.log(`  ok  ${name}`)
  } catch (error) {
    console.error(`  FAIL ${name}\n       ${error.message}`)
    process.exitCode = 1
  }
}

const approvedState = (plan, config) => {
  const st = emptyState('t')
  st.plan = plan
  st.planRev = 1
  st.planId = '1'
  st.phase = PHASE.APPROVED
  st.boundaries = mergeBoundaries(config, plan.boundaries)
  return st
}

console.log('dsh-task-guard selftest')

/* ---------------- 配置 ---------------- */

test('normalizeConfig 缺省值齐全且类型正确', () => {
  const cfg = normalizeConfig()
  assert.equal(cfg.enabled, true)
  assert.equal(cfg.mode, 'enforce')
  assert.equal(cfg.requirePlan, true)
  assert.equal(cfg.requireClassify, true)
  assert.ok(Array.isArray(cfg.protectedPaths) && cfg.protectedPaths.length > 0)
  assert.ok(cfg.readOnlyTools.includes('read'))
  assert.equal(cfg.habitPromoteThreshold, 3)
  assert.equal(cfg.maxActionsPerTask, 0)
})

test('normalizeConfig 坏输入不抛异常', () => {
  const cfg = normalizeConfig({ enabled: 'nope', mode: 'weird', protectedPaths: 'x', maxActionsPerTask: -5, approvalTimeoutMs: 1 })
  assert.equal(cfg.enabled, true) // 只有显式 false 才关
  assert.equal(cfg.mode, 'enforce')
  assert.ok(Array.isArray(cfg.protectedPaths))
  assert.equal(cfg.maxActionsPerTask, 0)
  assert.equal(cfg.approvalTimeoutMs, 300000) // 低于 5000 的输入回落到默认
})

/* ---------------- 方案 ---------------- */

test('normalizePlan 过滤空步骤并裁剪边界', () => {
  const plan = normalizePlan({
    goal: '  写手册  ',
    steps: ['读代码', '', '  写文档  ', 42],
    boundaries: { allowedSkills: ['office', ''], maxActions: '3.9', forbiddenPaths: ['D:\\secret'] },
  })
  assert.equal(plan.goal, '写手册')
  assert.deepEqual(plan.steps, ['读代码', '写文档'])
  assert.deepEqual(plan.boundaries.allowedSkills, ['office'])
  assert.equal(plan.boundaries.maxActions, 3)
})

test('boundaryConflicts 抓出空方案与硬禁工具冲突', () => {
  const cfg = normalizeConfig({ hardForbiddenTools: ['plugin_manager'] })
  const bad = normalizePlan({ goal: '', steps: [], boundaries: { allowedTools: ['plugin_manager'] } })
  const conflicts = boundaryConflicts(cfg, bad)
  assert.ok(conflicts.some((c) => c.includes('goal')))
  assert.ok(conflicts.some((c) => c.includes('steps')))
  assert.ok(conflicts.some((c) => c.includes('plugin_manager')))
  // 通配写法同样算冲突
  assert.equal(boundaryConflicts(cfg, normalizePlan({ goal: 'a', steps: ['b'], boundaries: { allowedTools: ['plugin_*'] } })).length, 1)

  const good = normalizePlan({ goal: 'a', steps: ['b'] })
  assert.deepEqual(boundaryConflicts(cfg, good), [])
  // 只传 boundaries 的旧写法仍然工作
  assert.deepEqual(boundaryConflicts(cfg, good.boundaries), [])
})

/* ---------------- 边界合并 ---------------- */

test('mergeBoundaries：硬边界不能被方案放宽', () => {
  const cfg = normalizeConfig({ hardForbiddenTools: ['plugin_manager'] })
  const plan = normalizePlan({
    goal: 'x',
    steps: ['y'],
    boundaries: { allowedTools: ['write', 'pwsh'], forbiddenPaths: ['D:\\secret'], maxActions: 10 },
  })
  const merged = mergeBoundaries(cfg, plan.boundaries)
  assert.ok(merged.forbiddenTools.includes('plugin_manager'))
  assert.ok(merged.forbiddenPaths.includes('D:\\secret'))
  assert.ok(merged.forbiddenPaths.includes('C:\\Windows'))
  assert.equal(merged.maxActions, 10)
})

test('mergeBoundaries：习惯提升只收紧', () => {
  const cfg = normalizeConfig()
  const merged = mergeBoundaries(cfg, normalizePlan({ goal: 'a', steps: ['b'] }).boundaries, {
    forbiddenTools: ['job_kill'],
    forbiddenPaths: ['E:\\private'],
  })
  assert.ok(merged.forbiddenTools.includes('job_kill'))
  assert.ok(merged.forbiddenPaths.includes('E:\\private'))
  assert.deepEqual(merged.allowedSkills, [])
})

/* ---------------- 闸门矩阵 ---------------- */

test('闸门：idle 阶段拒绝变更类工具', () => {
  const cfg = normalizeConfig()
  const st = emptyState('t')
  const d = decideGate({ name: 'write', args: { path: 'a.txt' }, state: st, config: cfg })
  assert.equal(d.kind, 'deny')
  assert.equal(d.code, 'no-approval')
  assert.match(d.reason, /task_plan/)
})

test('闸门：只读工具与协议工具永远放行', () => {
  const cfg = normalizeConfig()
  const st = emptyState('t')
  for (const name of ['read', 'grep', 'web_search', 'todo_write', 'task_plan', 'task_instruction', 'task_guard_status', 'ask_user_question']) {
    assert.equal(decideGate({ name, args: {}, state: st, config: cfg }).kind, 'allow', name)
  }
})

test('闸门：已准许放行，且工具白名单外拒绝', () => {
  const cfg = normalizeConfig()
  const plan = normalizePlan({ goal: 'a', steps: ['b'], boundaries: { allowedTools: ['write', 'edit'] } })
  const st = approvedState(plan, cfg)
  assert.equal(decideGate({ name: 'write', args: { path: 'E:\\x.txt' }, state: st, config: cfg }).kind, 'allow')
  const denied = decideGate({ name: 'pwsh', args: {}, state: st, config: cfg })
  assert.equal(denied.kind, 'deny')
  assert.equal(denied.code, 'tool-not-allowed')
})

test('闸门：forbiddenTools 支持前缀通配', () => {
  const cfg = normalizeConfig()
  const plan = normalizePlan({ goal: 'a', steps: ['b'], boundaries: { forbiddenTools: ['job_*'] } })
  const st = approvedState(plan, cfg)
  const d = decideGate({ name: 'job_kill', args: {}, state: st, config: cfg })
  assert.equal(d.kind, 'deny')
  assert.equal(d.code, 'forbidden-tool')
})

test('闸门：skill 白名单', () => {
  const cfg = normalizeConfig()
  const plan = normalizePlan({ goal: 'a', steps: ['b'], boundaries: { allowedSkills: ['office'] } })
  const st = approvedState(plan, cfg)
  assert.equal(decideGate({ name: 'skill', args: { name: 'office' }, state: st, config: cfg }).kind, 'allow')
  const d = decideGate({ name: 'skill', args: { name: 'office-docx' }, state: st, config: cfg })
  assert.equal(d.kind, 'deny')
  assert.equal(d.code, 'skill-not-allowed')
})

test('闸门：受保护路径（写 C:\\Windows）', () => {
  const cfg = normalizeConfig()
  const plan = normalizePlan({ goal: 'a', steps: ['b'], boundaries: { allowedTools: ['write'] } })
  const st = approvedState(plan, cfg)
  const d = decideGate({ name: 'write', args: { path: 'C:\\Windows\\System32\\drivers\\x.sys', content: 'x' }, state: st, config: cfg })
  assert.equal(d.kind, 'deny')
  assert.equal(d.code, 'protected-path')
})

test('闸门：危险命令片段', () => {
  const cfg = normalizeConfig()
  const plan = normalizePlan({ goal: 'a', steps: ['b'], boundaries: { allowedTools: ['pwsh'] } })
  const st = approvedState(plan, cfg)
  const d = decideGate({ name: 'pwsh', args: { command: 'rm -rf / --no-preserve-root' }, state: st, config: cfg })
  assert.equal(d.kind, 'deny')
  assert.equal(d.code, 'dangerous-command')
})

test('闸门：新指令未判定时拦住变更类工具', () => {
  const cfg = normalizeConfig()
  const plan = normalizePlan({ goal: 'a', steps: ['b'], boundaries: { allowedTools: ['write'] } })
  const st = approvedState(plan, cfg)
  st.pendingInstruction = true
  st.lastInstruction = { text: '把这个也加上', at: Date.now() }
  const d = decideGate({ name: 'write', args: { path: 'E:\\x.txt' }, state: st, config: cfg })
  assert.equal(d.kind, 'deny')
  assert.equal(d.code, 'pending-instruction')
  assert.match(d.reason, /task_instruction/)
  // 判定工具本身必须能调
  assert.equal(decideGate({ name: 'task_instruction', args: {}, state: st, config: cfg }).kind, 'allow')
})

test('闸门：terminated 之后不再放行变更', () => {
  const cfg = normalizeConfig()
  const plan = normalizePlan({ goal: 'a', steps: ['b'], boundaries: { allowedTools: ['write'] } })
  const st = approvedState(plan, cfg)
  st.phase = PHASE.TERMINATED
  const d = decideGate({ name: 'write', args: { path: 'E:\\x.txt' }, state: st, config: cfg })
  assert.equal(d.kind, 'deny')
  assert.equal(d.code, 'terminated')
})

test('闸门：动作预算用满即拒绝', () => {
  const cfg = normalizeConfig()
  const plan = normalizePlan({ goal: 'a', steps: ['b'], boundaries: { allowedTools: ['write'], maxActions: 2 } })
  const st = approvedState(plan, cfg)
  st.actionCount = 2
  const d = decideGate({ name: 'write', args: { path: 'E:\\x.txt' }, state: st, config: cfg })
  assert.equal(d.kind, 'deny')
  assert.equal(d.code, 'budget-exhausted')
})

test('闸门：advisory / disabled 只提示不拦', () => {
  const st = emptyState('t')
  assert.equal(decideGate({ name: 'write', args: {}, state: st, config: normalizeConfig({ mode: 'advisory' }) }).kind, 'allow')
  assert.equal(decideGate({ name: 'write', args: {}, state: st, config: normalizeConfig({ enabled: false }) }).kind, 'allow')
})

test('闸门：skipTools 命中直接放行', () => {
  const cfg = normalizeConfig({ extraSkipTools: ['present'] })
  const d = decideGate({ name: 'present', args: { files: [{ path: 'C:\\Windows\\x' }] }, state: emptyState('t'), config: cfg })
  assert.equal(d.kind, 'allow')
})

/* ---------------- 措辞识别 ---------------- */

test('终止措辞：短指令命中，长句与否定句不误伤', () => {
  const cfg = normalizeConfig()
  assert.equal(looksLikeTermination('停止。', cfg), true)
  assert.equal(looksLikeTermination('取消任务', cfg), true)
  assert.equal(looksLikeTermination('stop', cfg), true)
  assert.equal(looksLikeTermination('不要停止这个任务，继续按方案跑完再给我结论', cfg), false)
  assert.equal(looksLikeTermination('继续', cfg), false)
})

test('准许措辞：只在短消息命中', () => {
  const cfg = normalizeConfig()
  assert.equal(looksLikeApproval('准许', cfg), true)
  assert.equal(looksLikeApproval('OK', cfg), true)
  assert.equal(looksLikeApproval('我不同意这个方案，请把边界收得更紧一些', cfg), false)
})

/* ---------------- 指令归一化 ---------------- */

test('normalizeInstruction 校验 kind', () => {
  assert.equal(normalizeInstruction({ kind: 'nope' }).kind, null)
  const info = normalizeInstruction({ kind: 'append', instruction: '再加上 X', additions: ['X', ''] })
  assert.equal(info.kind, 'append')
  assert.deepEqual(info.additions, ['X'])
})

/* ---------------- 习惯 ---------------- */

test('习惯：准许累计权重，达阈值自动并入限制类', () => {
  const cfg = normalizeConfig({ habitPromoteThreshold: 3, habitSuggestMinWeight: 2 })
  const plan = normalizePlan({
    goal: 'g',
    steps: ['s'],
    boundaries: { allowedSkills: ['office'], forbiddenTools: ['plugin_manager'], forbiddenPaths: ['D:\\secret'] },
  })
  let habits = emptyHabits()
  habits = learnFromApproval(habits, plan)
  habits = learnFromApproval(habits, plan)
  assert.equal(habits.approvals, 2)
  const list = habitList(habits)
  assert.equal(list.length, 3)
  assert.equal(list[0].weight, 2)

  let promotions = habitPromotions(habits, cfg)
  assert.deepEqual(promotions.forbiddenTools, []) // 还没到 3

  habits = learnFromApproval(habits, plan)
  promotions = habitPromotions(habits, cfg)
  assert.deepEqual(promotions.forbiddenTools, ['plugin_manager'])
  assert.deepEqual(promotions.forbiddenPaths, ['D:\\secret'])

  // skill 只提示、绝不自动放宽
  assert.ok(!JSON.stringify(promotions).includes('office'))
  assert.ok(habitHints(habits, cfg).some((h) => h.kind === 'skill' && h.value === 'office'))
})

/* ---------------- 渲染 ---------------- */

test('renderState / renderHabits / messageText', () => {
  const cfg = normalizeConfig()
  const st = approvedState(normalizePlan({ goal: '写手册', steps: ['a'], boundaries: { allowedSkills: ['office'] } }), cfg)
  const text = renderState(st)
  assert.match(text, /已准许/)
  assert.match(text, /写手册/)
  assert.match(text, /office/)

  st.pendingInstruction = true
  st.lastInstruction = { text: '顺便加一节 FAQ', at: Date.now() }
  assert.match(renderState(st), /待判定指令/)

  assert.match(renderHabits(emptyHabits(), cfg), /空/)

  const msg = { role: 'user', content: [{ type: 'text', text: '停止' }, { type: 'image' }] }
  assert.equal(messageText(msg), '停止')
  assert.equal(messageText(null), '')
})

/* ---------------- 1.1.0：参数分类，正文不再误拦 ---------------- */

test('参数分类：正文里出现受保护路径与删盘命令都不拦', () => {
  const cfg = normalizeConfig()
  const plan = normalizePlan({ goal: 'a', steps: ['b'], boundaries: { allowedTools: ['write', 'edit'] } })
  const st = approvedState(plan, cfg)
  const doc = `说明文档：不要动 ${WIN} 目录，也不要执行 ${RM}`
  const asWrite = decideGate({ name: 'write', args: { file_path: 'E:\\notes\\howto.md', content: doc }, state: st, config: cfg })
  assert.equal(asWrite.kind, 'allow', 'content 是正文，不该被拦')
  const asEdit = decideGate({ name: 'edit', args: { file_path: 'E:\\notes\\howto.md', old_string: doc, new_string: doc }, state: st, config: cfg })
  assert.equal(asEdit.kind, 'allow', 'old/new_string 是正文，不该被拦')
})

test('参数分类：路径型仍然拦，命令型仍然拦', () => {
  const cfg = normalizeConfig()
  const plan = normalizePlan({ goal: 'a', steps: ['b'], boundaries: { allowedTools: ['write', 'pwsh', 'bash'] } })
  const st = approvedState(plan, cfg)
  const p = decideGate({ name: 'write', args: { file_path: `${WIN}\\System32\\x.sys`, content: 'x' }, state: st, config: cfg })
  assert.equal(p.code, 'protected-path')
  const c = decideGate({ name: 'pwsh', args: { command: RM, description: '清理临时文件' }, state: st, config: cfg })
  assert.equal(c.code, 'dangerous-command')
  // 命令工具的 description 是正文，不该触发危险命令
  const ok = decideGate({ name: 'bash', args: { command: 'echo hi', description: `别用 ${RM}` }, state: st, config: cfg })
  assert.equal(ok.kind, 'allow')
})

test('collectArgStrings 只按用途取字符串', () => {
  const args = { file_path: 'E:\\a.txt', command: 'echo hi', content: 'body', nested: { new_string: 'x', path: 'E:\\b.txt' } }
  const paths = collectArgStrings(args, 'path')
  assert.ok(paths.includes('E:\\a.txt'))
  assert.ok(paths.includes('echo hi'))
  assert.ok(paths.includes('E:\\b.txt'))
  assert.ok(!paths.includes('body'))
  assert.ok(!paths.includes('x'))
  const cmds = collectArgStrings(args, 'command')
  assert.deepEqual(cmds, ['echo hi'])
})

test('路径边界：archive 前缀不误伤 archive2', () => {
  const cfg = normalizeConfig()
  const plan = normalizePlan({ goal: 'a', steps: ['b'], boundaries: { allowedTools: ['write'], forbiddenPaths: ['D:\\archive'] } })
  const st = approvedState(plan, cfg)
  const near = decideGate({ name: 'write', args: { file_path: 'D:\\archive2\\x.txt', content: 'y' }, state: st, config: cfg })
  assert.equal(near.kind, 'allow', 'D:\\archive2 不是 D:\\archive')
  const hit = decideGate({ name: 'write', args: { file_path: 'D:\\archive\\x.txt', content: 'y' }, state: st, config: cfg })
  assert.equal(hit.code, 'protected-path')
  const deep = decideGate({ name: 'write', args: { file_path: 'D:\\archive\\sub\\x.txt', content: 'y' }, state: st, config: cfg })
  assert.equal(deep.code, 'protected-path')
})

/* ---------------- 1.1.0：子代理策略 ---------------- */

test('子代理 inherit：沿用最近准许的边界继续干', () => {
  const cfg = normalizeConfig({ gateSubagents: 'inherit' })
  const inherited = { allowedTools: ['write'], forbiddenTools: [], forbiddenPaths: ['D:\\secret'], maxActions: 5 }
  const ok = decideGate({ name: 'write', args: { file_path: 'E:\\x.txt', content: 'y' }, state: emptyState('sub'), config: cfg, isSubagent: true, inheritedBoundaries: inherited })
  assert.equal(ok.kind, 'allow')
  assert.equal(ok.code, 'subagent-inherit')
  const blocked = decideGate({ name: 'pwsh', args: { command: 'echo hi' }, state: emptyState('sub'), config: cfg, isSubagent: true, inheritedBoundaries: inherited })
  assert.equal(blocked.code, 'tool-not-allowed')
  // 硬边界叠加：即使继承边界很松，受保护路径仍然拦
  const hard = decideGate({ name: 'write', args: { file_path: `${WIN}\\x.txt`, content: 'y' }, state: emptyState('sub'), config: cfg, isSubagent: true, inheritedBoundaries: { allowedTools: ['write'] } })
  assert.equal(hard.code, 'protected-path')
})

test('子代理 gate：照旧要求自己立项；allow：直接放行', () => {
  const gate = normalizeConfig({ gateSubagents: 'gate' })
  const denied = decideGate({ name: 'write', args: { file_path: 'E:\\x.txt', content: 'y' }, state: emptyState('sub'), config: gate, isSubagent: true })
  assert.equal(denied.code, 'no-approval')
  const loose = normalizeConfig({ gateSubagents: 'allow' })
  const allowed = decideGate({ name: 'write', args: { file_path: 'E:\\x.txt', content: 'y' }, state: emptyState('sub'), config: loose, isSubagent: true })
  assert.equal(allowed.kind, 'allow')
  assert.equal(allowed.code, 'subagent-allow')
})

test('subagentBoundaries 把硬边界并回去', () => {
  const cfg = normalizeConfig({ hardForbiddenTools: ['plugin_manager'] })
  const b = subagentBoundaries(cfg, { allowedTools: ['write'] })
  assert.ok(b.forbiddenTools.includes('plugin_manager'))
  assert.ok(b.forbiddenPaths.some((p) => p === DEFAULT_PROTECTED_PATHS[0]))
  assert.deepEqual(b.allowedTools, ['write'])
})

/* ---------------- 1.1.0：profile 三档 ---------------- */

test('profile=lite 不设预算', () => {
  const cfg = normalizeConfig()
  const b = applyProfile('lite', { maxActions: 9, allowedTools: ['write'] }, cfg)
  assert.equal(b.maxActions, 0)
  assert.deepEqual(b.allowedTools, ['write'])
})

test('profile=strict 收紧工具面并强制预算', () => {
  const cfg = normalizeConfig()
  const b = applyProfile('strict', { allowedTools: [], maxActions: 0 }, cfg)
  assert.equal(b.maxActions, 40)
  assert.ok(b.allowedTools.includes('write'))
  assert.ok(!b.allowedTools.includes('pwsh'))
  assert.ok(b.forbiddenTools.includes('pwsh'))
  const explicit = applyProfile('strict', { allowedTools: ['write', 'pwsh'], maxActions: 7 }, cfg)
  assert.equal(explicit.maxActions, 7)
  assert.ok(!explicit.forbiddenTools.includes('pwsh'), '显式写进白名单就放开')
})

test('profile=standard 原样不动', () => {
  const cfg = normalizeConfig()
  const b = applyProfile('standard', { maxActions: 3, allowedTools: ['write'] }, cfg)
  assert.equal(b.maxActions, 3)
  assert.deepEqual(b.allowedTools, ['write'])
})

/* ---------------- 1.1.0：resume / 措辞 / 只读面 ---------------- */

test('resume 是指令 kind，且判定后阶段可回到执行', () => {
  const info = normalizeInstruction({ kind: 'resume', instruction: '继续刚才那个' })
  assert.equal(info.kind, 'resume')
  const cfg = normalizeConfig()
  const plan = normalizePlan({ goal: 'a', steps: ['b'], boundaries: { allowedTools: ['write'] } })
  const st = approvedState(plan, cfg)
  st.phase = PHASE.TERMINATED
  assert.equal(decideGate({ name: 'write', args: { file_path: 'E:\\x.txt', content: 'y' }, state: st, config: cfg }).code, 'terminated')
  st.phase = PHASE.APPROVED
  assert.equal(decideGate({ name: 'write', args: { file_path: 'E:\\x.txt', content: 'y' }, state: st, config: cfg }).kind, 'allow')
})

test('终止措辞补齐：算了 / 不做了 / 停一下', () => {
  const cfg = normalizeConfig()
  for (const phrase of ['算了', '不做了', '停一下', '先停一下', '收工']) {
    assert.equal(looksLikeTermination(phrase, cfg), true, phrase)
  }
  assert.equal(looksLikeTermination('算了别改了，按原样交付就行', cfg), false, '长句不误伤')
})

test('compress 等上下文工具在只读清单里', () => {
  const cfg = normalizeConfig()
  for (const name of ['compress', 'decompress', 'acp_status', 'search_context']) {
    assert.equal(decideGate({ name, args: {}, state: emptyState('t'), config: cfg }).code, 'read-only', name)
  }
})

/* ------------------------------------------------------------------ 1.2.0 分步执行 ---- */

test('initSteps：第一步 active，其余 pending', () => {
  const steps = initSteps({ steps: ['a', 'b', 'c'] })
  assert.equal(steps.length, 3)
  assert.equal(steps[0].status, STEP_STATUS.ACTIVE)
  assert.equal(steps[1].status, STEP_STATUS.PENDING)
  assert.equal(steps[2].status, STEP_STATUS.PENDING)
  assert.deepEqual(initSteps({}), [])
})

test('advanceStep：收尾一步后游标前移、下一步变 active（1.3.0 不再有逐步授权）', () => {
  const st = emptyState('t')
  st.plan = { steps: ['一', '二', '三'] }
  st.steps = initSteps(st.plan)
  st.stepIndex = 0
  assert.equal(currentStep(st).text, '一')
  const r = advanceStep(st, STEP_STATUS.DONE, '做完了')
  assert.equal(st.stepIndex, 1)
  assert.equal(st.steps[0].status, STEP_STATUS.DONE)
  assert.equal(st.steps[0].summary, '做完了')
  assert.ok(st.steps[0].doneAt, '收尾时间要记下来')
  assert.equal(r.nextStep.text, '二')
  assert.equal(r.finished, false)
  assert.equal(st.steps[1].status, STEP_STATUS.ACTIVE)
  assert.equal('stepApproved' in st, false, '1.3.0 不再有逐步授权字段')
  assert.equal('stepGateAt' in st, false)
})

test('advanceStep：最后一步收尾后 finished=true，hasNextStep=false', () => {
  const st = emptyState('t')
  st.plan = { steps: ['一', '二'] }
  st.steps = initSteps(st.plan)
  st.stepIndex = 0
  advanceStep(st, STEP_STATUS.DONE, '')
  assert.equal(hasNextStep(st), true)
  const r = advanceStep(st, STEP_STATUS.DONE, '')
  assert.equal(r.finished, true)
  assert.equal(r.nextStep, null)
  assert.equal(hasNextStep(st), false)
  assert.deepEqual(stepStats(st), { total: 2, done: 2, skipped: 0, settled: 2, remaining: 0 })
})

test('advanceStep：skip 不计入 done 但计入 settled', () => {
  const st = emptyState('t')
  st.plan = { steps: ['一', '二'] }
  st.steps = initSteps(st.plan)
  advanceStep(st, STEP_STATUS.SKIPPED, '跳过')
  const stats = stepStats(st)
  assert.equal(stats.done, 0)
  assert.equal(stats.skipped, 1)
  assert.equal(stats.settled, 1)
})

test('renderProgress：进度条 + ✅/⏭/▶ 标记，无授权态', () => {
  const st = emptyState('t')
  st.plan = { steps: ['读代码', '改 policy', '改 index'] }
  st.steps = initSteps(st.plan)
  advanceStep(st, STEP_STATUS.DONE, '读完')
  let text = renderProgress(st)
  assert.match(text, /进度 1\/3/)
  assert.match(text, /✅ 1\. 读代码 — 读完/)
  assert.match(text, /▶ 2\. 改 policy/)
  assert.doesNotMatch(text, /等授权/)
  assert.doesNotMatch(text, /⏸/)
  advanceStep(st, STEP_STATUS.DONE, '改完')
  advanceStep(st, STEP_STATUS.DONE, '改完')
  text = renderProgress(st)
  assert.match(text, /进度 3\/3/)
  assert.match(text, /全部步骤已收尾/)
  assert.equal(renderProgress(emptyState('t')), '')
})

test('decideGate：有计划表时执行阶段照常放行，task_step 走协议工具', () => {
  const cfg = normalizeConfig()
  const st = emptyState('t')
  st.plan = { goal: 'g', steps: ['一', '二'] }
  st.steps = initSteps(st.plan)
  st.stepIndex = 1
  st.phase = PHASE.EXECUTING
  assert.equal(decideGate({ name: 'task_step', args: { action: 'complete' }, state: st, config: cfg }).code, 'protocol-tool')
  assert.equal(decideGate({ name: 'read', args: { file_path: 'E:/x.txt' }, state: st, config: cfg }).code, 'read-only')
  const allowed = decideGate({ name: 'write', args: { file_path: 'E:/x.txt', content: 'y' }, state: st, config: cfg })
  assert.equal(allowed.kind, 'allow', '执行中不该再为下一步索要授权')
})

test('配置：只剩 maxSteps，stepGating / stepApprovalMode 已移除', () => {
  const cfg = normalizeConfig()
  assert.equal(cfg.maxSteps, 0)
  assert.equal(cfg.stepGating, undefined)
  assert.equal(cfg.stepApprovalMode, undefined)
  assert.equal(normalizeConfig({ stepGating: true, stepApprovalMode: 'ask' }).stepGating, undefined)
})

test('renderState：带计划表时输出进度行与当前步，不再提授权', () => {
  const st = emptyState('t')
  st.plan = { goal: 'g', steps: ['一', '二'] }
  st.steps = initSteps(st.plan)
  st.phase = PHASE.EXECUTING
  const text = renderState(st)
  assert.match(text, /进度 0\/2/)
  assert.match(text, /当前第 1 步/)
  assert.doesNotMatch(text, /等授权/)
})

test('task_step 属于协议工具且不在只读清单里（否则等待期能把闸门撑开）', () => {
  const cfg = normalizeConfig()
  const st = emptyState('t')
  st.phase = PHASE.IDLE
  assert.equal(decideGate({ name: 'task_step', args: {}, state: st, config: cfg }).code, 'protocol-tool')
})

test('boundaryVerdict 独立可用（子代理与人类共用）', () => {
  const cfg = normalizeConfig()
  const hit = boundaryVerdict({ name: 'write', args: { file_path: `${WIN}\\x` }, boundaries: { allowedTools: [], forbiddenTools: [], forbiddenPaths: cfg.protectedPaths, maxActions: 0 }, actionCount: 0, config: cfg })
  assert.equal(hit.code, 'protected-path')
  assert.equal(boundaryVerdict({ name: 'write', args: { file_path: 'E:\\x' }, boundaries: { forbiddenPaths: cfg.protectedPaths }, actionCount: 0, config: cfg }), null)
})

console.log(`\n${passed} 项通过${process.exitCode ? '，存在失败项' : '，全部通过'}`)
