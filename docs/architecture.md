# dsh-task-guard · 机制说明

三个需求不是一个功能，是三个机制。理解这张图就能自己改。

```
                     ┌──────────────────────────────────────────────┐
 用户消息 ──────────► │ agent/inbox/inserted                         │
                     │  ① 弹窗答复回灌？→ 忽略                       │
                     │  ② 阶段 idle？   → 忽略                       │
                     │  ③ 终止措辞？    → phase=TERMINATED（硬保证）  │
                     │  ④ AWAITING+准许？→ phase=APPROVED（降级路径） │
                     │  ④b STEP_AWAITING+准许？→ 授权当前步          │
                     │  ⑤ 其它          → pendingInstruction=true    │
                     └──────────────────────────────────────────────┘
                                     │
 模型要调工具 ──────► ┌──────────────────────────────────────────────┐
                     │ tools/pre-execute（waterfall）                │
                     │  decideGate() 按 16 条顺序判定                │
                     │  deny → 附 TASK_GUARD_* 代码，模型看到原因     │
                     │  allow → 计数、APPROVED→EXECUTING，next()      │
                     │  异常 → next()（闸门坏了不能废掉工具）          │
                     └──────────────────────────────────────────────┘
                                     │
 系统提示 ──────────► ┌──────────────────────────────────────────────┐
                     │ systemPrompt.section  order 10100  协议四段   │
                     │ systemPrompt.context  order  900   动态状态   │
                     │                                     ＋进度条   │
                     └──────────────────────────────────────────────┘
```

## 需求 1：方案 → 准许 → 执行

- **闸门**：`root.on('tools/pre-execute', …)` 返回 `{kind:'deny', reason, info:{name:'TaskGuardError', code}}`。返回 `deny` 而不是抛异常，模型能读到原因并自我纠正（reason 里直接写明「先调 task_plan」）。
- **立项**：`task_plan` 先 `normalizePlan` 洗参数、`boundaryConflicts` 查冲突（硬边界被放宽就直接 `invalid`，不浪费一次弹窗），再 `mergeBoundaries` 合并四层边界，然后弹窗。
- **弹窗**：`userQuestions.ask` 三选项（准许/修改/取消），带 `approvalTimeoutMs` 超时与 `exec.signal` 中断。`ask` 要求「exact live runtime root」——子会话抛 `DELEGATED_CALLER`、非交互抛 `CALLER_NOT_LIVE`，两种情况都降级成 `status=manual` 而不是失败。
- **为什么不用 `ctx.tools.guard`**：guard 是同步的、只能无条件拒；这里需要读会话状态、要异步问人、要给模型可执行提示，所以用 pre-execute 的 waterfall 返回 `deny`。

## 需求 1b：分步执行与每步授权（v1.2.0）

方案获准不再是「全放行」，而是把 `plan.steps` 摊成计划表，一次只放行一步。

```
task_plan approved
   └─ initSteps(plan)   steps[0]=ACTIVE，stepApproved=true（第一步随准许一起授权）
        │
        ├─ 模型做第 1 步（变更类工具在 EXECUTING 下放行）
        │
        ├─ task_step(complete, summary)
        │     └─ advanceStep(state, DONE)  → 当前步 DONE+summary，stepIndex++，
        │                                    下一步 ACTIVE，stepApproved=false
        │     └─ 还有下一步？
        │          ├─ 否 → phase=APPROVED，status=all-done
        │          └─ 是 → phase=STEP_AWAITING（闸门从此拒变更类工具）
        │                └─ stepApprovalMode=ask → 弹卡
        │                      [继续下一步] → stepApproved=true, phase=EXECUTING
        │                      [跳过这步]   → advanceStep(SKIPPED) → 再请示
        │                      [结束任务]   → phase=TERMINATED
        │                └─ stepApprovalMode=manual → 只返回 hint，等文字「继续」
        │
        └─ 文字降级：STEP_AWAITING + looksLikeApproval → stepApproved=true
```

关键实现约束：

