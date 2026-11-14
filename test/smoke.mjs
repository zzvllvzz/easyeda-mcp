// End-to-end check without EasyEDA: real server processes over stdio + the real
// extension bundle running against a fake `eda`.  Run: npm test
import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { WebSocket } from "ws";
import { startFakeEda } from "./fake-eda.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = 49000 + Math.floor(Math.random() * 500);
const OUT = mkdtempSync(join(tmpdir(), "easyeda-mcp-test-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startServer(name) {
	const child = spawn(process.execPath, [join(HERE, "..", "server", "index.mjs")], {
		env: { ...process.env, EASYEDA_MCP_PORT: String(PORT), EASYEDA_MCP_OUT: OUT },
		stdio: ["pipe", "pipe", "pipe"],
	});
	const pending = new Map();
	let seq = 0;
	createInterface({ input: child.stdout }).on("line", (line) => {
		const msg = JSON.parse(line);
		pending.get(msg.id)?.(msg);
		pending.delete(msg.id);
	});
	let stderr = "";
	child.stderr.on("data", (d) => (stderr += d));
	const rpc = (method, params) =>
		new Promise((resolve, reject) => {
			const id = ++seq;
			const timer = setTimeout(() => reject(new Error(`${name}: ${method} timed out\n${stderr}`)), 60000);
			pending.set(id, (m) => {
				clearTimeout(timer);
				resolve(m);
			});
			child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
		});
	const call = async (tool, args = {}) => {
		const r = await rpc("tools/call", { name: tool, arguments: args });
		if (r.error) throw new Error(JSON.stringify(r.error));
		return { text: r.result.content[0].text, isError: !!r.result.isError };
	};
	return { child, rpc, call, stderr: () => stderr, kill: () => child.kill() };
}

let failures = 0;
function check(name, cond, detail = "") {
	if (cond) console.log("  ok   " + name);
	else {
		failures++;
		console.log("  FAIL " + name + (detail ? "\n       " + String(detail).slice(0, 600) : ""));
	}
}

const t0 = Date.now();
const a = startServer("A");
const init = await a.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } });
check("initialize answers fast", init.result?.serverInfo?.name === "easyeda-mcp" && Date.now() - t0 < 3000, `${Date.now() - t0} ms`);
const list = await a.rpc("tools/list", {});
check("tools listed", list.result.tools.length === 12 && list.result.tools.every((t) => t.inputSchema && !t.handler), list.result.tools.map((t) => t.name).join());

let r = await a.call("eda_status", { waitMs: 200 });
check("status without EasyEDA says not connected", /NOT connected/.test(r.text), r.text);

