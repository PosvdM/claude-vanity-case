import * as L from "./logic.js";

const { invoke } = window.__TAURI__.core;

// ---------- 状态 ----------

const S = {
	page: "api",
	data: null,
	files: { settings: {}, global: {} },
	errors: { settings: null, global: null },
	store: null,
	storeError: null,
	sel: null,
	draft: null,
	models: {},
	search: "",
	onlySet: false,
	open: new Set(),
	// 还没提交的输入：JSON 编辑框（按字段）和"添加变量"。重绘时用它们恢复，免得切回窗口或写入别的字段时丢掉。
	jsonDrafts: {},
	envAdd: { name: "", value: "" },
};

const PAGES = [
	{ id: "api", label: "API" },
	{ id: "templates", label: "模板" },
	{ id: "settings", label: "设置" },
	{ id: "env", label: "环境变量" },
];

const TIER_LABELS = { opus: "Opus", sonnet: "Sonnet", haiku: "Haiku", fable: "Fable" };
const FILE_LABELS = { settings: "settings.json", global: ".claude.json" };

// ---------- DOM 小工具 ----------

function h(tag, attrs, ...kids) {
	const el = document.createElement(tag);
	for (const [k, v] of Object.entries(attrs ?? {})) {
		if (v == null || v === false) continue;
		if (k.startsWith("on")) el.addEventListener(k.slice(2).toLowerCase(), v);
		else if (k === "class") el.className = v;
		else if (k === "value" || k === "checked" || k === "disabled" || k === "open") el[k] = v;
		else el.setAttribute(k, v === true ? "" : v);
	}
	for (const c of kids.flat(Infinity)) if (c != null && c !== false) el.append(c instanceof Node ? c : String(c));
	return el;
}

function toast(text, err = false) {
	const el = h("div", { class: err ? "toast err" : "toast" }, text);
	document.getElementById("toasts").append(el);
	setTimeout(() => el.remove(), err ? 6000 : 2200);
}

/** 弹窗。buttons: [{ label, value, class }]，返回被点按钮的 value，按 Esc 返回 undefined。 */
function dialog(title, body, buttons) {
	const dlg = document.getElementById("dialog");
	return new Promise((resolve) => {
		const done = (v) => {
			dlg.close();
			resolve(v);
		};
		const btns = buttons.map((b) => h("button", { class: `btn ${b.class ?? ""}`, onclick: async () => {
			if (b.check && !(await b.check())) return;
			done(b.value);
		} }, b.label));
		dlg.replaceChildren(h("div", { class: "dlg-head" }, title), h("div", { class: "dlg-body" }, body), h("div", { class: "dlg-foot" }, btns));
		dlg.onclose = () => resolve(undefined);
		dlg.showModal();
	});
}

const confirmDlg = (title, text, ok, danger = false) =>
	dialog(title, h("p", {}, text), [{ label: "取消", value: false }, { label: ok, value: true, class: danger ? "primary danger-fill" : "primary" }]);

function datalist(id, values) {
	return h("datalist", { id }, values.map((v) => h("option", { value: v })));
}

const pretty = (v) => JSON.stringify(v, null, 2);

// ---------- 文件读写 ----------

function globalKeys() {
	const keys = new Set(S.data.fields.filter((f) => f.file === "global").map((f) => f.key.split(".")[0]));
	for (const t of S.store?.templates ?? []) for (const i of t.items) if (i.file === "global") keys.add(i.path[0]);
	return [...keys];
}

async function loadFiles() {
	const s = await invoke("read_file", { target: "settings" });
	S.files.settings = L.isObject(s.value) ? s.value : {};
	S.errors.settings = s.error ?? (L.isObject(s.value) ? null : "顶层不是 JSON 对象");
	const g = await invoke("read_file", { target: "global", keys: globalKeys() });
	S.files.global = L.isObject(g.value) ? g.value : {};
	S.errors.global = g.error ?? null;
}

/** 修改文件后重新读取并重绘。ops 里没有 value 的项表示删除。 */
async function patch(file, ops, msg) {
	if (!ops.length) return true;
	const wire = ops.map((o) => ("value" in o && o.value !== undefined ? { path: o.path, value: o.value } : { path: o.path, delete: true }));
	let ok = true;
	try {
		await invoke("patch_file", { target: file, ops: wire });
		if (msg) toast(msg);
	} catch (e) {
		toast(`${FILE_LABELS[file]}：${e}`, true);
		ok = false;
	}
	await loadFiles();
	render();
	return ok;
}

async function saveStore() {
	if (S.storeError) {
		toast("vanity.json 读取失败，修好或删掉它之前不能保存", true);
		return false;
	}
	try {
		await invoke("write_store", { value: S.store });
		return true;
	} catch (e) {
		toast(`保存 vanity.json 失败：${e}`, true);
		return false;
	}
}

const valueAt = (file, path) => L.getPath(S.files[file], path);

// ---------- 通用控件 ----------

function clearBtn(onclick) {
	return h("button", { class: "btn small ghost", title: "删除这个键", onclick }, "清除");
}

