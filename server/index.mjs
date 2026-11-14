#!/usr/bin/env node
// easyeda-mcp: MCP server (stdio) that runs code inside EasyEDA Pro through a
// tiny bridge extension. The MCP layer is hand-written JSON-RPC to keep startup
// instant and dependencies minimal.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, isAbsolute, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { Link, PORT } from "./link.mjs";
import * as api from "./api-index.mjs";

const VERSION = "0.1.0";
const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = process.env.EASYEDA_MCP_OUT || join(homedir(), ".easyeda-mcp", "out");
const DEFAULT_MAX_CHARS = 12000;

const log = (text) => process.stderr.write(`[easyeda-mcp] ${text}\n`);
const link = new Link(log);
link.start();

// Helpers are re-read on every call, so they can be edited while the server runs.
const helpersSource = () => readFileSync(join(HERE, "helpers.js"), "utf8").trim().replace(/;$/, "");
const wrap = (code) => `const h = (${helpersSource()})(eda, console, store);\n${code}`;

// ---------- output shaping ----------
function stamp() {
	return new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14) + "-" + Math.random().toString(36).slice(2, 6);
}
function ensureOut(dir = OUT_DIR) {
	mkdirSync(dir, { recursive: true });
	return dir;
}
const EXT_BY_TYPE = { "application/pdf": ".pdf", "image/png": ".png", "image/svg+xml": ".svg", "text/csv": ".csv", "application/zip": ".zip", "text/plain": ".txt" };

/** Replace binary results with files on disk. */
function extractBlobs(value, saveTo, saved) {
	if (!value || typeof value !== "object") return value;
	if (value.__blob === true && typeof value.base64 === "string") {
		const bytes = Buffer.from(value.base64, "base64");
		let path;
		if (saveTo && !saved.length && extname(saveTo)) path = isAbsolute(saveTo) ? saveTo : resolve(saveTo);
		else {
			const dir = saveTo && !extname(saveTo) ? resolve(saveTo) : OUT_DIR;
			const name = (value.name || "").replace(/[\\/:*?"<>|]/g, "_");
			const ext = extname(name) || EXT_BY_TYPE[value.type] || ".bin";
			path = join(dir, name ? `${stamp()}-${name}${extname(name) ? "" : ext}` : `${stamp()}${ext}`);
		}
		ensureOut(dirname(path));
		writeFileSync(path, bytes);
		const info = { file: path, bytes: bytes.length, type: value.type || undefined };
		saved.push(info);
		return info;
	}
	if (Array.isArray(value)) return value.map((v) => extractBlobs(v, saveTo, saved));
	for (const k of Object.keys(value)) value[k] = extractBlobs(value[k], saveTo, saved);
	return value;
}

function render(value) {
	if (value === undefined) return "undefined";
	if (typeof value === "string") return value;
	if (Array.isArray(value)) {
		if (!value.length) return "[]";
		return "[\n" + value.map((v) => " " + JSON.stringify(v)).join(",\n") + "\n]";
	}
	if (value && typeof value === "object") {
		const keys = Object.keys(value);
		if (!keys.length) return "{}";
		return (
			"{\n" +
			keys
				.map((k) => {
					const v = value[k];
					const body = Array.isArray(v) && v.length > 3 && typeof v[0] === "object" ? render(v).replace(/\n/g, "\n ") : JSON.stringify(v);
					return ` ${JSON.stringify(k)}: ${body}`;
				})
				.join(",\n") +
			"\n}"
		);
	}
	return JSON.stringify(value);
}

function shape(value) {
	if (Array.isArray(value)) return `array of ${value.length}` + (value.length && typeof value[0] === "object" && value[0] ? `, item keys: ${Object.keys(value[0]).join(", ")}` : "");
	if (value && typeof value === "object")
		return (
			"object with keys: " +
			Object.keys(value)
				.map((k) => (Array.isArray(value[k]) ? `${k}[${value[k].length}]` : k))
				.join(", ")
		);
	return typeof value;
}

/** Turn a bridge reply into tool text. Large results go to a file with a preview. */
function present(reply, { maxChars = DEFAULT_MAX_CHARS, saveTo } = {}) {
	const parts = [];
	let isError = false;
	if (!reply.ok) {
		isError = true;
		const e = reply.error || {};
		if (e.notConnected)
			parts.push(
				`EasyEDA is not connected to the bridge (port ${PORT}). Open EasyEDA Pro with a project; the 'EasyEDA MCP' extension must be installed with External Interaction enabled. In EasyEDA: menu MCP > Reconnect. Then retry.`,
			);
		else {
			parts.push("ERROR: " + (e.message || "unknown error"));
			const stack = String(e.stack || "")
				.split("\n")
				.slice(1, 4)
				.join("\n");
			if (stack.trim()) parts.push(stack);
		}
	} else {
		const saved = [];
		const value = extractBlobs(reply.value, saveTo, saved);
		let text = render(value);
		if (saveTo && !saved.length) {
			const path = isAbsolute(saveTo) ? saveTo : resolve(saveTo);
			ensureOut(dirname(path));
			writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value, null, 1));
			parts.push(`Saved to ${path} (${text.length} chars; ${shape(value)})`);
			text = text.length > 1500 ? text.slice(0, 1500) + "\n... (preview)" : text;
		} else if (text.length > maxChars) {
			const path = join(ensureOut(), `${stamp()}.${typeof value === "string" ? "txt" : "json"}`);
			writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value, null, 1));
			parts.push(
				`Result is large (${text.length} chars; ${shape(value)}). Full result saved to ${path}. Showing the first ${maxChars} chars; return less from the code (filter/map) or read the file.`,
			);
			text = text.slice(0, maxChars) + "\n... (truncated)";
		}
		parts.push(text);
	}
	if (reply.logs?.length) parts.push("console:\n" + reply.logs.join("\n").slice(0, 4000));
	if (reply.ms !== undefined && reply.ms > 3000) parts.push(`(${reply.ms} ms)`);
	return { content: [{ type: "text", text: parts.join("\n") }], isError };
}

