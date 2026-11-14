// Searchable index of the EasyEDA Pro extension API, built from the official
// typings. Parsed lazily on first use.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

let index = null;

function cleanDoc(lines) {
	// lines: raw comment lines without the leading " * "
	const out = { summary: "", remarks: "", params: [], returns: "", example: "" };
	let section = "summary";
	for (const raw of lines) {
		const line = raw.trimEnd();
		const tag = /^@(\w+)\s*(.*)$/.exec(line.trim());
		if (tag) {
			const [, name, rest] = tag;
			if (name === "param") {
				out.params.push(rest);
				section = "param";
			} else if (name === "returns") {
				out.returns = rest;
				section = "returns";
			} else if (name === "remarks") {
				out.remarks = rest;
				section = "remarks";
			} else if (name === "example") {
				section = "example";
			} else section = "skip";
			continue;
		}
		if (section === "summary") out.summary += (out.summary && line ? " " : "") + line.trim();
		else if (section === "remarks") out.remarks += (out.remarks ? "\n" : "") + line;
		else if (section === "example") out.example += line + "\n";
		else if (section === "param" && line.trim()) out.params[out.params.length - 1] += " " + line.trim();
	}
	out.remarks = out.remarks.trim();
	out.example = out.example.trim();
	return out;
}

function build() {
	const require = createRequire(import.meta.url);
	const file = require.resolve("@jlceda/pro-api-types/index.d.ts");
	const lines = readFileSync(file, "utf8").split(/\r?\n/);
	const decls = new Map(); // name -> {kind, name, doc, members:[], body:[]}
	let cur = null;
	let comment = null; // collecting
	let lastDoc = null;
	for (const line of lines) {
		const trimmed = line.trim();
		// comments
		if (comment) {
			if (trimmed.endsWith("*/")) {
				const last = trimmed.slice(0, -2).replace(/^\*\s?/, "");
				if (last.trim()) comment.push(last);
				lastDoc = cleanDoc(comment);
				comment = null;
			} else comment.push(trimmed.replace(/^\*\s?/, ""));
			continue;
		}
		if (trimmed.startsWith("/**")) {
			const close = trimmed.indexOf("*/");
			if (close < 0) {
				comment = [];
				const first = trimmed.slice(3).trim();
				if (first) comment.push(first);
				continue;
			}
			if (close === trimmed.length - 2) {
				lastDoc = cleanDoc([trimmed.slice(3, -2).trim()]);
				continue;
			}
			// comment followed by code on the same line: handled as an inline doc below
		}
		const top = /^\t(?:declare |export |abstract )*(class|interface|enum|type|const) (\w+)/.exec(line);
		if (top && !cur) {
			const d = { kind: top[1], name: top[2], doc: lastDoc, members: [], head: trimmed };
			lastDoc = null;
			decls.set(d.name, d);
			if (trimmed.endsWith("{")) cur = d;
			else if (d.kind === "type" && !trimmed.endsWith(";")) cur = d; // multi-line type
			continue;
		}
		if (cur) {
			if (/^\t\}/.test(line) || (cur.kind === "type" && /^\t\S/.test(line) && trimmed.endsWith(";") && !line.startsWith("\t\t"))) {
				cur = null;
				lastDoc = null;
				continue;
			}
			if (/^\t\t\S/.test(line)) {
				if (/^(private|protected) /.test(trimmed) || trimmed.startsWith("public constructor")) {
					lastDoc = null;
					continue;
				}
				let sig = trimmed.replace(/^public /, "");
				let inlineDoc = null;
				const inl = /^\/\*\*\s*(.*?)\s*\*\/\s*(.*)$/.exec(sig);
				if (inl) {
					inlineDoc = cleanDoc([inl[1]]);
					sig = inl[2];
				}
				const name = /^(?:static |readonly )*([A-Za-z_$][\w$]*)/.exec(sig)?.[1] ?? sig;
				cur.members.push({ name, sig: sig.replace(/[;,]$/, ""), doc: inlineDoc ?? lastDoc, method: /^[\w$]+(<[^>]*>)?\(/.test(sig) });
				lastDoc = null;
			}
			continue;
		}
		if (trimmed && !trimmed.startsWith("//")) lastDoc = null;
	}
	// eda.<prop> -> class
	const props = new Map();
	const classToProp = new Map();
	for (const m of decls.get("EDA")?.members ?? []) {
		const mm = /^(\w+): (\w+)$/.exec(m.sig);
		if (mm) {
			props.set(mm[1], mm[2]);
			classToProp.set(mm[2], mm[1]);
		}
	}
	index = { decls, props, classToProp };
	return index;
}

