# 参与开发

## 环境

- Node.js ≥ 20（只用标准库，无第三方依赖）
- 语法高亮无所谓，但请保证 `node --check` 通过

## 三条铁律

1. **纯策略层不许碰 Host API**。`lib/policy.js` 只做决策函数，必须能在裸 `node` 里跑；任何 `ctx.*`、`systemPrompt`、`tools` 的东西留在 `index.js`。
2. **改判定逻辑必须同步加断言**。`scripts/selftest.mjs` 是唯一的回归网，改动 `decideGate` / 匹配 / 习惯权重就补用例，跑 `node scripts/selftest.mjs` 全绿再提交。
3. **自测文件里的敏感字面量要拼接**。例如受保护路径写成 `C:${'\\'}Windows`、危险命令写成 `rm -${'rf'} /`。否则开发者本机装着旧版插件时，写自测文件这个动作会被自己的闸门拦掉。

## 目录约定

| 路径 | 职责 |
| --- | --- |
| `index.js` | Host 半边：注册事件、工具、提示段、命令；会话状态；习惯库读写 |
| `lib/policy.js` | 纯函数：配置归一化、边界合并、闸门判定、措辞识别、习惯权重 |
| `scripts/selftest.mjs` | 断言集，`npm run selftest` |
| `docs/` | 配置全表、架构与设计约束、发布与安装指南 |
| `cordis.patch.yml` | bundle 自带的插件装载行 |

## 提交前自检

```bash
node --check index.js
node --check lib/policy.js
node scripts/selftest.mjs      # 必须全绿
```

## 提 PR

- 一个 PR 只做一件事；修 bug 请附复现方式（哪个工具、什么参数、期望 vs 实际）。
- 涉及新配置项时：`lib/policy.js` 的 `normalizeConfig` 加默认值 + `docs/config.md` 加一行 + `cordis.patch.yml` 写默认 + `CHANGELOG.md` 记一条。
- 涉及提示段文案时，注意 `interpolate: false`，别让 `{{ }}` 被模板引擎吃掉。
