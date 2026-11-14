// Replaces the installed bridge extension inside EasyEDA with the current build,
// without the import dialog. The extension must have been imported by hand once.
//
// EasyEDA has to run with a debugging port:
//   easyeda-pro.exe --remote-debugging-port=9333 --remote-allow-origins=*
// then:  npm run build:ext && node scripts/push-ext.mjs   and restart EasyEDA.
//
// It only rewrites this extension's own records in EasyEDA's extension database
// (IndexedDB "User_<id>_v6": extensionsIndex, extensionsObjectStorage). Importing
// the .eext in the extension manager does the same thing the official way.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const port = process.env.CDP_PORT || 9333;
const b64 = (f) => readFileSync(join(root, f)).toString("base64");
const manifest = JSON.parse(readFileSync(join(root, "extension/extension.json"), "utf8"));
const data = {
	uuid: manifest.uuid,
	manifest,
	eext: b64("easyeda-mcp-bridge.eext"),
	files: {
		"extension.json": { type: "application/json", b64: b64("extension/extension.json") },
		"dist/index.js": { type: "text/javascript", b64: b64("extension/dist/index.js") },
	},
};

// Runs inside the editor page.
async function install(data) {
	const bytes = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
	const dbs = await indexedDB.databases();
	const name = dbs.map((d) => d.name).find((n) => n.startsWith("User_"));
	if (!name) throw new Error("extension database not found: " + dbs.map((d) => d.name).join());
	const db = await new Promise((r, j) => {
		const q = indexedDB.open(name);
		q.onsuccess = () => r(q.result);
		q.onerror = () => j(q.error);
	});
	const tx = db.transaction(["extensionsIndex", "extensionsObjectStorage"], "readwrite");
	const idx = tx.objectStore("extensionsIndex");
	const obj = tx.objectStore("extensionsObjectStorage");
	const get = (st, k) =>
		new Promise((r, j) => {
			const q = st.get(k);
			q.onsuccess = () => r(q.result);
			q.onerror = () => j(q.error);
		});
	const rec = await get(idx, data.uuid);
	if (!rec) throw new Error("the extension is not installed yet: import the .eext once in the extension manager");
	const before = rec.config && rec.config.version;
	const eext = bytes(data.eext);
	const pack = await get(obj, data.uuid);
	if (!pack) throw new Error("no package record");
	pack.source = new File([eext], (pack.source && pack.source.name) || "easyeda-mcp-bridge.eext");
	obj.put(pack);
	for (const [path, f] of Object.entries(data.files)) {
		const r = await get(obj, data.uuid + "|" + path);
		if (!r) throw new Error("no record for " + path);
		r.source = new File([bytes(f.b64)], path, { type: f.type });
		obj.put(r);
	}
	for (const k of Object.keys(data.manifest)) if (k in rec.config) rec.config[k] = data.manifest[k];
	rec.fileSize = eext.length;
	idx.put(rec);
	await new Promise((r, j) => {
		tx.oncomplete = r;
		tx.onerror = () => j(tx.error);
		tx.onabort = () => j(tx.error);
	});
	db.close();
	return { database: name, before, now: data.manifest.version };
}

const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = targets.find((t) => t.type === "page" && /easyeda|lceda/.test(t.url));
if (!page) throw new Error("no EasyEDA page on the debugging port " + port);
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r, j) => (ws.on("open", r), ws.on("error", j)));
const reply = await new Promise((resolve) => {
	ws.on("message", (d) => {
		const m = JSON.parse(d.toString());
		if (m.id === 1) resolve(m);
	});
	ws.send(
		JSON.stringify({
			id: 1,
			method: "Runtime.evaluate",
			params: { expression: `(${install.toString()})(${JSON.stringify(data)})`, awaitPromise: true, returnByValue: true },
		}),
	);
});
ws.close();
const res = reply.result;
if (!res || res.exceptionDetails) {
	console.error("failed:", res?.exceptionDetails?.exception?.description || JSON.stringify(reply));
	process.exit(1);
}
console.log(`stored ${res.result.value.before} -> ${res.result.value.now} in ${res.result.value.database}. Restart EasyEDA to load it.`);