/** 按字段类型生成控件。commit(undefined) 表示删除。 */
function control(f, val, commit) {
	const set = val !== undefined;
	const listId = f.suggestions ? `dl-${f.key ?? f.name}` : null;
	switch (f.type) {
		case "boolean": {
			const opts = [["未设置", undefined], ["开", true], ["关", false]];
			return h("div", { class: "ctl" },
				typeof val !== "boolean" && set ? h("span", { class: "raw" }, JSON.stringify(val)) : null,
				h("div", { class: "seg" }, opts.map(([label, v]) => h("button", { class: val === v ? "on" : "", onclick: () => val !== v && commit(v) }, label))));
		}
		case "flag": {
			const onVal = f.on ?? "1";
			// any：文档写明任何非空值都算开启的变量（如 DISABLE_TELEMETRY="0" 也是开）。
			const on = f.any ? set && val !== "" : val === onVal;
			return h("div", { class: "ctl" },
				set && val !== onVal ? h("span", { class: "raw", title: "当前值" }, JSON.stringify(val)) : null,
				h("button", { class: on ? "switch on" : "switch", title: on ? `写入 "${onVal}"` : "未设置", onclick: () => commit(on ? undefined : onVal) }));
		}
		case "enum": {
			const known = f.options.some((o) => L.deepEqual(o.value, val));
			const sel = h("select", { class: "input", onchange: (e) => commit(e.target.value === "" ? undefined : JSON.parse(e.target.value)) },
				h("option", { value: "" }, "未设置"),
				f.options.map((o) => h("option", { value: JSON.stringify(o.value) }, `${o.label} · ${o.value}`)),
				set && !known ? h("option", { value: JSON.stringify(val) }, `当前值 · ${JSON.stringify(val)}`) : null);
			sel.value = set ? JSON.stringify(val) : "";
			return h("div", { class: "ctl" }, sel);
		}
		case "string":
		case "integer":
		case "number": {
			const numeric = f.type !== "string";
			const orig = set ? (typeof val === "string" ? val : JSON.stringify(val)) : "";
			const input = h("input", {
				class: "input mono",
				value: orig,
				placeholder: f.placeholder ?? (numeric ? "数字" : ""),
				list: listId,
				spellcheck: "false",
				onchange: (e) => {
					const raw = e.target.value.trim();
					if (raw === "") return commit(undefined);
					if (!numeric) return commit(raw);
					// env 的数字项都是非负整数，按字符串写入。
					if (f.envValue) return /^\d+$/.test(raw) ? commit(raw) : bad(e.target, "请输入非负整数", orig);
					const n = Number(raw);
					if (!/^-?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(raw) || !Number.isFinite(n)) return bad(e.target, "请输入数字", orig);
					if (f.type === "integer" && !Number.isInteger(n)) return bad(e.target, "请输入整数", orig);
					if (f.min != null && n < f.min) return bad(e.target, `不能小于 ${f.min}`, orig);
					if (f.exclusiveMin != null && n <= f.exclusiveMin) return bad(e.target, `必须大于 ${f.exclusiveMin}`, orig);
					if (f.max != null && n > f.max) return bad(e.target, `不能大于 ${f.max}`, orig);
					commit(n);
				},
			});
			return h("div", { class: "ctl" }, input, listId ? datalist(listId, f.suggestions) : null);
		}
		case "stringArray": {
			const lines = Array.isArray(val) ? val.map(String) : [];
			const ta = h("textarea", {
				class: "input", rows: Math.min(Math.max(lines.length + 1, 2), 10), placeholder: "每行一项", spellcheck: "false",
				value: Array.isArray(val) ? lines.join("\n") : set ? JSON.stringify(val) : "",
				onchange: (e) => {
					const items = e.target.value.split("\n").map((s) => s.trim()).filter(Boolean);
					commit(items.length ? items : undefined);
				},
			});
			return h("div", { class: "ctl col" }, ta, set ? h("div", { class: "row" }, clearBtn(() => commit(undefined))) : null);
		}
		case "stringMap":
			return h("div", { class: "ctl col" }, kvEditor(L.isObject(val) ? val : {}, (obj) => commit(Object.keys(obj).length ? obj : undefined), { keyPh: "键", valPh: "值" }));
		default:
			return jsonEditor(f, val, commit);
	}
}

/** 输入无效：提示原因，并把输入框恢复成文件里的值，免得看起来像已保存。 */
function bad(input, msg, orig) {
	toast(msg, true);
	if (orig !== undefined) input.value = orig;
	else input.classList.add("bad");
}

function jsonEditor(f, val, commit) {
	const set = val !== undefined;
	const id = `${f.file ?? "settings"}:${f.key}`;
	const text = S.jsonDrafts[id] ?? (set ? pretty(val) : "");
	const ta = h("textarea", { class: "input", rows: Math.min(Math.max(text.split("\n").length + 1, 3), 16), spellcheck: "false", value: text, placeholder: f.example !== undefined ? `示例：${JSON.stringify(f.example)}` : "JSON",
		oninput: () => (S.jsonDrafts[id] = ta.value) });
	const save = () => {
		const raw = ta.value.trim();
		let v;
		if (raw !== "") {
			try {
				v = JSON.parse(raw);
			} catch (e) {
				return bad(ta, `JSON 有误：${e.message}`);
			}
		}
		delete S.jsonDrafts[id];
		commit(v);
	};
	ta.addEventListener("keydown", (e) => {
		if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) save();
	});
	return h("div", { class: "ctl col" }, ta, h("div", { class: "row" },
		f.example !== undefined && !set ? h("button", { class: "btn small ghost", onclick: () => (ta.value = pretty(f.example)) }, "填入示例") : null,
		set ? clearBtn(() => { delete S.jsonDrafts[id]; commit(undefined); }) : null,
		h("button", { class: "btn small", onclick: save }, "保存")));
}

