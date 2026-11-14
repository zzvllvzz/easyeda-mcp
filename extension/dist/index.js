"use strict";
// easyeda-mcp bridge extension. Deliberately tiny: it only runs code sent by the
// local MCP server and returns the result. All tool logic lives in the server,
// so this file should almost never need to change (and be reinstalled).
//
// EasyEDA evaluates an extension script more than once in the same page (seen on
// 3.2.209: two live copies). Two copies with their own watchdog steal the socket
// from each other, so the runtime is a singleton kept on globalThis and every
// copy of the script only forwards to it.
var edaEsbuildExportName = (() => {
	const VERSION = "0.1.2";
	const KEY = "__easyedaMcpBridge__";
	const PROTOCOL = 1;
	const SOCKET_ID = "easyeda-mcp";
	const SERVER_URL = "ws://127.0.0.1:49731";
	const CHUNK = 200000; // characters per websocket frame
	const WATCHDOG_MS = 2000;
	const DEAD_AFTER_MS = 5000;

	const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
	const g = globalThis;
	const ownEda = typeof eda !== "undefined" && eda ? eda : g.eda;

	function createRuntime(firstEda) {
	const edas = [firstEda];
	const state = {
		boot: Date.now().toString(36) + Math.random().toString(36).slice(2, 8), // changes when the page reloads
		started: false,
		staleSince: 0,
		timer: null,
		worker: null,
		ticker: "", // what drives the watchdog: "worker" or "interval"
		ticks: 0,
		lastTick: 0,
		reconnects: 0,
		deactivations: 0,
		connected: false,
		lastSeen: 0,
		opened: 0,
		executed: 0,
		lastError: "",
		running: new Map(), // id -> started at
		chunks: new Map(), // chunk id -> parts
		outbox: [], // results that could not be sent because the socket was down
		watchdog: false,
		persist: {}, // survives between exec calls: `store`
	};

	const api = () => edas[0];
	// Another copy of the script brings its own `eda`; keep it as a spare.
	function adopt(e) {
		if (e && !edas.includes(e)) edas.push(e);
	}

	function every(ms, fn) {
		if (typeof g.setInterval === "function") return g.setInterval(fn, ms);
		return api().sys_Timer.setIntervalTimer(SOCKET_ID + "-watchdog", ms, fn);
	}
	function after(ms, fn) {
		if (typeof g.setTimeout === "function") return g.setTimeout(fn, ms);
		const id = SOCKET_ID + "-t" + Math.random().toString(36).slice(2);
		api().sys_Timer.setTimeoutTimer(id, ms, fn);
		return id;
	}

	function toast(text) {
		try {
			api().sys_Message.showToastMessage("MCP: " + text);
		} catch (e) {
			/* ignore */
		}
	}

	// ---------- transport ----------
	function sendRaw(text) {
		api().sys_WebSocket.send(SOCKET_ID, text);
	}
	function send(obj) {
		const text = JSON.stringify(obj);
		if (text.length <= CHUNK) return sendRaw(text);
		const id = "c" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
		const total = Math.ceil(text.length / CHUNK);
		for (let i = 0; i < total; i++) {
			sendRaw(JSON.stringify({ t: "chunk", id, i, total, d: text.slice(i * CHUNK, (i + 1) * CHUNK) }));
		}
	}

	function hello() {
		let edaVersion = "";
		let client = null;
		try {
			edaVersion = api().sys_Environment.getEditorCurrentVersion();
			client = api().sys_Environment.isClient();
		} catch (e) {
			/* ignore */
		}
		send({ t: "hello", role: "eda", protocol: PROTOCOL, ext: VERSION, boot: state.boot, edaVersion, client, info: info() });
	}

	function onOpen() {
		state.connected = true;
		state.staleSince = 0;
		state.lastSeen = Date.now();
		state.opened++;
		try {
			hello();
		} catch (e) {
			state.lastError = String(e && e.message ? e.message : e);
		}
		flush();
	}

	function onMessage(event) {
		state.lastSeen = Date.now();
		if (!state.connected) {
			// register() was a no-op on a still-alive socket: treat as connected.
			state.connected = true;
		}
		let msg;
		try {
			const data = event && typeof event === "object" && "data" in event ? event.data : event;
			msg = JSON.parse(String(data));
		} catch (e) {
			return;
		}
		if (msg.t === "chunk") {
			let parts = state.chunks.get(msg.id);
			if (!parts) state.chunks.set(msg.id, (parts = []));
			parts[msg.i] = msg.d;
			if (parts.filter((p) => p !== undefined).length === msg.total) {
				state.chunks.delete(msg.id);
				onMessage(parts.join(""));
			}
			return;
		}
		if (msg.t === "ping") return void safeSend({ t: "pong" });
		if (msg.t === "hello?") {
			safeSend2(hello);
			return void flush();
		}
		if (msg.t === "exec") return void exec(msg);
	}
	function safeSend(obj) {
		safeSend2(() => send(obj));
	}
	// A result must not be lost when the socket happens to be down: keep it and
	// send it once the connection is back (the server waits for it).
	function deliver(reply) {
		try {
			send(reply);
		} catch (e) {
			state.lastError = String(e && e.message ? e.message : e);
			state.connected = false;
			if (state.outbox.length < 20) state.outbox.push(reply);
		}
	}
	function flush() {
		for (const reply of state.outbox.splice(0)) deliver(reply);
	}
	function safeSend2(fn) {
		try {
			fn();
		} catch (e) {
			state.lastError = String(e && e.message ? e.message : e);
			state.connected = false;
		}
	}

	function connect() {
		const ws = api().sys_WebSocket;
		ws.register(SOCKET_ID, SERVER_URL, onMessage, onOpen);
	}
	function reconnect() {
		state.connected = false;
		state.reconnects++;
		try {
			api().sys_WebSocket.close(SOCKET_ID);
		} catch (e) {
			/* ignore */
		}
		try {
			connect();
			state.lastError = "";
		} catch (e) {
			state.lastError = String(e && e.message ? e.message : e);
			if (edas.length > 1) edas.push(edas.shift()); // try the other copy's eda next time
		}
	}
	function tick() {
		const now = Date.now();
		// Two sources may drive this (worker and interval): run at most once a second.
		if (now - state.lastTick < 1000) return;
		state.lastTick = now;
		state.ticks++;
		const stale = now - state.lastSeen > DEAD_AFTER_MS;
		if (state.connected && !stale) {
			state.staleSince = 0;
			return;
		}
		if (state.connected) {
			// A busy editor thread delays this timer and the queued pings alike: give the
			// queue time to drain before deciding that the socket is dead.
			if (!state.staleSince) state.staleSince = now;
			if (now - state.staleSince < 1500) return;
		}
		state.staleSince = 0;
		reconnect();
	}
	// In a hidden or minimized window the browser engine lets page timers fire once a
	// minute, so a dropped socket stayed down for up to two minutes. Timers inside a
	// worker are not slowed down: let a worker drive the watchdog, and keep the page
	// interval as a fallback.
	function startWorker() {
		try {
			const src = "setInterval(function(){postMessage(0)}," + WATCHDOG_MS + ")";
			const url = g.URL.createObjectURL(new g.Blob([src], { type: "text/javascript" }));
			const w = new g.Worker(url);
			w.onmessage = tick;
			w.onerror = () => {
				state.ticker = "interval";
			};
			state.worker = w;
			state.ticker = "worker";
		} catch (e) {
			state.worker = null;
			state.ticker = "interval";
		}
	}
	function onVisible() {
		try {
			tick();
		} catch (e) {
			/* ignore */
		}
	}
	function startWatchdog() {
		if (state.watchdog) return;
		state.watchdog = true;
		startWorker();
		state.timer = every(WATCHDOG_MS, tick);
		try {
			g.document.addEventListener("visibilitychange", onVisible);
		} catch (e) {
			/* ignore */
		}
	}
	function stopWatchdog() {
		if (!state.watchdog) return;
		state.watchdog = false;
		try {
			if (state.worker) state.worker.terminate();
		} catch (e) {
			/* ignore */
		}
		state.worker = null;
		try {
			g.document.removeEventListener("visibilitychange", onVisible);
		} catch (e) {
			/* ignore */
		}
		try {
			if (typeof g.clearInterval === "function") g.clearInterval(state.timer);
			else api().sys_Timer.clearIntervalTimer(SOCKET_ID + "-watchdog");
		} catch (e) {
			/* ignore */
		}
	}
	// What the bridge looks like from inside; goes into hello and is readable in the
	// page as globalThis.__easyedaMcpBridge__.info().
	function info() {
		const now = Date.now();
		return {
			version: VERSION,
			boot: state.boot,
			connected: state.connected,
			lastSeenAgoMs: state.lastSeen ? now - state.lastSeen : null,
			opened: state.opened,
			reconnects: state.reconnects,
			executed: state.executed,
			running: state.running.size,
			outbox: state.outbox.length,
			ticker: state.ticker,
			ticks: state.ticks,
			lastTickAgoMs: state.lastTick ? now - state.lastTick : null,
			deactivations: state.deactivations,
			copies: edas.length,
			lastError: state.lastError,
		};
	}

	// ---------- result packing ----------
	function b64(bytes) {
		let s = "";
		for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
		return btoa(s);
	}
	async function pack(v, seen, depth) {
		if (v === null || v === undefined) return v;
		const t = typeof v;
		if (t === "string" || t === "boolean") return v;
		if (t === "number") return Number.isFinite(v) ? v : String(v);
		if (t === "bigint") return v.toString();
		if (t === "function" || t === "symbol") return undefined;
		if (depth > 40) return "[depth limit]";
		if (seen.has(v)) return "[circular]";
		if (typeof Blob !== "undefined" && v instanceof Blob) {
			const bytes = new Uint8Array(await v.arrayBuffer());
			return { __blob: true, name: v.name || "", type: v.type || "", size: bytes.length, base64: b64(bytes) };
		}
		if (v instanceof ArrayBuffer) v = new Uint8Array(v);
		if (ArrayBuffer.isView(v)) {
			const bytes = new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
			return { __blob: true, name: "", type: "", size: bytes.length, base64: b64(bytes) };
		}
		if (v instanceof Date) return v.toISOString();
		if (v instanceof Error) return { __error: true, message: v.message, stack: String(v.stack || "") };
		seen.add(v);
		try {
			if (Array.isArray(v)) {
				const out = [];
				for (const item of v) out.push(await pack(item, seen, depth + 1));
				return out;
			}
			if (v instanceof Map) {
				const out = {};
				for (const [k, item] of v) out[String(k)] = await pack(item, seen, depth + 1);
				return out;
			}
			if (v instanceof Set) return await pack([...v], seen, depth + 1);
			const out = {};
			const proto = Object.getPrototypeOf(v);
			if (proto && proto !== Object.prototype) {
				// EasyEDA primitives are class instances read through getState_Xxx().
				let p = proto;
				let found = false;
				while (p && p !== Object.prototype) {
					for (const name of Object.getOwnPropertyNames(p)) {
						if (!name.startsWith("getState_") || typeof v[name] !== "function") continue;
						const key = name.charAt(9).toLowerCase() + name.slice(10);
						if (key in out) continue;
						found = true;
						try {
							out[key] = await pack(v[name](), seen, depth + 1);
						} catch (e) {
							out[key] = "[getter failed: " + (e && e.message) + "]";
						}
					}
					p = Object.getPrototypeOf(p);
				}
				if (found) return out;
			}
			for (const k of Object.keys(v)) {
				const item = await pack(v[k], seen, depth + 1);
				if (item !== undefined) out[k] = item;
			}
			return out;
		} finally {
			seen.delete(v);
		}
	}

	function fmt(a) {
		if (typeof a === "string") return a;
		try {
			return JSON.stringify(a);
		} catch (e) {
			return String(a);
		}
	}

	// ---------- exec ----------
	async function exec(msg) {
		const started = Date.now();
		const logs = [];
		const con = {};
		for (const level of ["log", "info", "warn", "error", "debug"]) {
			con[level] = (...args) => {
				if (logs.length < 500) logs.push((level === "log" ? "" : level + ": ") + args.map(fmt).join(" "));
			};
		}
		state.running.set(msg.id, started);
		let reply;
		let timedOut = false;
		const timeoutMs = Math.max(1, Number(msg.timeoutMs) || 30000);
		try {
			const fn = new AsyncFunction("eda", "args", "console", "store", msg.code);
			const work = fn(api(), msg.args, con, state.persist);
			const timer = new Promise((resolve) =>
				after(timeoutMs, () => {
					timedOut = true;
					resolve();
				}),
			);
			let value;
			let failure;
			await Promise.race([
				work.then(
					(v) => (value = v),
					(e) => (failure = e || new Error("rejected")),
				),
				timer,
			]);
			if (failure !== undefined) throw failure;
			if (timedOut && value === undefined) {
				reply = {
					ok: false,
					error: {
						message: `Timed out after ${timeoutMs} ms. The code may still be running inside EasyEDA (it cannot be cancelled).`,
						timeout: true,
					},
				};
			} else {
				reply = { ok: true, value: await pack(value, new WeakSet(), 0) };
			}
		} catch (e) {
			reply = {
				ok: false,
				error: { message: String(e && e.message !== undefined ? e.message : e), stack: String((e && e.stack) || "") },
			};
		}
		state.running.delete(msg.id);
		state.executed++;
		reply.t = "result";
		reply.id = msg.id;
		reply.ms = Date.now() - started;
		reply.logs = logs;
		deliver(reply);
	}

	// ---------- entry points ----------
	function activate() {
		if (state.started) return; // the other copy of the script already did it
		state.started = true;
		try {
			connect();
		} catch (e) {
			state.lastError = String(e && e.message ? e.message : e);
			toast(
				"cannot open the local connection. Enable 'External interaction' for this extension in the extension manager. " +
					state.lastError,
			);
		}
		startWatchdog();
	}
	function stop() {
		stopWatchdog();
		try {
			api().sys_WebSocket.close(SOCKET_ID);
		} catch (e) {
			/* ignore */
		}
		state.connected = false;
		state.started = false;
		if (g[KEY] === runtime) delete g[KEY];
	}
	function mcpReconnect() {
		state.started = true;
		reconnect();
		startWatchdog();
		after(1500, mcpStatus);
	}
	function mcpStatus() {
		const alive = state.connected && Date.now() - state.lastSeen < DEAD_AFTER_MS;
		toast(
			(alive ? "connected to " + SERVER_URL : "NOT connected (" + SERVER_URL + "), is the MCP server running?") +
				` | ext ${VERSION} | executed ${state.executed}` +
				(state.running.size ? ` | running ${state.running.size}` : "") +
				(state.lastError ? ` | last error: ${state.lastError}` : ""),
		);
	}

	// EasyEDA may call deactivate() on one copy of the script while the page keeps
	// living. The bridge must not die from that: only count it. stop() is for a newer
	// build taking over.
	function deactivated() {
		state.deactivations++;
	}

	const runtime = { version: VERSION, adopt, activate, stop, deactivated, info, mcpReconnect, mcpStatus };
	return runtime;
	}

	// One runtime per page; a newer build replaces an older one.
	function rt() {
		let r = g[KEY];
		if (r && r.version !== VERSION) {
			try {
				r.stop();
			} catch (e) {
				/* ignore */
			}
			r = null;
		}
		if (!r) r = g[KEY] = createRuntime(ownEda);
		r.adopt(ownEda);
		return r;
	}
	const activate = () => rt().activate();
	const deactivate = () => {
		if (g[KEY] && g[KEY].deactivated) g[KEY].deactivated();
	};
	const mcpReconnect = () => rt().mcpReconnect();
	const mcpStatus = () => rt().mcpStatus();
	rt();

	const exported = { activate, deactivate, mcpReconnect, mcpStatus };
	try {
		if (ownEda) Object.assign(ownEda, { mcpReconnect, mcpStatus });
	} catch (e) {
		/* ignore */
	}
	try {
		Object.assign(g, { mcpReconnect, mcpStatus });
	} catch (e) {
		/* ignore */
	}
	return exported;
})();
