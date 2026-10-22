// 不依赖界面的逻辑：API 配置、模板和字段路径。浏览器和 node --test 共用。

export const TIERS = ["opus", "sonnet", "haiku", "fable"];

const tierPrefix = (tier) => `ANTHROPIC_DEFAULT_${tier.toUpperCase()}_MODEL`;
const MODEL_PARTS = { id: "", name: "_NAME", description: "_DESCRIPTION", capabilities: "_SUPPORTED_CAPABILITIES" };

/** API 配置接管的 env 变量：切换配置时先全部删除，再写入新配置的值。 */
export const PROFILE_ENV = [
	"ANTHROPIC_BASE_URL",
	"ANTHROPIC_AUTH_TOKEN",
	"ANTHROPIC_API_KEY",
	"ANTHROPIC_CUSTOM_HEADERS",
	"ANTHROPIC_MODEL",
	"CLAUDE_CODE_SUBAGENT_MODEL",
	...TIERS.flatMap((t) => Object.values(MODEL_PARTS).map((s) => tierPrefix(t) + s)),
	...Object.values(MODEL_PARTS).map((s) => "ANTHROPIC_CUSTOM_MODEL_OPTION" + s),
];

export const OFFICIAL_ID = "official";

export const emptyModel = () => ({ id: "", name: "", description: "", capabilities: "" });

export function newProfile(fields = {}) {
	return {
		id: fields.id ?? randomId(),
		name: "",
		baseUrl: "",
		authToken: "",
		apiKey: "",
		headers: "",
		model: "",
		subagentModel: "",
		tiers: Object.fromEntries(TIERS.map((t) => [t, emptyModel()])),
		custom: emptyModel(),
		overrides: {},
		...fields,
	};
}

export function randomId() {
	return Math.random().toString(36).slice(2, 10);
}

/** 配置对应的 env 值，只含非空项。 */
export function profileEnv(p) {
	const env = {};
	const put = (k, v) => {
		if (typeof v === "string" && v.trim() !== "") env[k] = v.trim();
	};
	put("ANTHROPIC_BASE_URL", p.baseUrl);
	put("ANTHROPIC_AUTH_TOKEN", p.authToken);
	put("ANTHROPIC_API_KEY", p.apiKey);
	put("ANTHROPIC_CUSTOM_HEADERS", p.headers);
	put("ANTHROPIC_MODEL", p.model);
	put("CLAUDE_CODE_SUBAGENT_MODEL", p.subagentModel);
	for (const t of TIERS) {
		for (const [part, suffix] of Object.entries(MODEL_PARTS)) put(tierPrefix(t) + suffix, p.tiers?.[t]?.[part]);
	}
	for (const [part, suffix] of Object.entries(MODEL_PARTS)) put("ANTHROPIC_CUSTOM_MODEL_OPTION" + suffix, p.custom?.[part]);
	return env;
}

function cleanOverrides(overrides) {
	return Object.fromEntries(
		Object.entries(overrides ?? {})
			.map(([k, v]) => [k.trim(), String(v).trim()])
			.filter(([k, v]) => k && v),
	);
}

/** 切换到这个配置时对 settings.json 的修改。官方登录（空配置）会删除全部接管的键。 */
export function profileOps(p) {
	const env = profileEnv(p);
	const ops = PROFILE_ENV.map((k) => (k in env ? { path: ["env", k], value: env[k] } : { path: ["env", k] }));
	const overrides = cleanOverrides(p.overrides);
	ops.push(Object.keys(overrides).length ? { path: ["modelOverrides"], value: overrides } : { path: ["modelOverrides"] });
	return ops;
}

/** 从 settings.json 现有内容生成配置，用于导入和"存为新配置"。 */
export function profileFromSettings(settings, fields = {}) {
	const env = isObject(settings?.env) ? settings.env : {};
	const s = (k) => (typeof env[k] === "string" ? env[k] : env[k] == null ? "" : String(env[k]));
	const model = (prefix) => Object.fromEntries(Object.entries(MODEL_PARTS).map(([part, suffix]) => [part, s(prefix + suffix)]));
	return newProfile({
		name: hostName(s("ANTHROPIC_BASE_URL")) || "当前配置",
		baseUrl: s("ANTHROPIC_BASE_URL"),
		authToken: s("ANTHROPIC_AUTH_TOKEN"),
		apiKey: s("ANTHROPIC_API_KEY"),
		headers: s("ANTHROPIC_CUSTOM_HEADERS"),
		model: s("ANTHROPIC_MODEL"),
		subagentModel: s("CLAUDE_CODE_SUBAGENT_MODEL"),
		tiers: Object.fromEntries(TIERS.map((t) => [t, model(tierPrefix(t))])),
		custom: model("ANTHROPIC_CUSTOM_MODEL_OPTION"),
		overrides: isObject(settings?.modelOverrides) ? { ...settings.modelOverrides } : {},
		...fields,
	});
}

export function hostName(url) {
	try {
		return new URL(url).hostname;
	} catch {
		return "";
	}
}

