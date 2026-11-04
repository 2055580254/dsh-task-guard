# dsh-task-guard · 配置参考

配置写在 `cordis.patch.yml` 的 `config` 里（或用 profile 补丁层同 id 覆盖）。改完重启 DSH 生效。

所有字段都是**可选**：缺失用默认值，类型不对也用默认值（`normalizeConfig` 不会因为配置写错而抛异常）。

```yaml
- insert:
    - id: task-guard
      name: dsh-task-guard
      config:
        enabled: true
        mode: enforce
        requirePlan: true
        requireClassify: true
        stepGating: true
        stepApprovalMode: ask
```

---

## 开关层

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `enabled` | bool | `true` | 只有显式 `false` 才整套停用。运行时可用 `/taskguard on\|off` 临时改。 |
| `mode` | `enforce` \| `advisory` | `enforce` | `enforce` 真拦并返回 deny；`advisory` 只注入协议提示、一切放行（调试插件用）。运行时 `/taskguard mode …`。 |

## 需求 1：方案准入

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `requirePlan` | bool | `true` | 开启后，未获准许的变更类工具被拒（`TASK_GUARD_NO_APPROVAL`）。关掉等于放弃需求 1。 |
| `approvalTimeoutMs` | number | `300000` | 等用户点「准许」的最长毫秒。超时返回 `status=manual`，走文字准许降级。低于 5000 回落到默认。 |
| `answerGraceMs` | number | `1500` | 准许答复回灌宽限期。弹窗答复会以 user message 形式回到会话，这段时间内的消息不算「新指令」，避免自己把自己判成追加。 |

## 需求 2：全局边界

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `protectedPaths` | string[] | 见下 | 路径前缀黑名单。工具参数（递归所有字符串值）里出现即拒：`TASK_GUARD_PROTECTED_PATH`。**不可被方案放宽。** |
| `dangerousCommands` | string[] | 见下 | 命令片段黑名单（大小写不敏感子串匹配），命中即拒：`TASK_GUARD_DANGEROUS_COMMAND`。**不可被方案放宽。** |
| `hardForbiddenTools` | string[] | `[]` | 全局硬禁工具，支持 `tool*` 前缀通配（`matchesToolPattern`）。**不可被方案放宽。** |
| `defaultAllowedSkills` | string[] | `[]` | 方案没写 `boundaries.allowedSkills` 时用的 skill 白名单；空数组 = 不限 skill。 |
| `defaultAllowedTools` | string[] | `[]` | 方案没写 `boundaries.allowedTools` 时用的工具白名单；空数组 = 不限。 |
| `maxActionsPerTask` | number | `0` | 全局动作预算；`0` = 不限。方案里的 `boundaries.maxActions` 可以更小或更大（以方案为准）。 |

默认 `protectedPaths`：

```
C:\Windows  C:\Program Files  C:\Program Files (x86)  C:\ProgramData  C:\Users\All Users
/etc  /usr  /bin  /sbin  /boot  /dev  /proc  /sys
```

默认 `dangerousCommands`：

```
rm -rf /        rm -rf ~     mkfs        dd if=      :(){（fork bomb）
shutdown /s     Stop-Computer
Remove-Item -Recurse -Force C:\
del /f /s /q C:\
format /fs
```

## 需求 3：指令判定

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `requireClassify` | bool | `true` | 新指令未判定前拒绝变更类工具（`TASK_GUARD_PENDING_INSTRUCTION`）。 |
| `detectTerminationFromText` | bool | `true` | 短消息命中终止措辞时，插件内部直接把阶段落成 `terminated`，不等模型判定。 |
| `detectApprovalFromText` | bool | `true` | `AWAITING` 阶段短消息命中准许措辞时，直接把阶段落成 `approved`（弹窗失败时的降级路径）。 |
| `terminationPatterns` | string[] | 见下 | 终止措辞正则（对 `^…$` 全匹配、且消息长度 ≤ 16 字才生效，避免「不要停止」误伤）。 |
| `approvalPatterns` | string[] | 见下 | 准许措辞正则，同样只对短消息生效。 |

默认 `terminationPatterns`：

```
^停止$  ^终止$  ^取消$  ^取消任务$  ^取消这个任务$  ^停$  ^别做了$  ^不用了$  ^停了?吧$
^stop$  ^abort$  ^cancel$  ^terminate$
```

默认 `approvalPatterns`：

```
^准许$  ^批准$  ^同意$  ^可以$  ^行$  ^执行$  ^准许执行$  ^通过$
^ok$  ^okay$  ^yes$  ^approve$  ^approved$  ^go$
```

## 放行面（豁免）

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `readOnlyTools` | string[] | 内置一批 | 只读工具名清单，永远放行且不消耗预算。 |
| `extraReadOnlyTools` | string[] | `[]` | 追加只读工具（MCP 只读查询可以加这里）。 |
| `skipTools` | string[] | 协议四件套 + `ask_user_question` `present` | 完全跳过闸门。**必须包含 `task_plan` / `task_instruction` / `task_step` / `task_guard_status`，否则自锁。** |
| `extraSkipTools` | string[] | `[]` | 追加跳过项。 |

