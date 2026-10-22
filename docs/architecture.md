# 技术文档

本文写给修改妆奁代码的人。使用方法见 [README](../README.md)。

## 结构

妆奁是一个 Tauri 2 程序。Rust 端只负责读写文件和发一个 HTTP 请求；界面和业务逻辑都在 `ui/` 里，用原生 JS 写成，没有构建步骤，Tauri 直接加载这个目录。

| 路径 | 职责 |
|---|---|
| `src-tauri/src/lib.rs` | Tauri 命令、三个文件的路径、写入前的备份 |
| `src-tauri/src/jsonfile.rs` | 读取 JSON 文件、识别格式、按路径修改、原子写入 |
| `src-tauri/src/models.rs` | "获取模型列表"的请求和响应解析 |
| `ui/logic.js` | 与界面无关的逻辑：API 配置与 env 的对应、当前配置的识别、模板的应用和恢复。浏览器和 `node --test` 共用 |
| `ui/app.js` | 四个页面的渲染和交互，以及和 Rust 端的调用 |
| `ui/data/fields.json` | 设置页的全部字段：类型、中文名、说明、默认值、文档锚点 |
| `ui/data/env-common.json` | 环境变量页直接列出的常用变量 |
| `ui/data/env-profile.json` | API 配置接管的变量的中文说明，测试用它核对 `PROFILE_ENV` |
| `ui/data/env-all.json` | 官方文档里的全部环境变量和英文说明，供"添加变量"补全，由脚本生成 |
| `scripts/update-docs.mjs` | 拉取官方文档，重新生成 `env-all.json`，报告 `fields.json` 与文档的差异 |
| `docs-src/` | 官方文档的本地副本和非托管键列表 `keys.tsv`，整理 `fields.json` 时以它为准 |

## Rust 命令

| 命令 | 作用 |
|---|---|
| `paths` | 返回三个文件和备份目录的路径 |
| `read_file(target, keys?)` | 读取文件。给了 `keys` 时只返回这些顶层键；`~/.claude.json` 很大，界面只取需要的键 |
| `patch_file(target, ops)` | 重新读取文件，按顺序应用修改后写回 |
| `write_store(value)` | 整个写入 `vanity.json` |
| `reveal(target)` | 在文件管理器中显示文件 |
| `open_doc(anchor)` | 用浏览器打开官方设置参考的某个锚点。只接受字母、数字和连字符，不能打开任意网址 |
| `fetch_models(req)` | 请求 `/v1/models`，返回排序去重后的模型 ID |

`target` 取 `settings`（`settings.json`）、`global`（`~/.claude.json`）或 `store`（`vanity.json`）。

`ops` 的每一项是 `{ path, value }` 或 `{ path, delete: true }`。删除用单独的标记，因为 `value` 可以是 JSON 的 `null`。删除后变空的上级对象一并删除。上级存在但不是对象时（如 `"attribution": false` 时写 `attribution.commit`）返回错误。

## 文件读写

- 每次修改都在 Rust 端重新读取文件再改，界面不会用手里的旧内容覆盖整个文件。Claude Code 自己也在频繁改写 `~/.claude.json`，这样冲突窗口只有读到写之间的几毫秒。
- 写入前识别原文件的缩进（tab 或空格个数）、换行符（LF 或 CRLF）和末尾换行，写回时照用；`serde_json` 开启 `preserve_order`，键的顺序不变。输出是 `serde_json` 的多行格式，数组每项一行，原文件里单行的数组会被展开。
- 先写同目录的 `<文件>.vanity-tmp`，复制原文件权限后改名替换。改名失败（Windows 上文件被占用）时直接覆盖原文件。
- 文件存在但不是合法 JSON 时，`patch_file` 返回错误，不写入，免得用空对象覆盖用户待修的文件。
- 每次运行中，`settings.json` 和 `~/.claude.json` 第一次被修改前各备份一次到 `backups/`。`vanity.json` 不备份。
- 设置了 `CLAUDE_CONFIG_DIR` 时，两个 Claude Code 文件都在那个目录里，`.claude.json` 也在其中，这与 Claude Code 的行为一致。
- 设置了 `VANITY_CASE_DIR` 时，`vanity.json` 和 `backups/` 放在那个目录里，供测试和开发使用。

## API 配置

`vanity.json` 的结构：

```json
{
	"version": 1,
	"profiles": [
		{
			"id": "k3j9x2ab",
			"name": "cpa",
			"baseUrl": "https://example.com",
			"keyType": "token",
			"key": "sk-…",
			"headers": "X-Title: claude",
			"model": "",
			"subagentModel": "",
			"tiers": {
				"opus": { "id": "claude-opus-5-5", "name": "", "description": "", "capabilities": "" },
				"sonnet": { "id": "", "name": "", "description": "", "capabilities": "" },
				"haiku": { "id": "", "name": "", "description": "", "capabilities": "" },
				"fable": { "id": "", "name": "", "description": "", "capabilities": "" }
			},
			"custom": { "id": "", "name": "", "description": "", "capabilities": "" },
			"overrides": { "claude-opus-5-5": "my-opus" }
		}
	],
	"templates": []
}
```

- `logic.js` 的 `PROFILE_ENV` 列出 API 配置接管的全部 env 变量；顶层的 `modelOverrides` 也归 API 配置管。切换时 `profileOps()` 先删除这些键，再写入配置里的非空值。设置页、环境变量页和模板都不能改这些键，避免和切换互相覆盖。
- 修改 `PROFILE_ENV` 时同步修改 `env-profile.json`，测试会核对两者是否一致。
- 当前配置靠比较内容识别：`settings.json` 里这些键的值与某套配置生成的值完全相同，这套就是当前配置。全部为空时是"官方登录"。都对不上时界面提示"存为新配置"。
- 编辑时界面改的是一份草稿，保存后才写入 `vanity.json`。保存的配置在保存前是当前配置时，同时写进 `settings.json`，两边保持一致。