1. **`task_step` 必须在 `PROTOCOL_TOOLS` 里**。`STEP_AWAITING` 阶段除协议工具与只读工具外全拒，`task_step` 漏出去就是自锁（模型没工具能解锁，只能靠用户 `/taskguard next`）。
2. **`decideGate` 的 `no-approval` 必须显式豁免 `STEP_AWAITING`**。它字面上「不是 APPROVED/EXECUTING」，但语义上是「已立项已准许、下一步未授权」——不豁免就会报 `no-approval`（提示「尚未立项」），误导模型去重新立项。
3. **分步闸门排在 `no-approval` 之后、`boundaryVerdict` 之前**：先把「有没有资格动手」问清，再问「动了合不合边界」。
4. **`advanceStep` 一定要清 `stepApproved`**——这是「每步都要再点一次」的机制点，漏了就等于自动放行。
5. **答复回灌**：弹卡期间 `store.asking` 置位、答复后写 `answeredAt`，`inbox/inserted` 在 `answerGraceMs` 内忽略——否则点「继续下一步」这句话会被当成一条新用户指令，触发 `pendingInstruction`。
6. **`skip` 不连环弹卡**：跳过之后只把下一步写进 `hint`，由模型向用户请示，避免用户点「跳过」时被连着弹五张卡。
7. **`append` 接受 `STEP_AWAITING`**：在等授权时提追加要求，是「接在当前步之后」，不是「重新立项」。

## 需求 2：边界与 skill 限制

四层嵌套，集合运算只有「并」与「交」，**没有减法**：

```
硬边界（配置，不可放宽）
  └─ 全局默认白名单（配置）
       └─ 本次方案边界（task_plan）
            └─ 习惯提升（habits.json 权重 ≥ 阈值）
```

- `mergeBoundaries(cfg, plan.boundaries, promotions)` 产出生效边界，写进 `state.boundaries`，同时进系统提示的 `task-guard:state` 段——**模型看得见自己在什么框里**。
- skill 限制：调 `skill` 工具时取 `skillNameOf(args)`，不在 `allowedSkills` 就拒。硬性要求 skill 白名单只收紧：习惯提升永远不往 `allowedSkills` 里加东西。
- 路径/命令检查对**所有工具参数递归取字符串**（`collectStrings`），所以嵌套在 `files[].path`、`command`、`content` 里的命中同样拦住。

## 需求 3：指令终止 / 追加判定

两条腿走路，缺一不可：

1. **硬保证（插件侧）**：`agent/inbox/inserted` 里直接识别终止措辞。消息长度 ≤ 16 字且整句匹配 `^停止$` 这类模式才落 `terminated`——长句不碰，避免「不要停止」被误杀。
2. **软判定（模型侧）**：其余消息把 `pendingInstruction` 置真，模型必须调 `task_instruction` 说明 kind，判定前闸门拒绝变更类工具。

`task_instruction` 的四种 kind 对应四种状态迁移：

| kind | 状态变化 | 结果 |
| --- | --- | --- |
| `terminate` | → `TERMINATED`，`concludeTurn()` 结束本轮 | 只许写收尾说明 |
| `append` | → `EXECUTING`，`additions` 追加 | 接着原任务干 |
| `new_task` | → `IDLE`，清空 plan/boundaries/additions | 必须重新 `task_plan` |
| `question` | 阶段不变 | 回答后继续 |

「追加」刻意**不重新立项**：重新弹窗会打断心流，而且用户说的本来就是「在原要求上加一点」。

## 状态机

```
IDLE ──task_plan──► AWAITING ──准许──► APPROVED ──首个变更动作──► EXECUTING
                      │  ▲                  │                        │
                 revise│  │改方案重提         │新指令                  │append
                      ▼  │                  ▼                        │
                   (重提) └──────────────► PENDING(待判定) ◄──────────┘
                                             │  terminate
                                             ▼
                                        TERMINATED ──resume──► APPROVED（预算重置）
```

`PENDING` 不是独立 phase，而是任意阶段上的 `pendingInstruction=true` 标志位——这样「追加到一半又来新指令」也能拦住。

## 习惯学习

```
你准许一个方案  → learnFromApproval：allowedSkills / forbiddenTools / forbiddenPaths / notes 各 +1
你否决          → learnFromRejection：rejections +1
你用终止措辞    → learnFromTermination：terminations +1
```

