# 发布到 GitHub · 操作指南

从「本地目录」到「公开仓库 + 可被别人安装」的完整流程。三条通道按你手上有什么工具挑一条走。

---

## 0. 发布前预检（30 秒）

```bash
cd dsh-task-guard
node --check index.js
node --check lib/policy.js
node scripts/selftest.mjs        # 必须全绿
```

再确认这几件事，缺了会导致别人装上跑不起来：

| 检查 | 命令 / 位置 | 期望 |
| --- | --- | --- |
| 入口字段 | `package.json` → `exports["."]` | `./index.js` |
| bundle 装载 | `package.json` → `dsh.bundle.patch` | `./cordis.patch.yml` |
| 文件清单 | `package.json` → `files` | 每个路径真实存在（CI 会校验） |
| 展示元数据 | `locale/zh.json`、`locale/en.json` | 都有 `meta.title` / `meta.description` |
| 图标 | `icon.svg` | ≤ 256 KiB，包内相对路径 |
| 无密钥 | 全仓搜索 `token`、`password`、`sk-` | 无命中 |

---

## 1. 初始化本地仓库

```bash
cd dsh-task-guard
git init -b main
git add -A
git commit -m "feat: dsh-task-guard 1.1.0 — 方案准许闸门 / 边界与 skill 限制 / 指令终止与追加判定"
```

> 换行已被 `.gitattributes` 统一为 LF，Windows 上不会出现整仓 `CRLF` 差异。

打版本标签（建议与 `package.json` 的 `version` 一致）：

```bash
git tag -a v1.1.0 -m "v1.1.0：准许卡缩小、gateSubagents/profile 真生效、参数分类防误拦、失败回滚预算、resume"
```

---

## 2. 在 GitHub 建仓库

### 通道 A · 网页（不需要任何命令行工具）

1. 打开 <https://github.com/new>
2. **Repository name**：`dsh-task-guard`
3. **Visibility**：`Public`（要给别人装就必须公开；私有仓库需对方有权限）
4. **不要**勾选 `Add a README file`、`.gitignore`、`license` —— 本地都已经有了，勾了会产生冲突
5. 点 `Create repository`，记下页面给的地址：`https://github.com/<你的用户名>/dsh-task-guard.git`

然后回到本地：

```bash
git remote add origin https://github.com/<你的用户名>/dsh-task-guard.git
git push -u origin main
git push origin v1.1.0
```

推送时会要账号密码 —— **GitHub 自 2021 年起不接受账户密码**，密码处必须填 Personal Access Token：

1. <https://github.com/settings/tokens> → `Generate new token (classic)`
2. 勾 `repo`（私有仓库需要）与 `workflow`（仓库里有 `.github/workflows/ci.yml` 时必须勾，否则推送被拒）
3. 有效期按需，生成后**只显示一次**，立刻复制
4. 推送时：用户名填 GitHub 用户名，密码粘贴 token

想省掉每次输入：

```bash
git config --global credential.helper manager   # Windows 凭据管理器，首次输入后记住
```

### 通道 B · 装了 GitHub CLI（最省事）

```powershell
winget install --id GitHub.cli -e
gh auth login            # 选 GitHub.com → HTTPS → 浏览器登录
```

```bash
gh repo create dsh-task-guard --public --source=. --remote=origin --push --description "DSH 任务闸门：方案先准许再动手 + 全局边界与 skill 限制 + 新指令终止/追加判定"
git push origin v1.1.0
```

`gh repo create` 会自动建仓、加 remote、推送当前分支，一步到位。

### 通道 C · SSH（已有密钥）

```bash
ssh -T git@github.com                                     # 先验证身份
git remote add origin git@github.com:<你的用户名>/dsh-task-guard.git
git push -u origin main && git push origin v1.1.0
```

仓库仍需先在网页上创建（SSH 不负责建仓）。

---

## 3. 本仓库自带的一键脚本

**先改仓库归属**。本仓库里所有地址都用 `GH_USER` 作占位，跑一次就全换掉（`README.md`、`package.json`、`docs/*` 一起改）：

```powershell
pwsh ./scripts/set-owner.ps1 -User <你的用户名>
# 想换仓库名：-Repo <名字>
# 只看会改什么：加 -WhatIf
```

然后发布。`scripts/publish.ps1`（Windows）与 `scripts/publish.sh`（macOS / Linux / Git Bash）把预检、提交、打标签、推送串起来，只做本地与推送动作，不清理任何文件：

