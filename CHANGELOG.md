# 变更记录

遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

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
