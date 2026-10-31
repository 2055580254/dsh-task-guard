#!/usr/bin/env bash
# 把 dsh-task-guard 发布到 GitHub：预检 → 本地提交 → 打标签 → 推送。
# 只做本地与推送动作，不清理任何文件。HTTPS 模式把 token 拼进本次 push 的 URL，不写入 .git/config。
# 详细流程与排错见 docs/publish.md
#
# 用法：
#   GITHUB_TOKEN=ghp_xxx ./scripts/publish.sh --user yourname
#   ./scripts/publish.sh --user yourname --ssh
#   ./scripts/publish.sh --user yourname --dry-run
set -euo pipefail

USER_NAME=""
REPO="dsh-task-guard"
BRANCH="main"
USE_SSH=0
DRY_RUN=0
MESSAGE=""
TOKEN="${GITHUB_TOKEN:-}"

while [ $# -gt 0 ]; do
  case "$1" in
    --user)     USER_NAME="$2"; shift 2 ;;
    --repo)     REPO="$2"; shift 2 ;;
    --branch)   BRANCH="$2"; shift 2 ;;
    --token)    TOKEN="$2"; shift 2 ;;
    --message)  MESSAGE="$2"; shift 2 ;;
    --ssh)      USE_SSH=1; shift ;;
    --dry-run)  DRY_RUN=1; shift ;;
    -h|--help)  sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "未知参数：$1" >&2; exit 2 ;;
  esac
done

step() { printf '\n== %s\n' "$1"; }
ok()   { printf '   ok  %s\n' "$1"; }
warn() { printf '   !!  %s\n' "$1"; }
die()  { printf '   xx  %s\n' "$1" >&2; exit 1; }

[ -n "$USER_NAME" ] || die "必须指定 --user <你的 GitHub 用户名>"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

step "1/6 预检"
command -v node >/dev/null || die "找不到 node"
command -v git  >/dev/null || die "找不到 git"
node --check index.js      || die "index.js 语法检查失败"
node --check lib/policy.js || die "lib/policy.js 语法检查失败"
ok "语法检查通过"

node scripts/selftest.mjs
ok "自测通过"

node --input-type=commonjs - <<'JS'
const fs = require('fs');
const j = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const miss = (j.files || []).filter(f => !fs.existsSync(f));
if (miss.length) { console.error('package.json files 缺文件: ' + miss.join(', ')); process.exit(1); }
if (!j.dsh || !j.dsh.bundle || !j.dsh.bundle.patch) { console.error('缺少 dsh.bundle.patch'); process.exit(1); }
if (!fs.existsSync(j.dsh.bundle.patch)) { console.error('patch 文件不存在: ' + j.dsh.bundle.patch); process.exit(1); }
for (const f of ['locale/zh.json', 'locale/en.json']) {
  const m = JSON.parse(fs.readFileSync(f, 'utf8')).meta || {};
  if (!m.title || !m.description) { console.error(f + ' 缺少 meta.title / meta.description'); process.exit(1); }
}
console.log('清单与元数据完整');
JS
ok "package.json / locale 校验通过"

VERSION="$(node -p "require('./package.json').version")"
[ -n "$VERSION" ] || die "读不到 package.json 的 version"
TAG="v$VERSION"
ok "版本 $VERSION → 标签 $TAG"

step "2/6 初始化仓库"
if [ ! -d .git ]; then
  git init -b "$BRANCH" >/dev/null
  ok "已在 $BRANCH 分支上 git init"
else
  ok "已是 git 仓库（当前分支 $(git rev-parse --abbrev-ref HEAD)）"
fi

step "3/6 提交"
git add -A
if git diff --cached --quiet; then
  ok "没有待提交的改动"
else
  if [ -z "$MESSAGE" ]; then
    if git rev-parse HEAD >/dev/null 2>&1; then
      MESSAGE="chore: 同步到 $TAG"
    else
      MESSAGE="feat: dsh-task-guard $VERSION — 方案准许闸门 / 边界与 skill 限制 / 指令终止与追加判定"
    fi
  fi
  ID_ARGS=()
  if [ -z "$(git config user.email || true)" ]; then
    ID_ARGS=(-c "user.name=$USER_NAME" -c "user.email=$USER_NAME@users.noreply.github.com")
    warn "本地未配置 git 身份，本次提交临时使用 GitHub noreply 邮箱"
  fi
  git "${ID_ARGS[@]}" commit -m "$MESSAGE"
  ok "已提交：$MESSAGE"
fi

step "4/6 打标签"
if git rev-parse -q --verify "refs/tags/$TAG" >/dev/null; then
  ok "$TAG 已存在，跳过"
else
  git tag -a "$TAG" -m "$TAG"
  ok "已打标签 $TAG"
fi

step "5/6 配置远程"
if [ "$USE_SSH" -eq 1 ]; then
  REMOTE="git@github.com:$USER_NAME/$REPO.git"
else
  REMOTE="https://github.com/$USER_NAME/$REPO.git"
fi
if git remote | grep -qx origin; then
  git remote set-url origin "$REMOTE"
else
  git remote add origin "$REMOTE"
fi
ok "origin → $REMOTE"

if [ "$DRY_RUN" -eq 1 ]; then
  step "6/6 干跑结束"
  echo "   仓库: https://github.com/$USER_NAME/$REPO"
  echo "   待推送: $BRANCH 与标签 $TAG"
  echo "   去掉 --dry-run 即真正推送。"
  exit 0
fi

step "6/6 推送"
if [ "$USE_SSH" -eq 1 ]; then
  git push -u origin "$BRANCH" || die "推送分支失败（SSH 身份是否已加到 GitHub？）"
  git push origin "$TAG"       || die "推送标签失败"
else
  [ -n "$TOKEN" ] || die "HTTPS 推送需要 token：导出 GITHUB_TOKEN，或加 --ssh 改走 SSH"
  PUSH_URL="https://x-access-token:$TOKEN@github.com/$USER_NAME/$REPO.git"
  git push "$PUSH_URL" "HEAD:refs/heads/$BRANCH" || die "推送分支失败（token 是否勾了 repo + workflow？仓库是否已创建？）"
  git push "$PUSH_URL" "refs/tags/$TAG"          || die "推送标签失败"
  ok "token 只用于本次 push，未写入 .git/config"
fi

printf '\n发布完成：\n'
echo "   仓库   https://github.com/$USER_NAME/$REPO"
echo "   安装   plugin_manager install_bundle，target = https://codeload.github.com/$USER_NAME/$REPO/tar.gz/refs/heads/$BRANCH"
echo "   固定版 https://codeload.github.com/$USER_NAME/$REPO/tar.gz/refs/tags/$TAG"
echo "   下一步 在仓库 Actions 页确认 CI 变绿；按需发 Release"
