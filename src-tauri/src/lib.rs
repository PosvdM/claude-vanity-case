mod jsonfile;
mod models;

use jsonfile::Op;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Mutex;

/// 工具能读写的三个文件。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Deserialize)]
#[serde(rename_all = "lowercase")]
enum Target {
	/// `~/.claude/settings.json`
	Settings,
	/// `~/.claude.json`
	Global,
	/// 工具自己的 `vanity.json`：API 配置和模板
	Store,
}

fn home() -> PathBuf {
	dirs::home_dir().unwrap_or_else(|| PathBuf::from("."))
}

/// 设置了 `CLAUDE_CONFIG_DIR` 时，Claude Code 把 `settings.json` 和 `.claude.json` 都放在那个目录里。
fn config_dir_override() -> Option<PathBuf> {
	std::env::var_os("CLAUDE_CONFIG_DIR").filter(|v| !v.is_empty()).map(PathBuf::from)
}

fn path_of(target: Target) -> PathBuf {
	match target {
		Target::Settings => config_dir_override().unwrap_or_else(|| home().join(".claude")).join("settings.json"),
		Target::Global => config_dir_override().unwrap_or_else(home).join(".claude.json"),
		Target::Store => store_dir().join("vanity.json"),
	}
}

/// 妆奁自己的数据目录。`VANITY_CASE_DIR` 用于测试和开发，避免动到真实数据。
fn store_dir() -> PathBuf {
	match std::env::var_os("VANITY_CASE_DIR").filter(|v| !v.is_empty()) {
		Some(dir) => PathBuf::from(dir),
		None => dirs::config_dir().unwrap_or_else(home).join("claude-vanity-case"),
	}
}

#[derive(Default)]
struct State {
	/// 本次运行中已经备份过的文件，每个文件只在第一次写入前备份一次。
	backed_up: Mutex<HashSet<Target>>,
}

impl State {
	fn backup_once(&self, target: Target) -> Result<(), String> {
		if target == Target::Store || !self.backed_up.lock().unwrap().insert(target) {
			return Ok(());
		}
		let src = path_of(target);
		if !src.exists() {
			return Ok(());
		}
		let name = match target {
			Target::Settings => "settings.json",
			_ => "claude.json",
		};
		let dir = store_dir().join("backups");
		std::fs::create_dir_all(&dir).map_err(|e| format!("创建备份目录失败：{e}"))?;
		std::fs::copy(&src, dir.join(name)).map_err(|e| format!("备份失败：{e}"))?;
		Ok(())
	}
}

#[derive(Serialize)]
struct Paths {
	settings: PathBuf,
	global: PathBuf,
	store: PathBuf,
	backups: PathBuf,
}

#[tauri::command]
fn paths() -> Paths {
	Paths {
		settings: path_of(Target::Settings),
		global: path_of(Target::Global),
		store: path_of(Target::Store),
		backups: store_dir().join("backups"),
	}
}

#[derive(Serialize)]
struct FileContent {
	exists: bool,
	value: Value,
	error: Option<String>,
}

/// 读取文件。给了 `keys` 时只返回这些顶层键，`~/.claude.json` 很大，界面只需要其中几个。
#[tauri::command]
fn read_file(target: Target, keys: Option<Vec<String>>) -> FileContent {
	match jsonfile::read(&path_of(target)) {
		Ok(None) => FileContent { exists: false, value: Value::Object(Map::new()), error: None },
		Ok(Some((value, _))) => {
			let value = match (keys, value) {
				(Some(keys), Value::Object(map)) => {
					Value::Object(map.into_iter().filter(|(k, _)| keys.contains(k)).collect())
				}
				(_, v) => v,
			};
			FileContent { exists: true, value, error: None }
		}
		Err(error) => FileContent { exists: true, value: Value::Object(Map::new()), error: Some(error) },
	}
}

#[tauri::command]
fn patch_file(state: tauri::State<State>, target: Target, ops: Vec<Op>) -> Result<(), String> {
	if ops.is_empty() {
		return Ok(());
	}
	state.backup_once(target)?;
	jsonfile::patch(&path_of(target), &ops).map(|_| ())
}

/// `vanity.json` 里有明文密钥，在 macOS 和 Linux 上只让当前用户读写。
#[tauri::command]
fn write_store(value: Value) -> Result<(), String> {
	let path = path_of(Target::Store);
	jsonfile::write_atomic(&path, &jsonfile::serialize(&value, &jsonfile::Format::default()))?;
	#[cfg(unix)]
	{
		use std::os::unix::fs::PermissionsExt;
		std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).map_err(|e| format!("设置权限失败：{e}"))?;
	}
	Ok(())
}