const get = () => index ?? build();

function methodLine(cls, m, prop) {
	const where = prop ? `eda.${prop}.` : `${cls}.`;
	const doc = m.doc?.summary ? `  // ${m.doc.summary}` : "";
	return `${where}${m.sig}${doc}`;
}

function methodDetail(cls, m, prop, withExample) {
	const out = [methodLine(cls, m, prop)];
	const d = m.doc;
	if (d) {
		if (d.remarks) out.push("remarks: " + d.remarks.replace(/\n/g, "\n  "));
		for (const p of d.params) out.push("param " + p);
		if (d.returns) out.push("returns " + d.returns);
		if (withExample && d.example) out.push("example:\n" + d.example);
	}
	return out.join("\n");
}

/** Describe one declaration: class / eda property / interface / enum / type, or "Class.method". */
export function describe(name, { examples = false } = {}) {
	const { decls, props, classToProp } = get();
	let [declName, member] = String(name).replace(/^eda\./, "").split(".");
	if (props.has(declName)) declName = props.get(declName);
	let d = decls.get(declName);
	if (!d) {
		const lower = declName.toLowerCase();
		const hits = [...decls.keys()].filter((k) => k.toLowerCase() === lower);
		if (hits.length === 1) d = decls.get(hits[0]);
		else {
			const near = [...decls.keys()].filter((k) => k.toLowerCase().includes(lower)).slice(0, 30);
			return `No declaration '${declName}'.` + (near.length ? ` Similar: ${near.join(", ")}` : "");
		}
	}
	const prop = classToProp.get(d.name);
	if (member) {
		const ms = d.members.filter((m) => m.name === member);
		if (!ms.length) return `No member '${member}' in ${d.name}. Members: ${[...new Set(d.members.map((m) => m.name))].join(", ")}`;
		return ms.map((m) => methodDetail(d.name, m, prop, true)).join("\n\n");
	}
	const head = `${d.kind} ${d.name}${prop ? `  (eda.${prop})` : ""}${d.doc?.summary ? `  // ${d.doc.summary}` : ""}`;
	if (d.kind === "type" || d.kind === "const") return head + "\n" + d.head + (d.members.length ? "\n" + d.members.map((m) => "  " + m.sig).join("\n") : "");
	const body = d.members.map((m) => (examples && m.method ? methodDetail(d.name, m, prop, true) + "\n" : "  " + m.sig + (m.doc?.summary ? `  // ${m.doc.summary}` : "")));
	return head + "\n" + body.join("\n");
}

/** Keyword search over method names and docs. */
export function search(query, limit = 20) {
	const { decls, classToProp } = get();
	const terms = String(query).toLowerCase().split(/\s+/).filter(Boolean);
	const hits = [];
	for (const d of decls.values()) {
		const prop = classToProp.get(d.name);
		const declHay = d.name.toLowerCase();
		if (d.kind !== "class" || !prop) {
			// interfaces / enums / types: match by name only
			const score = terms.reduce((s, t) => s + (declHay.includes(t) ? 3 : 0), 0);
			if (score >= terms.length * 3) hits.push({ score: score - 1, text: `${d.kind} ${d.name}${d.doc?.summary ? `  // ${d.doc.summary}` : ""}` });
			continue;
		}
		for (const m of d.members) {
			if (!m.method) continue;
			const nameHay = (d.name + "." + m.name).toLowerCase();
			const docHay = ((m.doc?.summary ?? "") + " " + (m.doc?.remarks ?? "") + " " + m.sig).toLowerCase();
			let score = 0;
			let all = true;
			for (const t of terms) {
				if (m.name.toLowerCase() === t) score += 6;
				else if (nameHay.includes(t)) score += 3;
				else if (docHay.includes(t)) score += 1;
				else all = false;
			}
			if (all && score) hits.push({ score, text: methodLine(d.name, m, prop) });
		}
	}
	hits.sort((a, b) => b.score - a.score);
	if (!hits.length) return `Nothing found for '${query}'. Try a class name with eda_api {name}, e.g. sch_PrimitiveWire.`;
	const shown = hits.slice(0, limit).map((h) => h.text);
	if (hits.length > limit) shown.push(`... ${hits.length - limit} more; narrow the query or raise limit`);
	return shown.join("\n");
}

/** All eda.* objects with a one-line description. */
export function overview() {
	const { decls, props } = get();
	return [...props]
		.map(([prop, cls]) => {
			const d = decls.get(cls);
			return `eda.${prop}  (${d?.members.filter((m) => m.method).length ?? 0} methods)${d?.doc?.summary ? `  // ${d.doc.summary}` : ""}`;
		})
		.join("\n");
}
