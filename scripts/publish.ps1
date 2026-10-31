<#
.SYNOPSIS
  把 dsh-task-guard 发布到 GitHub：预检 → 本地提交 → 打标签 → 推送。

.DESCRIPTION
  只做本地与推送动作，不清理任何文件。HTTPS 模式把 token 拼进本次 push 的 URL，
  不写入 .git/config。详细流程与排错见 docs/publish.md。

.EXAMPLE
  $env:GITHUB_TOKEN = "ghp_xxx"
  pwsh ./scripts/publish.ps1 -User yourname

.EXAMPLE
  pwsh ./scripts/publish.ps1 -User yourname -Ssh

.EXAMPLE
  pwsh ./scripts/publish.ps1 -User yourname -DryRun
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$User,

    [string]$Repo = 'dsh-task-guard',

    [string]$Branch = 'main',

    [switch]$Ssh,

    [switch]$DryRun,

    [string]$Token = $env:GITHUB_TOKEN,

    [string]$Message = ''
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Push-Location $Root

function Step($text) { Write-Host "`n== $text" -ForegroundColor Cyan }
function Ok($text) { Write-Host "   ok  $text" -ForegroundColor Green }
function Warn($text) { Write-Host "   !!  $text" -ForegroundColor Yellow }
function Die($text) { Write-Host "   xx  $text" -ForegroundColor Red; Pop-Location; exit 1 }

try {
    Step "1/6 预检"
    foreach ($cmd in 'node', 'git') {
        if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) { Die "找不到 $cmd，请先安装并加入 PATH" }
    }
    node --check index.js; if ($LASTEXITCODE -ne 0) { Die 'index.js 语法检查失败' }
    node --check lib/policy.js; if ($LASTEXITCODE -ne 0) { Die 'lib/policy.js 语法检查失败' }
    Ok '语法检查通过'

    node scripts/selftest.mjs | Out-Host
    if ($LASTEXITCODE -ne 0) { Die '纯策略层自测未通过，先修好再发布' }
    Ok '自测通过'

    $ManifestCheck = @'
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
'@
    # 走临时文件而不是 stdin：Windows PowerShell 5.1 往 native 进程的管道会带 BOM，node 会 JSON.parse 失败
    $CheckFile = Join-Path $env:TEMP 'dsh-task-guard-manifest-check.cjs'
    [System.IO.File]::WriteAllText($CheckFile, $ManifestCheck, (New-Object System.Text.UTF8Encoding($false)))
    node $CheckFile; $CheckCode = $LASTEXITCODE
    Remove-Item $CheckFile -Force -ErrorAction SilentlyContinue
    if ($CheckCode -ne 0) { Die '清单校验失败' }
    Ok 'package.json / locale 校验通过'

    $Version = (Get-Content package.json -Raw | ConvertFrom-Json).version
    if (-not $Version) { Die '读不到 package.json 的 version' }
    $Tag = "v$Version"
    Ok "版本 $Version → 标签 $Tag"

    Step "2/6 初始化仓库"
    if (-not (Test-Path '.git')) {
        git init -b $Branch | Out-Null
        Ok "已在 $Branch 分支上 git init"
    } else {
        $cur = (git rev-parse --abbrev-ref HEAD).Trim()
        Ok "已是 git 仓库（当前分支 $cur）"
    }

    Step "3/6 提交"
    git add -A
    $staged = git diff --cached --name-only
    if ([string]::IsNullOrWhiteSpace(($staged -join ''))) {
        Ok '没有待提交的改动'
    } else {
        if ([string]::IsNullOrWhiteSpace($Message)) {
            $Message = if ((git rev-parse HEAD 2>$null)) { "chore: 同步到 $Tag" } else { "feat: dsh-task-guard $Version — 方案准许闸门 / 边界与 skill 限制 / 指令终止与追加判定" }
        }
        $idArgs = @()
        if ([string]::IsNullOrWhiteSpace((git config user.email))) {
            $idArgs = @('-c', "user.name=$User", '-c', "user.email=$User@users.noreply.github.com")
            Warn '本地未配置 git 身份，本次提交临时使用 GitHub noreply 邮箱'
        }
        git @idArgs commit -m $Message | Out-Host
        if ($LASTEXITCODE -ne 0) { Die '提交失败' }
        Ok "已提交：$Message"
    }

    Step "4/6 打标签"
    if ((git tag -l $Tag)) {
        Ok "$Tag 已存在，跳过"
    } else {
        git tag -a $Tag -m "$Tag" | Out-Null
        Ok "已打标签 $Tag"
    }

    Step "5/6 配置远程"
    if ($Ssh) {
        $Remote = "git@github.com:$User/$Repo.git"
    } else {
        $Remote = "https://github.com/$User/$Repo.git"
    }
    $existing = git remote
    if ($existing -contains 'origin') {
        git remote set-url origin $Remote
        Ok "origin → $Remote"
    } else {
        git remote add origin $Remote
        Ok "origin → $Remote"
    }

    if ($DryRun) {
        Step '6/6 干跑结束'
        Write-Host "   仓库: https://github.com/$User/$Repo"
        Write-Host "   待推送: $Branch 与标签 $Tag"
        Write-Host "   去掉 -DryRun 即真正推送。"
        Pop-Location; exit 0
    }

    Step "6/6 推送"
    if ($Ssh) {
        git push -u origin $Branch | Out-Host
        if ($LASTEXITCODE -ne 0) { Die '推送分支失败（SSH 身份是否已加到 GitHub？）' }
        git push origin $Tag | Out-Host
        if ($LASTEXITCODE -ne 0) { Die '推送标签失败' }
    } else {
        if ([string]::IsNullOrWhiteSpace($Token)) {
            Die 'HTTPS 推送需要 token：设置 $env:GITHUB_TOKEN，或加 -Ssh 改走 SSH'
        }
        $PushUrl = "https://x-access-token:$Token@github.com/$User/$Repo.git"
        git push $PushUrl "HEAD:refs/heads/$Branch" | Out-Host
        if ($LASTEXITCODE -ne 0) { Die '推送分支失败（token 是否勾了 repo + workflow？仓库是否已创建？）' }
        git push $PushUrl "refs/tags/$Tag" | Out-Host
        if ($LASTEXITCODE -ne 0) { Die '推送标签失败' }
        Ok 'token 只用于本次 push，未写入 .git/config'
    }

    Write-Host "`n发布完成：" -ForegroundColor Green
    Write-Host "   仓库   https://github.com/$User/$Repo"
    Write-Host "   安装   plugin_manager install_bundle，target = https://codeload.github.com/$User/$Repo/tar.gz/refs/heads/$Branch"
    Write-Host "   固定版 https://codeload.github.com/$User/$Repo/tar.gz/refs/tags/$Tag"
    Write-Host "   下一步 在仓库 Actions 页确认 CI 变绿；按需发 Release"
}
finally {
    Pop-Location
}
