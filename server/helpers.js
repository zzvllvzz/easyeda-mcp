// Helper library `h`, injected in front of every piece of code the server sends
// to EasyEDA. It lives in the server on purpose: fixing a helper never requires
// reinstalling the extension. Must stay a single function expression.
(eda, console, store) => {
	const h = {};
	const st = (o, name) => {
		const f = o && o["getState_" + name];
		return typeof f === "function" ? f.call(o) : o ? o[name.charAt(0).toLowerCase() + name.slice(1)] : undefined;
	};
	// A wire is read back as one flat array of segments, four numbers each
	// ([x1,y1,x2,y2, x1,y1,x2,y2, ...]), whatever polyline it was created from.
	const flat = (line) => {
		const a = Array.isArray(line) ? line.flat() : [];
		if (a.length % 4) return [a];
		const out = [];
		for (let i = 0; i < a.length; i += 4) out.push(a.slice(i, i + 4));
		return out;
	};
	const round = (n) => (typeof n === "number" ? Math.round(n * 1000) / 1000 : n);
	// Timers. In a hidden or minimized window the browser engine fires chained page
	// timers once a minute (measured on 3.2.209: twelve 100 ms pauses in a row took
	// minutes), which froze every polling loop. Timers inside a worker are not slowed
	// down, so pauses are timed by one worker shared between calls; page timers are
	// only the fallback when a worker cannot be started.
	const clock = (() => {
		const g = globalThis;
		const KEY = "__easyedaMcpClock__";
		const V = 2;
		if (g[KEY] && g[KEY].v === V) return g[KEY];
		// An older build of this clock gives the page its timers back before it is replaced.
		if (g[KEY] && typeof g[KEY].unpatchTimers === "function") g[KEY].unpatchTimers();
		const c = { v: V, seq: 0, waiting: new Map(), worker: null, error: "", timers: null, routed: 0 };
		const pageTimer = (fn, ms) => void setTimeout(fn, Math.max(0, ms));
		try {
			const src = "onmessage=function(e){var d=e.data;setTimeout(function(){postMessage(d[0])},d[1])}";
			const w = new Worker(URL.createObjectURL(new Blob([src], { type: "text/javascript" })));
			w.onmessage = (e) => {
				const job = c.waiting.get(e.data);
				if (!job) return;
				c.waiting.delete(e.data);
				job.fn();
			};
			w.onerror = (e) => {
				c.worker = null;
				c.error = String((e && e.message) || "worker failed");
				for (const job of c.waiting.values()) pageTimer(job.fn, job.due - Date.now());
				c.waiting.clear();
			};
			c.worker = w;
		} catch (e) {
			c.error = String((e && e.message) || e);
		}
		c.after = (ms, fn) => {
			ms = Math.max(0, Math.round(Number(ms) || 0));
			if (!c.worker) return pageTimer(fn, ms);
			const id = ++c.seq;
			c.waiting.set(id, { fn, due: Date.now() + ms });
			c.worker.postMessage([id, ms]);
		};
		// EasyEDA's own timers suffer in the same way: with the window hidden a netlist took
		// 53 s instead of 2 s and placing a part 24 s. So while the window is hidden the
		// page's setTimeout/setInterval are timed by the worker too. A visible window keeps
		// the browser's own timers: nothing changes while a person works in the editor.
		c.patchTimers = () => {
			if (c.timers || !c.worker || typeof document === "undefined") return;
			const native = { st: g.setTimeout, ct: g.clearTimeout, si: g.setInterval, ci: g.clearInterval };
			const jobs = new Set();
			let seq = 1e9; // far above the ids the browser hands out
			const mine = (fn) => c.worker && typeof fn === "function" && document.visibilityState === "hidden";
			g.setTimeout = function (fn, ms, ...args) {
				if (!mine(fn)) return native.st.call(g, fn, ms, ...args);
				const id = ++seq;
				jobs.add(id);
				c.routed++;
				c.after(ms, () => {
					if (jobs.delete(id)) fn.apply(g, args);
				});
				return id;
			};
			g.setInterval = function (fn, ms, ...args) {
				if (!mine(fn)) return native.si.call(g, fn, ms, ...args);
				const id = ++seq;
				jobs.add(id);
				c.routed++;
				const every = Math.max(1, Number(ms) || 0);
				const tick = () => {
					if (!jobs.has(id)) return;
					c.after(every, tick);
					fn.apply(g, args);
				};
				c.after(every, tick);
				return id;
			};
			const clear = (nativeClear) =>
				function (id) {
					if (typeof id === "number" && id > 1e9 && jobs.delete(id)) return undefined;
					return nativeClear.call(g, id);
				};
			g.clearTimeout = clear(native.ct);
			g.clearInterval = clear(native.ci);
			c.timers = { native, jobs };
		};
		c.unpatchTimers = () => {
			if (!c.timers) return;
			const n = c.timers.native;
			g.setTimeout = n.st;
			g.clearTimeout = n.ct;
			g.setInterval = n.si;
			g.clearInterval = n.ci;
			c.timers = null; // timers already routed still fire
		};
		g[KEY] = c;
		return c;
	})();
	if (!globalThis.__easyedaMcpNativeTimers__) clock.patchTimers();
	// h.pageTimers(false) gives the page the browser's timers back, h.pageTimers(true) routes them again.
	h.pageTimers = (on) => {
		globalThis.__easyedaMcpNativeTimers__ = !on;
		if (on) clock.patchTimers();
		else clock.unpatchTimers();
		return h.clock();
	};
	h.sleep = (ms) => new Promise((r) => clock.after(ms, r));
	// How pauses are timed right now: "worker" or "page" (sync).
	h.clock = () => ({
		by: clock.worker ? "worker" : "page",
		waiting: clock.waiting.size,
		pageTimers: clock.timers ? "by the worker while the window is hidden" : "browser",
		routed: clock.routed,
		error: clock.error,
	});

	// Run a promise with a time limit so one hanging EasyEDA call does not eat the whole budget.
	h.limit = (promise, ms, label) =>
		Promise.race([
			promise,
			new Promise((_, rej) => clock.after(ms, () => rej(new Error(`${label || "call"} timed out after ${ms} ms`)))),
		]);

	// ---------- context ----------
	h.ctx = async () => {
		const out = {};
		const tryGet = async (key, fn) => {
			try {
				out[key] = await h.limit(Promise.resolve(fn()), 5000, key);
			} catch (e) {
				out[key] = { error: String(e.message || e) };
			}
		};
		await tryGet("project", async () => {
			const p = await eda.dmt_Project.getCurrentProjectInfo();
			return p ? { uuid: p.uuid, name: p.friendlyName || p.name } : null;
		});
		await tryGet("document", () => eda.dmt_SelectControl.getCurrentDocumentInfo());
		await tryGet("schematic", async () => {
			const s = await eda.dmt_Schematic.getCurrentSchematicInfo();
			return s ? { uuid: s.uuid, name: s.name } : null;
		});
		await tryGet("page", async () => {
			const p = await eda.dmt_Schematic.getCurrentSchematicPageInfo();
			return p ? { uuid: p.uuid, name: p.name } : null;
		});
		return out;
	};

	h.pages = async () => {
		// The "current schematic" call throws while no schematic tab is open (project just
		// opened): fall back to every page of the project.
		let pages;
		try {
			pages = await eda.dmt_Schematic.getCurrentSchematicAllSchematicPagesInfo();
		} catch (e) {
			pages = null;
		}
		if (!pages || !pages.length) pages = await eda.dmt_Schematic.getAllSchematicPagesInfo();
		return (pages || []).map((p) => ({ uuid: p.uuid, name: p.name, schematic: p.parentSchematicUuid }));
	};

	h.openPage = async (uuidOrName) => {
		let pages = await h.pages();
		// Right after a project was opened the list is empty for a few seconds.
		for (let n = 0; n < 40 && !pages.length; n++) {
			await h.sleep(200);
			pages = await h.pages();
		}
		// Names come back as "cpu" from one API call and "CPU" from another: ignore case.
		const key = String(uuidOrName).toLowerCase();
		const page = pages.find((p) => p.uuid === uuidOrName) || pages.find((p) => String(p.name).toLowerCase() === key);
		if (!page) throw new Error(`No page '${uuidOrName}'. Pages: ${pages.map((p) => p.name).join(", ")}`);
		const tabId = await eda.dmt_EditorControl.openDocument(page.uuid);
		return { ...page, tabId };
	};

	// ---------- reading ----------
	const pinOut = (p) => ({
		id: st(p, "PrimitiveId"),
		num: st(p, "PinNumber"),
		name: st(p, "PinName"),
		x: round(st(p, "X")),
		y: round(st(p, "Y")),
		rot: st(p, "Rotation"),
		len: st(p, "PinLength"),
		nc: st(p, "NoConnected") || undefined,
	});
	const partOut = (c) => ({
		id: st(c, "PrimitiveId"),
		type: st(c, "ComponentType"),
		des: st(c, "Designator") || undefined,
		name: st(c, "Name") || undefined,
		net: st(c, "Net") || undefined,
		x: round(st(c, "X")),
		y: round(st(c, "Y")),
		rot: st(c, "Rotation") || 0,
		mirror: st(c, "Mirror") || undefined,
		sub: st(c, "SubPartName") || undefined,
		lcsc: st(c, "SupplierId") || undefined,
	});
	const wireOut = (w) => ({
		id: st(w, "PrimitiveId"),
		net: st(w, "Net") || "",
		line: flat(st(w, "Line")).map((seg) => seg.map(round)),
	});

	h.parts = async (opts = {}) => {
		const all = await eda.sch_PrimitiveComponent.getAll(opts.type, !!opts.allPages);
		let parts = (all || []).map(partOut);
		if (opts.type === undefined && !opts.everything) parts = parts.filter((p) => p.type !== "sheet");
		if (opts.des) {
			const want = new Set([].concat(opts.des));
			parts = parts.filter((p) => want.has(p.des));
		}
		if (opts.region) {
			const [x1, y1, x2, y2] = opts.region;
			parts = parts.filter(
				(p) => p.x >= Math.min(x1, x2) && p.x <= Math.max(x1, x2) && p.y >= Math.min(y1, y2) && p.y <= Math.max(y1, y2),
			);
		}
		if (opts.pins) {
			for (const p of parts) {
				if (p.type !== "part" && !opts.allPins) continue;
				const pins = await eda.sch_PrimitiveComponent.getAllPinsByPrimitiveId(p.id);
				p.pins = (pins || []).map(pinOut);
			}
		}
		return parts;
	};

	h.part = async (desOrId) => {
		const parts = await h.parts({ pins: true, allPins: true, everything: true });
		const p = parts.find((x) => x.des === desOrId || x.id === desOrId);
		if (!p) throw new Error(`No component '${desOrId}' on this page`);
		return p;
	};

	h.wires = async (net) => ((await eda.sch_PrimitiveWire.getAll(net)) || []).map(wireOut);

	// Wait until the page's wire list knows the given new wires (it is updated about a
	// second after creation; reading the list earlier misses them). Use after creating
	// wires with the raw API; h.draw does it itself. Resolves to true when all are listed.
	h.settle = async (wireIds, ms = 4000) => {
		const W = eda.sch_PrimitiveWire;
		let want = [...new Set([].concat(wireIds || []).filter(Boolean))];
		// A wire merged into a neighbour no longer exists under its own id: do not wait for it.
		if (want.length) want = ((await W.get(want)) || []).filter(Boolean).map((w) => st(w, "PrimitiveId"));
		const list = async () => (typeof W.getAllPrimitiveId === "function" ? await W.getAllPrimitiveId() : ((await W.getAll()) || []).map((w) => st(w, "PrimitiveId"))) || [];
		const start = Date.now();
		for (;;) {
			const have = new Set(await list());
			if (want.every((id) => have.has(id))) return true;
			if (Date.now() - start > ms) return false;
			await h.sleep(60);
		}
	};

	// Everything on the current page in a compact form.
	h.snapshot = async (opts = {}) => {
		const parts = await h.parts({ pins: opts.pins !== false, region: opts.region, everything: true, allPins: opts.allPins });
		let wires = await h.wires();
		if (opts.region) {
			const [x1, y1, x2, y2] = opts.region;
			const inside = (x, y) => x >= Math.min(x1, x2) && x <= Math.max(x1, x2) && y >= Math.min(y1, y2) && y <= Math.max(y1, y2);
			wires = wires.filter((w) => w.line.some((seg) => seg.some((_, i) => i % 2 === 0 && inside(seg[i], seg[i + 1]))));
		}
		return {
			page: (await h.ctx()).page,
			parts: parts.filter((p) => p.type === "part"),
			flags: parts.filter((p) => p.type !== "part" && p.type !== "sheet"),
			wires,
		};
	};

	// ---------- netlist ----------
	h.parsePads = (text) => {
		const nets = {};
		let cur = null;
		for (const line of String(text).split(/\r?\n/)) {
			const m = /^\*SIGNAL\*\s+(\S+)/.exec(line);
			if (m) {
				cur = m[1];
				nets[cur] = nets[cur] || [];
				continue;
			}
			if (line.startsWith("*")) {
				cur = null;
				continue;
			}
			if (cur) nets[cur].push(...line.split(/\s+/).filter(Boolean));
		}
		return nets;
	};

	// {net: ["U1.3", "R2.1"]} for the whole schematic (all pages), from the native PADS netlist.
	h.nets = async (opts = {}) => {
		let text = await eda.sch_Netlist.getNetlist("PADS");
		if (text && typeof text !== "string" && typeof text.text === "function") text = await text.text();
		const nets = h.parsePads(text);
		// A schematic with nothing connected yet has a netlist without nets.
		if (opts.allowEmpty && String(text).includes("*PART*")) return nets;
		if (!Object.keys(nets).length) throw new Error("PADS netlist came back without *SIGNAL* sections: " + String(text).slice(0, 300));
		return nets;
	};

	// What is connected to a net, or to which net a pin ("U1.3") belongs.
	h.net = async (nameOrPin) => {
		const nets = await h.nets();
		const key = String(nameOrPin);
		if (nets[key]) return { net: key, nodes: nets[key] };
		const upper = Object.keys(nets).find((n) => n.toUpperCase() === key.toUpperCase());
		if (upper) return { net: upper, nodes: nets[upper] };
		for (const [net, nodes] of Object.entries(nets)) if (nodes.includes(key)) return { net, nodes };
		return { net: null, nodes: [], note: `'${key}' is neither a net name nor a connected pin` };
	};

	// Compare the real netlist with an expectation: {NET: ["U1.3", ...]}.
	// Net names are compared case-insensitively; unnamed expectations can use any key starting with "?".
	h.checkNets = async (expected, nets) => {
		nets = nets || (await h.nets());
		const byPin = {};
		for (const [net, nodes] of Object.entries(nets)) for (const n of nodes) byPin[n] = net;
		const problems = [];
		for (const [name, nodes] of Object.entries(expected)) {
			const actualNets = [...new Set(nodes.map((n) => byPin[n] || "(unconnected)"))];
			if (actualNets.length !== 1) {
				problems.push({ net: name, problem: "split", detail: Object.fromEntries(nodes.map((n) => [n, byPin[n] || null])) });
				continue;
			}
			const actual = actualNets[0];
			if (actual === "(unconnected)") {
				problems.push({ net: name, problem: "unconnected", nodes });
				continue;
			}
			if (!name.startsWith("?") && actual.toUpperCase() !== name.toUpperCase())
				problems.push({ net: name, problem: "wrong name", actual });
			const extra = nets[actual].filter((n) => !nodes.includes(n));
			if (extra.length) problems.push({ net: name, problem: "extra nodes (short?)", actual, extra });
		}
		return { ok: problems.length === 0, checked: Object.keys(expected).length, problems };
	};

	// ---------- library ----------
	const lcscSeen = new Map();
	h.lcsc = async (ids) => {
		const list = [].concat(ids);
		const ask = [...new Set(list.filter((id) => !lcscSeen.has(id)))];
		const found = ask.length ? (await eda.lib_Device.getByLcscIds(ask)) || [] : [];
		const out = {};
		for (const id of list) if (lcscSeen.has(id)) out[id] = lcscSeen.get(id);
		for (const d of found) {
			const id = d.supplierId || d.lcsc || (d.otherProperty && d.otherProperty["Supplier Part"]) || d.name;
			out[id] = { uuid: d.uuid, libraryUuid: d.libraryUuid, name: d.name };
			lcscSeen.set(id, out[id]);
		}
		const missing = list.filter((id) => !out[id]);
		return { found: out, missing, raw: missing.length && found.length ? found.map((d) => ({ uuid: d.uuid, name: d.name })) : undefined };
	};

	// Search the device library by words: [{name, lcsc, footprint, uuid, libraryUuid, ...}].
	// The result goes straight into {op:"part", device:{uuid, libraryUuid}}.
	h.search = async (key, opts = {}) => {
		const found = (await eda.lib_Device.search(String(key), opts.libraryUuid, undefined, undefined, opts.limit || 10, opts.page || 1)) || [];
		return found.map((d) => {
			const o = d.otherProperty || {};
			return {
				name: d.name,
				lcsc: d.supplierId || o["Supplier Part"] || undefined,
				footprint: d.footprintName || undefined,
				maker: d.manufacturerId || o["Manufacturer Part"] || undefined,
				value: o.Value || undefined,
				cls: o["JLCPCB Part Class"] || undefined,
				desc: opts.desc === false ? undefined : String(d.description || o["LCSC Part Name"] || "").slice(0, opts.descChars || 120) || undefined,
				datasheet: opts.datasheet ? o.Datasheet || undefined : undefined,
				uuid: d.uuid,
				libraryUuid: d.libraryUuid,
			};
		});
	};

	// ---------- layout ----------
	const box = (b) => (b ? [round(b.minX), round(b.minY), round(b.maxX), round(b.maxY)] : null);
	const grow = (b, m) => [b[0] - m, b[1] - m, b[2] + m, b[3] + m];
	const hit = (a, b) => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];
	const union = (a, b) => (!a ? b : !b ? a : [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])]);

	// Everything that takes room on the page, as rectangles [x1,y1,x2,y2] (y points up):
	//   {sheet, items:[{kind:"part"|"flag"|"port"|"wire"|"text"|"shape", id, name, box, body?, labels?}]}
	// A part's box covers its body, its pins and its visible labels.
	h.boxes = async (opts = {}) => {
		const P = eda.sch_Primitive;
		const C = eda.sch_PrimitiveComponent;
		const items = [];
		let sheet = null;
		for (const c of (await C.getAll()) || []) {
			const id = st(c, "PrimitiveId");
			const type = st(c, "ComponentType");
			const body = box(await P.getPrimitivesBBox([id]));
			if (type === "sheet") {
				sheet = body;
				continue;
			}
			let all = body;
			const labels = [];
			if (type === "part") {
				for (const p of (await C.getAllPinsByPrimitiveId(id)) || []) {
					const x = st(p, "X");
					const y = st(p, "Y");
					all = union(all, [x, y, x, y]);
				}
			}
			if (opts.labels !== false) {
				for (const a of (await eda.sch_PrimitiveAttribute.getAll(id)) || []) {
					if (st(a, "X") === null || st(a, "X") === undefined) continue;
					if (!st(a, "ValueVisible") && !st(a, "KeyVisible")) continue;
					const b = box(await P.getPrimitivesBBox([st(a, "PrimitiveId")]));
					if (!b || (b[0] === b[2] && b[1] === b[3])) continue;
					labels.push({ key: st(a, "Key"), box: b });
					all = union(all, b);
				}
			}
			items.push({ kind: type === "part" ? "part" : type === "netport" ? "port" : "flag", id, name: st(c, "Designator") || st(c, "Net") || st(c, "Name") || "", box: all, body, labels: labels.length ? labels : undefined });
		}
		for (const w of (await eda.sch_PrimitiveWire.getAll()) || []) {
			for (const sg of segs(w)) items.push({ kind: "wire", id: st(w, "PrimitiveId"), name: st(w, "Net") || "", box: [Math.min(sg[0], sg[2]), Math.min(sg[1], sg[3]), Math.max(sg[0], sg[2]), Math.max(sg[1], sg[3])], seg: sg });
		}
		for (const [kind, api] of [
			["text", eda.sch_PrimitiveText],
			["shape", eda.sch_PrimitiveRectangle],
			["shape", eda.sch_PrimitiveCircle],
			["shape", eda.sch_PrimitivePolygon],
		]) {
			let ids = [];
			try {
				ids = (await api.getAllPrimitiveId()) || [];
			} catch (e) {
				/* not on this kind of page */
			}
			for (const id of ids) {
				const b = box(await P.getPrimitivesBBox([id]));
				if (b) items.push({ kind, id, name: "", box: b });
			}
		}
		return { sheet, items };
	};

	// Things lying on top of each other on the page:
	//   parts   two parts, flags or ports whose bodies overlap
	//   labels  a visible label (designator, value) covered by another part or another label
	//   wires   a wire running through the body of a part it is not connected to at that point
	h.overlaps = async () => {
		const { items } = await h.boxes();
		const comps = items.filter((i) => i.kind === "part" || i.kind === "flag" || i.kind === "port");
		const out = { parts: [], labels: [], wires: [] };
		const inset = (b) => [b[0] + 1, b[1] + 1, b[2] - 1, b[3] - 1];
		for (let i = 0; i < comps.length; i++) {
			for (let k = i + 1; k < comps.length; k++) {
				const a = comps[i];
				const b = comps[k];
				if (a.body && b.body && hit(inset(a.body), inset(b.body))) out.parts.push([a.name || a.id, b.name || b.id]);
			}
		}
		const labels = comps.flatMap((c) => (c.labels || []).map((l) => ({ of: c.name || c.id, id: c.id, key: l.key, box: l.box })));
		for (let i = 0; i < labels.length; i++) {
			const l = labels[i];
			for (const c of comps) if (c.id !== l.id && c.body && hit(inset(l.box), inset(c.body))) out.labels.push({ label: `${l.of} ${l.key}`, over: c.name || c.id });
			for (let k = i + 1; k < labels.length; k++) if (hit(inset(l.box), inset(labels[k].box))) out.labels.push({ label: `${l.of} ${l.key}`, over: `${labels[k].of} ${labels[k].key}` });
		}
		for (const w of items.filter((i) => i.kind === "wire")) {
			const thin = [w.box[0] - 0.1, w.box[1] - 0.1, w.box[2] + 0.1, w.box[3] + 0.1];
			for (const c of comps) if (c.kind === "part" && c.body && hit(thin, inset(c.body))) out.wires.push({ wire: w.id, net: w.name, through: c.name || c.id, seg: w.seg });
		}
		out.ok = !out.parts.length && !out.labels.length && !out.wires.length;
		return out;
	};

	// Free room for a block of w x h units: up to `count` rectangles [x1,y1,x2,y2] that touch
	// nothing on the page, searched from the top left corner. opts: {margin=20, step=10,
	// region:[x1,y1,x2,y2], avoid:[[x1,y1,x2,y2],...], count=1}. The title block in the
	// bottom right corner of the sheet is kept clear.
	h.free = async (w, hgt, opts = {}) => {
		const { sheet, items } = await h.boxes();
		const margin = opts.margin === undefined ? 20 : opts.margin;
		const step = opts.step || 10;
		const area = opts.region || (sheet ? [sheet[0] + 20, sheet[1] + 20, sheet[2] - 20, sheet[3] - 20] : [20, 20, 1150, 805]);
		const taken = items.map((i) => grow(i.box, margin));
		if (sheet && opts.titleBlock !== false) taken.push([sheet[2] - 720, sheet[1], sheet[2], sheet[1] + 215]);
		for (const a of opts.avoid || []) taken.push(a);
		const found = [];
		for (let top = area[3]; top - hgt >= area[1] && found.length < (opts.count || 1); top -= step) {
			for (let left = area[0]; left + w <= area[2]; left += step) {
				const r = [left, top - hgt, left + w, top];
				if (taken.some((t) => hit(r, t))) continue;
				found.push(r);
				taken.push(grow(r, margin));
				if (found.length >= (opts.count || 1)) break;
			}
		}
		return { found, sheet };
	};

	// Checks on the schematic. EasyEDA's own rule check gives only the number of findings
	// per severity through the API (the list is in its DRC panel; ui:true fills the panel).
	// The rest is worked out here from the netlist and the current page:
	//   floating   pins of this page on no net and not marked "not connected"
	//   single     named nets with one pin only (a misspelt net name looks like this)
	//   unnumbered parts of this page still called "R?"
	//   duplicates designators used twice on this page
	h.erc = async (opts = {}) => {
		const out = {};
		try {
			const native = await h.limit(eda.sch_Drc.check(!!opts.strict, !!opts.ui, true), 30000, "rule check");
			out.easyeda = Array.isArray(native) ? Object.fromEntries(native.map((e) => [e.type, e.count !== undefined ? e.count : (e.rule || "") + (e.net ? " " + e.net : "")])) : native;
		} catch (e) {
			out.easyeda = { error: String(e.message || e) };
		}
		const nets = await h.nets({ allowEmpty: true });
		const onNet = new Set(Object.values(nets).flat());
		const parts = (await h.parts({ pins: true })).filter((p) => !p.type || p.type === "part");
		out.floating = [];
		out.unnumbered = [];
		const seen = new Map();
		for (const p of parts) {
			if (!p.des || /\?$/.test(p.des)) out.unnumbered.push(p.des || p.id);
			else seen.set(p.des, (seen.get(p.des) || 0) + 1);
			for (const pin of p.pins || []) if (!pin.nc && !onNet.has(`${p.des}.${pin.num}`)) out.floating.push(`${p.des}.${pin.num}`);
		}
		// Parts of a multi-part device share a designator: those are not duplicates.
		const subs = new Map();
		for (const p of parts) if (p.des) subs.set(p.des, (subs.get(p.des) || new Set()).add(p.sub || ""));
		out.duplicates = [...seen].filter(([d, n]) => n > 1 && subs.get(d).size < n).map(([d]) => d);
		out.single = Object.entries(nets)
			.filter(([n, nodes]) => nodes.length === 1 && !AUTO_NET.test(n))
			.map(([n, nodes]) => `${n}: ${nodes[0]}`);
		out.ok = !out.floating.length && !out.unnumbered.length && !out.duplicates.length && !out.single.length;
		if (!opts.verbose) for (const k of ["floating", "single"]) if (out[k].length > 25) out[k] = { count: out[k].length, first: out[k].slice(0, 25) };
		return out;
	};

	// ---------- writing ----------
	const resolvePart = async (ref) => {
		if (typeof ref !== "string") return ref;
		const parts = await eda.sch_PrimitiveComponent.getAll();
		const hit = (parts || []).find((c) => st(c, "Designator") === ref || st(c, "PrimitiveId") === ref);
		if (!hit) throw new Error(`No component '${ref}' on this page`);
		return st(hit, "PrimitiveId");
	};

	// Editor 3.2.209: for a moment after a netlist was generated the editor takes no
	// changes: modify() throws "Cannot destructure property 'cmdKey'", a wire create()
	// throws "create failed!" and delete() quietly returns false. The same call repeated
	// a little later goes through.
	const WAITS = [150, 300, 600, 1200, 2000];
	const retry = async (fn, busy = /cmdKey/) => {
		for (let n = 0; ; n++) {
			try {
				return await fn();
			} catch (e) {
				if (n >= WAITS.length || !busy.test(String(e && e.message))) throw e;
				await h.sleep(WAITS[n]);
			}
		}
	};
	// A wire that is refused for good (a zero-length one) gives the same "create failed!":
	// tell those apart before trying.
	const newWire = (line, net) => {
		const pts = Array.isArray(line) ? line.flat() : [];
		if (pts.length < 4 || pts.length % 2) throw new Error("a wire needs [x1,y1,x2,y2,...]");
		let moves = false;
		for (let i = 2; i < pts.length; i += 2) if (pts[i] !== pts[0] || pts[i + 1] !== pts[1]) moves = true;
		if (!moves) throw new Error("a wire of zero length cannot be created");
		return retry(() => eda.sch_PrimitiveWire.create(line, net || undefined), /cmdKey|create failed/);
	};
	// delete() with the same patience; in the end make sure the primitives are gone.
	const del = async (api, ids) => {
		ids = [].concat(ids || []).filter(Boolean);
		if (!ids.length) return true;
		for (let n = 0; n <= WAITS.length; n++) {
			let ok;
			try {
				ok = await api.delete(ids);
			} catch (e) {
				if (!/cmdKey/.test(String(e && e.message))) throw e;
				ok = false;
			}
			if (ok !== false) return true;
			// false is also the answer when there is nothing to delete
			if (!((await api.get(ids)) || []).filter(Boolean).length) return true;
			if (n < WAITS.length) await h.sleep(WAITS[n]);
		}
		const left = ((await api.get(ids)) || []).filter(Boolean);
		if (left.length) throw new Error(`EasyEDA refused to delete ${left.length} of ${ids.length} primitives`);
		return true;
	};
	const modPart = (id, prop) => retry(() => eda.sch_PrimitiveComponent.modify(id, prop));
	const modWire = (id, prop) => retry(() => eda.sch_PrimitiveWire.modify(id, prop));

	const segs = (w) => flat(st(w, "Line")).map((s) => s.map(round));
	// The same set of segments whatever their order and direction.
	const segKey = (lines) =>
		lines
			.map((s) => (s[0] < s[2] || (s[0] === s[2] && s[1] <= s[3]) ? s : [s[2], s[3], s[0], s[1]]).join(","))
			.sort()
			.join(";");
	// EasyEDA keeps a zero-length wire under a net flag that sits on a pin end, and refuses
	// to create one ("create failed!"): such segments are its own business.
	const nonZero = (lines) => lines.filter((s) => s[0] !== s[2] || s[1] !== s[3]);
	const makeWire = async (lines, net) => {
		lines = nonZero(lines);
		if (!lines.length) return null;
		return newWire(lines.length === 1 ? lines[0] : lines, net);
	};
	const cap = (k) => k.charAt(0).toUpperCase() + k.slice(1);

	// Net flags and net ports. They cannot be modified at all ("only parts"), so a wrong
	// one is deleted and created again.
	const makeFlag = async (o, j = {}) => {
		const C = eda.sch_PrimitiveComponent;
		const rot = (((o.rot || 0) % 360) + 360) % 360;
		const make = (r) => (o.op === "port" ? C.createNetPort(o.dir || "BI", o.net, o.x, o.y, r, !!o.mirror) : C.createNetFlag(o.kind || "Ground", o.net, o.x, o.y, r, !!o.mirror));
		let c = await make(rot);
		if (!c) throw new Error(`${o.op === "port" ? "createNetPort" : "createNetFlag"} returned nothing`);
		let id = st(c, "PrimitiveId");
		j.undo = () => del(C, [id]);
		// Editor 3.2.209 stores 90 as 270 and 270 as 90 here too: ask for the mirrored angle.
		let back = await C.get(id);
		if (rot && back && (st(back, "Rotation") || 0) !== rot) {
			await del(C, [id]);
			c = await make((360 - rot) % 360);
			if (!c) throw new Error("the flag could not be created again with the right rotation");
			id = st(c, "PrimitiveId");
			back = await C.get(id);
			if (back && (st(back, "Rotation") || 0) !== rot) throw new Error(`rotation is ${st(back, "Rotation")}, asked ${rot}`);
		}
		return id;
	};
	const FLAG_KIND = { "Ground-GND": "Ground", "Ground-AGND": "AnalogGround", "Ground-PGND": "ProtectGround" };
	// What makeFlag needs to create the same flag or port again.
	const flagInfo = (c) => {
		const type = st(c, "ComponentType");
		const name = String((st(c, "Component") || {}).name || "");
		const base = { id: st(c, "PrimitiveId"), net: st(c, "Net") || st(c, "Name") || "", x: st(c, "X"), y: st(c, "Y"), rot: st(c, "Rotation") || 0, mirror: !!st(c, "Mirror") };
		if (type === "netflag") return { ...base, op: "flag", kind: FLAG_KIND[name] || (name.startsWith("Power") ? "Power" : "Ground") };
		if (type === "netport") return { ...base, op: "port", dir: (/Netport-(IN|OUT|BI)/.exec(name) || [0, "BI"])[1] };
		return null;
	};

	// Every op gets a journal entry `j` and leaves in `j.undo` how to take itself back
	// (or says in `j.why` that it cannot be taken back).
	const ops = {
		// {op:"wire", line:[x1,y1,x2,y2,...], net?}
		async wire(o, j = {}) {
			const w = await newWire(o.line, o.net);
			if (!w) {
				// EasyEDA merges a wire into a collinear neighbour of the same net and returns nothing.
				return { note: "no primitive returned (probably merged into an existing wire); verify with h.net()" };
			}
			const id = st(w, "PrimitiveId");
			j.undo = () => del(eda.sch_PrimitiveWire, [id]);
			return { id, net: st(w, "Net") || "" };
		},
		// {op:"part", device:{libraryUuid, uuid} | lcsc:"C1234", x, y, rot?, mirror?, sub?, des?}
		async part(o, j = {}) {
			let device = o.device;
			if (!device && o.lcsc) {
				const r = await h.lcsc(o.lcsc);
				device = r.found[o.lcsc];
				if (!device) throw new Error(`LCSC ${o.lcsc} not found in the library`);
			}
			if (!device) throw new Error("part needs `device` {libraryUuid, uuid} or `lcsc`");
			const rot = (((o.rot || 0) % 360) + 360) % 360;
			const c = await eda.sch_PrimitiveComponent.create(device, o.x, o.y, o.sub, rot, !!o.mirror, o.bom !== false, o.pcb !== false);
			if (!c) throw new Error("create returned nothing");
			const id = st(c, "PrimitiveId");
			j.undo = () => del(eda.sch_PrimitiveComponent, [id]);
			// Editor 3.2.209: create() stores 90 as 270 and 270 as 90 (the returned object lies),
			// while modify() is consistent with what is read back. Read back and correct.
			// (Every call gets slower as the page fills up, so an unrotated part is not read back.)
			let back = rot ? await eda.sch_PrimitiveComponent.get(id) : c;
			if (rot && st(back, "Rotation") !== rot) {
				await modPart(id, { rotation: rot });
				back = await eda.sch_PrimitiveComponent.get(id);
				if (st(back, "Rotation") !== rot) throw new Error(`rotation is ${st(back, "Rotation")}, asked ${rot}`);
			}
			// Without `des` the part stays "R?" for now; h.draw numbers such parts at the end.
			if (o.des) await modPart(id, { designator: o.des });
			return { id, des: o.des || st(back, "Designator") || "" };
		},
		// {op:"flag", kind:"Ground"|"Power"|"AnalogGround"|"ProtectGround", net, x, y, rot?}
		async flag(o, j = {}) {
			const id = await makeFlag({ ...o, op: "flag" }, j);
			return { id };
		},
		// {op:"port", dir:"IN"|"OUT"|"BI", net, x, y, rot?}
		async port(o, j = {}) {
			const id = await makeFlag({ ...o, op: "port" }, j);
			return { id };
		},
		// {op:"move", part:"R1"|id, x?, y?, rot?, mirror?}  (native modify: no "connected move" refusal)
		async move(o, j = {}) {
			const id = await resolvePart(o.part);
			const was = await eda.sch_PrimitiveComponent.get(id);
			const prev = { x: st(was, "X"), y: st(was, "Y"), rotation: st(was, "Rotation") || 0, mirror: !!st(was, "Mirror") };
			const prop = {};
			for (const k of ["x", "y", "mirror"]) if (o[k] !== undefined) prop[k] = o[k];
			if (o.rot !== undefined) prop.rotation = o.rot;
			j.undo = () => modPart(id, prev);
			await modPart(id, prop);
			const c = await eda.sch_PrimitiveComponent.get(id);
			return { id, x: round(st(c, "X")), y: round(st(c, "Y")), rot: st(c, "Rotation") };
		},
		// {op:"set", part:"R1"|id, props:{designator?, name?, ...}}
		async set(o, j = {}) {
			const id = await resolvePart(o.part);
			const was = await eda.sch_PrimitiveComponent.get(id);
			const prev = {};
			for (const k of Object.keys(o.props || {})) {
				if (k === "otherProperty") {
					const old = st(was, "OtherProperty") || {};
					prev.otherProperty = Object.fromEntries(Object.keys(o.props.otherProperty || {}).map((p) => [p, old[p] === undefined ? "" : old[p]]));
				} else {
					const v = st(was, cap(k));
					prev[k] = v === undefined ? null : v;
				}
			}
			j.undo = () => modPart(id, prev);
			await modPart(id, o.props);
			return { id };
		},
		// {op:"nc", pin: pinPrimitiveId | "U1.3", value?: true}
		async nc(o, j = {}) {
			let pinId = o.pin;
			const m = /^([^.]+)\.(.+)$/.exec(String(o.pin));
			if (m) {
				const part = await h.part(m[1]);
				const pin = part.pins.find((p) => String(p.num) === m[2] || p.name === m[2]);
				if (!pin) throw new Error(`No pin ${m[2]} on ${m[1]}`);
				pinId = pin.id;
			}
			// Editor 3.2.209: pin modify() without `y` flips the sign of the pin's y (the pin
			// jumps off the part). Always pass the current y, then read back.
			const before = await eda.sch_PrimitivePin.get(pinId);
			if (!before) throw new Error(`No pin ${pinId}`);
			const y = st(before, "Y");
			const prev = !!st(before, "NoConnected");
			j.undo = () => eda.sch_PrimitivePin.modify(pinId, { noConnected: prev, y });
			await retry(() => eda.sch_PrimitivePin.modify(pinId, { noConnected: o.value !== false, y }));
			let after = await eda.sch_PrimitivePin.get(pinId);
			if (Math.abs(st(after, "Y") - y) > 0.01) {
				await retry(() => eda.sch_PrimitivePin.modify(pinId, { y }));
				after = await eda.sch_PrimitivePin.get(pinId);
				if (Math.abs(st(after, "Y") - y) > 0.01) throw new Error(`pin ${pinId} moved to y=${st(after, "Y")}, was ${y}`);
			}
			return { id: pinId, nc: !!st(after, "NoConnected") };
		},
		// {op:"unname", wire:id}  remove the net name (and its label) from a wire
		async unname(o, j = {}) {
			const was = await eda.sch_PrimitiveWire.get(o.wire);
			if (!was) throw new Error(`No wire ${o.wire}`);
			const saved = { lines: segs(was), net: st(was, "Net") || "" };
			// A name cannot be put back with modify(): the wire is drawn again.
			j.undo = async (u) => {
				await del(eda.sch_PrimitiveWire, [o.wire]);
				const w = await makeWire(saved.lines, saved.net);
				if (u && w) u.reborn.set(o.wire, st(w, "PrimitiveId"));
			};
			await modWire(o.wire, { net: "" });
			const w = await eda.sch_PrimitiveWire.get(o.wire);
			const net = w ? st(w, "Net") || "" : "";
			if (net) throw new Error(`wire still named '${net}'`);
			return { id: o.wire };
		},
		// {op:"rewire", wire:id, line:[...]}  change geometry while keeping the net name
		// (native modify({line}) erases the name, so delete and create again).
		async rewire(o, j = {}) {
			const was = await eda.sch_PrimitiveWire.get(o.wire);
			if (!was) throw new Error(`No wire ${o.wire}`);
			const saved = { lines: segs(was), net: st(was, "Net") || "" };
			const net = o.net !== undefined ? o.net : saved.net;
			let newId = null;
			j.undo = async (u) => {
				if (newId) await del(eda.sch_PrimitiveWire, [newId]);
				const w = await makeWire(saved.lines, saved.net);
				if (u && w) u.reborn.set(o.wire, st(w, "PrimitiveId"));
			};
			await del(eda.sch_PrimitiveWire, [o.wire]);
			const r = await ops.wire({ line: o.line, net });
			newId = r.id || null;
			return r;
		},
		// {op:"delete", wires?:[ids], parts?:[ids or designators], others?:[ids of texts and shapes]}
		async delete(o, j = {}) {
			const out = {};
			const undos = [];
			if (o.wires && o.wires.length) {
				const was = ((await eda.sch_PrimitiveWire.get(o.wires)) || []).filter(Boolean).map((w) => ({ id: st(w, "PrimitiveId"), lines: segs(w), net: st(w, "Net") || "" }));
				undos.push(async (u) => {
					for (const s of was) {
						const w = await makeWire(s.lines, s.net);
						if (u && w) u.reborn.set(s.id, st(w, "PrimitiveId"));
					}
				});
				j.undo = async (u) => {
					for (const f of undos) await f(u);
				};
				out.wires = await del(eda.sch_PrimitiveWire, o.wires);
			}
			if (o.parts && o.parts.length) {
				const ids = [];
				for (const p of o.parts) ids.push(await resolvePart(p));
				out.parts = await del(eda.sch_PrimitiveComponent, ids);
				j.why = "deleted parts cannot be put back";
			}
			if (o.others && o.others.length) {
				for (const id of o.others) {
					const type = await eda.sch_Primitive.getPrimitiveTypeByPrimitiveId(id);
					const cls = { Text: "sch_PrimitiveText", Rectangle: "sch_PrimitiveRectangle", Circle: "sch_PrimitiveCircle", Polygon: "sch_PrimitivePolygon" }[cap(String(type || "").toLowerCase())];
					if (!cls) throw new Error(`primitive ${id} is '${type}', not a text or a shape`);
					await del(eda[cls], [id]);
				}
				out.others = true;
				j.why = j.why || "deleted texts and shapes cannot be put back";
			}
			return out;
		},
		// {op:"text", x, y, text, rot?, size?, color?, font?, bold?, italic?, underline?, align?}
		async text(o, j = {}) {
			const t = await eda.sch_PrimitiveText.create(o.x, o.y, String(o.text), o.rot || 0, o.color, o.font, o.size, o.bold, o.italic, o.underline, o.align);
			if (!t) throw new Error("text create returned nothing");
			const id = st(t, "PrimitiveId");
			j.undo = () => del(eda.sch_PrimitiveText, [id]);
			return { id };
		},
		// {op:"rect", x, y, w, h, r?, color?, fill?, width?, lineType?, fillStyle?}  x,y is the top left corner (y points up)
		async rect(o, j = {}) {
			const r = await eda.sch_PrimitiveRectangle.create(o.x, o.y, o.w, o.h, o.r || 0, o.rot || 0, o.color, o.fill, o.width, o.lineType, o.fillStyle);
			if (!r) throw new Error("rectangle create returned nothing");
			const id = st(r, "PrimitiveId");
			j.undo = () => del(eda.sch_PrimitiveRectangle, [id]);
			return { id };
		},
		// {op:"circle", x, y, r, color?, fill?, width?, lineType?, fillStyle?}
		async circle(o, j = {}) {
			const c = await eda.sch_PrimitiveCircle.create(o.x, o.y, o.r, o.color, o.fill, o.width, o.lineType, o.fillStyle);
			if (!c) throw new Error("circle create returned nothing");
			const id = st(c, "PrimitiveId");
			j.undo = () => del(eda.sch_PrimitiveCircle, [id]);
			return { id };
		},
		// {op:"line", line:[x1,y1,x2,y2,...], color?, fill?, width?, lineType?}  a drawing line, not a wire
		async line(o, j = {}) {
			const p = await eda.sch_PrimitivePolygon.create(o.line, o.color, o.fill, o.width, o.lineType);
			if (!p) throw new Error("polygon create returned nothing");
			const id = st(p, "PrimitiveId");
			j.undo = () => del(eda.sch_PrimitivePolygon, [id]);
			return { id };
		},
		// {op:"attr", part:"R1"|id, key:"Designator"|"Name"|..., x?, y?, rot?, value?, visible?, keyVisible?}
		// moves or edits one text attribute of a part (its designator or value label).
		async attr(o, j = {}) {
			const id = await resolvePart(o.part);
			const all = (await eda.sch_PrimitiveAttribute.getAll(id)) || [];
			const a = all.find((x) => String(st(x, "Key")).toLowerCase() === String(o.key).toLowerCase());
			if (!a) throw new Error(`No attribute '${o.key}' on ${o.part}. Attributes: ${all.map((x) => st(x, "Key")).join(", ")}`);
			const aid = st(a, "PrimitiveId");
			const prev = { x: st(a, "X"), y: st(a, "Y"), rotation: st(a, "Rotation") || 0, value: st(a, "Value"), valueVisible: st(a, "ValueVisible"), keyVisible: st(a, "KeyVisible") };
			const prop = {};
			for (const k of ["x", "y", "value", "keyVisible"]) if (o[k] !== undefined) prop[k] = o[k];
			if (o.rot !== undefined) prop.rotation = o.rot;
			if (o.visible !== undefined) prop.valueVisible = o.visible;
			// Editor 3.2.209 was seen writing an attribute's y with the opposite sign: read back,
			// and when y came out mirrored, ask for the mirrored value instead.
			const put = async (want) => {
				await retry(() => eda.sch_PrimitiveAttribute.modify(aid, want));
				let back = await eda.sch_PrimitiveAttribute.get(aid);
				if (want.y !== undefined && want.y !== null && Math.abs(st(back, "Y") - want.y) > 0.01) {
					await retry(() => eda.sch_PrimitiveAttribute.modify(aid, { ...want, y: -want.y }));
					back = await eda.sch_PrimitiveAttribute.get(aid);
					if (Math.abs(st(back, "Y") - want.y) > 0.01) throw new Error(`attribute y is ${st(back, "Y")}, asked ${want.y}`);
				}
				return back;
			};
			j.undo = () => put(prev);
			const back = await put(prop);
			return { id: aid, x: round(st(back, "X")), y: round(st(back, "Y")), rot: st(back, "Rotation") || 0, value: st(back, "Value") };
		},
	};

	// Net names EasyEDA makes up for wires nobody named ($1N23).
	const AUTO_NET = /^\$\d*N\d+$/;
	// What a change did to connectivity: compare two netlists ({net: ["U1.3", ...]}).
	//   shorts   nets with different names given by a person are now one net
	//   joined   an unnamed net became part of another net (the usual result of wiring)
	//   dropped  pins that were on a net and are on none now
	//   split    one net fell apart into several
	//   renamed  same pins, another name
	//   connected pins that were on no net before
	h.netDiff = (before, after) => {
		const index = (nets) => {
			const m = {};
			for (const [n, nodes] of Object.entries(nets)) for (const p of nodes) m[p] = n;
			return m;
		};
		const bp = index(before);
		const ap = index(after);
		const out = { shorts: [], joined: [], dropped: [], split: [], renamed: [], connected: {} };
		for (const [net, nodes] of Object.entries(after)) {
			const from = [...new Set(nodes.map((p) => bp[p]).filter(Boolean))];
			if (from.length > 1) {
				const named = from.filter((n) => !AUTO_NET.test(n));
				if (named.length > 1) out.shorts.push({ net, nets: named, pins: Object.fromEntries(named.map((n) => [n, nodes.filter((p) => bp[p] === n).slice(0, 4)])) });
				else out.joined.push({ net, from });
			} else if (from.length === 1 && from[0] !== net && !after[from[0]] && !(AUTO_NET.test(net) && AUTO_NET.test(from[0]))) {
				out.renamed.push({ from: from[0], to: net });
			}
			const added = nodes.filter((p) => !bp[p]);
			if (added.length) out.connected[net] = added;
		}
		for (const [net, nodes] of Object.entries(before)) {
			const gone = nodes.filter((p) => !ap[p]);
			if (gone.length) out.dropped.push({ net, pins: gone });
			const into = [...new Set(nodes.map((p) => ap[p]).filter(Boolean))];
			if (into.length > 1) out.split.push({ net, into });
		}
		return out;
	};
	const sameNets = (a, b) => {
		const key = (nets) =>
			Object.entries(nets)
				.map(([n, nodes]) => (AUTO_NET.test(n) ? "?" : n) + "=" + [...nodes].sort().join(","))
				.sort()
				.join("|");
		return key(a) === key(b);
	};

	const CHANGES_NETS = ["wire", "rewire", "flag", "port", "part", "move", "delete", "unname"];

	// Apply a list of operations in order, as one change: either all of it is on the page
	// afterwards or none of it.
	//   guard    (on by default when the ops can change connectivity) the netlist is read
	//            before and after; nets with different names that became one net are a short,
	//            and a short takes the whole change back. allowShorts: true | ["A","B"] permits it.
	//   expect   {NET: ["U1.3", ...]} must hold afterwards (see h.checkNets), else taken back.
	//   rollback (default true, false with keepGoing) take everything back when an op fails,
	//            a short appears or `expect` does not hold. rollback:false leaves what was done.
	//   trial    do it, report what it does to the nets, and take it all back whatever happened.
	//   keepGoing, verbose, number:false, guard:false
	h.draw = async (list, opts = {}) => {
		const C = eda.sch_PrimitiveComponent;
		const W = eda.sch_PrimitiveWire;
		const trial = !!(opts.trial || opts.dryRun);
		if (trial) {
			const bad = list.map((o, i) => (o.op === "delete" && ((o.parts && o.parts.length) || (o.others && o.others.length)) ? i : -1)).filter((i) => i >= 0);
			if (bad.length) throw new Error(`trial refused: op ${bad.join(", ")} deletes parts or drawings, and those cannot be put back`);
		}
		const autoUndo = opts.rollback !== undefined ? !!opts.rollback : !opts.keepGoing;
		const guard = trial || !!opts.expect || (opts.guard !== false && list.some((o) => CHANGES_NETS.includes(o.op)));
		const results = [];
		const journal = [];
		const created = { wires: [], parts: [] };
		const wireOps = []; // {i, id} of every wire op that returned a wire
		const wireIds = async () => (typeof W.getAllPrimitiveId === "function" ? await W.getAllPrimitiveId() : ((await W.getAll()) || []).map((w) => st(w, "PrimitiveId"))) || [];

		// The page as it is now: needed to tell a new wire from one merged into an old wire,
		// and to put everything back.
		let wiresBefore = null; // id -> {lines, net}
		let partsBefore = null; // Set of ids
		let netsBefore = null;
		const notes = [];
		if (list.some((o) => CHANGES_NETS.includes(o.op))) {
			try {
				wiresBefore = new Map(((await W.getAll()) || []).map((w) => [st(w, "PrimitiveId"), { lines: segs(w), net: st(w, "Net") || "" }]));
				partsBefore = new Set(((await C.getAll()) || []).map((c) => st(c, "PrimitiveId")));
			} catch (e) {
				notes.push("could not read the page before the change: " + String(e.message || e));
			}
		}
		const preexisting = wiresBefore ? new Set(wiresBefore.keys()) : null;
		if (guard) {
			try {
				netsBefore = await h.nets({ allowEmpty: true });
			} catch (e) {
				if (trial || opts.expect) throw new Error("the netlist cannot be read, so the change cannot be checked: " + String(e.message || e));
				notes.push("guard is off, the netlist could not be read: " + String(e.message || e));
			}
		}

		// One library request for all the parts of the list.
		const wanted = [...new Set(list.filter((o) => o.op === "part" && o.lcsc && !o.device).map((o) => o.lcsc))];
		if (wanted.length) {
			try {
				await h.lcsc(wanted);
			} catch (e) {
				/* the op itself will report it */
			}
		}
		let failed = 0;
		// Placing a part keeps the editor busy for half a second or more whatever else goes on,
		// and several parts placed at once share that time: runs of `part` ops go in batches.
		const PAR = opts.parallel === undefined ? 8 : Math.max(1, opts.parallel);
		for (let i = 0; i < list.length; ) {
			let n = 1;
			if (list[i].op === "part") while (i + n < list.length && n < PAR && list[i + n].op === "part") n++;
			const batch = [];
			for (let b = 0; b < n; b++) {
				const j = { i: i + b, undo: null, why: "" };
				journal.push(j);
				batch.push(j);
			}
			const done = await Promise.all(
				batch.map(async (j) => {
					const o = list[j.i];
					const fn = ops[o.op];
					try {
						if (!fn) throw new Error(`Unknown op '${o.op}'. Known: ${Object.keys(ops).join(", ")}`);
						return { r: await h.limit(fn(o, j), opts.opTimeoutMs || 30000, `op ${j.i} (${o.op})`) };
					} catch (e) {
						return { e };
					}
				}),
			);
			let stop = false;
			for (let b = 0; b < n; b++) {
				const j = batch[b];
				const o = list[j.i];
				const { r, e } = done[b];
				if (e) {
					failed++;
					results.push({ i: j.i, op: o.op, error: String(e.message || e) });
					if (!opts.keepGoing) stop = true;
					continue;
				}
				const canSweep = !!(preexisting && partsBefore);
				if (r && r.id && (o.op === "wire" || o.op === "rewire")) {
					// EasyEDA merges a new wire with every wire whose end it touches and then
					// returns the existing wire.
					if (created.wires.includes(r.id) || (preexisting && preexisting.has(r.id))) {
						r.note = "merged into an existing wire";
						if (o.op === "wire") j.undo = null; // the old wire is put back from the snapshot instead
					} else {
						created.wires.push(r.id);
						if (o.op === "wire" && canSweep) j.bulk = true;
					}
					wireOps.push({ i: j.i, id: r.id });
				}
				if (r && r.id && (o.op === "part" || o.op === "flag" || o.op === "port")) {
					created.parts.push(r.id);
					if (canSweep) j.bulk = true;
				}
				if (r && r.id && ["text", "rect", "circle", "line"].includes(o.op)) (created.drawings = created.drawings || []).push(r.id);
				if (opts.verbose || (r && r.note) || o.op === "part") results.push({ i: j.i, op: o.op, ...r });
			}
			if (stop) break;
			i += n;
		}
		// Editor 3.2.209: the page's wire list (getAll, getAllPrimitiveId) lags about a
		// second behind wire creation, while get(ids) sees new wires at once. Wait here,
		// so that whatever is read after this call is complete.
		const hasFlags = list.some((o) => o.op === "flag" || o.op === "port");
		if (opts.settle !== false) {
			if (created.wires.length) await h.settle(created.wires);
			else if (hasFlags && preexisting) await h.sleep(1200);
		}
		// A net flag put straight on a pin end makes EasyEDA add a zero-length wire there.
		// Count those as created, so that rollback and later clean-up know about them.
		if (preexisting && hasFlags) {
			try {
				const extra = (await wireIds()).filter((id) => !preexisting.has(id) && !created.wires.includes(id));
				if (extra.length) {
					const ws = (await W.get(extra)) || [];
					const auto = ws.filter((w) => flat(st(w, "Line")).every((s) => s[0] === s[2] && s[1] === s[3])).map((w) => st(w, "PrimitiveId"));
					if (auto.length) {
						created.wires.push(...auto);
						created.autoWires = auto;
					}
				}
			} catch (e) {
				/* only bookkeeping */
			}
		}
		// Read back: every wire we created must still exist with the net we asked for.
		const mismatches = [];
		const absorbed = []; // ops whose wire was merged into a later wire of the same change
		if (opts.verify !== false && wireOps.length) {
			const back = (await W.get([...new Set(wireOps.map((x) => x.id))])) || [];
			const byId = new Map(back.filter(Boolean).map((w) => [st(w, "PrimitiveId"), w]));
			// A wire of this change can be taken into a LATER wire of the same change (its end
			// lies on the later wire): then its id is gone, but its copper is still there as
			// part of the survivor. That is a merge, not a loss.
			const alive = [...byId.values()].map((w) => ({ w, segs: flat(st(w, "Line")) }));
			const onSeg = (px, py, s) =>
				Math.abs((s[2] - s[0]) * (py - s[1]) - (s[3] - s[1]) * (px - s[0])) < 1e-6 &&
				px >= Math.min(s[0], s[2]) - 1e-6 && px <= Math.max(s[0], s[2]) + 1e-6 &&
				py >= Math.min(s[1], s[3]) - 1e-6 && py <= Math.max(s[1], s[3]) + 1e-6;
			const absorbedBy = (line) => {
				const pts = [];
				for (let k = 0; k + 1 < line.length; k += 2) pts.push([line[k], line[k + 1]]);
				const n = pts.length;
				for (let k = 0; k + 1 < n; k++) pts.push([(pts[k][0] + pts[k + 1][0]) / 2, (pts[k][1] + pts[k + 1][1]) / 2]);
				return alive.find((a) => pts.every((p) => a.segs.some((s) => onSeg(p[0], p[1], s))));
			};
			for (const { i, id } of wireOps) {
				const o = list[i];
				let w = byId.get(id);
				if (!w && Array.isArray(o.line)) {
					const a = absorbedBy(o.line);
					if (a) {
						w = a.w;
						absorbed.push(i);
					}
				}
				if (!w) mismatches.push({ i, id, problem: "wire is gone after creation (merged or rejected)" });
				else if (o.net && String(st(w, "Net") || "").toUpperCase() !== String(o.net).toUpperCase())
					mismatches.push({ i, id, problem: `net is '${st(w, "Net") || ""}', asked '${o.net}'` });
			}
		}
		const stopped = failed > 0 && !opts.keepGoing;
		const willUndoAnyway = trial || (stopped && autoUndo);

		// One netlist does three jobs: EasyEDA numbers the parts left as "R?" while making it
		// (unique across all pages, there is no API call for annotation), it shows what the
		// change did to the nets, and it is what `expect` is checked against.
		const unnumbered = results.filter((r) => r.op === "part" && r.id && /\?$/.test(r.des || ""));
		let netsAfter = null;
		let changes = null;
		let expected = null;
		const wantNetlist = (netsBefore && !(stopped && autoUndo)) || (unnumbered.length && opts.number !== false && !willUndoAnyway);
		if (wantNetlist) {
			// Connectivity follows a deleted wire with the same delay of about a second as the
			// wire list follows a new one: a netlist taken at once still has the old nets.
			if (list.some((o) => o.op === "rewire" || o.op === "unname" || (o.op === "delete" && o.wires && o.wires.length))) await h.sleep(1100);
			try {
				netsAfter = await h.nets({ allowEmpty: true });
				for (const r of unnumbered) {
					const c = await C.get(r.id);
					r.des = (c && st(c, "Designator")) || r.des;
				}
			} catch (e) {
				results.push({ op: "netlist", error: String(e.message || e) });
			}
			if (netsBefore && netsAfter) changes = h.netDiff(netsBefore, netsAfter);
			if (opts.expect && netsAfter) expected = await h.checkNets(opts.expect, netsAfter);
		}
		const allowed = opts.allowShorts === true ? null : new Set([].concat(opts.allowShorts || []).map((n) => String(n).toUpperCase()));
		const shorts = changes && allowed ? changes.shorts.filter((s) => !s.nets.every((n) => allowed.has(n.toUpperCase()))) : [];
		const expectFailed = !!(opts.expect && (!expected || !expected.ok));
		const ok = failed === 0 && mismatches.length === 0 && shorts.length === 0 && !expectFailed;
		const firstError = results.find((r) => r.error && r.i !== undefined);
		const done = stopped ? firstError.i : list.length;
		const summary = { ok, total: list.length, applied: done - (opts.keepGoing ? failed : 0), failed };
		if (trial) summary.trial = true;
		if (shorts.length) summary.shorts = shorts;
		if (expected && !expected.ok) summary.expect = expected.problems;
		else if (expected) summary.expect = "holds";

		if (changes) {
			const c = {};
			for (const k of ["joined", "dropped", "split", "renamed"]) if (changes[k].length) c[k] = changes[k];
			if (opts.allowShorts && changes.shorts.length) c.shortsAllowed = changes.shorts;
			const pins = Object.values(changes.connected).reduce((n, a) => n + a.length, 0);
			if (pins) c.connected = pins <= 40 || opts.verbose ? changes.connected : Object.fromEntries(Object.entries(changes.connected).map(([n, a]) => [n, a.length + " pins"]));
			if (Object.keys(c).length) summary.nets = c;
		}

		if (trial || (!ok && autoUndo)) {
			// Take everything back, newest first.
			const u = { reborn: new Map(), notUndone: [] };
			for (const j of [...journal].reverse()) {
				// plain creations are deleted all at once by the sweep below
				if (j.bulk) continue;
				if (!j.undo) {
					if (j.why) u.notUndone.push({ i: j.i, why: j.why });
					continue;
				}
				try {
					await retry(() => j.undo(u));
				} catch (e) {
					u.notUndone.push({ i: j.i, why: String(e.message || e) });
				}
				if (j.why) u.notUndone.push({ i: j.i, why: j.why });
			}
			try {
				// Sweep: whatever this call left behind and no journal entry knew about (wires
				// EasyEDA added by itself, parts of an op that failed half way).
				if (u.reborn.size) await h.settle([...u.reborn.values()]);
				if (preexisting) {
					const keep = new Set(u.reborn.values());
					const listed = await wireIds();
					const mine = [...new Set([...listed, ...created.wires])].filter((id) => !preexisting.has(id) && !keep.has(id));
					const gone = mine.length ? ((await W.get(mine)) || []).filter(Boolean).map((x) => st(x, "PrimitiveId")) : [];
					if (gone.length) await del(W, gone);
					// An old wire that a new one was merged into: draw it the way it was.
					const old = (await W.get([...preexisting].filter((id) => !u.reborn.has(id)))) || [];
					const now = new Map(old.filter(Boolean).map((w) => [st(w, "PrimitiveId"), w]));
					// (EasyEDA merges a new wire with every wire whose end it touches, whatever the
					// shape, so one new wire can swallow several old ones.)
					const redo = [];
					for (const [id, was] of wiresBefore) {
						if (u.reborn.has(id)) continue;
						const lines = nonZero(was.lines);
						if (!lines.length) continue;
						const w = now.get(id);
						if (w && segKey(nonZero(segs(w))) === segKey(lines) && (st(w, "Net") || "") === was.net) continue;
						if (w) await del(W, [id]);
						redo.push([id, lines, was.net]);
					}
					for (const [id, lines, net] of redo) {
						const nw = await makeWire(lines, net);
						if (nw) u.reborn.set(id, st(nw, "PrimitiveId"));
					}
				}
				if (partsBefore) {
					const extra = ((await C.getAll()) || []).map((c) => st(c, "PrimitiveId")).filter((id) => !partsBefore.has(id));
					if (extra.length) await del(C, extra);
				}
				if (u.reborn.size) await h.settle([...u.reborn.values()]);
			} catch (e) {
				u.notUndone.push({ why: "clean-up failed: " + String(e.message || e) });
			}
			summary.rolledBack = true;
			if (u.reborn.size) summary.redrawnWires = Object.fromEntries(u.reborn); // old id -> new id
			if (u.notUndone.length) summary.notUndone = u.notUndone;
			if (netsBefore) {
				try {
					let netsNow = null;
					let reseated = false;
					for (let n = 0; n < 5; n++) {
						netsNow = await h.nets({ allowEmpty: true });
						if (sameNets(netsBefore, netsNow)) break;
						// The netlist lags behind deleted wires for about a second: look again first.
						if (n === 0) {
							await h.sleep(1100);
							continue;
						}
						// A flag or port that sat right on a pin end was joined to it by a zero-length
						// wire of EasyEDA's own. Once that wire is lost (the part was moved away and
						// back) only a new flag brings it back.
						if (!reseated && wiresBefore) {
							reseated = true;
							const spots = new Set();
							for (const was of wiresBefore.values()) for (const sg of was.lines) if (sg[0] === sg[2] && sg[1] === sg[3]) spots.add(sg[0] + "," + sg[1]);
							const again = [];
							for (const c of (await C.getAll()) || []) {
								const info = flagInfo(c);
								if (info && spots.has(round(info.x) + "," + round(info.y))) again.push(info);
							}
							for (const info of again) {
								await del(C, [info.id]);
								await makeFlag(info);
							}
							if (again.length) summary.reseatedFlags = again.length;
						}
						await h.sleep(700);
					}
					summary.restored = sameNets(netsBefore, netsNow);
					if (!summary.restored) summary.restoreDiff = h.netDiff(netsBefore, netsNow);
				} catch (e) {
					summary.restored = "unknown: " + String(e.message || e);
				}
			}
		} else {
			summary.created = created;
		}
		if (mismatches.length) summary.mismatches = mismatches;
		if (absorbed.length) summary.mergedIntoLaterWire = absorbed.length;
		if (notes.length) summary.notes = notes;
		if (results.length) summary.results = results;
		return summary;
	};

	// ---------- PCB ----------
	// Coordinates are in mil, y points up (a rectangle [x, y, w, h] starts at its top left
	// corner and goes down). Pass {unit:"mm"} to read and write millimetres instead.
	const pcb = (h.pcb = {});
	const MM = 39.37007874015748;
	const LAYERS = { top: 1, bottom: 2, topsilk: 3, bottomsilk: 4, topmask: 5, bottommask: 6, toppaste: 7, bottompaste: 8, topassembly: 9, bottomassembly: 10, outline: 11, multi: 12, document: 13, doc: 13, mechanical: 14, mech: 14 };
	const layerId = (l, dflt) => {
		if (l === undefined || l === null) return dflt;
		if (typeof l === "number") return l;
		const key = String(l).toLowerCase().replace(/[\s_-]/g, "");
		if (LAYERS[key]) return LAYERS[key];
		const m = /^in(?:ner)?(\d+)$/.exec(key);
		if (m) return 14 + Number(m[1]);
		if (/^\d+$/.test(key)) return Number(key);
		throw new Error(`Unknown layer '${l}'. Use a number or: ${Object.keys(LAYERS).join(", ")}, inner1..inner30`);
	};
	const scale = (opts) => (opts && opts.unit === "mm" ? MM : 1);
	const outNum = (v, k) => (typeof v === "number" ? Math.round((v / k) * (k === 1 ? 100 : 10000)) / (k === 1 ? 100 : 10000) : v);
	const PCB_API = {
		Line: "pcb_PrimitiveLine",
		Via: "pcb_PrimitiveVia",
		Polyline: "pcb_PrimitivePolyline",
		Pour: "pcb_PrimitivePour",
		Region: "pcb_PrimitiveRegion",
		Fill: "pcb_PrimitiveFill",
		String: "pcb_PrimitiveString",
		Component: "pcb_PrimitiveComponent",
		Arc: "pcb_PrimitiveArc",
		Pad: "pcb_PrimitivePad",
		Image: "pcb_PrimitiveImage",
		Dimension: "pcb_PrimitiveDimension",
	};

	pcb.ensure = async () => {
		const doc = await eda.dmt_SelectControl.getCurrentDocumentInfo();
		if (!doc || doc.documentType !== 3) throw new Error("The active tab is not a PCB. Open one with h.pcb.open() first.");
		return doc;
	};
	// Open a PCB of the project by name or uuid (the first one when nothing is given).
	pcb.open = async (nameOrUuid) => {
		const all = (await eda.dmt_Pcb.getAllPcbsInfo()) || [];
		if (!all.length) throw new Error("This project has no PCB");
		const key = nameOrUuid === undefined ? null : String(nameOrUuid).toLowerCase();
		const hit = key === null ? all[0] : all.find((p) => p.uuid === nameOrUuid) || all.find((p) => String(p.name).toLowerCase() === key);
		if (!hit) throw new Error(`No PCB '${nameOrUuid}'. PCBs: ${all.map((p) => p.name).join(", ")}`);
		const tabId = await eda.dmt_EditorControl.openDocument(hit.uuid);
		// The document needs a moment before its primitives can be read.
		for (let n = 0; n < 50; n++) {
			const doc = await eda.dmt_SelectControl.getCurrentDocumentInfo();
			if (doc && doc.uuid === hit.uuid) break;
			await h.sleep(100);
		}
		return { uuid: hit.uuid, name: hit.name, board: hit.parentBoardName, tabId };
	};

	const polySource = (o, k) => {
		if (o.polygon) return o.polygon.map((v) => (typeof v === "number" ? v : v));
		if (o.rect) return ["R", o.rect[0] * k, o.rect[1] * k, o.rect[2] * k, o.rect[3] * k, o.rect[4] || 0, (o.rect[5] || 0) * k];
		if (o.circle) return ["CIRCLE", o.circle[0] * k, o.circle[1] * k, o.circle[2] * k];
		if (o.points && o.points.length >= 4) return [o.points[0] * k, o.points[1] * k, "L", ...o.points.slice(2).map((v) => v * k)];
		throw new Error("a shape needs rect:[x,y,w,h], circle:[x,y,r], points:[x1,y1,x2,y2,...] or a raw polygon");
	};
	const polygon = (o, k) => {
		const p = eda.pcb_MathPolygon.createPolygon(polySource(o, k));
		if (!p) throw new Error("EasyEDA rejected the shape: " + JSON.stringify(polySource(o, k)).slice(0, 120));
		return p;
	};
	const srcOf = (v) => (v && v.polygon ? v.polygon : v && typeof v.getSource === "function" ? v.getSource() : v);

	const padOut = (p, k) => ({ num: st(p, "PadNumber"), net: st(p, "Net") || "", x: outNum(st(p, "X"), k), y: outNum(st(p, "Y"), k), layer: st(p, "Layer") });
	const compOut = (c, k) => ({
		id: st(c, "PrimitiveId"),
		des: st(c, "Designator") || undefined,
		x: outNum(st(c, "X"), k),
		y: outNum(st(c, "Y"), k),
		rot: st(c, "Rotation") || 0,
		layer: st(c, "Layer"),
		footprint: (st(c, "Footprint") || {}).name,
		lcsc: st(c, "SupplierId") || undefined,
		locked: st(c, "PrimitiveLock") || undefined,
	});
	// Components of the board. opts: {des:[..], pads:true (with coordinates), unit}
	pcb.parts = async (opts = {}) => {
		await pcb.ensure();
		const k = scale(opts);
		const want = opts.des ? new Set([].concat(opts.des)) : null;
		const out = [];
		for (const c of (await eda.pcb_PrimitiveComponent.getAll()) || []) {
			if (want && !want.has(st(c, "Designator"))) continue;
			const o = compOut(c, k);
			if (opts.pads) o.pads = ((await eda.pcb_PrimitiveComponent.getAllPinsByPrimitiveId(o.id)) || []).map((p) => padOut(p, k));
			else o.pads = (st(c, "Pads") || []).map((p) => `${p.padNumber}:${p.net || ""}`).join(" ");
			out.push(o);
		}
		return out;
	};
	pcb.part = async (des, opts = {}) => {
		const r = await pcb.parts({ ...opts, des: [des], pads: true });
		if (!r.length) throw new Error(`No component '${des}' on the board`);
		return r[0];
	};
	const lineOut = (l, k) => ({ id: st(l, "PrimitiveId"), net: st(l, "Net") || "", layer: st(l, "Layer"), line: [st(l, "StartX"), st(l, "StartY"), st(l, "EndX"), st(l, "EndY")].map((v) => outNum(v, k)), w: outNum(st(l, "LineWidth"), k) });
	// Straight tracks and lines. opts: {net, layer, unit}. Copper layers hold tracks, the others drawings.
	pcb.tracks = async (opts = {}) => {
		await pcb.ensure();
		const k = scale(opts);
		const layer = opts.layer === undefined ? undefined : layerId(opts.layer);
		return ((await eda.pcb_PrimitiveLine.getAll(opts.net, layer)) || []).map((l) => lineOut(l, k));
	};
	pcb.vias = async (opts = {}) => {
		await pcb.ensure();
		const k = scale(opts);
		return ((await eda.pcb_PrimitiveVia.getAll(opts.net)) || []).map((v) => ({ id: st(v, "PrimitiveId"), net: st(v, "Net") || "", x: outNum(st(v, "X"), k), y: outNum(st(v, "Y"), k), hole: outNum(st(v, "HoleDiameter"), k), dia: outNum(st(v, "Diameter"), k) }));
	};
	// Polylines, pours, keep-out regions, fills and texts.
	pcb.shapes = async (opts = {}) => {
		await pcb.ensure();
		const k = scale(opts);
		const out = { polylines: [], pours: [], regions: [], fills: [], texts: [] };
		for (const p of (await eda.pcb_PrimitivePolyline.getAll()) || []) out.polylines.push({ id: st(p, "PrimitiveId"), net: st(p, "Net") || "", layer: st(p, "Layer"), polygon: srcOf(st(p, "Polygon")), w: outNum(st(p, "LineWidth"), k) });
		for (const p of (await eda.pcb_PrimitivePour.getAll()) || []) out.pours.push({ id: st(p, "PrimitiveId"), net: st(p, "Net") || "", layer: st(p, "Layer"), name: st(p, "PourName"), priority: st(p, "PourPriority"), polygon: srcOf(st(p, "ComplexPolygon")) });
		for (const p of (await eda.pcb_PrimitiveRegion.getAll()) || []) out.regions.push({ id: st(p, "PrimitiveId"), layer: st(p, "Layer"), rules: st(p, "RuleType"), name: st(p, "RegionName") || undefined, polygon: srcOf(st(p, "ComplexPolygon")) });
		for (const p of (await eda.pcb_PrimitiveFill.getAll()) || []) out.fills.push({ id: st(p, "PrimitiveId"), net: st(p, "Net") || "", layer: st(p, "Layer"), polygon: srcOf(st(p, "ComplexPolygon")) });
		for (const s of (await eda.pcb_PrimitiveString.getAll()) || []) out.texts.push({ id: st(s, "PrimitiveId"), layer: st(s, "Layer"), x: outNum(st(s, "X"), k), y: outNum(st(s, "Y"), k), text: st(s, "Text"), size: outNum(st(s, "FontSize"), k), rot: st(s, "Rotation") || 0 });
		if (k !== 1) out.note = "polygon numbers are in mil";
		return out;
	};
	// What the board is: layers in use, rule set, size of the outline, how much of everything.
	pcb.info = async (opts = {}) => {
		const doc = await pcb.ensure();
		const k = scale(opts);
		const cur = await eda.dmt_Pcb.getCurrentPcbInfo();
		const out = { pcb: cur ? { uuid: cur.uuid, name: cur.name, board: cur.parentBoardName } : { uuid: doc.uuid }, unit: k === 1 ? "mil" : "mm" };
		out.copperLayers = await eda.pcb_Layer.getTheNumberOfCopperLayers();
		out.layers = ((await eda.pcb_Layer.getAllLayers()) || []).filter((l) => l.layerStatus).map((l) => `${l.id}:${l.name}`);
		try {
			out.rules = await eda.pcb_Drc.getCurrentRuleConfigurationName();
		} catch (e) {
			/* optional */
		}
		const ids = [...((await eda.pcb_PrimitivePolyline.getAllPrimitiveId(undefined, 11)) || []), ...((await eda.pcb_PrimitiveLine.getAllPrimitiveId(undefined, 11)) || [])];
		try {
			ids.push(...((await eda.pcb_PrimitiveArc.getAllPrimitiveId(undefined, 11)) || []));
		} catch (e) {
			/* optional */
		}
		if (ids.length) {
			const b = await eda.pcb_Primitive.getPrimitivesBBox(ids);
			if (b) out.outline = { box: [b.minX, b.minY, b.maxX, b.maxY].map((v) => outNum(v, k)), width: outNum(b.maxX - b.minX, k), height: outNum(b.maxY - b.minY, k), mm: [Math.round(((b.maxX - b.minX) / MM) * 100) / 100, Math.round(((b.maxY - b.minY) / MM) * 100) / 100] };
		} else out.outline = null;
		const count = async (api) => ((await eda[api].getAllPrimitiveId()) || []).length;
		out.counts = { components: await count("pcb_PrimitiveComponent"), tracks: await count("pcb_PrimitiveLine"), vias: await count("pcb_PrimitiveVia"), polylines: await count("pcb_PrimitivePolyline"), pours: await count("pcb_PrimitivePour"), regions: await count("pcb_PrimitiveRegion"), fills: await count("pcb_PrimitiveFill"), texts: await count("pcb_PrimitiveString") };
		out.nets = ((await eda.pcb_Net.getAllNetsName()) || []).length;
		return out;
	};
	// Nets of the board: {net: {pads:["R1.2",...], length, tracks, vias}}; one net when a name is given.
	pcb.nets = async (name, opts = {}) => {
		await pcb.ensure();
		const k = scale(opts);
		const out = {};
		for (const n of (await eda.pcb_Net.getAllNets()) || []) out[n.net] = { pads: [], length: outNum(n.length, k), tracks: 0, vias: 0 };
		for (const c of (await eda.pcb_PrimitiveComponent.getAll()) || []) for (const p of st(c, "Pads") || []) if (p.net && out[p.net]) out[p.net].pads.push(`${st(c, "Designator")}.${p.padNumber}`);
		for (const l of (await eda.pcb_PrimitiveLine.getAll()) || []) if (out[st(l, "Net")]) out[st(l, "Net")].tracks++;
		for (const v of (await eda.pcb_PrimitiveVia.getAll()) || []) if (out[st(v, "Net")]) out[st(v, "Net")].vias++;
		if (name === undefined || name === null) return out;
		const key = Object.keys(out).find((n) => n.toUpperCase() === String(name).toUpperCase());
		if (!key) throw new Error(`No net '${name}' on the board`);
		return { net: key, ...out[key] };
	};

	// Design rule check. Returns {ok, counts:{type:n}, errors:[{type, rule, net, text, at:[x,y], objs}]}.
	// A pad or track not yet connected to its net shows up as "Connection Error".
	const drcFlat = (tree) => {
		const out = [];
		const walk = (node) => {
			if (!node || typeof node !== "object") return;
			if (Array.isArray(node)) return void node.forEach(walk);
			if (node.errorType) {
				const ex = node.explanation || {};
				let text = String(ex.str || "");
				for (const key of ["obj1", "obj2"]) if (node[key]) text = text.replace(`{${key}}`, `${node[key].typeName || ""}${node[key].suffix || ""}`);
				// the numbers of the rule ({minDistance}, {shouldBe}, ...) come separately
				for (const src of [ex.errData, ex.param]) if (src) text = text.replace(/\{(\w+)\}/g, (m, key) => (src[key] !== undefined && typeof src[key] !== "object" ? String(src[key]) : m));
				const who = ["obj1", "obj2"].filter((key) => node[key]).map((key) => String(node[key].suffix || "").replace(/^\([^)]*\):\s*/, ""));
				out.push({ type: node.errorType, rule: node.ruleName, net: node.net || undefined, who, text: text || undefined, at: node.pos ? [Math.round(node.pos.x * 1000) / 100, Math.round(node.pos.y * 1000) / 100] : undefined, objs: node.objs });
				return;
			}
			if (node.list) walk(node.list);
		};
		walk(tree);
		return out;
	};
	const drcKey = (e) => `${e.type}|${e.net || ""}|${[...(e.objs || [])].sort().join(",")}`;
	const drcRun = async (strict) => drcFlat(await h.limit(eda.pcb_Drc.check(strict !== false, false, true), 120000, "DRC"));
	pcb.drc = async (opts = {}) => {
		await pcb.ensure();
		const errors = await drcRun(opts.strict);
		const counts = {};
		for (const e of errors) counts[e.type] = (counts[e.type] || 0) + 1;
		const max = opts.max || 60;
		return { ok: errors.length === 0, counts, errors: opts.type ? errors.filter((e) => e.type === opts.type).slice(0, max) : errors.slice(0, max), more: errors.length > max ? errors.length - max : undefined };
	};
	// Pads and tracks still waiting for their connection, by net.
	pcb.unrouted = async () => {
		const errors = (await drcRun(true)).filter((e) => /connection/i.test(e.type));
		const out = {};
		for (const e of errors) (out[e.net || "?"] = out[e.net || "?"] || []).push(...(e.who && e.who.length ? e.who : [e.text]));
		return { nets: Object.keys(out).length, open: out };
	};

	const pcbDel = async (api, ids) => {
		ids = [].concat(ids || []).filter(Boolean);
		if (!ids.length) return true;
		for (let n = 0; n <= WAITS.length; n++) {
			let ok;
			try {
				ok = await api.delete(ids);
			} catch (e) {
				if (!/cmdKey/.test(String(e && e.message))) throw e;
				ok = false;
			}
			if (ok !== false) return true;
			const left = await api.get(ids);
			if (!([].concat(left || []).filter(Boolean).length)) return true;
			if (n < WAITS.length) await h.sleep(WAITS[n]);
		}
		throw new Error(`EasyEDA refused to delete ${ids.length} PCB primitives`);
	};
	// Editor 3.2.209: pcb_Primitive.getPrimitiveTypeByPrimitiveId answers undefined for
	// everything, so ask every kind in turn.
	const pcbTypeOf = async (id) => {
		for (const [type, api] of Object.entries(PCB_API)) {
			if (!eda[api] || typeof eda[api].get !== "function") continue;
			try {
				const p = await eda[api].get(id);
				if (p && !Array.isArray(p)) return type;
			} catch (e) {
				/* not this kind */
			}
		}
		return undefined;
	};
	const pcbPart = async (ref) => {
		const all = (await eda.pcb_PrimitiveComponent.getAll()) || [];
		const hitC = all.find((c) => st(c, "Designator") === ref || st(c, "PrimitiveId") === ref);
		if (!hitC) throw new Error(`No component '${ref}' on the board`);
		return hitC;
	};
	const need = (o, ...keys) => {
		for (const key of keys) if (o[key] === undefined || o[key] === null) throw new Error(`op '${o.op}' needs '${key}'`);
	};

	const pcbOps = {
		// {op:"track", net, layer:"top", points:[x1,y1,x2,y2,...], width?}  one straight track per pair of points
		async track(o, j, k) {
			need(o, "points");
			if (o.points.length < 4 || o.points.length % 2) throw new Error("track needs points:[x1,y1,x2,y2,...]");
			const layer = layerId(o.layer, 1);
			const ids = [];
			j.undo = () => pcbDel(eda.pcb_PrimitiveLine, ids);
			for (let i = 0; i + 3 < o.points.length; i += 2) {
				const [x1, y1, x2, y2] = o.points.slice(i, i + 4).map((v) => v * k);
				const l = await eda.pcb_PrimitiveLine.create(o.net || "", layer, x1, y1, x2, y2, (o.width === undefined ? 10 / k : o.width) * k);
				if (!l) throw new Error(`track segment ${i / 2} was not created`);
				ids.push(st(l, "PrimitiveId"));
			}
			return { ids };
		},
		// {op:"via", net, x, y, hole?, dia?}
		async via(o, j, k) {
			need(o, "x", "y");
			const v = await eda.pcb_PrimitiveVia.create(o.net || "", o.x * k, o.y * k, (o.hole === undefined ? 12 / k : o.hole) * k, (o.dia === undefined ? 24 / k : o.dia) * k);
			if (!v) throw new Error("via was not created");
			const id = st(v, "PrimitiveId");
			j.undo = () => pcbDel(eda.pcb_PrimitiveVia, [id]);
			return { id };
		},
		// {op:"move", part:"R1", x?, y?, rot?, layer?}
		async move(o, j, k) {
			need(o, "part");
			const c = await pcbPart(o.part);
			const id = st(c, "PrimitiveId");
			const prev = { x: st(c, "X"), y: st(c, "Y"), rotation: st(c, "Rotation") || 0, layer: st(c, "Layer") };
			const prop = {};
			if (o.x !== undefined) prop.x = o.x * k;
			if (o.y !== undefined) prop.y = o.y * k;
			if (o.rot !== undefined) prop.rotation = o.rot;
			if (o.layer !== undefined) prop.layer = layerId(o.layer);
			j.undo = () => retry(() => eda.pcb_PrimitiveComponent.modify(id, prev));
			await retry(() => eda.pcb_PrimitiveComponent.modify(id, prop));
			const b = await eda.pcb_PrimitiveComponent.get(id);
			const got = { id, x: outNum(st(b, "X"), k), y: outNum(st(b, "Y"), k), rot: st(b, "Rotation") || 0, layer: st(b, "Layer") };
			if (o.rot !== undefined && got.rot !== (((o.rot % 360) + 360) % 360)) throw new Error(`rotation is ${got.rot}, asked ${o.rot}`);
			return got;
		},
		// {op:"place", lcsc:"C1234" | device:{libraryUuid,uuid} | footprint:{libraryUuid,uuid}, x, y, layer?, rot?, des?}
		// A part placed here is not in the schematic: the next import from the schematic may remove it.
		async place(o, j, k) {
			need(o, "x", "y");
			let device = o.device || o.footprint;
			if (o.footprint) device = { libraryType: "footprint", ...o.footprint };
			if (!device && o.lcsc) {
				const r = await h.lcsc(o.lcsc);
				device = r.found[o.lcsc];
				if (!device) throw new Error(`LCSC ${o.lcsc} not found in the library`);
			}
			if (!device) throw new Error("place needs `lcsc`, `device` or `footprint`");
			const c = await eda.pcb_PrimitiveComponent.create(device, layerId(o.layer, 1), o.x * k, o.y * k, o.rot || 0);
			if (!c) throw new Error("component was not created");
			const id = st(c, "PrimitiveId");
			j.undo = () => pcbDel(eda.pcb_PrimitiveComponent, [id]);
			if (o.des) await retry(() => eda.pcb_PrimitiveComponent.modify(id, { designator: o.des }));
			const b = await eda.pcb_PrimitiveComponent.get(id);
			return { id, des: st(b, "Designator") || "", rot: st(b, "Rotation") || 0 };
		},
		// {op:"set", part:"R1", props:{designator?, primitiveLock?, ...}}
		async set(o, j) {
			need(o, "part", "props");
			const c = await pcbPart(o.part);
			const id = st(c, "PrimitiveId");
			const prev = {};
			for (const key of Object.keys(o.props)) {
				const v = st(c, cap(key));
				prev[key] = v === undefined ? null : v;
			}
			j.undo = () => retry(() => eda.pcb_PrimitiveComponent.modify(id, prev));
			await retry(() => eda.pcb_PrimitiveComponent.modify(id, o.props));
			return { id };
		},
		// {op:"outline", rect:[x,y,w,h] | points:[...] | circle:[x,y,r], width?}  the board outline
		async outline(o, j, k) {
			const p = await eda.pcb_PrimitivePolyline.create("", 11, polygon(o, k), o.width === undefined ? undefined : o.width * k);
			if (!p) throw new Error("outline was not created");
			const id = st(p, "PrimitiveId");
			j.undo = () => pcbDel(eda.pcb_PrimitivePolyline, [id]);
			return { id };
		},
		// {op:"line", layer:"topsilk", points:[...] | rect | circle, width?, net?}  a drawing line (silkscreen, document layer)
		async line(o, j, k) {
			const p = await eda.pcb_PrimitivePolyline.create(o.net || "", layerId(o.layer, 3), polygon(o, k), o.width === undefined ? undefined : o.width * k);
			if (!p) throw new Error("line was not created");
			const id = st(p, "PrimitiveId");
			j.undo = () => pcbDel(eda.pcb_PrimitivePolyline, [id]);
			return { id };
		},
		// {op:"pour", net, layer:"bottom", rect | points, name?, priority?, fill?, keepIslands?, rebuild?}  copper pour
		async pour(o, j, k) {
			need(o, "net");
			const p = await eda.pcb_PrimitivePour.create(o.net, layerId(o.layer, 1), polygon(o, k), o.fill, o.keepIslands, o.name, o.priority);
			if (!p) throw new Error("pour was not created");
			const id = st(p, "PrimitiveId");
			j.undo = () => pcbDel(eda.pcb_PrimitivePour, [id]);
			const out = { id, name: st(p, "PourName") };
			if (o.rebuild !== false && typeof p.rebuildCopperRegion === "function") {
				try {
					await h.limit(p.rebuildCopperRegion(), 60000, "pour rebuild");
					out.filled = true;
				} catch (e) {
					out.filled = false;
					out.note = "pour created, filling failed: " + String(e.message || e);
				}
			}
			return out;
		},
		// {op:"region", layer, rect | points, rules?:[numbers], name?}  keep-out or rule region
		async region(o, j, k) {
			const p = await eda.pcb_PrimitiveRegion.create(layerId(o.layer, 1), polygon(o, k), o.rules, o.name);
			if (!p) throw new Error("region was not created");
			const id = st(p, "PrimitiveId");
			j.undo = () => pcbDel(eda.pcb_PrimitiveRegion, [id]);
			return { id, rules: st(p, "RuleType") };
		},
		// {op:"fill", layer, rect | points | circle, net?}  solid copper or drawing fill
		async fill(o, j, k) {
			const p = await eda.pcb_PrimitiveFill.create(layerId(o.layer, 1), polygon(o, k), o.net || "");
			if (!p) throw new Error("fill was not created");
			const id = st(p, "PrimitiveId");
			j.undo = () => pcbDel(eda.pcb_PrimitiveFill, [id]);
			return { id };
		},
		// {op:"text", layer:"topsilk", x, y, text, size?, width?, rot?, font?, mirror?}
		async text(o, j, k) {
			need(o, "x", "y", "text");
			const s = await eda.pcb_PrimitiveString.create(layerId(o.layer, 3), o.x * k, o.y * k, String(o.text), o.font || "default", (o.size === undefined ? 40 / k : o.size) * k, (o.width === undefined ? 6 / k : o.width) * k, o.align === undefined ? 1 : o.align, o.rot || 0, false, 0, !!o.mirror, false);
			if (!s) throw new Error("text was not created");
			const id = st(s, "PrimitiveId");
			j.undo = () => pcbDel(eda.pcb_PrimitiveString, [id]);
			return { id };
		},
		// {op:"delete", ids:[...]}  any primitives by id; tracks and vias can be put back, the rest cannot
		async delete(o, j) {
			need(o, "ids");
			const groups = {};
			const saved = [];
			for (const id of o.ids) {
				const type = await pcbTypeOf(id);
				const api = PCB_API[type];
				if (!api) throw new Error(`no primitive ${id} on the board`);
				(groups[api] = groups[api] || []).push(id);
				if (type === "Line") {
					const l = await eda.pcb_PrimitiveLine.get(id);
					saved.push(() => eda.pcb_PrimitiveLine.create(st(l, "Net") || "", st(l, "Layer"), st(l, "StartX"), st(l, "StartY"), st(l, "EndX"), st(l, "EndY"), st(l, "LineWidth")));
				} else if (type === "Via") {
					const v = await eda.pcb_PrimitiveVia.get(id);
					saved.push(() => eda.pcb_PrimitiveVia.create(st(v, "Net") || "", st(v, "X"), st(v, "Y"), st(v, "HoleDiameter"), st(v, "Diameter")));
				} else j.why = "deleted shapes, texts and components cannot be put back";
			}
			j.undo = async () => {
				for (const f of saved) await f();
			};
			for (const [api, ids] of Object.entries(groups)) await pcbDel(eda[api], ids);
			return { deleted: o.ids.length };
		},
	};

	const CHANGES_COPPER = ["track", "via", "move", "place", "pour", "fill", "delete", "outline", "region"];
	// Apply a list of operations to the board as one change.
	//   guard    (on by default when copper changes) the design rule check runs before and
	//            after; a new error other than "not connected yet" takes the whole change back.
	//            allowErrors:true keeps it.
	//   rollback (default true, false with keepGoing) take everything back when an op fails or
	//            the guard objects. trial:true takes it back in any case and reports.
	//   unit:"mm", keepGoing, verbose
	pcb.draw = async (list, opts = {}) => {
		await pcb.ensure();
		const k = scale(opts);
		const trial = !!(opts.trial || opts.dryRun);
		const autoUndo = opts.rollback !== undefined ? !!opts.rollback : !opts.keepGoing;
		const guard = opts.guard !== false && (trial || list.some((o) => CHANGES_COPPER.includes(o.op)));
		const notes = [];
		let before = null;
		if (guard) {
			try {
				before = await drcRun(true);
			} catch (e) {
				notes.push("guard is off, the rule check failed: " + String(e.message || e));
			}
		}
		const results = [];
		const journal = [];
		const created = [];
		let failed = 0;
		for (let i = 0; i < list.length; i++) {
			const o = list[i];
			const fn = pcbOps[o.op];
			const j = { i, undo: null, why: "" };
			journal.push(j);
			try {
				if (!fn) throw new Error(`Unknown op '${o.op}'. Known: ${Object.keys(pcbOps).join(", ")}`);
				const r = await h.limit(fn(o, j, k), opts.opTimeoutMs || 90000, `op ${i} (${o.op})`);
				if (r && r.id && o.op !== "move" && o.op !== "set") created.push(r.id);
				if (r && r.ids) created.push(...r.ids);
				if (opts.verbose || o.op === "place" || (r && r.note)) results.push({ i, op: o.op, ...r });
			} catch (e) {
				failed++;
				results.push({ i, op: o.op, error: String(e.message || e) });
				if (!opts.keepGoing) break;
			}
		}
		const stopped = failed > 0 && !opts.keepGoing;
		// A pour keeps its old filling until it is rebuilt, and the rule check would blame a
		// new via or track for touching copper that is no longer meant to be there.
		const refill = async () => {
			if (opts.rebuild === false || !list.some((o) => ["track", "via", "move", "place", "delete", "fill", "region"].includes(o.op))) return;
			for (const p of (await eda.pcb_PrimitivePour.getAll()) || []) {
				if (typeof p.rebuildCopperRegion !== "function") continue;
				try {
					await h.limit(p.rebuildCopperRegion(), 120000, "pour rebuild");
				} catch (e) {
					notes.push("a pour was not rebuilt: " + String(e.message || e));
				}
			}
		};
		let fresh = [];
		let after = null;
		if (before && !(stopped && autoUndo)) {
			try {
				await refill();
				after = await drcRun(true);
				const had = new Set(before.map(drcKey));
				fresh = after.filter((e) => !had.has(drcKey(e)));
			} catch (e) {
				notes.push("the rule check after the change failed: " + String(e.message || e));
			}
		}
		const serious = fresh.filter((e) => !/connection/i.test(e.type));
		const objected = serious.length > 0 && !opts.allowErrors;
		const ok = failed === 0 && !objected;
		const firstError = results.find((r) => r.error && r.i !== undefined);
		const summary = { ok, total: list.length, applied: (stopped ? firstError.i : list.length) - (opts.keepGoing ? failed : 0), failed };
		if (trial) summary.trial = true;
		if (after) {
			const gone = before.length - (after.length - fresh.length);
			summary.drc = { before: before.length, after: after.length, fixed: gone || undefined };
			if (serious.length) summary.drc.newErrors = serious.slice(0, 20);
			const open = fresh.filter((e) => /connection/i.test(e.type)).length;
			if (open) summary.drc.newOpenConnections = open;
		}
		if (trial || (!ok && autoUndo)) {
			const notUndone = [];
			for (const j of [...journal].reverse()) {
				if (j.undo) {
					try {
						await j.undo();
					} catch (e) {
						notUndone.push({ i: j.i, why: String(e.message || e) });
					}
				}
				if (j.why) notUndone.push({ i: j.i, why: j.why });
			}
			summary.rolledBack = true;
			if (notUndone.length) summary.notUndone = notUndone;
			if (before) {
				try {
					await refill();
					const now = await drcRun(true);
					const had = new Set(before.map(drcKey));
					summary.restored = now.length === before.length && now.every((e) => had.has(drcKey(e)));
				} catch (e) {
					summary.restored = "unknown: " + String(e.message || e);
				}
			}
		} else summary.created = created;
		if (notes.length) summary.notes = notes;
		if (results.length) summary.results = results;
		return summary;
	};

	// Bring the schematic's changes onto the board. EasyEDA shows a confirmation dialog with
	// the list of changes: this reads the list and presses "Apply Changes" (apply:false
	// presses "Cancel" and only reports).
	pcb.import = async (opts = {}) => {
		await pcb.ensure();
		const find = () => document.querySelector("#dlgShowImportChanges_dialog_box");
		if (find()) throw new Error("The import dialog is already open in EasyEDA: close it first");
		const started = await h.limit(eda.pcb_Document.importChanges(), 60000, "importChanges");
		let dlg = null;
		for (let n = 0; n < 60 && !dlg; n++) {
			dlg = find();
			if (!dlg) await h.sleep(100);
		}
		if (!dlg) return { started, dialog: false, note: "no confirmation dialog appeared: nothing to import, or EasyEDA showed a message instead" };
		const text = String((dlg.querySelector('[class*="dialog__body"]') || dlg).innerText || "");
		const changes = text
			.split("\n")
			.map((s) => s.trim().replace(/\t+/g, " | "))
			.filter((s) => / \| /.test(s) && !/^Change/.test(s));
		const btn = dlg.querySelector(`button[data-test="${opts.apply === false ? "Cancel" : "Apply Changes"}"]`);
		if (!btn) return { started, dialog: true, applied: false, changes, note: "the dialog has no such button: finish it in EasyEDA" };
		btn.click();
		for (let n = 0; n < 150 && find(); n++) await h.sleep(100);
		if (find()) return { started, dialog: true, applied: false, changes, note: "the dialog did not close: look at EasyEDA" };
		await h.sleep(500);
		return { applied: opts.apply !== false, changes, components: ((await eda.pcb_PrimitiveComponent.getAllPrimitiveId()) || []).length };
	};

	// Fill all pours again (after moving parts or tracks).
	pcb.rebuild = async () => {
		await pcb.ensure();
		const pours = (await eda.pcb_PrimitivePour.getAll()) || [];
		let done = 0;
		for (const p of pours) {
			if (typeof p.rebuildCopperRegion !== "function") continue;
			await h.limit(p.rebuildCopperRegion(), 120000, "pour rebuild");
			done++;
		}
		return { pours: pours.length, rebuilt: done };
	};

	// EasyEDA's own autorouter. props: {RoutingNets?: [nets], layers?: [1,2], ignoreNets?: [..]} (see eda_api IPCB_AutoRoutingProps).
	pcb.autoroute = async (props, opts = {}) => {
		await pcb.ensure();
		const before = ((await eda.pcb_PrimitiveLine.getAllPrimitiveId()) || []).length;
		const result = await h.limit(eda.pcb_Document.autoRouting(props), opts.timeoutMs || 300000, "autorouting");
		await h.sleep(500);
		const after = ((await eda.pcb_PrimitiveLine.getAllPrimitiveId()) || []).length;
		return { result, tracksBefore: before, tracksAfter: after, unrouted: await pcb.unrouted() };
	};

	// Files from the board. format: gerber (zip), pnp (pick and place csv), bom, netlist, step, obj,
	// dxf, dsn, ipc356, ipc2581, odb, testpoints, info, altium, pads, pdf, view (picture of the canvas).
	// Ordering functions of EasyEDA (placePcbOrder and the like) are never called from here.
	pcb.exportFile = async (format, opts = {}) => {
		await pcb.ensure();
		const m = eda.pcb_ManufactureData;
		const n = opts.name;
		switch (String(format).toLowerCase()) {
			case "gerber":
				return m.getGerberFile(n, opts.colorSilkscreen, opts.unit, opts.digitalFormat, opts.other, opts.layers, opts.objects);
			case "pnp":
			case "pickplace":
				return m.getPickAndPlaceFile(n, opts.type || "csv", opts.unit);
			case "bom":
				return m.getBomFile(n, opts.type || "csv", opts.template);
			case "netlist":
				return m.getNetlistFile(n, opts.type);
			case "step":
			case "obj":
				return m.get3DFile(n, String(format).toLowerCase(), opts.element, opts.modelMode, opts.autoGenerateModels);
			case "dxf":
				return m.getDxfFile(n, opts.layers, opts.objects);
			case "dsn":
				return m.getDsnFile(n);
			case "ipc356":
				return m.getIpcD356AFile(n);
			case "ipc2581":
				return m.getIpc2581CFile(n, opts.type, opts.unit);
			case "odb":
				return m.getOpenDatabaseDoublePlusFile(n, opts.unit, opts.other, opts.layers, opts.objects);
			case "testpoints":
				return m.getTestPointFile(n, opts.type || "csv");
			case "info":
				return m.getPcbInfoFile(n);
			case "altium":
				return m.getAltiumDesignerFile(n);
			case "pads":
				return m.getPadsFile(n);
			case "pdf":
				// (called without a content configuration it never answers; takes about 20 s)
				return m.getPdfFile(n || "board", opts.outputMethod, opts.contentConfig || { displayAttributesAsMenu: false, showOutlineOnly: false }, opts.watermark, opts.pages);
			case "view":
				return eda.dmt_EditorControl.getCurrentRenderedAreaImage(opts.tabId);
			default:
				throw new Error(`Unknown PCB export '${format}'. Known: gerber, pnp, bom, netlist, step, obj, dxf, dsn, ipc356, ipc2581, odb, testpoints, info, altium, pads, pdf, view`);
		}
	};

	// ---------- export ----------
	// Returns a File; the server saves it to disk and gives back the path.
	h.exportFile = async (format, opts = {}) => {
		const m = eda.sch_ManufactureData;
		const name = opts.name;
		if (format === "pdf" || format === "png" || format === "svg") {
			// Editor 3.2.209: getPdfFile does not exist (only in the typings) and getPngFile /
			// getSvgFile never resolve. getExportDocumentFile does all three.
			const object = opts.object || "Current Schematic Page";
			if (typeof m.getExportDocumentFile === "function")
				return m.getExportDocumentFile(name, format.toUpperCase(), opts.params, object, opts.objectParams);
			if (format === "pdf") return m.getPdfFile(name, opts.params, object, opts.objectParams);
			if (format === "png") return m.getPngFile(name, opts.resolution);
			return m.getSvgFile(name);
		}
		if (format === "netlist") return m.getNetlistFile(name, opts.type || "PADS");
		if (format === "bom") return m.getBomFile(name, opts.type || "csv");
		if (format === "view") return eda.dmt_EditorControl.getCurrentRenderedAreaImage(opts.tabId);
		throw new Error(`Unknown export format '${format}'. Known: pdf, png, svg, netlist, bom, view`);
	};

	// List the real methods of an API object, e.g. h.methods("sch_PrimitiveWire").
	h.methods = (name) => {
		const obj = name ? eda[name] : eda;
		if (!obj) throw new Error(`eda.${name} does not exist`);
		if (!name) return Object.keys(eda).sort();
		const names = new Set();
		for (let p = obj; p && p !== Object.prototype; p = Object.getPrototypeOf(p))
			for (const n of Object.getOwnPropertyNames(p)) if (n !== "constructor" && typeof obj[n] === "function") names.add(n);
		return [...names].sort();
	};

	return h;
}
