import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
	OFFICIAL_ID,
	PROFILE_ENV,
	activeProfileId,
	applyTemplate,
	builtinTemplates,
	getPath,
	initialStore,
	isProfilePath,
	newProfile,
	profileFromSettings,
	profileOps,
	restoreTemplate,
	templateStatus,
} from "../ui/logic.js";

const envProfile = JSON.parse(readFileSync(new URL("../ui/data/env-profile.json", import.meta.url)));

/** 测试里模拟 Rust 端的 patch：设置或删除，删除后清掉空的上级对象。 */
function patch(obj, ops) {
	const root = structuredClone(obj);
	for (const { path, value } of ops) {
		const parents = [root];
		let cur = root;
		for (const k of path.slice(0, -1)) {
			if (value === undefined && !(k in cur)) break;
			cur[k] ??= {};
			cur = cur[k];
			parents.push(cur);
		}
		const last = path.at(-1);
		if (value === undefined) {
			delete cur[last];
			for (let i = parents.length - 1; i > 0 && Object.keys(parents[i]).length === 0; i--) delete parents[i - 1][path[i - 1]];
		} else cur[last] = value;
	}
	return root;
}

test("PROFILE_ENV 和 env-profile.json 列出的变量一致", () => {
	assert.deepEqual([...PROFILE_ENV].sort(), envProfile.map((e) => e.name).sort());
});

test("切换配置：写入新值，删除旧配置留下的键，其他 env 不动", () => {
	const settings = {
		env: { ANTHROPIC_BASE_URL: "https://old", ANTHROPIC_API_KEY: "k", ANTHROPIC_DEFAULT_OPUS_MODEL: "x", HTTP_PROXY: "p" },
		modelOverrides: { a: "b" },
	};
	const p = newProfile({ name: "new", baseUrl: "https://new", authToken: "t", tiers: { ...newProfile().tiers, sonnet: { id: "s", name: "", description: "", capabilities: "" } } });
	const out = patch(settings, profileOps(p));
	assert.deepEqual(out, { env: { HTTP_PROXY: "p", ANTHROPIC_BASE_URL: "https://new", ANTHROPIC_AUTH_TOKEN: "t", ANTHROPIC_DEFAULT_SONNET_MODEL: "s" } });
	assert.equal(activeProfileId(out, [p]), p.id);
});

test("官方登录删除全部接管的键", () => {
	const out = patch({ env: { ANTHROPIC_BASE_URL: "u", ANTHROPIC_AUTH_TOKEN: "t" }, model: "opus" }, profileOps(newProfile({ id: OFFICIAL_ID })));
	assert.deepEqual(out, { model: "opus" });
	assert.equal(activeProfileId(out, []), OFFICIAL_ID);
});

test("从 settings.json 导入后能识别为当前配置", () => {
	const settings = {
		env: { ANTHROPIC_BASE_URL: "https://cpa.example.com", ANTHROPIC_API_KEY: "k", ANTHROPIC_CUSTOM_MODEL_OPTION: "m", ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME: "H" },
		modelOverrides: { "claude-opus-5-5": "o" },
	};
	const p = profileFromSettings(settings);
	assert.equal(p.name, "cpa.example.com");
	assert.equal(p.apiKey, "k");
	assert.equal(p.authToken, "");
	assert.equal(p.custom.id, "m");
	assert.equal(p.tiers.haiku.name, "H");
	assert.equal(activeProfileId(settings, [p]), p.id);
	assert.equal(activeProfileId({ env: { ANTHROPIC_BASE_URL: "other" } }, [p]), null);
});

test("同时设置了两种密钥时都保留", () => {
	const settings = { env: { ANTHROPIC_AUTH_TOKEN: "t", ANTHROPIC_API_KEY: "k" } };
	const p = profileFromSettings(settings);
	assert.equal(activeProfileId(settings, [p]), p.id);
	assert.deepEqual(patch({}, profileOps(p)), settings);
});

test("第一次打开：有自定义 API 时导入，没有时只有内置模板", () => {
	assert.equal(initialStore({ env: { ANTHROPIC_BASE_URL: "https://a.b" } }).profiles.length, 1);
	const store = initialStore({});
	assert.equal(store.profiles.length, 0);
	assert.equal(store.templates.length, builtinTemplates().length);
});

test("模板应用后能恢复原值，原来没有的键被删除", () => {
	const t = builtinTemplates()[0];
	let files = { settings: { env: { DISABLE_TELEMETRY: "0" } }, global: { hasCompletedOnboarding: false, numStartups: 3 } };
	assert.equal(templateStatus(t, files), "none");
	const applied = applyTemplate(t, files);
	files = { settings: patch(files.settings, applied.ops.settings), global: patch(files.global, applied.ops.global) };
	assert.equal(templateStatus(t, files), "applied");
	const { ops, skipped } = restoreTemplate({ ...t, snapshot: applied.snapshot }, files);
	assert.deepEqual(skipped, []);
	files = { settings: patch(files.settings, ops.settings), global: patch(files.global, ops.global) };
	assert.deepEqual(files, { settings: { env: { DISABLE_TELEMETRY: "0" } }, global: { hasCompletedOnboarding: false, numStartups: 3 } });
});

test("恢复时跳过应用后被改过的项", () => {
	const t = builtinTemplates()[1];
	let files = { settings: {}, global: {} };
	const applied = applyTemplate(t, files);
	files.settings = patch(patch(files.settings, applied.ops.settings), [{ path: ["env", "CLAUDE_CODE_ATTRIBUTION_HEADER"], value: "1" }]);
	assert.equal(templateStatus(t, files), "partial");
	const { ops, skipped, snapshot } = restoreTemplate({ ...t, snapshot: applied.snapshot }, files);
	assert.equal(skipped.length, 1);
	assert.deepEqual(snapshot.map((s) => s.path.at(-1)), ["CLAUDE_CODE_ATTRIBUTION_HEADER"]);
	assert.deepEqual(patch(files.settings, ops.settings), { env: { CLAUDE_CODE_ATTRIBUTION_HEADER: "1" } });
});

test("重复应用保留最早的快照", () => {
	const t = builtinTemplates()[2];
	const first = applyTemplate(t, { settings: { attribution: { commit: "x" } }, global: {} });
	const second = applyTemplate({ ...t, snapshot: first.snapshot }, { settings: { attribution: { commit: "", pr: "" } }, global: {} });
	assert.deepEqual(getPath({ s: second.snapshot[0] }, ["s", "value"]), "x");
});

test("API 配置接管的位置", () => {
	assert.ok(isProfilePath("settings", ["env", "ANTHROPIC_BASE_URL"]));
	assert.ok(isProfilePath("settings", ["modelOverrides", "x"]));
	assert.ok(!isProfilePath("settings", ["env", "HTTP_PROXY"]));
	assert.ok(!isProfilePath("global", ["modelOverrides"]));
});