## 模板

模板的结构：

```json
{
	"id": "quiet",
	"name": "静默",
	"desc": "…",
	"items": [{ "file": "global", "path": ["hasCompletedOnboarding"], "value": true }],
	"snapshot": [{ "file": "global", "path": ["hasCompletedOnboarding"], "exists": false, "value": null }]
}
```

- `applyTemplate()` 为每一项记下应用前的值，存进 `snapshot`。已经记过的项保留最早的那份，所以连续应用两次后恢复，得到的仍是第一次应用前的值。
- `snapshot` 先保存到 `vanity.json`，再写配置文件，写入中途出错时也不会丢失恢复所需的记录。
- `restoreTemplate()` 只恢复当前值仍等于模板值的项，其余项跳过，避免覆盖应用后用户自己改的值。恢复后清空 `snapshot`。
- 编辑模板时，`snapshot` 里已删除的项一并去掉。
- 内置模板由 `builtinTemplates()` 定义，只在第一次生成 `vanity.json` 时写入，之后与自建模板一样可以修改和删除。

## 字段数据

`fields.json` 的结构为 `{ "topics": [...], "fields": [...] }`。`topics` 是设置页分组的显示顺序。每个字段：

```json
{
	"key": "permissions.defaultMode",
	"file": "settings",
	"topic": "权限",
	"type": "enum",
	"options": [{ "value": "default", "label": "每次询问" }],
	"label": "默认权限模式",
	"desc": "…",
	"default": "…",
	"doc": "permissions-defaultmode"
}
```

| 字段 | 说明 |
|---|---|
| `key` | 设置键，嵌套键用点连接，与官方索引一致 |
| `file` | `settings` 或 `global`（官方 Scope 为 `Global config` 的键写在 `~/.claude.json`） |
| `type` | 决定控件：`boolean`（未设置/开/关）、`string`（可带 `suggestions`）、`enum`（带 `options`，`value` 是写入文件的原值）、`integer`/`number`（可带 `min`、`max`）、`stringArray`（每行一项）、`stringMap`（键值对）、`object`（只作分组标题，子键另有条目）、`json`（JSON 编辑框，可带 `example`） |
| `label`、`desc`、`default` | 中文名、说明、默认值描述 |
| `doc` | 官方设置参考里的锚点，取自索引表的链接 |
| `removed` | 官方已移除的键。文件里没有设置时不显示 |

设置页不显示 `env`（环境变量页）和 `modelOverrides`（API 页）。父对象在文件里被写成非对象时（如 `"attribution": false`），父项显示为 JSON 编辑框，子键隐藏。

`hasCompletedOnboarding` 不在官方文档里，但 Claude Code 会读取它来决定是否显示首次启动引导，所以手工维护这一条。

环境变量的 `env-common.json` 和 `env-profile.json` 每项有 `name`、`group`、`type`、`label`、`desc`。`type` 为 `flag` 时是开关：打开写入 `on` 的值（默认 `"1"`），关闭删除变量。`CLAUDE_CODE_ATTRIBUTION_HEADER` 这类写 `"0"` 才生效的变量，用 `on` 指明。env 的值一律按字符串写入。

### 跟进官方文档

发版前运行 `npm run update-docs`：

1. 下载最新的 `settings-reference.md` 和 `env-vars.md` 到 `docs-src/`，重新生成 `env-all.json` 和 `keys.tsv`。
2. 列出文档有而 `fields.json` 没有的非托管键、`fields.json` 有而文档已删除的键、改为只在托管配置里生效的键，以及常用变量里已不在文档中的变量。
3. 按列出的结果手工修改 `fields.json`：新键对照 `docs-src/settings-reference.md` 里该键的 Scope、Type 和正文补齐各字段；删除的键加 `removed: true` 或直接删除。

## 开发和测试

- `npm run dev` 启动开发版。为了不动自己的配置，先建一个临时目录，复制一份 `settings.json` 和 `.claude.json` 进去，再用 `CLAUDE_CONFIG_DIR=<临时目录> VANITY_CASE_DIR=<临时目录>/vanity npm run dev` 启动。
- `npm test` 运行 `test/` 下的 JS 测试和 Rust 单元测试。JS 测试覆盖 `logic.js`；Rust 测试覆盖格式保留、路径修改、损坏文件的处理和模型列表解析，并用 Tauri 的 mock runtime 按界面发送的 JSON 调用命令，核对参数名。
- 图标的源文件是 `assets/icon.svg`。修改后先导出为 1024×1024 的 PNG，再运行 `npx tauri icon <png> -o src-tauri/icons` 生成各平台图标，删掉生成的 `android/`、`ios/` 和 `Square*` 文件。

## 发布

1. 同步修改 `package.json`、`src-tauri/Cargo.toml` 和 `src-tauri/tauri.conf.json` 里的版本号。
2. 推送 `v<版本号>` 标签。`.github/workflows/release.yml` 在 macOS 上构建通用二进制的 `.app` 和 `.dmg`，在 Windows 上构建 NSIS 安装包，上传到同名的草稿 Release。
3. 在 GitHub 上补写发布说明，再发布草稿。

安装包没有签名，也没有公证。