const run = async (code, args, opts = {}) => present(await link.exec(wrap(code), args ?? null, opts.timeoutMs ?? 30000), opts);
const text = (t, isError = false) => ({ content: [{ type: "text", text: t }], isError });

// ---------- tools ----------
const HELPERS_DOC = `Helpers available as \`h\` inside eda_exec code (all async unless noted):
 h.ctx() current project/document/schematic/page | h.pages() | h.openPage(uuidOrName)
 h.parts({pins?, des?, region?:[x1,y1,x2,y2], type?, allPages?}) compact components; h.part("U1") one component with pins
 h.wires(net?) | h.snapshot({region?, pins?}) parts+flags+wires of the page
 h.nets() {net:["U1.3",...]} from the native PADS netlist (all pages) | h.net("GND" | "U1.3") | h.checkNets({NET:["U1.3","R2.1"]})
 h.lcsc("C1234" | [..]) -> {found:{id:{uuid,libraryUuid}}, missing}
 h.draw(ops, {trial?, expect?:{NET:[pins]}, allowShorts?, rollback?, guard?, keepGoing?, verbose?}) one change, all or nothing (see sch_draw)
   ops: {op:"wire",line:[x1,y1,x2,y2,..],net?} {op:"part",lcsc|device,x,y,rot?,des?}
   {op:"flag",kind:"Ground"|"Power",net,x,y,rot?} {op:"port",dir:"IN"|"OUT"|"BI",net,x,y,rot?} {op:"move",part,x?,y?,rot?}
   {op:"set",part,props} {op:"nc",pin:"U1.3"} {op:"unname",wire} {op:"rewire",wire,line} {op:"delete",wires?,parts?,others?}
   {op:"text",x,y,text,size?,rot?} {op:"rect",x,y,w,h} {op:"circle",x,y,r} {op:"line",line:[..]} {op:"attr",part,key:"Designator"|"Name",x?,y?,rot?,visible?}
 h.netDiff(before, after) what changed between two h.nets() results (shorts, joined, dropped, split, renamed, connected; sync)
 h.erc({strict?, ui?}) floating pins, single-pin nets, unnumbered and duplicate designators + EasyEDA's own counts
 h.overlaps() parts/labels/wires lying on each other | h.free(w, h, {count?, margin?, region?}) free room on the sheet | h.boxes() rectangles of everything
 h.search("100nF 0402", {limit?}) devices of the library -> [{name, lcsc, footprint, uuid, libraryUuid}]
 h.exportFile("pdf"|"png"|"svg"|"netlist"|"bom"|"view") returns a File (the server saves it and returns the path)
 PCB (active tab must be a PCB; mil, y up; every call takes {unit:"mm"}): h.pcb.open(name?) | h.pcb.info() | h.pcb.parts({des?, pads?}) | h.pcb.part("R1")
   h.pcb.tracks({net?, layer?}) | h.pcb.vias({net?}) | h.pcb.shapes() | h.pcb.nets(name?) | h.pcb.unrouted() | h.pcb.drc({max?, type?})
   h.pcb.draw(ops, {trial?, rollback?, guard?, allowErrors?, unit?}) (see pcb_draw) | h.pcb.import({apply?}) schematic -> board
   h.pcb.rebuild() refill pours | h.pcb.autoroute(props?) | h.pcb.exportFile("gerber"|"pnp"|"bom"|"step"|...)
 h.methods("sch_PrimitiveWire") real method names at runtime (sync) | h.limit(promise, ms, label) | h.sleep(ms)
 h.settle(wireIds) wait until the page wire list knows new wires (after raw sch_PrimitiveWire.create; h.draw does it itself)
Editor 3.2.209 quirks when using the raw API (the helpers already handle them): the wire list (getAll/getAllPrimitiveId) lags ~1 s behind wire creation;
 sch_PrimitiveComponent.create stores rotation 90 as 270 and 270 as 90 (modify is right); sch_PrimitivePin.modify without y flips the pin's y, always pass y;
 for a moment after a netlist was generated modify() throws 'cmdKey', a wire create() throws 'create failed!' and delete() returns false: repeat the call; generating a netlist numbers the 'R?' parts;
 connectivity follows a deleted wire with ~1 s delay; net flags and ports cannot be modified (delete and create again); a flag on a pin end is joined by a zero-length wire that cannot be created by hand;
 EasyEDA merges a new wire with every wire whose end it touches (create returns the old wire's id); pcb_Primitive.getPrimitiveTypeByPrimitiveId answers undefined; a pour is refilled with pourObject.rebuildCopperRegion();
 pcb_Document.importChanges() only opens a confirmation dialog (h.pcb.import presses the button); never call the ordering functions (placePcbOrder, placeComponentsOrder, ...);
 getPdfFile does not exist and getPngFile/getSvgFile never resolve, use getExportDocumentFile(name,'PDF'|'PNG'|'SVG',params,'Current Schematic Page').
 Pause with h.sleep: in a hidden or minimized EasyEDA window page timers fire once a second, chained ones once a minute. The helpers route the page's timers through a worker while the window is hidden (h.clock() shows it, h.pageTimers(false) turns it off).`;

