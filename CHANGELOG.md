# 变更记录

遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## 1.2.0 — 2026-11-04

### 新增：分步执行（计划表 · progress · 每步授权）
- 方案里的 `steps` 在获准后展开成**可跟踪的计划表**：`state.steps[]`（每步 `{index, text, status, startedAt, doneAt, summary}`）、`stepIndex`、`stepApproved`。
- **新工具 `task_step`**：`progress`（进度条＋计划表＋每步摘要）／`complete`（本步收尾并请示下一步）／`start`（请求或确认当前步授权）／`skip`（跳过）／`reset`（退回第 1 步）。已加入 `PROTOCOL_TOOLS`，否则等待期会自锁。
- **新阶段 `awaiting_step`**（`PHASE.STEP_AWAITING`）：一步收尾后进入「等待授权下一步」，闸门在这一阶段拒绝一切变更类工具（code `step-approval`），只放行 `PROTOCOL_TOOLS` 与只读工具；从 `no-approval` 判定里显式豁免（它算「已立项已准许，只是下一步未授权」）。
- **第一步随方案准许一起授权**，之后每步都要重新授权；`advanceStep` 收尾后自动清空 `stepApproved`。
- **`renderProgress(state)`**：`进度 2/6 ▓▓▓▓░░░░░░` ＋ `✅/⏭/▶/⏸` 四种标记 ＋ 等授权提示；接入 `task_step`、`task_guard_status(action=steps)`、`/taskguard step`、以及每轮注入的动态状态 context。
- `task_instruction`：`append` 现在也接受 `awaiting_step` 阶段（在等授权时提追加要求不必重新立项）；`new_task` 清理计划表；`resume` 恢复时保留当前步位置。
- `/taskguard next`：人肉授权当前这一步（弹卡点不到/超时时的救命路径，写 `history` 与 `step-approve`）。
- 文字降级路径：`awaiting_step` 阶段用户回「继续/下一步」即视为授权（`inbox/inserted` 里判定，仍受 `answerGraceMs` 防回灌保护）。
- `skip` 不连环弹卡：跳过之后只把下一步写给用户，避免一次点错连弹五张。
- 配置：`stepGating`（默认 `true`；`false` 退回 1.1.0 的自由推进，`complete` 只记账）、`stepApprovalMode`（`ask` 自动弹卡 / `manual` 只文字请示）、`maxSteps`（0=不限）。

### 修复
- `decideGate` 的 `no-approval` 分支不再误拦 `awaiting_step`（原先会被当成「未立项」）。

### 自测
- 新增 10 项断言（initSteps、advanceStep 的 done/skip/finished、stepStats、renderProgress、awaiting_step 闸门矩阵、stepGating=false、配置默认、renderState 进度行、task_step 属协议工具），合计 **47 项全部通过**。

## 1.1.0 — 2026-10-31

### 修复（界面）
- **准许卡撑满界面、按钮点不到**：问句从「整份方案多行文本」压成单行 `方案#N｜目标（N 步 · 预算 N）`，完整方案移入 `detail` 折叠区。新增 `compactApproval`（默认 `true`）、`maxApprovalSummaryChars`（默认 110，下限 40）、`approvalDetail`（默认 `true`）三项配置。

### 修复（逻辑）
- `gateSubagents` 从死配置改为三档生效：`inherit`（默认，子代理沿用最近一次人类准许的边界，硬边界仍生效）/ `gate` / `allow`。旧写法 `true → inherit`、`false → allow`。
- `profile`（`lite` / `standard` / `strict`）真正影响执行：`lite` 强制不设预算，`strict` 收紧工具面并在方案未写预算时回落到 40。
- 内容型参数不再误拦：`write.content`、`edit.new_string`、`text`、`prompt` 等正文类参数豁免路径/命令扫描；`compress` 等上下文工具归入只读。
- 路径匹配加入边界检查，`D:\archive` 不再命中 `D:\archive2`、`D:\archive-2024`。
- 失败不再消耗动作预算：`tools/result` 中 `isError === true` 时按 `callId` 回滚计数。
- `task_plan` 加并发锁，上一张准许卡未处理时返回 `status=busy`，不再互相覆盖。
- `task_instruction` 新增 `kind=resume`：终止后可恢复原方案，预算重置，不重新弹窗。
- 终止措辞补充「算了 / 不做了 / 别弄了 / 别改了 / 收工 / 停一下 / 先停」。
- 新增 `action=habits-reset` 与 `/taskguard habits reset`。

### 文档
- README 增补 v1.1.0 对照表、故障排查、`resume` / `busy` 说明。
- `docs/config.md` 重写 `gateSubagents` 三档，新增「准许框体积」「profile 档位」。
- `docs/architecture.md` 新增「参数分类（防误拦）」「子代理策略」「预算与失败回滚」，状态机补 `resume` 边。

## 1.0.0 — 2026-10-31

首个可用版本。

- `tools/pre-execute` 准入闸门：未获准许时拒绝变更类工具，拒绝原因写明缺哪一步。
- 四层边界：全局硬边界（受保护路径 / 危险命令 / 硬禁工具）+ 方案边界（allowedTools / forbiddenTools / forbiddenPaths / maxActions）+ `allowedSkills` + 习惯库自动提升。
- 三工具：`task_plan`（立项与准许）、`task_instruction`（新指令判定 terminate / append / resume / new_task / question）、`task_guard_status`（查看状态与习惯库）。
- 系统提示注入「任务闸门协议」段与动态状态行，人用命令 `/taskguard`。
- 习惯库：至少 8 种措辞的终止/准许识别，权重累积后自动并入边界。
- 纯策略层 `lib/policy.js` 与 23 项自测。
