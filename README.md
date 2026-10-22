# 妆奁 · Vanity Case

编辑 Claude Code 配置文件的桌面小工具，支持 macOS 和 Windows。需要改配置时打开，改完关掉窗口程序就退出；不常驻后台，也不代理 Claude Code 的请求。

所有修改直接写进 Claude Code 自己的配置文件（`~/.claude/settings.json` 和 `~/.claude.json`）。不打开妆奁时，Claude Code 照常读取这些文件。

## 功能

- **API**：保存多套 API 配置（服务地址、密钥、请求头和模型映射），一键切换。"获取模型列表"读取服务上的模型，填写模型映射时可以直接选。
- **模板**：把一组设置存成模板，一键应用；应用前的值会记下来，可以一键恢复。内置"静默"（跳过首次启动引导、关闭遥测）、"第三方 API" 和"不署名"三个模板。
- **设置**：官方设置参考里能写进用户配置的 200 多个键，按主题分组，每个都有中文说明，可以搜索、只看已设置的。
- **环境变量**：常用的约 30 个变量直接列出，其余的可以按名字搜索添加。

## 安装

从 [Releases](https://github.com/PosvdM/claude-vanity-case/releases) 下载：

- macOS：`.dmg`，同时支持 Apple 芯片和 Intel 芯片。
- Windows：`-setup.exe` 安装包。Windows 10 和 11 自带所需的 WebView2。

安装包没有签名。macOS 第一次打开时，在「应用程序」里右键点妆奁，选择"打开"；Windows 弹出 SmartScreen 提示时，点"更多信息"再点"仍要运行"。

## 使用

### API

左栏列出"官方登录"和保存的配置，绿点表示 `settings.json` 当前用的是哪一套。

- **保存并切换**：保存配置，并把它写进 `settings.json`。切换时先删除上一套配置写入的键，再写入这一套的值，`env` 里的其他变量不受影响。
- **保存并写入**：编辑的是当前生效的配置时显示，保存后同步写进 `settings.json`。
- **切换到官方登录**：删除所有 API 相关的键，Claude Code 改用 `/login` 登录的账号。
- `settings.json` 里的 API 设置和所有配置都对不上时（比如手动改过文件），页面顶部会提示，可以点"存为新配置"。

密钥有两种写法：Auth Token 写入 `ANTHROPIC_AUTH_TOKEN`，以 `Authorization: Bearer` 发送；API Key 写入 `ANTHROPIC_API_KEY`，以 `x-api-key` 发送。中转站一般用 Auth Token。

**模型映射**里留空的项不写入：

| 项目 | 写入 |
|---|---|
| 默认模型 | `ANTHROPIC_MODEL` |
| subagent 模型 | `CLAUDE_CODE_SUBAGENT_MODEL` |
| Opus / Sonnet / Haiku / Fable | `ANTHROPIC_DEFAULT_<档位>_MODEL`；点"更多"可填显示名称、说明和支持的能力 |
| 自定义选项 | `ANTHROPIC_CUSTOM_MODEL_OPTION`，在 `/model` 里多出一个选项 |
| 按版本映射 | `modelOverrides`：在 `/model` 里选中左边的模型时，实际请求右边的模型 ID |

"获取模型列表"请求 `<服务地址>/v1/models`，代理取 `settings.json` 的 `env` 里的 `HTTPS_PROXY` 或 `HTTP_PROXY`。这是妆奁唯一的网络请求，只在点这个按钮时发出。

### 模板

- **应用**：写入模板里的值。每一项第一次被应用时，记下它原来的值（包括"原来没有"）。
- **恢复**：把记下的值写回去，原来没有的键会被删除。应用后又被改过的项不恢复，提示里会列出来。没有应用记录时"恢复"不可用，比如模板里的值本来就已经设好了。
- 状态标签：所有项都与文件一致时为"已应用"，一部分一致时为"部分生效"。
- 模板可以同时包含 `settings.json` 和 `~/.claude.json` 的键，值按 JSON 填写（字符串要加引号）。API 配置管理的键不能放进模板。

### 设置和环境变量

修改立即写入文件：输入框在失去焦点时保存，JSON 编辑框点"保存"或按 Ctrl/Cmd+Enter 保存。布尔值的"未设置"、"清除"按钮和清空输入框都会从文件里删除这个键，Claude Code 随即使用默认值。

- 只在企业托管配置里生效的键不显示，写进用户配置也没有作用。
- 已被官方移除的键只在文件里还设着时显示。
- `settings.json` 里有、官方文档没有收录的键列在"其他字段"里，可以按 JSON 编辑或删除。
- 每个键的说明后面有"文档"链接，打开官方设置参考里对应的条目。

### 生效时机

Claude Code 会监视 `settings.json`，大多数设置在运行中的会话里立即生效。API 配置和其他环境变量建议新开一个会话再用。

## 读写的文件

| 文件 | 内容 |
|---|---|
| `~/.claude/settings.json` | Claude Code 的用户配置。API、设置、环境变量和模板都写这里 |
| `~/.claude.json` | Claude Code 的全局状态。只读写设置页"全局配置"分组里的键和模板里用到的键 |
| `vanity.json` | 妆奁自己的数据：API 配置（含明文密钥）和模板。macOS 在 `~/Library/Application Support/claude-vanity-case/`，权限为 600；Windows 在 `%APPDATA%\claude-vanity-case\` |
| `backups/` | 与 `vanity.json` 同目录。每次打开妆奁后第一次修改某个文件前，把它复制一份到这里，只保留最近一份 |

- 设置了环境变量 `CLAUDE_CONFIG_DIR` 时，两个 Claude Code 文件都从那个目录读写。macOS 上从「应用程序」启动的妆奁拿不到 shell 里设置的变量，这种情况需要在终端里直接运行 `"/Applications/Vanity Case.app/Contents/MacOS/vanity-case"`。
- 写入前重新读取文件，只改动涉及的键；缩进、换行符、键的顺序和文件权限保持不变，但数组会改成每项一行。
- 文件不是合法的 JSON 时，页面顶部显示错误，修好之前不会写这个文件。
- 第一次打开时，如果 `settings.json` 里已经设置了 API，会自动存为第一套配置。
- 侧栏底部的 `settings.json` 和 `.claude.json` 可以在文件夹中显示对应文件。

## 开发

需要 Node.js 22 或更高版本和 Rust stable。

```bash
npm install
npm run dev          # 启动开发版
npm test             # JS 和 Rust 单元测试
npm run build        # 打包
npm run update-docs  # 拉取最新官方文档，列出需要补充的设置键
```

架构、数据格式和发布流程见 [技术文档](docs/architecture.md)。

## 许可证

[GNU AGPL-3.0-or-later](LICENSE)