#[tauri::command]
fn reveal(target: Target) -> Result<(), String> {
	let path = path_of(target);
	let path = if path.exists() { path } else { path.parent().map(PathBuf::from).unwrap_or(path) };
	tauri_plugin_opener::reveal_item_in_dir(path).map_err(|e| e.to_string())
}

/// 只打开官方设置参考里的锚点，不接受任意网址。
#[tauri::command]
fn open_doc(anchor: String) -> Result<(), String> {
	if !anchor.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
		return Err("锚点无效".into());
	}
	let url = format!("https://code.claude.com/docs/en/settings-reference#{anchor}");
	tauri_plugin_opener::open_url(url, None::<&str>).map_err(|e| e.to_string())
}

#[tauri::command]
async fn fetch_models(req: models::Request) -> Result<Vec<String>, String> {
	tauri::async_runtime::spawn_blocking(move || models::fetch(&req))
		.await
		.map_err(|e| e.to_string())?
}

fn setup<R: tauri::Runtime>(builder: tauri::Builder<R>) -> tauri::Builder<R> {
	builder
		.manage(State::default())
		.invoke_handler(tauri::generate_handler![paths, read_file, patch_file, write_store, reveal, open_doc, fetch_models])
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
	setup(tauri::Builder::default()).run(tauri::generate_context!()).expect("启动失败");
}

#[cfg(test)]
mod tests {
	use serde_json::{json, Value};
	use tauri::test::{get_ipc_response, mock_builder, mock_context, noop_assets, INVOKE_KEY};

	/// 按界面发送的 JSON 调用命令，核对参数名和 `Op` 的反序列化。
	fn call(webview: &tauri::WebviewWindow<tauri::test::MockRuntime>, cmd: &str, body: Value) -> Result<Value, Value> {
		get_ipc_response(
			webview,
			tauri::webview::InvokeRequest {
				cmd: cmd.into(),
				callback: tauri::ipc::CallbackFn(0),
				error: tauri::ipc::CallbackFn(1),
				url: "tauri://localhost".parse().unwrap(),
				body: tauri::ipc::InvokeBody::Json(body),
				headers: Default::default(),
				invoke_key: INVOKE_KEY.to_string(),
			},
		)
		.map(|b| b.deserialize::<Value>().unwrap())
	}

	#[test]
	fn commands_work_over_ipc() {
		let dir = tempfile::tempdir().unwrap();
		std::env::set_var("CLAUDE_CONFIG_DIR", dir.path());
		std::env::set_var("VANITY_CASE_DIR", dir.path().join("vanity"));
		std::fs::write(dir.path().join("settings.json"), "{\n\t\"env\": { \"A\": \"1\" },\n\t\"keep\": true\n}\n").unwrap();
		std::fs::write(dir.path().join(".claude.json"), r#"{"hasCompletedOnboarding":false,"projects":{"big":1}}"#).unwrap();

		let app = super::setup(mock_builder()).build(mock_context(noop_assets())).unwrap();
		let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default()).build().unwrap();

		let ops = json!([
			{ "path": ["env", "A"], "delete": true },
			{ "path": ["model"], "value": "opus" },
			{ "path": ["nothing"], "value": null }
		]);
		call(&webview, "patch_file", json!({ "target": "settings", "ops": ops })).unwrap();
		let text = std::fs::read_to_string(dir.path().join("settings.json")).unwrap();
		assert_eq!(text, "{\n\t\"keep\": true,\n\t\"model\": \"opus\",\n\t\"nothing\": null\n}\n");

		assert!(dir.path().join("vanity/backups/settings.json").exists());

		let global = call(&webview, "read_file", json!({ "target": "global", "keys": ["hasCompletedOnboarding"] })).unwrap();
		assert_eq!(global["value"], json!({ "hasCompletedOnboarding": false }));

		std::fs::write(dir.path().join("settings.json"), "{ broken").unwrap();
		let read = call(&webview, "read_file", json!({ "target": "settings" })).unwrap();
		assert!(read["error"].is_string());
		assert!(call(&webview, "patch_file", json!({ "target": "settings", "ops": [{ "path": ["a"], "value": 1 }] })).is_err());
		assert!(call(&webview, "open_doc", json!({ "anchor": "x/../evil" })).is_err());
	}
}