const tools = [
	{
		name: "eda_status",
		description: "Check the bridge: is EasyEDA Pro connected, which editor/extension version, and what project/document/page is active.",
		inputSchema: {
			type: "object",
			properties: { waitMs: { type: "integer", description: "How long to wait for EasyEDA to connect before giving up (default 8000)." } },
		},
		annotations: { readOnlyHint: true },
		async handler({ waitMs }) {
			const s = await link.status(waitMs ?? 8000);
			const lines = [`server ${VERSION}, role ${s.role}, port ${s.port}`];
			if (!s.eda) {
				lines.push(
					"EasyEDA: NOT connected. Open EasyEDA Pro; the 'EasyEDA MCP' extension must be installed and have External Interaction enabled (it reconnects by itself within ~10 s; or menu MCP > Reconnect).",
				);
				return text(lines.join("\n"));
			}
			lines.push(`EasyEDA: connected, editor ${s.eda.edaVersion || "?"}, extension ${s.eda.ext}, ${s.eda.client ? "desktop client" : "web"}`);
			const r = await link.exec(
				wrap(
					"const b = globalThis.__easyedaMcpBridge__; let vis = null; try { vis = document.visibilityState; } catch (e) {}" +
						"return { ctx: await h.ctx(), bridge: b && b.info ? b.info() : null, vis };",
				),
				null,
				15000,
				0,
			);
			if (r.ok && r.value?.bridge) {
				const b = r.value.bridge;
				const age = s.eda.since ? Math.round((Date.now() - s.eda.since) / 1000) : null;
				lines.push(
					`bridge: socket up ${age ?? "?"} s, opened ${b.opened}x, reconnects ${b.reconnects}, executed ${b.executed}, watchdog by ${b.ticker || "?"}, window ${r.value.vis || "?"}` +
						(b.deactivations ? `, deactivate() called ${b.deactivations}x` : "") +
						(b.lastError ? `, last error: ${b.lastError}` : ""),
				);
			} else if (r.ok && r.value?.vis) lines.push(`window ${r.value.vis}`);
			lines.push(r.ok ? render(r.value.ctx) : "context failed: " + (r.error?.message || "?"));
			return text(lines.join("\n"));
		},
	},
	{
		name: "eda_exec",
		description:
			"Run JavaScript inside EasyEDA Pro and get the returned value. The code is the body of an async function with `eda` (the EasyEDA extension API), `h` (helpers), `args` (your JSON), `console` (captured) and `store` (object that persists between calls). Use `return` for the result. Do many operations in ONE call with loops instead of many calls. EasyEDA primitives are returned as plain objects built from their getState_* getters; File/Blob results are saved to disk and returned as a path. Nothing is guarded or confirmed: read back what you changed. Schematic y axis points up.\n" +
			HELPERS_DOC,
		inputSchema: {
			type: "object",
			properties: {
				code: { type: "string", description: "Body of an async function. Example: const w = await h.wires('GND'); return w.length;" },
				args: { description: "Any JSON value, available in the code as `args`." },
				timeoutMs: { type: "integer", description: "Time limit in ms (default 30000). Code that times out keeps running in EasyEDA." },
				maxChars: { type: "integer", description: `Inline result limit (default ${DEFAULT_MAX_CHARS}); larger results are saved to a file and previewed.` },
				saveTo: { type: "string", description: "Absolute path: save the result (or the returned File) there instead of returning it inline." },
			},
			required: ["code"],
		},
		handler: ({ code, args, timeoutMs, maxChars, saveTo }) => run(code, args, { timeoutMs, maxChars, saveTo }),
	},
	{
		name: "eda_call",
		description:
			"Call one EasyEDA API method by path, e.g. method 'sch_PrimitiveWire.getAll' with args ['GND']. Shortcut for simple reads and single writes; for anything with loops use eda_exec. Look up signatures with eda_api.",
		inputSchema: {
			type: "object",
			properties: {
				method: { type: "string", description: "Path under eda, e.g. dmt_Schematic.getCurrentSchematicPageInfo" },
				args: { type: "array", description: "Positional arguments (default none).", items: {} },
				timeoutMs: { type: "integer" },
				maxChars: { type: "integer" },
				saveTo: { type: "string" },
			},
			required: ["method"],
		},
		handler: ({ method, args, timeoutMs, maxChars, saveTo }) =>
			run(
				`const path = args.method.replace(/^eda\\./, "").split(".");
let obj = eda;
for (const key of path.slice(0, -1)) { obj = obj[key]; if (obj == null) throw new Error("eda." + path.join(".") + ": '" + key + "' does not exist"); }
const fn = obj[path[path.length - 1]];
if (typeof fn !== "function") throw new Error("eda." + path.join(".") + " is not a function. Methods: " + h.methods(path.length === 2 ? path[0] : undefined).join(", "));
return fn.apply(obj, args.args || []);`,
				{ method, args },
				{ timeoutMs, maxChars, saveTo },
			),
	},
	{
		name: "eda_api",
		description:
			"Look up the EasyEDA Pro extension API (offline, from the official typings; doc comments are in Chinese). `query`: keyword search over method names and docs. `name`: full listing of a class/eda object (sch_PrimitiveWire), an interface, enum or type, or one method with remarks and example (sch_PrimitiveWire.modify). No arguments: overview of all eda.* objects.",
		inputSchema: {
			type: "object",
			properties: {
				query: { type: "string", description: "Keywords, e.g. 'netlist' or 'pin modify'." },
				name: { type: "string", description: "Class, eda property, interface, enum, type, or Class.method." },
				limit: { type: "integer", description: "Max search results (default 20)." },
				examples: { type: "boolean", description: "With `name` of a class: include remarks and examples for every method (long)." },
			},
		},
		annotations: { readOnlyHint: true },
		async handler({ query, name, limit, examples }) {
			let out;
			if (name) out = api.describe(name, { examples });
			else if (query) out = api.search(query, limit ?? 20);
			else out = api.overview();
			if (out.length > 30000) out = out.slice(0, 30000) + "\n... (truncated; ask for one method: Class.method)";
			return text(out);
		},
	},
	{
		name: "sch_read",
		description:
			"Read the active schematic page compactly. what: 'summary' (counts, designators, net names of wires), 'parts' (components with pin coordinates), 'wires', 'snapshot' (parts+flags+wires), 'nets' (whole-schematic netlist {net: pins}), 'net' (one net by name or by pin like 'U1.3', needs `net`), 'check' (floating pins, single-pin nets, unnumbered or duplicate designators, EasyEDA's own rule check counts), 'overlaps' (parts, labels and wires lying on each other), 'free' (room for a block of `size` [w,h]: rectangles touching nothing), 'boxes' (the rectangle every object takes). Filter with `des` (designators) or `region` [x1,y1,x2,y2]. Pin x,y is the outer end where a wire attaches.",
		inputSchema: {
			type: "object",
			properties: {
				what: { type: "string", enum: ["summary", "parts", "wires", "snapshot", "nets", "net", "check", "overlaps", "free", "boxes"] },
				des: { type: "array", items: { type: "string" }, description: "Only these designators (parts)." },
				net: { type: "string", description: "Net name (wires, net) or a pin like U1.3 (net)." },
				region: { type: "array", items: { type: "number" }, description: "[x1,y1,x2,y2]" },
				pins: { type: "boolean", description: "Include pins for parts/snapshot (default true)." },
				size: { type: "array", items: { type: "number" }, description: "what:'free': [width, height] of the block to fit." },
				count: { type: "integer", description: "what:'free': how many places to return (default 1)." },
				maxChars: { type: "integer" },
				saveTo: { type: "string" },
			},
		},
		annotations: { readOnlyHint: true },
		handler: ({ maxChars, saveTo, ...a }) =>
			run(
				`const what = args.what || "summary";
if (what === "parts") return h.parts({ pins: args.pins !== false, des: args.des, region: args.region });
if (what === "wires") return h.wires(args.net);
if (what === "snapshot") return h.snapshot({ region: args.region, pins: args.pins !== false });
if (what === "nets") return h.nets();
if (what === "net") { if (!args.net) throw new Error("what:'net' needs net"); return h.net(args.net); }
if (what === "check") return h.erc();
if (what === "overlaps") return h.overlaps();
if (what === "boxes") return h.boxes();
if (what === "free") { if (!args.size) throw new Error("what:'free' needs size:[w,h]"); return h.free(args.size[0], args.size[1], { count: args.count, region: args.region }); }
const s = await h.snapshot({ pins: false });
const count = {};
for (const w of s.wires) count[w.net || "(unnamed)"] = (count[w.net || "(unnamed)"] || 0) + 1;
return {
  ctx: await h.ctx(),
  parts: s.parts.length + ": " + s.parts.map((p) => p.des || "?").sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).join(" "),
  flags: s.flags.length + ": " + [...new Set(s.flags.map((f) => f.type + ":" + (f.net || f.name || "")))].join(" "),
  wires: s.wires.length,
  wireNets: Object.entries(count).map(([n, c]) => (c > 1 ? n + "x" + c : n)).join(" "),
};`,
				a,
				{ maxChars, saveTo, timeoutMs: 60000 },
			),
	},
	{
		name: "sch_draw",
		description:
			"Apply a list of drawing operations to the active schematic page as ONE change: afterwards either all of it is on the page or none of it. The netlist is read before and after (guard): nets with different names that became one net are a short, and a short takes the whole change back, as does a failed op or an `expect` that does not hold; the report says what happened to the nets (connected, joined, dropped, split, renamed) and `restored:true` confirms that the netlist is back to what it was. trial:true does the change, reports, and takes it back in any case (a dry run on the real editor). ops: {op:'wire',line:[x1,y1,x2,y2,...],net?} | {op:'part',lcsc:'C1234'|device:{libraryUuid,uuid},x,y,rot?,mirror?,des?} | {op:'flag',kind:'Ground'|'Power'|'AnalogGround'|'ProtectGround',net,x,y,rot?} | {op:'port',dir:'IN'|'OUT'|'BI',net,x,y,rot?} | {op:'move',part:'R1',x?,y?,rot?,mirror?} | {op:'set',part,props:{designator?,name?}} | {op:'nc',pin:'U1.3'} | {op:'unname',wire:id} | {op:'rewire',wire:id,line} | {op:'delete',wires?:[ids],parts?:[ids|designators],others?:[ids of texts/shapes]} | {op:'text',x,y,text,size?,rot?,color?} | {op:'rect',x,y,w,h} (x,y top left) | {op:'circle',x,y,r} | {op:'line',line:[...]} (drawing line, not a wire) | {op:'attr',part,key:'Designator'|'Name',x?,y?,rot?,visible?,value?} (move or edit a label of a part). Notes: y points up; a wire with `net` gets a visible label; EasyEDA merges a new wire with every wire whose end it touches (reported as merged, the old wire keeps its id); pins touching end to end without a wire are not connected; parts placed without `des` are numbered by EasyEDA (unique across all pages); the netlist also numbers any other 'R?' part of the project; deleted parts cannot be put back by a rollback.",
		inputSchema: {
			type: "object",
			properties: {
				ops: { type: "array", items: { type: "object" } },
				trial: { type: "boolean", description: "Do it, report what it does to the nets, then take everything back." },
				expect: { type: "object", description: "{NET: ['U1.3','R2.1']}: these nets must consist of exactly these pins afterwards, else the change is taken back. A key starting with '?' checks an unnamed net." },
				allowShorts: { description: "true, or a list of net names that may be joined on purpose." },
				rollback: { type: "boolean", description: "Default true: take everything back on a failed op, a short or a failed expect. false keeps what was done." },
				guard: { type: "boolean", description: "Default true. false skips the two netlists (faster, no short detection)." },
				keepGoing: { type: "boolean", description: "Continue after a failed op (turns rollback off unless it is set)." },
				verbose: { type: "boolean", description: "Return an entry for every op, not only parts and problems." },
				timeoutMs: { type: "integer", description: "Default 180000." },
			},
			required: ["ops"],
		},
		handler: ({ ops, timeoutMs, ...opts }) => run(`return h.draw(args.ops, args.opts);`, { ops, opts }, { timeoutMs: timeoutMs ?? 180000 }),
	},
	{
		name: "sch_export",
		description:
			"Export from the active schematic to a file and return its path: pdf (look at the real drawing; open the path with the Read tool), png, svg, netlist (PADS text), bom (csv), view (image of what the canvas currently shows; may be stale).",
		inputSchema: {
			type: "object",
			properties: {
				format: { type: "string", enum: ["pdf", "png", "svg", "netlist", "bom", "view"] },
				path: { type: "string", description: "Absolute file path or directory. Default: ~/.easyeda-mcp/out/" },
				options: { type: "object", description: "Passed to h.exportFile: {name?, params?, resolution?, type?, tabId?, object?, objectParams?}. pdf exports the current page by default; object: 'Current Schematic' or 'All Schematic' for more." },
				timeoutMs: { type: "integer", description: "Default 90000." },
			},
			required: ["format"],
		},
		async handler({ format, path, options, timeoutMs }) {
			const reply = await link.exec(
				wrap(`const f = await h.exportFile(args.format, args.options || {}); if (!f) throw new Error("EasyEDA returned no file for " + args.format); return f;`),
				{ format, options },
				timeoutMs ?? 90000,
			);
			if (reply.ok && !(reply.value && reply.value.__blob)) {
				return present({ ...reply, ok: false, error: { message: "Export did not return a file: " + JSON.stringify(reply.value).slice(0, 300) } });
			}
			return present(reply, { saveTo: path });
		},
	},
	{
		name: "lib_search",
		description:
			"Search the EasyEDA/LCSC device library by words ('100nF 0402 X7R', 'STM32F103C8T6') or look up LCSC numbers. Returns name, LCSC number, footprint, JLCPCB class (Basic/Extended) and the uuid pair that {op:'part', device:{uuid, libraryUuid}} takes.",
		inputSchema: {
			type: "object",
			properties: {
				query: { type: "string", description: "Words to search for." },
				lcsc: { type: "array", items: { type: "string" }, description: "Instead of query: LCSC numbers like C25804." },
				limit: { type: "integer", description: "Default 10." },
				page: { type: "integer" },
				datasheet: { type: "boolean", description: "Include datasheet links." },
			},
		},
		annotations: { readOnlyHint: true },
		handler: ({ query, lcsc, limit, page, datasheet }) =>
			run(`if (args.lcsc && args.lcsc.length) return h.lcsc(args.lcsc); if (!args.query) throw new Error("give query or lcsc"); return h.search(args.query, { limit: args.limit, page: args.page, datasheet: args.datasheet });`, { query, lcsc, limit, page, datasheet }, { timeoutMs: 60000 }),
	},
	{
		name: "pcb_read",
		description:
			"Read the active PCB (open one with pcb_do action:'open'). what: 'info' (layers, rule set, outline size, counts), 'parts' (components; pads:true adds pad coordinates and nets), 'tracks', 'vias', 'shapes' (polylines, pours, regions, fills, texts), 'nets' (pads, track length, tracks and vias per net; `net` for one), 'unrouted' (pads still waiting for a connection), 'drc' (design rule check with the list of errors). Coordinates are in mil with y up; unit:'mm' switches to millimetres.",
		inputSchema: {
			type: "object",
			properties: {
				what: { type: "string", enum: ["info", "parts", "tracks", "vias", "shapes", "nets", "unrouted", "drc"] },
				des: { type: "array", items: { type: "string" }, description: "parts: only these designators." },
				pads: { type: "boolean", description: "parts: include pad coordinates." },
				net: { type: "string", description: "tracks, vias, nets: only this net." },
				layer: { description: "tracks: layer number or name (top, bottom, topsilk, outline, inner1...)." },
				unit: { type: "string", enum: ["mil", "mm"] },
				max: { type: "integer", description: "drc: how many errors to list (default 60)." },
				maxChars: { type: "integer" },
				saveTo: { type: "string" },
			},
		},
		annotations: { readOnlyHint: true },
		handler: ({ maxChars, saveTo, ...a }) =>
			run(
				`const what = args.what || "info"; const o = { unit: args.unit };
if (what === "info") return h.pcb.info(o);
if (what === "parts") return h.pcb.parts({ ...o, des: args.des, pads: args.pads });
if (what === "tracks") return h.pcb.tracks({ ...o, net: args.net, layer: args.layer });
if (what === "vias") return h.pcb.vias({ ...o, net: args.net });
if (what === "shapes") return h.pcb.shapes(o);
if (what === "nets") return h.pcb.nets(args.net, o);
if (what === "unrouted") return h.pcb.unrouted();
if (what === "drc") return h.pcb.drc({ max: args.max });
throw new Error("unknown what: " + what);`,
				a,
				{ maxChars, saveTo, timeoutMs: 180000 },
			),
	},
	{
		name: "pcb_draw",
		description:
			"Apply a list of operations to the active PCB as ONE change. The design rule check runs before and after (guard): a new error other than a not-yet-routed connection (clearance, short, overlap with a keep-out) takes the whole change back, as does a failed op; pours are refilled before judging. trial:true reports and takes it back in any case. Coordinates in mil, y up (unit:'mm' for millimetres); layer by number or name (top, bottom, topsilk, bottomsilk, outline, document, inner1...). ops: {op:'track',net,layer,points:[x1,y1,x2,y2,...],width?} | {op:'via',net,x,y,hole?,dia?} | {op:'move',part:'R1',x?,y?,rot?,layer?} | {op:'place',lcsc|device|footprint,x,y,layer?,rot?,des?} | {op:'set',part,props} | {op:'outline',rect:[x,y,w,h]|points:[...]|circle:[x,y,r]} | {op:'pour',net,layer,rect|points,name?,priority?} | {op:'region',layer,rect|points,rules?} (keep-out) | {op:'fill',layer,rect|points|circle,net?} | {op:'text',layer,x,y,text,size?,width?,rot?} | {op:'line',layer,points,width?} (silkscreen or document line) | {op:'delete',ids:[...]}. A rectangle starts at its top left corner. Components normally come from the schematic (pcb_do action:'import'); deleted shapes, texts and components cannot be put back by a rollback, tracks and vias can.",
		inputSchema: {
			type: "object",
			properties: {
				ops: { type: "array", items: { type: "object" } },
				unit: { type: "string", enum: ["mil", "mm"] },
				trial: { type: "boolean", description: "Do it, report the rule check, then take everything back." },
				rollback: { type: "boolean", description: "Default true: take everything back on a failed op or a new rule error." },
				allowErrors: { type: "boolean", description: "Keep the change even if it adds rule errors (they are still reported)." },
				guard: { type: "boolean", description: "Default true. false skips the rule checks." },
				rebuild: { type: "boolean", description: "Default true: refill pours before the rule check." },
				keepGoing: { type: "boolean" },
				verbose: { type: "boolean" },
				timeoutMs: { type: "integer", description: "Default 300000." },
			},
			required: ["ops"],
		},
		handler: ({ ops, timeoutMs, ...opts }) => run(`return h.pcb.draw(args.ops, args.opts);`, { ops, opts }, { timeoutMs: timeoutMs ?? 300000 }),
	},
	{
		name: "pcb_do",
		description:
			"Whole-board actions. action: 'open' (open a PCB of the project by `name` or uuid, the first one by default), 'import' (bring the schematic's changes onto the board; lists the changes and applies them, apply:false only lists), 'rebuild' (refill all pours), 'autoroute' (EasyEDA's own router; `props` like {RoutingNets:['A','B'], layers:[1,2], ignoreNets:[...]}), 'unroute' (delete all tracks and vias of `net`, or of every net when none is given).",
		inputSchema: {
			type: "object",
			properties: {
				action: { type: "string", enum: ["open", "import", "rebuild", "autoroute", "unroute"] },
				name: { type: "string", description: "open: PCB name or uuid." },
				apply: { type: "boolean", description: "import: default true." },
				props: { type: "object", description: "autoroute: IPCB_AutoRoutingProps." },
				net: { type: "string", description: "unroute: only this net." },
				timeoutMs: { type: "integer", description: "Default 300000." },
			},
			required: ["action"],
		},
		handler: ({ action, name, apply, props, net, timeoutMs }) =>
			run(
				`if (args.action === "open") return h.pcb.open(args.name);
if (args.action === "import") return h.pcb.import({ apply: args.apply });
if (args.action === "rebuild") return h.pcb.rebuild();
if (args.action === "autoroute") return h.pcb.autoroute(args.props);
if (args.action === "unroute") {
  const ids = [...(await h.pcb.tracks({ net: args.net })).filter((t) => t.net && (t.layer <= 2 || (t.layer >= 15 && t.layer <= 44))).map((t) => t.id), ...(await h.pcb.vias({ net: args.net })).map((v) => v.id)];
  if (!ids.length) return { deleted: 0 };
  return h.pcb.draw([{ op: "delete", ids }], { guard: false });
}
throw new Error("unknown action: " + args.action);`,
				{ action, name, apply, props, net },
				{ timeoutMs: timeoutMs ?? 300000 },
			),
	},
	{
		name: "pcb_export",
		description:
			"Export from the active PCB to a file and return its path: gerber (zip for fabrication), pnp (pick and place csv), bom, netlist, step, obj (3D), dxf, dsn (for external routers), ipc356, ipc2581, odb, testpoints, info, altium, pads, view (picture of what the canvas shows). Nothing is ordered: EasyEDA's ordering functions are never called.",
		inputSchema: {
			type: "object",
			properties: {
				format: { type: "string", enum: ["gerber", "pnp", "bom", "netlist", "step", "obj", "dxf", "dsn", "ipc356", "ipc2581", "odb", "testpoints", "info", "altium", "pads", "pdf", "view"] },
				path: { type: "string", description: "Absolute file path or directory. Default: ~/.easyeda-mcp/out/" },
				options: { type: "object", description: "Passed to h.pcb.exportFile: {name?, type?, unit?, layers?, objects?, ...}." },
				timeoutMs: { type: "integer", description: "Default 180000." },
			},
			required: ["format"],
		},
		async handler({ format, path, options, timeoutMs }) {
			const reply = await link.exec(
				wrap(`const f = await h.pcb.exportFile(args.format, args.options || {}); if (!f) throw new Error("EasyEDA returned no file for " + args.format); return f;`),
				{ format, options },
				timeoutMs ?? 180000,
			);
			if (reply.ok && !(reply.value && reply.value.__blob)) {
				return present({ ...reply, ok: false, error: { message: "Export did not return a file: " + JSON.stringify(reply.value).slice(0, 300) } });
			}
			return present(reply, { saveTo: path });
		},
	},
];

