//! 读写 JSON 配置文件：按路径修改，保留原文件的缩进、换行符、键顺序和权限。

use serde::Deserialize;
use serde_json::{Map, Value};
use std::fs;
use std::io;
use std::path::Path;

/// 一次修改：`delete` 为真时删除这个键，否则写入 `value`（可以是 `null`）。
#[derive(Debug, Clone, Deserialize)]
pub struct Op {
	pub path: Vec<String>,
	#[serde(default)]
	pub value: Value,
	#[serde(default)]
	pub delete: bool,
}

/// 原文件的格式，写回时照着用。
#[derive(Debug, Clone, PartialEq)]
pub struct Format {
	pub indent: String,
	pub crlf: bool,
	pub trailing_newline: bool,
}

impl Default for Format {
	fn default() -> Self {
		Format { indent: "  ".into(), crlf: false, trailing_newline: true }
	}
}

pub fn detect_format(text: &str) -> Format {
	let crlf = text.contains("\r\n");
	let trailing_newline = text.ends_with('\n');
	let indent = text
		.lines()
		.skip(1)
		.find_map(|line| {
			let ws: String = line.chars().take_while(|c| *c == ' ' || *c == '\t').collect();
			(!ws.is_empty()).then_some(ws)
		})
		.unwrap_or_else(|| "  ".into());
	Format { indent, crlf, trailing_newline }
}

pub fn serialize(value: &Value, format: &Format) -> String {
	let mut buf = Vec::new();
	let formatter = serde_json::ser::PrettyFormatter::with_indent(format.indent.as_bytes());
	let mut ser = serde_json::Serializer::with_formatter(&mut buf, formatter);
	serde::Serialize::serialize(value, &mut ser).expect("serde_json::Value 总能序列化");
	let mut text = String::from_utf8(buf).expect("serde_json 输出 UTF-8");
	if format.trailing_newline {
		text.push('\n');
	}
	if format.crlf {
		text = text.replace('\n', "\r\n");
	}
	text
}

/// 按路径设置或删除。删除后变空的上级对象一并删除。
pub fn apply(root: &mut Value, op: &Op) -> Result<(), String> {
	if op.path.is_empty() {
		return Err("路径不能为空".into());
	}
	if !root.is_object() {
		return Err("文件顶层不是 JSON 对象".into());
	}
	if op.delete {
		remove(root, &op.path);
		Ok(())
	} else {
		set(root, &op.path, op.value.clone())
	}
}

fn set(node: &mut Value, path: &[String], value: Value) -> Result<(), String> {
	let map = node.as_object_mut().ok_or_else(|| format!("`{}` 的上级不是对象", path[0]))?;
	if path.len() == 1 {
		map.insert(path[0].clone(), value);
		return Ok(());
	}
	let child = map.entry(path[0].clone()).or_insert_with(|| Value::Object(Map::new()));
	if child.is_null() {
		*child = Value::Object(Map::new());
	}
	if !child.is_object() {
		return Err(format!("`{}` 不是对象，不能在下面设置 `{}`", path[0], path[1..].join(".")));
	}
	set(child, &path[1..], value)
}

/// 返回删除后这个节点是否变成了空对象。
fn remove(node: &mut Value, path: &[String]) -> bool {
	let Some(map) = node.as_object_mut() else { return false };
	if path.len() == 1 {
		map.shift_remove(&path[0]);
	} else if let Some(child) = map.get_mut(&path[0]) {
		if remove(child, &path[1..]) {
			map.shift_remove(&path[0]);
		}
	}
	map.is_empty()
}

pub fn parse(text: &str) -> Result<Value, String> {
	let trimmed = text.trim_start_matches('\u{feff}');
	if trimmed.trim().is_empty() {
		return Ok(Value::Object(Map::new()));
	}
	serde_json::from_str(trimmed).map_err(|e| format!("不是合法的 JSON：{e}"))
}

/// 读文件。文件不存在时返回 `None`。
pub fn read(path: &Path) -> Result<Option<(Value, Format)>, String> {
	match fs::read_to_string(path) {
		Ok(text) => Ok(Some((parse(&text)?, detect_format(&text)))),
		Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
		Err(e) => Err(format!("读取失败：{e}")),
	}
}