/** 键值对编辑器：失焦时提交整个对象。 */
function kvEditor(obj, commit, { keyPh, valPh, keyList, valList } = {}) {
	const rows = Object.entries(obj).map(([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)]);
	const box = h("div", { class: "kv" });
	const collect = () => {
		const out = {};
		for (const row of box.querySelectorAll(".kv-row")) {
			const [k, v] = row.querySelectorAll("input");
			if (k.value.trim() && v.value.trim()) out[k.value.trim()] = v.value.trim();
		}
		return out;
	};
	const changed = () => {
		const next = collect();
		if (!L.deepEqual(next, Object.fromEntries(rows.filter(([k, v]) => k && v)))) commit(next);
	};
	const addRow = (k = "", v = "") =>
		h("div", { class: "kv-row" },
			h("input", { class: "input mono", value: k, placeholder: keyPh, list: keyList, spellcheck: "false", onchange: changed }),
			h("input", { class: "input mono", value: v, placeholder: valPh, list: valList, spellcheck: "false", onchange: changed }),
			h("button", { class: "btn small ghost", title: "删除这一行", onclick: (e) => { e.target.closest(".kv-row").remove(); changed(); } }, "×"));
	for (const [k, v] of rows) box.append(addRow(k, v));
	box.append(h("div", {}, h("button", { class: "btn small ghost", onclick: (e) => e.target.parentElement.before(addRow()) }, "+ 添加一行")));
	return box;
}

function docLink(anchor) {
	return anchor ? h("a", { onclick: () => invoke("open_doc", { anchor }).catch((e) => toast(String(e), true)) }, "文档") : null;
}

function fieldRow(f, val, commit, { depth = 0, extra } = {}) {
	const set = val !== undefined;
	const wide = f.type === "json" || f.type === "stringMap";
	return h("div", { class: `field${wide ? " wide" : ""}`, style: depth ? `padding-left:${16 + depth * 18}px` : null },
		h("div", {},
			h("div", { class: "name" }, set ? h("span", { class: "set", title: "已设置" }) : null, h("b", {}, f.label), h("code", {}, f.key ?? f.name)),
			h("p", { class: "desc" }, f.desc, f.default ? h("span", { class: "default" }, ` 默认：${f.default}。`) : " ", docLink(f.doc), extra)),
		control(f, val, commit));
}

function head(title, sub, ...right) {
	return h("div", { class: "head" }, h("div", { class: "info" }, h("h1", {}, title), sub ? h("p", {}, sub) : null), right);
}

function fileErrors(...files) {
	return files.filter((f) => S.errors[f]).map((f) =>
		h("div", { class: "banner err" }, h("span", { class: "grow" }, `${FILE_LABELS[f]} 读取失败：${S.errors[f]}。修好之前不能修改这个文件。`)));
}

// ---------- API 页 ----------

function selectProfile(id) {
	S.sel = id;
	const p = S.store.profiles.find((x) => x.id === id);
	S.draft = p ? structuredClone(p) : null;
}

async function leaveDraft() {
	if (!S.draft || S.draft._new === undefined && L.deepEqual(S.draft, S.store.profiles.find((p) => p.id === S.draft.id))) return true;
	return confirmDlg("放弃未保存的修改？", `「${S.draft.name || "未命名"}」有未保存的修改。`, "放弃");
}

function pageApi() {
	const profiles = S.store.profiles;
	const active = L.activeProfileId(S.files.settings, profiles);
	if (S.sel == null || (S.sel !== L.OFFICIAL_ID && !S.draft?._new && !profiles.some((p) => p.id === S.sel))) selectProfile(active ?? profiles[0]?.id ?? L.OFFICIAL_ID);

	const item = (id, title, host) =>
		h("button", { class: `pitem${S.sel === id ? " sel" : ""}`, onclick: async () => {
			if (S.sel === id || !(await leaveDraft())) return;
			selectProfile(id);
			render();
		} },
			h("span", { class: `dot${active === id ? " on" : ""}`, title: active === id ? "当前生效" : null }),
			h("div", { class: "meta" }, h("div", { class: "title" }, title), host ? h("div", { class: "host" }, host) : null));

	const list = h("div", { class: "plist" },
		item(L.OFFICIAL_ID, "官方登录", "claude.ai 账号"),
		h("div", { class: "sep" }),
		profiles.map((p) => item(p.id, p.name || "未命名", L.hostName(p.baseUrl) || p.baseUrl)),
		S.draft?._new ? item(S.draft.id, `${S.draft.name || "新配置"}（未保存）`, "") : null,
		h("div", { class: "sep" }),
		h("button", { class: "btn small ghost", style: "width:100%", onclick: async () => {
			if (!(await leaveDraft())) return;
			S.draft = L.newProfile({ name: "新配置", _new: true });
			S.sel = S.draft.id;
			render();
		} }, "+ 新建配置"));

	const banners = [...fileErrors("settings")];
	if (active === null && !S.errors.settings)
		banners.push(h("div", { class: "banner" },
			h("span", { class: "grow" }, "settings.json 里的 API 设置和已保存的配置都对不上。"),
			h("button", { class: "btn small", onclick: async () => {
				const p = L.profileFromSettings(S.files.settings);
				S.store.profiles.push(p);
				if (await saveStore()) toast(`已存为「${p.name}」`);
				selectProfile(p.id);
				render();
			} }, "存为新配置")));

	return [
		head("API", "切换配置时改写 settings.json 里 API 相关的 env 和 modelOverrides，其他内容不动。新开的 Claude Code 会话生效。"),
		banners,
		h("div", { class: "split" }, list, h("div", {}, S.sel === L.OFFICIAL_ID ? officialCard(active) : profileEditor(active))),
	];
}

