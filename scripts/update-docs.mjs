#!/usr/bin/env node
// 发版前运行：拉取最新的官方文档，重新生成 ui/data/env-all.json，
// 并列出 ui/data/fields.json 需要补充或删除的设置键。
//
// 用法：node scripts/update-docs.mjs [--offline]
//   --offline  不联网，直接用 docs-src/ 里已有的文档

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const at = (p) => resolve(root, p);
const DOCS = {
	"docs-src/settings-reference.md": "https://code.claude.com/docs/en/settings-reference.md",
	"docs-src/env-vars.md": "https://code.claude.com/docs/en/env-vars.md",
};

/** 拆分表格行，处理转义的 `\|`。 */
function splitRow(line) {
	const cells = [];
	let cur = "";
	for (let i = 0; i < line.length; i++) {
		if (line[i] === "\\" && line[i + 1] === "|") {
			cur += "|";
			i++;
		} else if (line[i] === "|") {
			cells.push(cur);
			cur = "";
		} else cur += line[i];
	}
	cells.push(cur);
	return cells.slice(1, -1).map((c) => c.trim());
}

/** 去掉 markdown 链接和粗体，只留文字。 */
function plain(text) {
	return text
		.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/\*\*([^*]+)\*\*/g, "$1")
		.replace(/\s+/g, " ")
		.trim();
}

/** 读出文档里所有表头为 `firstHeader` 的表格的行。 */
function tables(md, firstHeader) {
	const rows = [];
	let inside = false;
	const lines = md.split(/\r?\n/);
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i].trim();
		if (!line.startsWith("|")) {
			inside = false;
			continue;
		}
		const cells = splitRow(line);
		if (!inside) {
			if (cells[0] === firstHeader && /^\|[\s:|-]+\|$/.test((lines[i + 1] ?? "").trim())) {
				inside = true;
				i++;
			}
			continue;
		}
		rows.push(cells);
	}
	return rows;
}

const firstCode = (cell) => /`([^`]+)`/.exec(cell)?.[1];

if (!process.argv.includes("--offline")) {
	for (const [file, url] of Object.entries(DOCS)) {
		const res = await fetch(url);
		if (!res.ok) throw new Error(`${url}：${res.status}`);
		writeFileSync(at(file), await res.text());
		console.log(`已下载 ${url}`);
	}
}

// 环境变量：全部重新生成。
const envs = new Map();
for (const cells of tables(readFileSync(at("docs-src/env-vars.md"), "utf8"), "Variable")) {
	const name = /^`([A-Za-z_][A-Za-z0-9_]*)`$/.exec(cells[0] ?? "")?.[1];
	if (name && !envs.has(name)) envs.set(name, { name, desc: plain(cells.slice(1).join(" | ")) });
}
const envAll = [...envs.values()].sort((a, b) => (a.name < b.name ? -1 : 1));
writeFileSync(at("ui/data/env-all.json"), JSON.stringify(envAll, null, 2) + "\n");
console.log(`env-all.json：${envAll.length} 个变量`);

for (const file of ["ui/data/env-common.json", "ui/data/env-profile.json"]) {
	const gone = JSON.parse(readFileSync(at(file), "utf8")).filter((e) => !envs.has(e.name));
	if (gone.length) console.log(`${file} 里这些变量已不在文档中：${gone.map((e) => e.name).join("、")}`);
}

// 设置键：只报告差异，翻译和类型要人工补。
const index = tables(readFileSync(at("docs-src/settings-reference.md"), "utf8"), "Key")
	.map((cells) => ({ key: firstCode(cells[0]), removed: /^Removed in/.test(cells[1] ?? ""), topic: cells[2], scope: cells[3] }))
	.filter((r) => r.key);
const wanted = index.filter((r) => r.scope !== "Managed");
const { fields } = JSON.parse(readFileSync(at("ui/data/fields.json"), "utf8"));
const have = new Set(fields.map((f) => f.key));
const docKeys = new Set(index.map((r) => r.key));
const added = wanted.filter((r) => !have.has(r.key));
// hasCompletedOnboarding 是文档没写但 Claude Code 会读的键，手工维护。
const removed = fields.filter((f) => !docKeys.has(f.key) && f.key !== "hasCompletedOnboarding");
const nowManaged = fields.filter((f) => index.some((r) => r.key === f.key && r.scope === "Managed"));
// 官方标为已移除、但 fields.json 里没标 removed 的键。
const nowRemoved = fields.filter((f) => !f.removed && index.some((r) => r.key === f.key && r.removed));
writeFileSync(at("docs-src/keys.tsv"), wanted.map((r) => `${r.key}\t${r.topic}\t${r.scope}`).join("\n") + "\n");

console.log(`设置键：文档 ${index.length} 个，其中非托管 ${wanted.length} 个；fields.json ${fields.length} 个`);
if (added.length) console.log(`需要补充：\n${added.map((r) => `  ${r.key}（${r.topic}，${r.scope}）`).join("\n")}`);
if (removed.length) console.log(`文档里已没有：\n${removed.map((f) => `  ${f.key}`).join("\n")}`);
if (nowManaged.length) console.log(`已改为只在托管配置里生效：\n${nowManaged.map((f) => `  ${f.key}`).join("\n")}`);
if (nowRemoved.length) console.log(`官方已移除，需要加 removed: true：\n${nowRemoved.map((f) => `  ${f.key}`).join("\n")}`);
if (!added.length && !removed.length && !nowManaged.length && !nowRemoved.length) console.log("fields.json 与文档一致");