r = await a.call("eda_api", { query: "wire create" });
check("api search", /eda\.sch_PrimitiveWire\.create\(line/.test(r.text), r.text);
r = await a.call("eda_api", { name: "sch_PrimitiveWire.modify" });
check("api method detail has example", /example:/.test(r.text) && /param primitiveId/.test(r.text), r.text);

console.log("-- EasyEDA appears");
const fake = startFakeEda({ url: `ws://127.0.0.1:${PORT}` });
r = await a.call("eda_status");
check("status connected with context", /connected, editor 3\.2\.209-fake/.test(r.text) && /"fake"/.test(r.text), r.text);
check("status shows the bridge diagnostics", /bridge: socket up \d+ s, opened 1x, reconnects 0, executed \d+, watchdog by interval/.test(r.text), r.text);

r = await a.call("eda_exec", { code: "console.log('hi', {a:1}); store.n = (store.n||0)+1; return args.x * 2;", args: { x: 21 } });
check("exec returns value and console", /^42/.test(r.text) && /hi \{"a":1\}/.test(r.text), r.text);
r = await a.call("eda_exec", { code: "store.n++; return store.n;" });
check("store persists between calls", r.text.trim() === "2", r.text);
r = await a.call("eda_exec", { code: "null.x" });
check("exception reported as error", r.isError && /ERROR: .*null/.test(r.text), r.text);
r = await a.call("eda_exec", { code: "syntax error here(" });
check("syntax error reported", r.isError && /ERROR/.test(r.text), r.text);
r = await a.call("eda_exec", { code: "await new Promise(r => setTimeout(r, 5000)); return 1;", timeoutMs: 300 });
check("timeout reported", r.isError && /Timed out after 300 ms/.test(r.text), r.text);

r = await a.call("sch_draw", {
	ops: [
		{ op: "wire", line: [80, 100, 40, 100], net: "gnd" },
		{ op: "wire", line: [120, 100, 280, 100] },
		{ op: "flag", kind: "Ground", net: "GND", x: 40, y: 100 },
		{ op: "part", lcsc: "C25804", x: 500, y: 100, des: "R9" },
		{ op: "move", part: "R2", x: 310 },
	],
});
check("draw applies ops and reports ok", /"ok": true/.test(r.text) && /"applied": 5/.test(r.text) && /"des":"R9"/.test(r.text), r.text);
check("draw really changed the fake schematic", fake.wires.size === 2 && [...fake.parts.values()].some((p) => p._des === "R9") && [...fake.parts.values()].find((p) => p._des === "R2")._x === 310);

r = await a.call("sch_draw", { ops: [{ op: "wire", line: [0, 0, 10, 0], net: "LIES" }, { op: "wire", line: [0, 0, 10, 0], net: "MERGE" }] });
check("draw catches a net name that did not stick", /"ok": false/.test(r.text) && /net is '', asked 'LIES'/.test(r.text) && /probably merged/.test(r.text), r.text);

r = await a.call("sch_draw", { ops: [{ op: "wire", line: [0, 50, 10, 50] }, { op: "part", lcsc: "C0", x: 0, y: 0 }, { op: "wire", line: [0, 60, 10, 60] }], rollback: true });
check("draw stops at failure and rolls back", /"rolledBack": true/.test(r.text) && /LCSC C0 not found/.test(r.text) && fake.wires.size === 2, r.text + " wires=" + fake.wires.size);

r = await a.call("sch_draw", { ops: [{ op: "part", lcsc: "C25804", x: 700, y: 100, rot: 90 }, { op: "part", lcsc: "C25804", x: 800, y: 100 }, { op: "move", part: "R9", y: 120 }] });
const placed = [...fake.parts.values()].filter((p) => p._x === 700 || p._x === 800);
check("part rotation is corrected after create", placed.find((p) => p._x === 700)?._rot === 90, r.text);
check("new parts get numbered by the editor", /"des":"R3"/.test(r.text) && /"des":"R4"/.test(r.text) && placed.every((p) => /^R[0-9]+$/.test(p._des)), r.text);
r = await a.call("sch_draw", { ops: [{ op: "move", part: "R9", y: 100 }] });
check("modify right after a netlist is retried", /"ok": true/.test(r.text) && [...fake.parts.values()].find((p) => p._des === "R9")._y === 100, r.text);
for (const p of placed) fake.parts.delete(p._id);
r = await a.call("eda_exec", { code: "const s = Date.now(); for (let i = 0; i < 5; i++) await h.sleep(20); return { ms: Date.now() - s, by: h.clock().by };" });
check("pauses work without a worker (page timer fallback)", /"by": ?"page"/.test(r.text) && +(/"ms": ?(\d+)/.exec(r.text) || [0, 0])[1] >= 90, r.text);

console.log("-- guard, trial, expect");
const wiresBefore = fake.wires.size;
r = await a.call("sch_draw", { ops: [{ op: "wire", line: [0, 200, 10, 200], net: "SHORTME" }] });
check("a short is caught and the change is taken back", /"ok": false/.test(r.text) && /"shorts"/.test(r.text) && /"GND","VCC"|"VCC","GND"/.test(r.text) && /"rolledBack": true/.test(r.text) && /"restored": true/.test(r.text) && fake.wires.size === wiresBefore, r.text + " wires=" + fake.wires.size);
r = await a.call("sch_draw", { ops: [{ op: "wire", line: [0, 200, 10, 200], net: "SHORTME" }], allowShorts: true });
check("allowShorts keeps a short that was meant", /"ok": true/.test(r.text) && /shortsAllowed/.test(r.text) && fake.wires.size === wiresBefore + 1, r.text);
for (const [id, w] of fake.wires) if (w._net === "SHORTME") fake.wires.delete(id);
r = await a.call("sch_draw", { ops: [{ op: "wire", line: [0, 210, 10, 210], net: "NEWNET" }, { op: "part", lcsc: "C25804", x: 900, y: 300 }], trial: true });
check("trial reports and leaves nothing behind", /"trial": true/.test(r.text) && /"NEWNET":\["R2.2"\]/.test(r.text) && /"restored": true/.test(r.text) && fake.wires.size === wiresBefore && ![...fake.parts.values()].some((p) => p._x === 900), r.text);
r = await a.call("sch_draw", { ops: [{ op: "wire", line: [0, 210, 10, 210], net: "NEWNET" }], expect: { NEWNET: ["R2.2", "R1.1"] } });
check("a failed expect takes the change back", /"ok": false/.test(r.text) && /"problem":"split"/.test(r.text) && /"rolledBack": true/.test(r.text) && fake.wires.size === wiresBefore, r.text);
r = await a.call("sch_draw", { ops: [{ op: "wire", line: [0, 210, 10, 210], net: "NEWNET" }], expect: { NEWNET: ["R2.2"] } });
check("expect that holds keeps the change", /"ok": true/.test(r.text) && /"expect": "holds"/.test(r.text) && fake.wires.size === wiresBefore + 1, r.text);
for (const [id, w] of fake.wires) if (w._net === "NEWNET") fake.wires.delete(id);
r = await a.call("sch_draw", { ops: [{ op: "move", part: "R2", x: 999 }, { op: "part", lcsc: "C0", x: 0, y: 0 }] });
check("rollback puts a moved part back", /"rolledBack": true/.test(r.text) && [...fake.parts.values()].find((p) => p._des === "R2")._x === 310, r.text);
r = await a.call("lib_search", { query: "100nF 0402", limit: 2 });
check("library search", /"lcsc":"C100"/.test(r.text) && /"footprint":"C0402"/.test(r.text) && /"libraryUuid":"lib"/.test(r.text), r.text);
r = await a.call("pcb_read", { what: "info" });
check("PCB tools say when no PCB is open", r.isError && /not a PCB/.test(r.text), r.text);

r = await a.call("eda_call", { method: "sch_PrimitiveWire.getAll", args: ["GND"] });
check("call returns primitives as plain objects", /"primitiveId":"e\d+"/.test(r.text) && /"net":"GND"/.test(r.text) && /"line":\[80,100,40,100\]/.test(r.text), r.text);
r = await a.call("eda_call", { method: "sch_PrimitiveWire.nope" });
check("call of a missing method lists real ones", r.isError && /is not a function. Methods: .*getAll/.test(r.text), r.text);

r = await a.call("sch_read", {});
check("read summary", /R1 R2 R9/.test(r.text) && /GND/.test(r.text) && /"wires": 2/.test(r.text), r.text);
r = await a.call("sch_read", { what: "parts", des: ["R1"] });
check("read parts with pins", /"des":"R1"/.test(r.text) && /"pins":\[\{"id":"e1p1","num":"1","name":"1","x":80,"y":100,"rot":180/.test(r.text) && !/R2/.test(r.text), r.text);
r = await a.call("sch_read", { what: "net", net: "R1.2" });
check("read net by pin", /"net": "VCC"/.test(r.text), r.text);
r = await a.call("eda_exec", { code: "return h.checkNets({GND:['R1.1','R2.1'], VCC:['R1.2','R2.2'], '?x':['R1.1']});" });
check("checkNets finds split and extra", /"ok": false/.test(r.text) && /"problem":"split"/.test(r.text) && /extra nodes/.test(r.text), r.text);

r = await a.call("sch_export", { format: "pdf" });
const pdfPath = /"file": "(.+?)"/.exec(r.text)?.[1]?.replace(/\\\\/g, "\\");
check("export saves a real file", pdfPath && existsSync(pdfPath) && readFileSync(pdfPath, "utf8") === "%PDF-1.4 fake", r.text);

r = await a.call("eda_exec", { code: "return Array.from({length: 3000}, (_, i) => ({i, name: 'item' + i}));" });
const bigPath = /saved to (.+?\.json)/.exec(r.text)?.[1];
check("large result goes to a file with a preview", bigPath && existsSync(bigPath) && JSON.parse(readFileSync(bigPath, "utf8")).length === 3000 && r.text.length < 14000, r.text.slice(0, 300));

r = await a.call("eda_exec", { code: "return args.s.length + ':' + 'y'.repeat(900000).length;", args: { s: "x".repeat(700000) } });
check("big payload to EasyEDA is chunked", r.text.startsWith("700000:900000"), r.text.slice(0, 200));
r = await a.call("eda_exec", { code: "return 'z'.repeat(900000);", saveTo: join(OUT, "big.txt") });
check("big payload from EasyEDA is chunked and saved", readFileSync(join(OUT, "big.txt"), "utf8").length === 900000, r.text.slice(0, 200));

console.log("-- two copies of the script, long request");
const openedBefore = fake.opened();
r = await a.call("eda_exec", { code: "store.mark = 'kept'; await h.sleep(9000); return 'long';" });
check("a 9 s request is not cut by the second copy", r.text.trim().startsWith("long"), r.text);
check("the copies do not reopen the socket in turns", fake.opened() === openedBefore, `opened ${fake.opened() - openedBefore} more`);
r = await a.call("eda_exec", { code: "return store.mark;" });
check("still the same runtime afterwards", r.text.trim() === "kept", r.text);

console.log("-- socket drops while a request runs");
const running = a.call("eda_exec", { code: "await h.sleep(3000); return 'alive';" });
await sleep(500);
fake.drop();
r = await running;
check("the running request still returns its result", r.text.trim().startsWith("alive"), r.text);

console.log("-- web pages are kept out");
const tryOrigin = (origin) =>
	new Promise((resolve) => {
		const ws = new WebSocket(`ws://127.0.0.1:${PORT}`, origin === undefined ? {} : { origin });
		ws.on("open", () => {
			ws.close();
			resolve("open");
		});
		ws.on("unexpected-response", (req, res) => {
			req.destroy();
			resolve(res.statusCode);
		});
		ws.on("error", () => resolve("error"));
	});
const origins = {
	"https://evil.example": 401,
	null: 401,
	"https://easyeda.com.evil.example": 401,
	"http://pro.easyeda.com": 401,
	"https://pro.easyeda.com": "open",
	"https://pro.lceda.cn": "open",
};
for (const [origin, want] of Object.entries(origins)) {
	const got = await tryOrigin(origin);
	check(`origin ${origin}: ${want === "open" ? "accepted" : "refused"}`, got === want, got);
}
check("local program without origin: accepted", (await tryOrigin(undefined)) === "open");
r = await a.call("eda_exec", { code: "return 'still here';" });
check("EasyEDA still served after the refused attempts", r.text.trim() === "still here", r.text);

console.log("-- second session (peer)");
const b = startServer("B");
await b.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } });
r = await b.call("eda_status");
check("second server works as a peer", /role peer/.test(r.text) && /connected, editor/.test(r.text), r.text);
const both = await Promise.all([a.call("eda_exec", { code: "await h.sleep(300); return 'A';" }), b.call("eda_exec", { code: "await h.sleep(100); return 'B';" })]);
check("parallel requests from two sessions do not mix", both[0].text.trim() === "A" && both[1].text.trim() === "B", JSON.stringify(both));

console.log("-- first session exits, peer takes over");
a.kill();
const t1 = Date.now();
r = await b.call("eda_exec", { code: "return (await h.wires()).length;" });
if (r.isError) r = await b.call("eda_exec", { code: "return (await h.wires()).length;" });
check(`peer became hub and EasyEDA reconnected (${Date.now() - t1} ms)`, r.text.trim() === "2", r.text);
r = await b.call("eda_status");
check("status after takeover", /role hub/.test(r.text) && /connected, editor/.test(r.text), r.text);

console.log("-- connection drops silently");
fake.drop();
const t2 = Date.now();
r = await b.call("eda_exec", { code: "return 7;" });
check(`reconnects after a dropped socket (${Date.now() - t2} ms)`, r.text.trim() === "7", r.text);

fake.stop();
b.kill();
rmSync(OUT, { recursive: true, force: true });
console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