function officialCard(active) {
	const env = L.isObject(S.files.settings.env) ? S.files.settings.env : {};
	const owned = L.PROFILE_ENV.filter((k) => env[k] != null);
	if (S.files.settings.modelOverrides !== undefined) owned.push("modelOverrides");
	return h("div", { class: "card" },
		h("h2", {}, "官方登录", active === L.OFFICIAL_ID ? h("span", { class: "pill on" }, "当前") : null),
		h("div", { class: "form", style: "grid-template-columns:1fr" },
			h("p", { style: "margin:0;color:var(--muted)" }, "用 Claude 账号或 Anthropic Console 登录（/login），不使用自定义 API。"),
			owned.length ? h("p", { style: "margin:0;color:var(--muted)" }, "切换时会删除：", owned.map((k) => h("code", { style: "margin-right:8px" }, k))) : null),
		h("div", { class: "actions" }, h("span", { class: "grow" }),
			h("button", { class: "btn primary", disabled: active === L.OFFICIAL_ID || !!S.errors.settings, onclick: () => patch("settings", L.profileOps(L.newProfile({ id: L.OFFICIAL_ID })), "已切换到官方登录") }, "切换到官方登录")));
}

function profileEditor(active) {
	const d = S.draft;
	if (!d) return null;
	const isActive = active === d.id;
	const models = S.models[d.id] ?? {};
	const dirtyPill = h("span", { class: "pill warn", hidden: !d._new && L.deepEqual(d, S.store.profiles.find((p) => p.id === d.id)) }, "未保存");
	const touch = () => (dirtyPill.hidden = !d._new && L.deepEqual(d, S.store.profiles.find((p) => p.id === d.id)));
	const bind = (obj, key, attrs = {}) =>
		h("input", { class: "input mono", value: obj[key] ?? "", spellcheck: "false", ...attrs, oninput: (e) => { obj[key] = e.target.value; touch(); } });
	const modelInput = (obj, key, ph) => bind(obj, key, { list: "dl-models", placeholder: ph });


	const tierRow = (label, m, ph) => {
		const hasMore = !!(m.name || m.description || m.capabilities);
		const more = h("div", { class: "more", hidden: !hasMore },
			bind(m, "name", { placeholder: "显示名称（_NAME）" }),
			bind(m, "description", { placeholder: "说明（_DESCRIPTION）" }),
			h("div", { class: "full" }, bind(m, "capabilities", { placeholder: "能力（_SUPPORTED_CAPABILITIES），逗号分隔，如 effort,thinking", list: "dl-caps" })));
		return h("div", { class: "tier" }, h("label", {}, label), modelInput(m, "id", ph),
			h("button", { class: "btn small ghost", onclick: (e) => { more.hidden = !more.hidden; e.target.textContent = more.hidden ? "更多" : "收起"; } }, hasMore ? "收起" : "更多"),
			more);
	};

	const fetchState = models.loading ? h("span", { class: "fetch-state" }, "获取中…")
		: models.error ? h("span", { class: "fetch-state err", title: models.error }, models.error.length > 60 ? models.error.slice(0, 60) + "…" : models.error)
		: models.ids ? h("span", { class: "fetch-state" }, `${models.ids.length} 个模型，输入框里可选`) : null;

	const caps = S.data.envProfile.find((e) => e.name.endsWith("_SUPPORTED_CAPABILITIES"))?.suggestions ?? [];

	return h("div", {},
		datalist("dl-models", models.ids ?? []),
		datalist("dl-caps", caps),
		h("div", { class: "card" },
			h("h2", {}, d.name || "未命名", isActive ? h("span", { class: "pill on" }, "当前") : null, dirtyPill),
			h("div", { class: "form" },
				h("label", {}, "名称"), h("input", { class: "input", value: d.name, oninput: (e) => { d.name = e.target.value; touch(); } }),
				h("label", {}, "服务地址"), bind(d, "baseUrl", { placeholder: "https://api.example.com" }),
				h("label", {}, "Auth Token"), bind(d, "authToken", { placeholder: "ANTHROPIC_AUTH_TOKEN" }),
				h("label", {}, "API Key"), bind(d, "apiKey", { placeholder: "ANTHROPIC_API_KEY" }),
				h("div", { class: "hint" }, "一般只填一个。Auth Token 以 Authorization: Bearer 发送，中转站多用这个；API Key 以 x-api-key 发送。"),
				h("label", { class: "top" }, "请求头"),
				h("textarea", { class: "input", rows: 2, placeholder: "每行一个，如 X-Title: claude", spellcheck: "false", value: d.headers, oninput: (e) => { d.headers = e.target.value; touch(); } }))),
		h("div", { class: "card" },
			h("h2", {}, "模型映射", h("span", { class: "sub" }, "留空的项不写入"), h("span", { class: "tail" }, fetchState,
				h("button", { class: "btn small", disabled: models.loading, onclick: () => fetchModels(d) }, "获取模型列表"))),
			h("div", { class: "tier single" }, h("label", {}, "默认模型"), modelInput(d, "model", "ANTHROPIC_MODEL，如 opus 或完整模型 ID")),
			h("div", { class: "tier single" }, h("label", {}, "subagent 模型"), modelInput(d, "subagentModel", "CLAUDE_CODE_SUBAGENT_MODEL")),
			L.TIERS.map((t) => tierRow(TIER_LABELS[t], d.tiers[t], `${TIER_LABELS[t]} 档对应的模型 ID`)),
			tierRow("自定义选项", d.custom, "ANTHROPIC_CUSTOM_MODEL_OPTION，在 /model 里多一个选项"),
			h("div", { class: "tier single" }, h("label", { style: "align-self:start;padding-top:6px" }, "按版本映射"),
				h("div", {}, kvEditor(d.overrides, (obj) => { d.overrides = obj; touch(); }, { keyPh: "Anthropic 模型 ID，如 claude-opus-5-5", valPh: "改用的模型 ID", valList: "dl-models" }),
					h("p", { class: "fetch-state", style: "margin:6px 0 0" }, "写入 modelOverrides：/model 里选中左边的模型时，实际请求右边的模型 ID。")))),
		h("div", { class: "card" }, h("div", { class: "actions", style: "border-top:0" },
			d._new ? null : h("button", { class: "btn danger", onclick: () => deleteProfile(d, isActive) }, "删除"),
			d._new ? null : h("button", { class: "btn", onclick: () => {
				const copy = { ...structuredClone(d), id: L.randomId(), name: `${d.name} 副本`, _new: true };
				S.draft = copy;
				S.sel = copy.id;
				render();
			} }, "复制"),
			h("span", { class: "grow" }),
			h("button", { class: "btn", onclick: () => saveProfile(false) }, isActive ? "保存并写入" : "保存"),
			isActive ? null : h("button", { class: "btn primary", disabled: !!S.errors.settings, onclick: () => saveProfile(true) }, "保存并切换"))));
}