/** settings.json 里和 API 配置有关的部分，用来判断当前用的是哪个配置。 */
function currentProfileState(settings) {
	const env = isObject(settings?.env) ? settings.env : {};
	const state = {};
	for (const k of PROFILE_ENV) if (env[k] != null && String(env[k]).trim() !== "") state[k] = String(env[k]).trim();
	return { env: state, overrides: cleanOverrides(isObject(settings?.modelOverrides) ? settings.modelOverrides : {}) };
}

export function matchesProfile(settings, p) {
	const cur = currentProfileState(settings);
	return deepEqual(cur.env, profileEnv(p)) && deepEqual(cur.overrides, cleanOverrides(p.overrides));
}

/** 当前生效的配置 id；什么都没设是官方登录；和所有配置都对不上时返回 null。 */
export function activeProfileId(settings, profiles) {
	if (matchesProfile(settings, newProfile({ id: OFFICIAL_ID }))) return OFFICIAL_ID;
	return profiles.find((p) => matchesProfile(settings, p))?.id ?? null;
}

// ---------- 路径 ----------

export function isObject(v) {
	return v !== null && typeof v === "object" && !Array.isArray(v);
}

export function getPath(obj, path) {
	let cur = obj;
	for (const k of path) {
		if (!isObject(cur) || !(k in cur)) return undefined;
		cur = cur[k];
	}
	return cur;
}

export function deepEqual(a, b) {
	if (a === b) return true;
	if (typeof a !== typeof b || a === null || b === null || typeof a !== "object") return false;
	if (Array.isArray(a) !== Array.isArray(b)) return false;
	const ka = Object.keys(a);
	const kb = Object.keys(b);
	return ka.length === kb.length && ka.every((k) => Object.hasOwn(b, k) && deepEqual(a[k], b[k]));
}

/** 这个位置归 API 配置管，模板和设置页不能改。 */
export function isProfilePath(file, path) {
	if (file !== "settings") return false;
	if (path[0] === "modelOverrides") return true;
	return path[0] === "env" && (path.length === 1 || PROFILE_ENV.includes(path[1]));
}

// ---------- 模板 ----------

const sameItem = (a, b) => a.file === b.file && deepEqual(a.path, b.path);

/** files：{ settings, global } 两个文件当前的内容。 */
export function templateStatus(t, files) {
	if (!t.items.length) return "none";
	const hit = t.items.filter((i) => deepEqual(getPath(files[i.file], i.path), i.value)).length;
	return hit === t.items.length ? "applied" : hit ? "partial" : "none";
}

/** 应用模板：记下每项原来的值（已经记过的保留最早那份），返回要写的修改和新的快照。 */
export function applyTemplate(t, files) {
	const snapshot = [...(t.snapshot ?? [])];
	const ops = { settings: [], global: [] };
	for (const item of t.items) {
		if (!snapshot.some((s) => sameItem(s, item))) {
			const cur = getPath(files[item.file], item.path);
			snapshot.push({ file: item.file, path: item.path, exists: cur !== undefined, value: cur ?? null });
		}
		ops[item.file].push({ path: item.path, value: item.value });
	}
	return { ops, snapshot };
}

/**
 * 恢复模板：只恢复仍是模板值的项，应用后被改过的项跳过。
 * 返回的 snapshot 只保留跳过的项的记录，以后重新应用再恢复时还能找回原值。
 */
export function restoreTemplate(t, files) {
	const ops = { settings: [], global: [] };
	const skipped = [];
	const snapshot = [];
	for (const item of t.items) {
		const snap = (t.snapshot ?? []).find((s) => sameItem(s, item));
		if (!snap) continue;
		if (!deepEqual(getPath(files[item.file], item.path), item.value)) {
			skipped.push(item);
			snapshot.push(snap);
			continue;
		}
		ops[item.file].push(snap.exists ? { path: item.path, value: snap.value } : { path: item.path });
	}
	return { ops, skipped, snapshot };
}

export function builtinTemplates() {
	const env = (k, v) => ({ file: "settings", path: ["env", k], value: v });
	return [
		{
			id: "quiet",
			name: "静默",
			desc: "跳过首次启动引导，关闭遥测、错误上报和反馈调查。",
			items: [
				{ file: "global", path: ["hasCompletedOnboarding"], value: true },
				env("DISABLE_TELEMETRY", "1"),
				env("DISABLE_ERROR_REPORTING", "1"),
				env("CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY", "1"),
			],
		},
		{
			id: "third-party",
			name: "第三方 API",
			desc: "关闭非必要网络请求，不发送 attribution header。适合中转站和自建服务。",
			items: [env("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "1"), env("CLAUDE_CODE_ATTRIBUTION_HEADER", "0")],
		},
		{
			id: "no-attribution",
			name: "不署名",
			desc: "提交和 PR 里不加 Claude 的署名。",
			items: [
				{ file: "settings", path: ["attribution", "commit"], value: "" },
				{ file: "settings", path: ["attribution", "pr"], value: "" },
			],
		},
	];
}

/** 第一次打开时的 vanity.json：内置模板，加上从 settings.json 导入的当前 API 配置。 */
export function initialStore(settings) {
	const profiles = [];
	if (activeProfileId(settings, []) !== OFFICIAL_ID) profiles.push(profileFromSettings(settings));
	return { version: 1, profiles, templates: builtinTemplates() };
}