// ---------- MCP over stdio ----------
const INSTRUCTIONS = `Bridge to a running EasyEDA Pro. Start with eda_status. Schematic: sch_read, sch_draw, sch_export; board: pcb_read, pcb_draw, pcb_do, pcb_export; parts: lib_search; anything else: eda_exec (JavaScript in the editor with helpers \`h\`) and eda_api (signatures, do not guess them). sch_draw and pcb_draw are all-or-nothing and guarded: a short on the schematic or a new rule error on the board takes the change back; use trial:true to see what a change would do. Prefer ONE call with many ops over many small calls. Still look at the result: sch_read what:'net' or 'check', sch_export png, pcb_read what:'drc'. Helper code lives in the server (server/helpers.js) and can be fixed without reinstalling the extension.`;

function send(msg) {
	process.stdout.write(JSON.stringify(msg) + "\n");
}

async function handle(msg) {
	const { id, method, params } = msg;
	const reply = (result) => id !== undefined && send({ jsonrpc: "2.0", id, result });
	const fail = (code, message) => id !== undefined && send({ jsonrpc: "2.0", id, error: { code, message } });
	switch (method) {
		case "initialize":
			return reply({
				protocolVersion: params?.protocolVersion || "2025-06-18",
				capabilities: { tools: {} },
				serverInfo: { name: "easyeda-mcp", version: VERSION },
				instructions: INSTRUCTIONS,
			});
		case "ping":
			return reply({});
		case "tools/list":
			return reply({ tools: tools.map(({ handler, ...t }) => t) });
		case "tools/call": {
			const tool = tools.find((t) => t.name === params?.name);
			if (!tool) return fail(-32602, `Unknown tool: ${params?.name}`);
			try {
				return reply(await tool.handler(params.arguments || {}));
			} catch (e) {
				return reply(text("ERROR: " + (e?.message || String(e)), true));
			}
		}
		case "resources/list":
			return reply({ resources: [] });
		case "prompts/list":
			return reply({ prompts: [] });
		default:
			if (id !== undefined) fail(-32601, `Method not found: ${method}`);
	}
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
	if (!line.trim()) return;
	let msg;
	try {
		msg = JSON.parse(line);
	} catch {
		return send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
	}
	if (Array.isArray(msg)) msg.forEach((m) => handle(m));
	else handle(msg);
});
rl.on("close", () => {
	link.close();
	process.exit(0);
});
process.on("uncaughtException", (e) => log("uncaught: " + (e?.stack || e)));
process.on("unhandledRejection", (e) => log("unhandled: " + (e?.stack || e)));