/** 按 NO_PROXY 判断这个地址是否直连：逗号分隔的主机名或域名后缀，`*` 表示全部直连。 */
function bypassProxy(url, noProxy) {
	const host = L.hostName(url);
	if (!host || !noProxy) return false;
	return String(noProxy).split(",").map((s) => s.trim().toLowerCase().replace(/^\*?\./, "")).filter(Boolean)
		.some((e) => e === "*" || host === e || host.endsWith(`.${e}`));
}

async function fetchModels(d) {
	const env = L.isObject(S.files.settings.env) ? S.files.settings.env : {};
	S.models[d.id] = { loading: true };
	render();
	try {
		const proxy = bypassProxy(d.baseUrl, env.NO_PROXY ?? env.no_proxy) ? "" : env.HTTPS_PROXY || env.HTTP_PROXY || "";
		const ids = await invoke("fetch_models", { req: { baseUrl: d.baseUrl, authToken: d.authToken, apiKey: d.apiKey, headers: d.headers, proxy } });
		S.models[d.id] = { ids };
	} catch (e) {
		S.models[d.id] = { error: String(e) };
	}
	render();
}

async function saveProfile(apply) {
	const d = structuredClone(S.draft);
	delete d._new;
	d.name = d.name.trim() || L.hostName(d.baseUrl) || "未命名";
	const list = S.store.profiles;
	const idx = list.findIndex((p) => p.id === d.id);
	const wasActive = idx >= 0 && L.matchesProfile(S.files.settings, list[idx]);
	if (idx >= 0) list[idx] = d;
	else list.push(d);
	S.draft = structuredClone(d);
	if (!(await saveStore())) return;
	if (apply || wasActive) await patch("settings", L.profileOps(d), apply ? `已切换到「${d.name}」` : "已保存并写入 settings.json");
	else {
		toast("已保存");
		render();
	}
}

async function deleteProfile(d, isActive) {
	const note = isActive ? "它是当前生效的配置，settings.json 里的值会保留。" : "";
	if (!(await confirmDlg("删除配置？", `删除「${d.name}」。${note}`, "删除", true))) return;
	S.store.profiles = S.store.profiles.filter((p) => p.id !== d.id);
	S.sel = null;
	S.draft = null;
	if (await saveStore()) toast("已删除");
	render();
}

// ---------- 模板页 ----------

const STATUS = { applied: ["已应用", "on"], partial: ["部分生效", "warn"], none: ["未应用", ""] };

function pageTemplates() {
	const ts = S.store.templates;
	return [
		head("模板", "一组字段和值，一键写入；应用前的值会记下来，可以一键恢复。",
			h("button", { class: "btn", onclick: () => editTemplate(null) }, "+ 新建模板")),
		fileErrors("settings", "global"),
		ts.length ? ts.map(templateCard) : h("div", { class: "card empty" }, "还没有模板"),
	];
}

function templateCard(t) {
	const [label, cls] = STATUS[L.templateStatus(t, S.files)];
	const canRestore = !!t.snapshot?.length;
	return h("div", { class: "card tpl" },
		h("h2", {}, t.name, h("span", { class: `pill ${cls}` }, label), h("span", { class: "tail" },
			h("button", { class: "btn small ghost", onclick: () => editTemplate(t) }, "编辑"),
			h("button", { class: "btn small ghost danger", onclick: () => deleteTemplate(t) }, "删除"),
			h("button", { class: "btn small", disabled: !canRestore, title: canRestore ? "写回应用前的值" : "没有应用前的记录", onclick: () => restoreTemplate(t) }, "恢复"),
			h("button", { class: "btn small primary", disabled: label === "已应用", onclick: () => applyTemplate(t) }, "应用"))),
		t.desc ? h("p", { class: "desc" }, t.desc) : null,
		h("ul", { class: "items" }, t.items.map((i) => {
			const hit = L.deepEqual(valueAt(i.file, i.path), i.value);
			return h("li", {}, h("span", { class: hit ? "hit" : "" }, hit ? "✓" : "·"), h("span", { class: "file" }, FILE_LABELS[i.file]), `${i.path.join(".")} = ${JSON.stringify(i.value)}`);
		})));
}

async function applyTemplate(t) {
	await loadFiles();
	const { ops, snapshot } = L.applyTemplate(t, S.files);
	t.snapshot = snapshot;
	if (!(await saveStore())) return;
	const ok = (await patch("settings", ops.settings)) & (await patch("global", ops.global));
	if (ok) toast(`已应用「${t.name}」`);
}

