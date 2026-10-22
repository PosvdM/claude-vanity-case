//! "获取模型列表"：请求 API 服务的 `/v1/models`。这是工具唯一的网络请求，只在用户点按钮时发出。

use serde::Deserialize;
use serde_json::Value;
use std::time::Duration;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Request {
	pub base_url: String,
	/// `ANTHROPIC_AUTH_TOKEN`，以 `Authorization: Bearer` 发送，和 Claude Code 一致。
	#[serde(default)]
	pub auth_token: String,
	/// `ANTHROPIC_API_KEY`，以 `x-api-key` 发送。
	#[serde(default)]
	pub api_key: String,
	/// `ANTHROPIC_CUSTOM_HEADERS` 的原文，每行一个 `Name: Value`。
	#[serde(default)]
	pub headers: String,
	/// 为空时 ureq 按 `HTTPS_PROXY` 等环境变量决定。
	#[serde(default)]
	pub proxy: String,
}

pub fn models_url(base: &str) -> String {
	let base = base.trim().trim_end_matches('/');
	if base.ends_with("/v1") {
		format!("{base}/models?limit=1000")
	} else {
		format!("{base}/v1/models?limit=1000")
	}
}

pub fn parse_headers(text: &str) -> Vec<(String, String)> {
	text.lines()
		.filter_map(|line| {
			let (name, value) = line.split_once(':')?;
			let name = name.trim();
			(!name.is_empty()).then(|| (name.to_string(), value.trim().to_string()))
		})
		.collect()
}

/// 兼容 `{ "data": [{ "id" }] }`、`{ "models": [...] }` 和直接返回数组几种写法。
pub fn parse_ids(body: &Value) -> Vec<String> {
	let list = body
		.get("data")
		.or_else(|| body.get("models"))
		.unwrap_or(body)
		.as_array()
		.cloned()
		.unwrap_or_default();
	let mut ids: Vec<String> = list
		.iter()
		.filter_map(|m| m.as_str().or_else(|| m.get("id").and_then(Value::as_str)).map(String::from))
		.collect();
	ids.sort();
	ids.dedup();
	ids
}

pub fn fetch(req: &Request) -> Result<Vec<String>, String> {
	if req.base_url.trim().is_empty() {
		return Err("没有填写服务地址".into());
	}
	// 不跟随重定向：ureq 跟随时只去掉 Authorization，x-api-key 和自定义请求头会发给新主机。
	let mut config = ureq::Agent::config_builder()
		.timeout_global(Some(Duration::from_secs(15)))
		.http_status_as_error(false)
		.max_redirects(0);
	if !req.proxy.trim().is_empty() {
		let proxy = ureq::Proxy::new(req.proxy.trim()).map_err(|e| format!("代理地址无效：{e}"))?;
		config = config.proxy(Some(proxy));
	}
	let agent: ureq::Agent = config.build().into();
	let mut call = agent.get(&models_url(&req.base_url)).header("anthropic-version", "2023-06-01");
	if !req.auth_token.is_empty() {
		call = call.header("Authorization", &format!("Bearer {}", req.auth_token));
	}
	if !req.api_key.is_empty() {
		call = call.header("x-api-key", &req.api_key);
	}
	for (name, value) in parse_headers(&req.headers) {
		call = call.header(&name, &value);
	}
	let mut resp = call.call().map_err(|e| format!("请求失败：{e}"))?;
	let status = resp.status();
	if status.is_redirection() {
		let to = resp.headers().get("location").and_then(|v| v.to_str().ok()).unwrap_or("?");
		return Err(format!("服务返回 {status}，重定向到 {to}；请把服务地址改成新地址"));
	}
	let text = resp.body_mut().read_to_string().map_err(|e| format!("读取响应失败：{e}"))?;
	if !status.is_success() {
		let snippet: String = text.chars().take(500).collect();
		return Err(format!("服务返回 {status}：{snippet}"));
	}
	let body: Value = serde_json::from_str(&text).map_err(|_| "响应不是 JSON".to_string())?;
	let ids = parse_ids(&body);
	if ids.is_empty() {
		return Err("响应里没有模型".into());
	}
	Ok(ids)
}

#[cfg(test)]
mod tests {
	use super::*;
	use serde_json::json;

	#[test]
	fn builds_models_url() {
		assert_eq!(models_url("https://a.com/"), "https://a.com/v1/models?limit=1000");
		assert_eq!(models_url("https://a.com/v1"), "https://a.com/v1/models?limit=1000");
	}

	#[test]
	fn parses_headers() {
		assert_eq!(
			parse_headers("X-A: 1\n\nbad\nX-B:two: parts"),
			vec![("X-A".into(), "1".into()), ("X-B".into(), "two: parts".into())]
		);
	}

	#[test]
	fn parses_model_ids() {
		assert_eq!(parse_ids(&json!({ "data": [{ "id": "b" }, { "id": "a" }, { "id": "a" }] })), vec!["a", "b"]);
		assert_eq!(parse_ids(&json!({ "models": ["x"] })), vec!["x"]);
		assert_eq!(parse_ids(&json!([{ "id": "y" }])), vec!["y"]);
	}
}
