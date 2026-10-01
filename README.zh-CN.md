<p align="center">
  <img alt="49Agents" src="https://github.com/user-attachments/assets/93d237b6-e1ec-40ea-aa30-6feb72ca6599" height="120" />
</p>

<h1 align="center">49 Agents IDE</h1>

<p align="center">首个 2D Agent IDE。</p>

<p align="center"><strong>所有 Agent、所有终端、所有项目、所有机器，都在同一张画布上。</strong></p>

<p align="center"><a href="./README.md">English</a> · 简体中文</p>

<img width="100%" alt="49 Agents IDE" src="https://github.com/user-attachments/assets/878b3926-e017-4ccc-9c54-315b647fd417" />

## 为什么做它

同时跑五六个 Claude Code / Codex，十几个终端标签来回切，很快就乱了。49 Agents IDE 把每个终端变成一张无限画布上的窗格，可以随意摆放、缩放，一眼看到所有 Agent 在做什么。

| 以前 | 用 49 之后 |
|------|-----------|
| 十几个终端标签 | 一张可缩放的画布 |
| 每台机器都要 SSH | 多台机器接入同一画布，无需 SSH |
| 切窗口查看 Claude 状态 | 每个窗格都显示 Agent 状态 |
| 离开电脑就没法用 | 手机、平板随时打开 |
| 只有终端，没有文件 | 画布上直接用 Monaco 编辑器 |
| 🤷 | Git 图 |
| 🤷 | 交互式 issue 表格（[Beads](https://github.com/steveyegge/beads)） |
| 🤷 | 权限请求通知 |
| 🤷 | Markdown 笔记 |

每个窗格都是真实的 tmux 终端，所以**任何命令行 Agent 都能用**：Claude Code、Codex，以及 Qwen Code、Kimi CLI 等国产 CLI Agent。

## 快速开始（推荐自托管）

```bash
git clone https://github.com/alpbahadur/49-IDE.git
cd 49-IDE
./49ctl setup    # 一次性交互式配置
./49ctl start    # 启动服务端和 agent
```

打开 `http://localhost:1071` 即可使用。无需注册、登录或 token。

自托管免费，终端和文件不会离开你的机器，两条命令就能跑起来。也可以先试用云端版本 [app.49agents.com](https://app.49agents.com)（服务器在海外，国内访问速度可能较慢）。

## 桌面版（macOS）

从 [GitHub Releases](https://github.com/alpbahadur/49-IDE/releases/latest) 下载最新的 `.dmg`。应用尚未经过 Apple 公证，首次打开前运行：

```bash
xattr -cr /Applications/49Agents.app
```

之后正常打开即可，它会以图标形式常驻菜单栏。在菜单栏图标中选择 **Check for Updates** 即可更新。

## 功能

**画布与工作区**
- 无限画布：没有标签页和分屏，窗格可以放在任何位置
- 拖动、缩放、排列，布局自动保存

**终端**
- 基于 ttyd 的真实 tmux 会话：完整 ANSI 颜色、滚动历史、你自己的 shell 配置
- 广播输入：输入一次，同时发送到多个终端

**多机器**
- 无需 SSH：任意机器上的 Agent 都能接入同一张画布
- HUD 面板：实时查看所有机器的 CPU、内存和 Claude API 用量

**访问方式**
- 笔记本、平板、手机，同一个工作区、同一个布局
- 支持 Tailscale、局域网或托管中继
- 整套服务可以完全自托管；终端数据只转发、不在服务器端保存

**键盘优先**
- Tab 组合键切换窗格、WASD 空间导航、数字键 1–9 快速聚焦

## 许可证

[BSL 1.1](./LICENSE)：源码公开，个人和小团队可免费使用，2030-02-26 起转为 MIT 许可证。