async function restoreTemplate(t) {
	await loadFiles();
	const { ops, skipped, snapshot } = L.restoreTemplate(t, S.files);
	const ok = (await patch("settings", ops.settings)) & (await patch("global", ops.global));
	if (!ok) return;
	t.snapshot = snapshot.length ? snapshot : null;
	await saveStore();
	render();
	if (skipped.length) toast(`已恢复「${t.name}」，跳过应用后改动过的：${skipped.map((i) => i.path.join(".")).join("、")}`);
	else toast(`已恢复「${t.name}」`);
}

async function deleteTemplate(t) {
	if (!(await confirmDlg("删除模板？", `删除「${t.name}」。已写入文件的值不会变，应用前的记录会丢失。`, "删除", true))) return;
	S.store.templates = S.store.templates.filter((x) => x !== t);
	if (await saveStore()) toast("已删除");
	render();
}

function pathSuggestions(file) {
	const keys = S.data.fields.filter((f) => f.file === file && f.type !== "object" && !L.isProfilePath(file, f.key.split("."))).map((f) => f.key);
	if (file === "settings") keys.push(...S.data.envAll.filter((e) => !L.PROFILE_ENV.includes(e.name)).map((e) => `env.${e.name}`));
	return keys;
}

async function editTemplate(t) {
	const items = t ? t.items.map((i) => ({ ...i })) : [{ file: "settings", path: [], value: "" }];
	const name = h("input", { class: "input", value: t?.name ?? "", placeholder: "名称" });
	const desc = h("input", { class: "input", value: t?.desc ?? "", placeholder: "说明（可选）" });
	const rowsBox = h("div", { style: "display:flex;flex-direction:column;gap:6px" });
	const defaultFor = (file, path) => {
		const f = S.data.fields.find((x) => x.file === file && x.key === path);
		if (!f) return path.startsWith("env.") ? '"1"' : "";
		return f.type === "boolean" ? "true" : f.type === "stringArray" ? "[]" : f.example !== undefined ? JSON.stringify(f.example) : "";
	};
	const row = (it) => {
		const fileSel = h("select", { class: "input" }, Object.entries(FILE_LABELS).map(([v, l]) => h("option", { value: v }, l)));
		fileSel.value = it.file;
		const path = h("input", { class: "input mono", value: it.path.join("."), placeholder: "键，如 env.DISABLE_TELEMETRY", list: `dl-tpl-${it.file}`, spellcheck: "false" });
		const value = h("input", { class: "input mono", value: it.path.length ? JSON.stringify(it.value) : "", placeholder: 'JSON 值，如 true 或 "1"', spellcheck: "false" });
		fileSel.onchange = () => path.setAttribute("list", `dl-tpl-${fileSel.value}`);
		path.onchange = () => { if (!value.value.trim()) value.value = defaultFor(fileSel.value, path.value.trim()); };
		return h("div", { class: "item-row" }, fileSel, path, value,
			h("button", { class: "btn small ghost", title: "填入文件里的当前值", onclick: async () => {
				const p = path.value.trim().split(".");
				const read = await invoke("read_file", { target: fileSel.value, keys: [p[0]] });
				const cur = L.getPath(read.value, p);
				if (cur === undefined) toast("文件里没有这个键", true);
				else value.value = JSON.stringify(cur);
			} }, "当前值"),
			h("button", { class: "btn small ghost", onclick: (e) => e.target.closest(".item-row").remove() }, "×"));
	};
	for (const it of items) rowsBox.append(row(it));
	let parsed = [];
	const check = () => {
		if (!name.value.trim()) return toast("请填写名称", true), false;
		parsed = [];
		for (const r of rowsBox.querySelectorAll(".item-row")) {
			const [fileSel, path, value] = r.querySelectorAll("select, input");
			const p = path.value.trim().split(".").filter(Boolean);
			if (!p.length && !value.value.trim()) continue;
			if (!p.length) return toast("有一项没填键", true), false;
			if (L.isProfilePath(fileSel.value, p)) return toast(`${p.join(".")} 由 API 配置管理，不能放进模板`, true), false;
			let v;
			try {
				v = JSON.parse(value.value);
			} catch {
				return toast(`${p.join(".")} 的值不是合法 JSON；字符串要加引号`, true), false;
			}
			if (fileSel.value === "settings" && p[0] === "env" && typeof v !== "string") return toast(`${p.join(".")} 是环境变量，值要写成字符串，如 "1"`, true), false;
			parsed.push({ file: fileSel.value, path: p, value: v });
		}
		if (!parsed.length) return toast("至少要有一项", true), false;
		return true;
	};
	const body = h("div", { style: "display:flex;flex-direction:column;gap:10px" },
		datalist("dl-tpl-settings", pathSuggestions("settings")),
		datalist("dl-tpl-global", pathSuggestions("global")),
		name, desc,
		h("div", { class: "item-row", style: "color:var(--faint);font-size:12px" }, h("span", {}, "文件"), h("span", {}, "键"), h("span", {}, "值（JSON）")),
		rowsBox,
		h("div", {}, h("button", { class: "btn small ghost", onclick: () => rowsBox.append(row({ file: "settings", path: [], value: "" })) }, "+ 添加一项")));
	const ok = await dialog(t ? "编辑模板" : "新建模板", body, [{ label: "取消", value: false }, { label: "保存", value: true, class: "primary", check }]);
	if (!ok) return;
	const next = { id: t?.id ?? L.randomId(), name: name.value.trim(), desc: desc.value.trim(), items: parsed };
	if (t?.snapshot) next.snapshot = t.snapshot.filter((s) => parsed.some((i) => i.file === s.file && L.deepEqual(i.path, s.path)));
	if (t) S.store.templates[S.store.templates.indexOf(t)] = next;
	else S.store.templates.push(next);
	if (await saveStore()) toast("已保存");
	// 模板可能用到 ~/.claude.json 里之前没读的键。
	await loadFiles();
	render();
}