```powershell
# Windows，HTTPS + PAT
$env:GITHUB_TOKEN = "ghp_xxx"
pwsh ./scripts/publish.ps1 -User <你的用户名> -Repo dsh-task-guard

# 已经配好 SSH
pwsh ./scripts/publish.ps1 -User <你的用户名> -Repo dsh-task-guard -Ssh

# 只做预检和本地提交，不推送（看会发生什么）
pwsh ./scripts/publish.ps1 -User <你的用户名> -Repo dsh-task-guard -DryRun
```

```bash
# macOS / Linux / Git Bash
GITHUB_TOKEN=ghp_xxx ./scripts/publish.sh --user <你的用户名> --repo dsh-task-guard
```

脚本行为：

1. 预检（`node --check` ×2、selftest、`files` 清单完整性）
2. `git init -b main`（已是仓库则跳过）、`git add -A`、首次提交
3. 打 tag `v<package.json version>`
4. 配 remote（HTTPS 会把 token 拼进 URL，**只在本次 push 使用，不写进 `.git/config`**）
5. push 分支与标签
6. 打印仓库地址与后续安装命令

---

## 4. 发 Release（可选但推荐）

打了 tag 之后，在 GitHub 上：`Releases` → `Draft a new release` → 选 `v1.1.0` → 标题 `v1.1.0` → 说明直接粘 `CHANGELOG.md` 里对应段落 → `Publish release`。

Release 附带源码 zip/tar.gz，别人可以用固定版本的 tarball 安装（比跟 `main` 稳）：

```
https://codeload.github.com/<你的用户名>/dsh-task-guard/tar.gz/refs/tags/v1.1.0
```

---

## 5. 发布后确认

| 要确认的 | 怎么看 |
| --- | --- |
| CI 是否通过 | 仓库 `Actions` 页，`CI` 工作流最近一次运行是绿的（Ubuntu + Windows × Node 20/22 四格） |
| 别人能不能装 | 照 `docs/install.md` 走一遍，`application=applied` 且 `warnings` 为空 |
| 许可证显示 | 仓库首页右上出现 `MIT license` |
| 首页可读性 | README 顶部有安装命令、仓库简介与 topics（`dsh`、`deepseek-harness`、`cordis`、`plugin`、`guardrail`） |

---

## 6. 常见拦截与解法

| 现象 | 原因 | 解法 |
| --- | --- | --- |
| `remote: Support for password authentication was removed` | 用了账户密码 | 改填 PAT |
| `refusing to allow a Personal Access Token to create or update workflow` | token 没勾 `workflow` | 重新生成 token 并勾上 `workflow` |
| `failed to push some refs (fetch first)` | 远端已有提交（网页建仓时勾了 README） | `git pull --rebase origin main` 后重推 |
| `fatal: remote origin already exists` | remote 已配过 | `git remote set-url origin <新地址>` |
| 推送后满屏 `LF will be replaced by CRLF` | 本机 autocrlf | 仓库已有 `.gitattributes`，警告可忽略；想彻底消掉：`git config core.autocrlf false` |
| `gh: command not found` | 没装 CLI | 走通道 A，或 `winget install --id GitHub.cli -e` |
| CI 红在 `package.json files 缺文件` | 清单里写了没提交的文件 | 补齐文件或改 `files` |
| 私有仓库别人装不上 | 无访问权限 | 转公开，或让对方用带 token 的 tarball 地址 |

---

## 7. 之后怎么升级版本

```bash
# 1. 改代码
# 2. 升版本号（三处保持一致：package.json / cordis.patch.yml 注释 / CHANGELOG.md 标题）
npm version patch --no-git-tag-version     # 或 minor / major，按需手改
# 3. 补 CHANGELOG
git add -A && git commit -m "release: v1.1.1"
git tag -a v1.1.1 -m "v1.1.1"
git push && git push origin v1.1.1
```

已装旧版的用户按 `docs/install.md` 的「升级」一节操作（先 `remove_bundle` 再 `install_bundle`，包管理器不允许同名覆盖安装）。

---

## 8. 安全检查（公开前最后一遍）

```bash
git log --stat | head -50                    # 看首个提交都带上了什么
git grep -n -iE "token|secret|password|ghp_|sk-[a-z0-9]{10}" -- . ':!CHANGELOG.md'
```

确认没有把 `~/.dsh/profiles/...`、习惯库 `habits.json`、日志、`node_modules` 带进仓库（`.gitignore` 已挡，但首次 `git add -A` 前值得扫一眼）。

习惯库会记录你的目录习惯（例如常用禁路径），**不要提交**；`docs/habits.example.json` 是脱敏示例，可以提交。
