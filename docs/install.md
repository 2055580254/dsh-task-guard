# 安装与升级 · 操作指南

给**别人**看的：拿到这个仓库之后怎么装进自己的 DeepSeek Harness。三条通道挑一条，最后都要看到 `application=applied`。

前提：DSH 已能正常启动（任意 profile），Node.js ≥ 20。本包是 **Host-only bundle**，无第三方依赖、无需构建。

---

## 通道 1 · 直接把 GitHub 地址交给 DSH（最快）

对 DSH 说：

> 用 plugin_manager install_bundle，target = `https://codeload.github.com/<仓库所有者>/dsh-task-guard/tar.gz/refs/heads/main`

想锁定版本就把 `heads/main` 换成 `tags/v1.2.0`。这与本机已装的 `dsh-purge` 用的是同一种 tarball 规格，不需要预先 clone。

装完检查返回：

| 返回字段 | 期望 |
| --- | --- |
| `stage` | `enable` |
| `application` | `applied` |
| `warnings` | `[]` |
| `version` | `1.2.0` 或你装的版本 |

若 `application=failed` 且 `error.code` 是 `already-installed` → 先卸载再装（见「升级」）。
若 `kind=build-blocked` 或日志里出现 `ERR_PNPM_IGNORED_BUILDS` → 见文末「装不上怎么办」。

---

## 通道 2 · clone 到本地（要改代码、要看源码选这个）

```bash
git clone https://github.com/<仓库所有者>/dsh-task-guard.git
```

然后对 DSH 说：

> 用 plugin_manager install_bundle，target = `<clone 出来的绝对路径>`

Windows 例：`E:\src\dsh-task-guard`；macOS/Linux 例：`/opt/src/dsh-task-guard`。

这样装的是 **link 依赖**：改仓库里的源码后重启 DSH 就生效，`git pull` 即升级。

---

## 通道 3 · 手工落盘（不经过 plugin_manager）

1. 把仓库整个目录复制到当前 profile 的 `node_modules/dsh-task-guard/`：

   | 平台 | profile 目录 |
   | --- | --- |
   | Windows | `%USERPROFILE%\.dsh\profiles\<profile>\` |
   | macOS / Linux | `~/.dsh/profiles/<profile>/` |

   默认 profile 名是 `desktop`。

2. 在同一个 profile 的 `cordis.patch.yml` 末尾追加：

   ```yaml
   - insert:
       - id: task-guard
         name: dsh-task-guard
         config:
           enabled: true
           mode: enforce
           requirePlan: true
           requireClassify: true
   ```

3. 在 profile 的 `package.json` 的 `dsh.profile.bundles` 数组末尾加一项 `"dsh-task-guard"`。

4. 重启 DSH。

> 手工方式不会写进 `dependencies`，`pnpm install` 之后可能被清掉 —— 长期用还是走通道 1 或 2。

---

## 装好之后怎么确认真的在跑

新开一个会话，看两处：

1. **系统提示**里出现 `任务闸门协议（dsh-task-guard，强制）` 段落，末尾还有一行动态状态 `[task-guard] 阶段=未立项（idle）`。
2. **工具清单**里出现 `task_plan`、`task_instruction`、`task_step`、`task_guard_status` 四个工具，以及 `/taskguard` 命令。

再做一个最小验证（应该被拦住，这就是在生效）：

> 直接让它 `pwsh -Command "echo hi"`

期望返回：

```
【task-guard】阶段=idle，未获准许，拒绝执行 pwsh。
尚未立项：先调用 task_plan（目标 / 步骤 / 边界 / skill 白名单）取得用户准许。
```

看到这段就说明闸门在工作。接着让它 `task_plan`，点「准许执行」，同一条 `pwsh` 就会放行。

---

## 日常用法（三句话）

1. 让它干活 → 它会先 `task_plan`，你点「准许执行」。
2. 想收窄范围 → 在方案里写 `boundaries`（`allowedTools` / `forbiddenPaths` / `maxActions` / `allowedSkills`）。
3. 中途变卦 → 直接说「算了 / 停一下」它会终止；说「继续」会 `resume` 原方案（不重新弹窗，预算重置）；说新事情它会重新立项。

完整命令与故障排查见仓库根目录 `README.md`；配置项全表见 `docs/config.md`。

---

## 升级

包管理器不允许同名覆盖安装，标准两步：

1. 对 DSH 说：`plugin_manager remove_bundle，target = dsh-task-guard` → 期望 `application=applied`
2. 再按通道 1 或 2 装新版本

link 方式（通道 2）更省事：

```bash
cd dsh-task-guard && git pull
```

重启 DSH 即可，`version` 会跟着仓库变。

升级前建议备份习惯库（**不是**仓库里的文件）：

| 平台 | 习惯库位置 |
| --- | --- |
| Windows | `%USERPROFILE%\.dsh\profiles\<profile>\task-guard\habits.json` |
| macOS / Linux | `~/.dsh/profiles/<profile>/task-guard/habits.json` |

---

## 卸载

1. `plugin_manager remove_bundle，target = dsh-task-guard`
2. 想连习惯库一起清掉：删掉上面那个 `task-guard/habits.json`（父目录一并删也行）

卸载后闸门立即消失，变更类工具恢复自由。

---

## 装不上怎么办

| 现象 | 原因 | 解法 |
| --- | --- | --- |
| `already-installed` | 同名包已在 profile 里 | 先 `remove_bundle` 再 `install_bundle` |
| `ERR_PNPM_IGNORED_BUILDS` + `pendingBuilds` 里是**别的包**（如 `dsh-purge`） | pnpm 11 把未批准的 build 写进 profile 的 `pnpm-workspace.yaml` 的 `allowBuilds`，占位值是 `set this to true or false`，导致任何安装都失败 | 打开 `<profile>/pnpm-workspace.yaml`，删掉那行占位符（或改成 `true`），重跑安装 |
| `warnings` 里有 bundle 未生效 | 运行时没重新加载 | 重启 DSH 再看 |
| 装上但工具没出现 | 另一个同名插件占用了 `task_plan` 等名字 | `plugin_manager list_plugins` 查重，先禁掉冲突项 |
| `application=applied` 但行为是旧版 | 旧实例还挂在内存 | 完全退出 DSH（不是关窗口）再启动 |