// ---------- 设置页 ----------

const HIDDEN_KEYS = new Set(["env", "modelOverrides"]);

function settingsFields() {
	return S.data.fields.filter((f) => !HIDDEN_KEYS.has(f.key));
}

function pageSettings() {
	const fields = settingsFields();
	const q = S.search.trim().toLowerCase();
	const isSet = (f) => valueAt(f.file, f.key.split(".")) !== undefined;
	const match = (f) => !q || [f.key, f.label, f.desc].some((s) => s?.toLowerCase().includes(q));
	// 父对象被写成了非对象（如 "attribution": false）时，子键没法单独写，只显示父项的 JSON 编辑框。
	const blocked = (f) => {
		const path = f.key.split(".");
		return path.slice(0, -1).some((_, i) => {
			const v = valueAt(f.file, path.slice(0, i + 1));
			return v !== undefined && !L.isObject(v);
		});
	};
	const visible = (f) => {
		if (blocked(f)) return false;
		if (f.type === "object") return fields.some((c) => c.key.startsWith(f.key + ".") && visible(c)) || (isSet(f) && !L.isObject(valueAt(f.file, f.key.split("."))));
		if (f.removed && !isSet(f)) return false;
		return match(f) && (!S.onlySet || isSet(f));
	};
	const setCount = fields.filter((f) => f.type !== "object" && isSet(f)).length;

	const sections = S.data.topics.map((topic) => {
		const list = fields.filter((f) => f.topic === topic && visible(f));
		if (!list.length) return null;
		const n = list.filter((f) => f.type !== "object" && isSet(f)).length;
		const det = h("details", { class: "card", open: !!q || S.onlySet || S.open.has(topic) },
			h("summary", {}, topic, h("span", { class: "sub" }, n ? `已设置 ${n}` : ""), h("span", { class: "tail sub" }, `${list.filter((f) => f.type !== "object").length} 项`)),
			list.map((f) => settingRow(f)));
		det.addEventListener("toggle", () => (det.open ? S.open.add(topic) : S.open.delete(topic)));
		return det;
	});

	const known = new Set(["$schema", ...S.data.fields.filter((f) => f.file === "settings").map((f) => f.key.split(".")[0])]);
	const unknown = Object.keys(S.files.settings).filter((k) => !known.has(k));

	// 输入法组字期间不重绘，否则会打断组字。
	const onSearch = (e) => {
		if (e.isComposing) return;
		S.search = e.target.value;
		renderKeepFocus(e.target);
	};
	const search = h("input", { class: "input", placeholder: "搜索键名或说明", value: S.search, oninput: onSearch, oncompositionend: onSearch });
	return [
		head("设置", "修改立即写入文件。环境变量在「环境变量」页，API 地址、密钥和模型映射在「API」页。"),
		fileErrors("settings", "global"),
		h("div", { class: "toolbar" }, search,
			h("label", {}, h("input", { type: "checkbox", checked: S.onlySet, onchange: (e) => { S.onlySet = e.target.checked; render(); } }), "只看已设置"),
			h("span", { class: "stat" }, `已设置 ${setCount} / ${fields.filter((f) => f.type !== "object").length}`)),
		sections.some(Boolean) ? sections : h("div", { class: "card empty" }, "没有匹配的设置"),
		unknown.length ? h("div", { class: "card" }, h("h2", {}, "其他字段", h("span", { class: "sub" }, "settings.json 里有，但官方文档没有收录")),
			unknown.map((k) => fieldRow({ key: k, label: k, type: "json", desc: "按 JSON 编辑，或清除。" }, S.files.settings[k], (v) => commitPath("settings", [k], v)))) : null,
	];
}

function settingRow(f) {
	const path = f.key.split(".");
	const depth = path.length - 1;
	const val = valueAt(f.file, path);
	if (f.type === "object") {
		const nonObject = val !== undefined && !L.isObject(val);
		if (nonObject) return fieldRow({ ...f, type: "json" }, val, (v) => commitPath(f.file, path, v), { depth });
		return h("div", { class: "field wide group-head", style: depth ? `padding-left:${16 + depth * 18}px` : null },
			h("div", {}, h("div", { class: "name" }, h("b", {}, f.label), h("code", {}, f.key)), h("p", { class: "desc" }, f.desc, " ", docLink(f.doc))));
	}
	const extra = f.file === "global" ? h("span", { class: "default" }, " 写在 ~/.claude.json。") : null;
	return fieldRow(f, val, (v) => commitPath(f.file, path, v), { depth, extra });
}

function commitPath(file, path, v) {
	return patch(file, [v === undefined ? { path } : { path, value: v }], v === undefined ? `已删除 ${path.join(".")}` : `已写入 ${path.join(".")}`);
}

function renderKeepFocus(input) {
	const pos = input.selectionStart;
	render();
	const next = document.querySelector(".toolbar .input");
	next?.focus();
	next?.setSelectionRange(pos, pos);
}

// ---------- 环境变量页 ----------