内置 `readOnlyTools`（节选）：`read` `glob` `grep` `web_search` `web_fetch` `research` `cache_search` `platform_search` `domain_search` `advanced_search` `multi_search` `weather` `free_search_test` `skill` `load_workspace_dependencies` `working_directory` `list_agents` `job_list` `job_output` `schedule_list` `schedule_delete` `list_mcp_resources` `list_mcp_resource_templates` `read_mcp_resource` `cordis_inspect_list` `cordis_inspect_query` `todo_write` `ask_user_question` `present`。

> 注意：`job_kill` 不在只读清单里——它算变更动作。想让它随便调就加到 `extraReadOnlyTools`。

## 其它

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `gateSubagents` | `inherit` \| `gate` \| `allow` \| bool | `inherit` | 子会话/子代理策略。`inherit`：沿用最近一次人类准许的边界继续干（硬边界仍生效，不会死锁）；`gate`：子代理也要自己立项（它拿不到弹窗，等于必须走文字准许）；`allow`：不管子代理。旧写法 `true`→`inherit`、`false`→`allow`。 |
| `habitPath` | string | 见下 | 习惯库路径。默认 `%DSH_PROFILE_DIR%\task-guard\habits.json`，无该变量时 `~/.dsh/task-guard/habits.json`。 |
| `habitSuggestMinWeight` | number | `2` | 权重达此值 → 作为「习惯补充」写进系统提示。 |
| `habitPromoteThreshold` | number | `3` | 权重达此值 → `forbiddenTools` / `forbiddenPaths` 自动并入生效边界。 |

## 分步执行（v1.2.0）

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `stepGating` | bool | `true` | 一步一授权。`true`：`task_step(action=complete)` 后阶段进入 `awaiting_step`，变更类工具被拒（`TASK_GUARD_STEP_APPROVAL`），必须先 `task_step(action=start)`。`false`：退回 1.1.0 的自由推进，`complete` 只记账、不拦。 |
| `stepApprovalMode` | `ask` \| `manual` | `ask` | `ask`：每步收尾后自动弹「继续下一步 / 跳过这步 / 结束任务」卡。`manual`：不弹卡，只把下一步写给用户，等其回复「继续」再 `task_step(action=start)`（适合不想被卡片打断的长任务）。 |
| `maxSteps` | number | `0` | 计划表步数上限，0=不限。方案超限时 `task_plan` 报 `invalid`。 |

行为要点：

- 第一步随方案准许一起授权；`advanceStep` 收尾后 `stepApproved` 立刻清空，所以「每一步都要再点一次」是硬保证。
- `awaiting_step` 阶段只放行 `PROTOCOL_TOOLS`（`task_plan` / `task_instruction` / `task_step` / `task_guard_status`）与只读工具；`task_step` 漏出协议清单会自锁。
- 弹不出卡（子会话/非交互）时，你在 `answerGraceMs` 之外回一句「继续」「下一步」，`agent/inbox/inserted` 会把它识别为该步授权（不会误判成新指令）。
- `stepApprovalMode=manual` 与 `approvalTimeoutMs` 无关：manual 根本不发卡，不存在超时。

## 准许框体积（v1.1.0）

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `compactApproval` | bool | `true` | 问句压成一行 `方案#N｜目标（3 步 · 预算 40）`；设为 `false` 回到旧的整段方案问句（卡片会很大）。 |
| `maxApprovalSummaryChars` | number | `110` | 摘要里目标的最大字数，超出用 `…` 截断（下限 40）。 |
| `approvalDetail` | bool | `true` | 把完整方案（步骤/验收/边界/备注）放进卡片的 `detail` 字段；`false` 则完全不显示细节。 |

> 这三项就是「框占据太大点不到按钮」的修法：问句不再承载多行正文，卡片高度由桌面端按 `detail` 折叠。

## profile 档位（v1.1.0 起真正生效）

`task_plan` 的 `profile` 字段会改变边界，不只是标签：

| profile | 动作预算 | 工具面 |
| --- | --- | --- |
| `lite` | 强制不设预算（`maxActions=0`） | 原样 |
| `standard` | 原样 | 原样 |
| `strict` | 方案没写就用 `maxActionsPerTask`，再没有就 `40` | 没写 `allowedTools` 时默认只给 `read/glob/grep/write/edit/todo_write` + 协议工具；`pwsh/bash/plugin_manager/job_kill/purge_*` 必须显式写进 `allowedTools` 才放开 |

---

## 三个典型配置

**保守（在家里自己用，少打扰）**

```yaml
config:
  mode: enforce
  requirePlan: true
  extraSkipTools: ['job_kill']
  defaultAllowedSkills: []
```

**严格（跑自动化、怕误删）**

```yaml
config:
  mode: enforce
  requirePlan: true
  requireClassify: true
  maxActionsPerTask: 30
  hardForbiddenTools: ['plugin_manager', 'purge_apply', 'purge_revert']
  protectedPaths:
    - 'C:\Windows'
    - 'C:\Program Files'
    - 'D:\archive'          # 自己的数据区
```

**只观察（先看它会拦什么）**

```yaml
config:
  mode: advisory
  enabled: true
```

`advisory` 下闸门只注入 prompt、从不返回 deny，适合先跑几天看日志里 `[task-guard] 拦截 …` 的记录再切 `enforce`。
