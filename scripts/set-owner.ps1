<#
.SYNOPSIS
  一次性把仓库里的 GH_USER 占位符替换成你的 GitHub 用户名（和可选的仓库名）。

.DESCRIPTION
  本仓库发布前在 README.md / package.json / docs/*.md 里用 GH_USER 作占位。
  运行本脚本后所有占位都会被替换成真实用户名，之后不再需要手工改。

.EXAMPLE
  pwsh ./scripts/set-owner.ps1 -User yourname

.EXAMPLE
  pwsh ./scripts/set-owner.ps1 -User yourname -Repo task-guard -WhatIf
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [Parameter(Mandatory = $true)]
    [string]$User,

    [string]$Repo = 'dsh-task-guard'
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)

if ($User -notmatch '^[A-Za-z0-9][A-Za-z0-9-]{0,38}$') {
    throw "GitHub 用户名格式不对：$User"
}

$Targets = @(
    'README.md',
    'package.json',
    'docs/install.md',
    'docs/publish.md',
    'CONTRIBUTING.md'
) | Where-Object { Test-Path (Join-Path $Root $_) }

$changed = @()
foreach ($rel in $Targets) {
    $path = Join-Path $Root $rel
    $text = Get-Content $path -Raw -Encoding utf8
    if ($text -notmatch 'GH_USER') { continue }

    $new = $text -replace 'GH_USER/dsh-task-guard', "$User/$Repo"
    $new = $new -replace 'GH_USER', $User

    if ($PSCmdlet.ShouldProcess($rel, "替换 GH_USER → $User")) {
        Set-Content $path -Value $new -NoNewline -Encoding utf8
        $changed += $rel
    }
}

$left = @()
foreach ($rel in $Targets) {
    if ((Get-Content (Join-Path $Root $rel) -Raw -Encoding utf8) -match 'GH_USER') { $left += $rel }
}

if ($changed.Count -eq 0) {
    Write-Host '没有找到 GH_USER 占位符（可能已经替换过了）。' -ForegroundColor Yellow
} else {
    Write-Host "已替换：$($changed -join ', ')" -ForegroundColor Green
}
if ($left.Count -gt 0) {
    Write-Host "仍有残留：$($left -join ', ') —— 请手工检查" -ForegroundColor Yellow
}

Write-Host ''
Write-Host '下一步：'
Write-Host "  git add -A && git commit -m `"chore: 仓库地址改为 $User/$Repo`""
Write-Host "  pwsh ./scripts/publish.ps1 -User $User" -ForegroundColor Cyan
Write-Host ''
Write-Host "仓库地址会变成 https://github.com/$User/$Repo"