/// 先写临时文件再改名，保留原文件权限；改名失败（如 Windows 上文件被占用）时直接覆盖。
pub fn write_atomic(path: &Path, text: &str) -> Result<(), String> {
	if let Some(dir) = path.parent() {
		fs::create_dir_all(dir).map_err(|e| format!("创建目录失败：{e}"))?;
	}
	let perms = fs::metadata(path).ok().map(|m| m.permissions());
	let mut tmp = path.as_os_str().to_owned();
	tmp.push(".vanity-tmp");
	let tmp = std::path::PathBuf::from(tmp);
	fs::write(&tmp, text).map_err(|e| format!("写入失败：{e}"))?;
	if let Some(p) = perms {
		let _ = fs::set_permissions(&tmp, p);
	}
	if fs::rename(&tmp, path).is_err() {
		let _ = fs::remove_file(&tmp);
		fs::write(path, text).map_err(|e| format!("写入失败：{e}"))?;
	}
	Ok(())
}

/// 重新读取文件，应用修改并写回。文件存在但解析失败时拒绝修改，免得覆盖用户待修的文件。
pub fn patch(path: &Path, ops: &[Op]) -> Result<Value, String> {
	let (mut root, format) = read(path)?.unwrap_or_else(|| (Value::Object(Map::new()), Format::default()));
	for op in ops {
		apply(&mut root, op)?;
	}
	write_atomic(path, &serialize(&root, &format))?;
	Ok(root)
}

#[cfg(test)]
mod tests {
	use super::*;
	use serde_json::json;

	fn op(path: &str, value: Option<Value>) -> Op {
		let path = path.split('.').map(String::from).collect();
		match value {
			Some(value) => Op { path, value, delete: false },
			None => Op { path, value: Value::Null, delete: true },
		}
	}

	#[test]
	fn detects_indent_and_line_endings() {
		assert_eq!(detect_format("{\n\t\"a\": 1\n}\n").indent, "\t");
		assert_eq!(detect_format("{\n    \"a\": 1\n}").indent, "    ");
		let f = detect_format("{\r\n  \"a\": 1\r\n}\r\n");
		assert!(f.crlf && f.trailing_newline);
		assert!(!detect_format("{}").trailing_newline);
	}

	#[test]
	fn round_trips_format_and_key_order() {
		let text = "{\r\n    \"z\": 1,\r\n    \"a\": {\r\n        \"b\": \"中文\"\r\n    }\r\n}\r\n";
		let v = parse(text).unwrap();
		assert_eq!(serialize(&v, &detect_format(text)), text);
	}

	#[test]
	fn sets_nested_paths_creating_parents() {
		let mut v = json!({ "env": { "A": "1" } });
		apply(&mut v, &op("env.B", Some(json!("2")))).unwrap();
		apply(&mut v, &op("permissions.defaultMode", Some(json!("auto")))).unwrap();
		assert_eq!(v, json!({ "env": { "A": "1", "B": "2" }, "permissions": { "defaultMode": "auto" } }));
	}

	#[test]
	fn removes_keys_and_empty_parents() {
		let mut v = json!({ "env": { "A": "1" }, "x": 1 });
		apply(&mut v, &op("env.A", None)).unwrap();
		assert_eq!(v, json!({ "x": 1 }));
		apply(&mut v, &op("missing.deep", None)).unwrap();
		assert_eq!(v, json!({ "x": 1 }));
		apply(&mut v, &op("x", Some(Value::Null))).unwrap();
		assert_eq!(v, json!({ "x": null }));
	}

	#[test]
	fn refuses_to_set_below_a_non_object() {
		let mut v = json!({ "env": "oops" });
		assert!(apply(&mut v, &op("env.A", Some(json!("1")))).is_err());
	}

	#[test]
	fn patch_rereads_and_refuses_broken_files() {
		let dir = tempfile::tempdir().unwrap();
		let path = dir.path().join("settings.json");
		patch(&path, &[op("a", Some(json!(1)))]).unwrap();
		assert_eq!(fs::read_to_string(&path).unwrap(), "{\n  \"a\": 1\n}\n");
		fs::write(&path, "{\n\t\"a\": 1,\n\t\"b\": 2\n}").unwrap();
		patch(&path, &[op("a", None)]).unwrap();
		assert_eq!(fs::read_to_string(&path).unwrap(), "{\n\t\"b\": 2\n}");
		fs::write(&path, "{ broken").unwrap();
		assert!(patch(&path, &[op("a", Some(json!(1)))]).is_err());
		assert_eq!(fs::read_to_string(&path).unwrap(), "{ broken");
	}

	#[cfg(unix)]
	#[test]
	fn keeps_file_permissions() {
		use std::os::unix::fs::PermissionsExt;
		let dir = tempfile::tempdir().unwrap();
		let path = dir.path().join("settings.json");
		fs::write(&path, "{}").unwrap();
		fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
		patch(&path, &[op("a", Some(json!(1)))]).unwrap();
		assert_eq!(fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
	}
}