function pageEnv() {
	const env = L.isObject(S.files.settings.env) ? S.files.settings.env : {};
	const common = S.data.envCommon;
	const groups = [...new Set(common.map((e) => e.group))];
	const commonNames = new Set(common.map((e) => e.name));
	const others = Object.keys(env).filter((k) => !commonNames.has(k) && !L.PROFILE_ENV.includes(k));
	const docOf = (name) => S.data.envAll.find((e) => e.name === name)?.desc ?? "官方文档未收录的变量。";
	const commitEnv = (name, v) => commitPath("settings", ["env", name], v);
	const asField = (e) => ({ ...e, key: e.name, envValue: true, type: e.type === "number" ? "integer" : e.type });

	const nameIn = h("input", { class: "input mono", placeholder: "变量名", list: "dl-env-all", spellcheck: "false", value: S.envAdd.name });
	const valIn = h("input", { class: "input mono", placeholder: "值", spellcheck: "false", value: S.envAdd.value, oninput: () => (S.envAdd.value = valIn.value) });
	const hint = h("p", { class: "desc", style: "margin:6px 0 0" });
	const showHint = () => {
		const n = nameIn.value.trim();
		hint.textContent = !n ? "" : L.PROFILE_ENV.includes(n) ? "这个变量由 API 配置管理，请到「API」页修改。" : docOf(n);
	};
	nameIn.oninput = () => {
		S.envAdd.name = nameIn.value;
		showHint();
	};
	showHint();
	const add = async () => {
		const n = nameIn.value.trim();
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(n)) return toast("变量名只能包含字母、数字和下划线", true);
		if (L.PROFILE_ENV.includes(n)) return toast("这个变量由 API 配置管理，请到「API」页修改", true);
		const value = valIn.value;
		S.envAdd = { name: "", value: "" };
		if (!(await commitEnv(n, value))) S.envAdd = { name: n, value };
	};

	return [
		head("环境变量", "settings.json 的 env。值都按字符串写入；关掉开关或清空输入框会删除这个变量。"),
		fileErrors("settings"),
		h("div", { class: "banner info" }, h("span", { class: "grow" }, "API 地址、密钥和模型相关的变量由「API」页管理，这里不显示。")),
		groups.map((g) => h("div", { class: "card" }, h("h2", {}, g),
			common.filter((e) => e.group === g).map((e) => fieldRow(asField(e), env[e.name], (v) => commitEnv(e.name, v))))),
		h("div", { class: "card" }, h("h2", {}, "其他变量", h("span", { class: "sub" }, others.length ? `${others.length} 个` : "")),
			others.map((k) => fieldRow({ name: k, key: k, label: k, type: "string", envValue: true, desc: docOf(k) }, env[k], (v) => commitEnv(k, v))),
			h("div", { class: "field" },
				h("div", {}, h("div", { class: "name" }, h("b", {}, "添加变量")), hint),
				h("div", { class: "ctl col" }, nameIn, valIn, h("div", { class: "row" }, h("button", { class: "btn small primary", onclick: add }, "添加")))),
			datalist("dl-env-all", S.data.envAll.filter((e) => !L.PROFILE_ENV.includes(e.name) && !(e.name in env)).map((e) => e.name))),
	];
}

// ---------- 渲染 ----------

function render() {
	const env = L.isObject(S.files.settings.env) ? S.files.settings.env : {};
	const counts = {
		api: S.store.profiles.length || "",
		templates: S.store.templates.length || "",
		settings: settingsFields().filter((f) => f.type !== "object" && valueAt(f.file, f.key.split(".")) !== undefined).length || "",
		env: Object.keys(env).filter((k) => !L.PROFILE_ENV.includes(k)).length || "",
	};
	document.getElementById("nav").replaceChildren(...PAGES.map((p) =>
		h("button", { class: `nav-item${S.page === p.id ? " active" : ""}`, onclick: async () => {
			if (S.page === p.id) return;
			if (S.page === "api" && !(await leaveDraft())) return;
			if (S.page === "api") S.draft = null, S.sel = null;
			S.page = p.id;
			render();
			document.querySelector("main").scrollTop = 0;
		} }, p.label, h("span", { class: "count" }, counts[p.id]))));
	const page = { api: pageApi, templates: pageTemplates, settings: pageSettings, env: pageEnv }[S.page]();
	const main = document.querySelector("main");
	const scroll = main.scrollTop;
	document.getElementById("page").replaceChildren(...[page].flat(Infinity).filter(Boolean));
	main.scrollTop = scroll;
	if (S.storeError)
		document.getElementById("page").prepend(h("div", { class: "banner err" }, `vanity.json 读取失败：${S.storeError}。API 配置和模板的修改不会保存。`));
}

// ---------- 启动 ----------

async function init() {
	const load = (f) => fetch(`data/${f}.json`).then((r) => r.json());
	const [fields, envCommon, envProfile, envAll] = await Promise.all(["fields", "env-common", "env-profile", "env-all"].map(load));
	S.data = { ...fields, envCommon, envProfile, envAll };

	const st = await invoke("read_file", { target: "store" });
	await loadFiles();
	if (st.error) {
		S.storeError = st.error;
		S.store = { version: 1, profiles: [], templates: [] };
	} else if (!st.exists) {
		S.store = L.initialStore(S.files.settings);
		await saveStore();
	} else {
		S.store = { version: 1, profiles: [], templates: [], ...st.value };
		await loadFiles();
	}
	render();

	for (const b of document.querySelectorAll("[data-reveal]")) b.onclick = () => invoke("reveal", { target: b.dataset.reveal }).catch((e) => toast(String(e), true));
	window.__TAURI__.app.getVersion().then((v) => (document.getElementById("version").textContent = `v${v}`));
	// 切回窗口时重新读文件，拿到在别处做的修改。
	window.addEventListener("focus", async () => {
		const before = JSON.stringify([S.files, S.errors]);
		await loadFiles();
		// 文件没变就不重绘，保留正在编辑的输入。
		if (JSON.stringify([S.files, S.errors]) !== before && !document.getElementById("dialog").open) render();
	});
}

init().catch((e) => {
	document.getElementById("page").replaceChildren(h("div", { class: "banner err" }, `启动失败：${e}`));
});