写盘是串行队列（`state.queue = state.queue.then(...)`），并发安全；读失败按空库继续，绝不阻塞启动。权重到 `habitPromoteThreshold` 后由 `habitPromotions` 并入边界，到 `habitSuggestMinWeight` 后由 `habitHints` 写进系统提示。

**为什么 skill 不放宽**：安全方向永远是收紧。如果把「你常允许 office」学成默认放宽，反而把边界越学越松——那就违背了需求 2 的本意。

## 缓存与性能

- 协议段是**静态字符串**（`interpolate:false`），落在系统提示前缀里，不会每次请求抖动。
- 动态状态走 `systemPrompt.context`（order 900），只在状态真的变化时文本才变——`renderState` 不含时间戳，避免无谓的前缀失效。
- 闸门是纯内存判定，无 IO；只有 `task_plan` 弹窗与习惯写盘会等。

## 参数分类（v1.1.0，防误拦）

`args` 不再被无差别扫描，按 key 分三类：

| 类 | key 例 | 受保护路径 | 危险命令 |
| --- | --- | --- | --- |
| path 型 | `file_path` `path` `cwd` `dest` `output` `url` | 扫 | 扫 |
| command 型 | `command` `cmd` `script` `argv` | 扫 | 扫 |
| content 型 | `content` `new_string` `old_string` `text` `prompt` `description` `notes` | 豁免 | 豁免 |

未识别的 key 归入 path 型（MCP 工具的自定义参数仍兜得住）；`mode='command'` 时若一个命令型参数都没有，退回 path 型扫（兼容非标准工具）。路径匹配还要过左右边界检查，`D:\archive` 不会命中 `D:\archive2`。

**为什么必须这样**：写文档时正文里出现系统目录路径或一条删盘命令是正常内容，旧逻辑会把它当危险动作拦掉——闸门不能把人写字的笔也缴了。

## 子代理策略（v1.1.0）

`Agent` 只暴露 `id`，Host 侧没有父会话字段，所以判定方式是**推断**：某会话的 `task_plan` 弹窗抛 `DELEGATED_CALLER` / `CALLER_NOT_LIVE`（即 `verdict.kind === 'unavailable'`）时，把该会话标记成 `state.isSubagent = true`，之后它的工具调用走 `gateSubagents` 三档：

- `inherit`（默认）：边界 = 最近一次人类准许的 `boundaries` ⊕ 硬边界，跳过 terminated / pending / no-approval 三个「人类会话状态」。子代理能干活，但碰不了受保护路径。
- `gate`：不用继承，继续走人类那套 → 它在 `idle` 上被 `no-approval` 拦住，提示它先 `task_plan`（而它弹不出窗，实际必须靠文字准许）。
- `allow`：直接放行。

## 预算与失败回滚（v1.1.0）

`pre-execute` 放行时按 `callId` 记账（`store.counted`），`tools/result` 里 `result.isError === true` 就把 `actionCount` 减回去。否则模型试错三四次就烧穿预算，正确调用反而被拦。

## 设计约束（踩过的坑，改代码前先看）

1. **服务获取用局部 `root.get('systemPrompt')`，不用对象级 `inject`**。对象级 inject 在缺服务的宿主上会让整个 `apply` 永不执行且不报错——调试起来极其痛苦。
2. **闸门必须放行 `PROTOCOL_TOOLS`**（`task_plan` / `task_instruction` / `task_step` / `task_guard_status`）。漏一个就是自锁，而且用户会以为插件坏了。
3. **闸门内任何异常都 `next()`**。闸门是安全网，不是单点故障源。
4. **弹窗答复会以 user message 回灌**。不区分就会把自己弹的答复当成「追加指令」，任务永远进不了执行。用 `asking` 标志 + `answeredAt` + `answerGraceMs` 三重挡。
5. **终止措辞只在短消息上生效**。否则「不要停止」「别取消」全成误杀。
6. **`gateSubagents` 不能是死配置**。子会话拿不到 `userQuestions`，没有继承策略就永远锁死在 `no-approval`——1.0.0 踩过。
7. **别把整份方案塞进准许卡的问句**。卡片会把按钮顶出视口，用户点不到 → 300 秒超时 → 模型以为被拒。问句一行、细节进 `detail`。
8. **正文不是动作**。`content` / `new_string` 里出现路径或命令字样属于正常写作，闸门只认路径型与命令型参数。
