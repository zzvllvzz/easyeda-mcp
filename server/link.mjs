// Connection to EasyEDA. Several MCP servers (one per Claude session) may run at
// once, but only one can own the port the extension connects to. The first one
// becomes the hub; the others connect to it as peers and send their requests
// through it. If the hub exits, a peer takes over the port.
import { WebSocketServer, WebSocket } from "ws";

export const PORT = Number(process.env.EASYEDA_MCP_PORT) || 49731;
const HOST = "127.0.0.1";
const CHUNK = 200000;
const PING_MS = 2000;
const MAX_PAYLOAD = 512 * 1024 * 1024;
// The extension may drop and reopen its socket while code is still running in the
// editor (watchdog after a busy thread). Running requests survive that long.
const GRACE_MS = 12000;

// Whoever connects to the port can run code in the editor, so web pages must be kept out:
// a browser opens WebSockets to 127.0.0.1 for any site. Browsers always send an Origin
// header with the handshake and a page cannot remove it, while local programs (other
// sessions of this server, scripts/run.mjs) send none. So a connection without Origin is
// a local program, and one with Origin is accepted only from EasyEDA's own pages
// (the desktop client runs https://pro.easyeda.com). EASYEDA_MCP_ORIGINS adds more,
// comma separated.
const EDA_HOST = /(^|\.)(easyeda\.com|lceda\.cn)$/;
const EXTRA_ORIGINS = (process.env.EASYEDA_MCP_ORIGINS || "")
	.split(",")
	.map((s) => s.trim())
	.filter(Boolean);
export function originAllowed(origin) {
	if (origin === undefined) return true;
	if (EXTRA_ORIGINS.includes(origin)) return true;
	try {
		const url = new URL(origin);
		return url.protocol === "https:" && EDA_HOST.test(url.hostname);
	} catch {
		return false;
	}
}

export class Link {
	constructor(log = () => {}) {
		this.log = log;
		this.role = "starting"; // hub | peer | starting
		this.server = null;
		this.eda = null; // hub: socket of the extension
		this.edaInfo = null;
		this.hubSocket = null; // peer: socket to the hub
		this.pending = new Map(); // id -> {resolve, reject, timer}
		this.forward = new Map(); // hub: eda request id -> {peer, peerId}
		this.chunks = new Map();
		this.seq = 0;
		this.closed = false;
		this.waiters = new Set();
		this.boot = null; // id of the extension runtime; changes when the editor page reloads
		this.graceTimer = null;
	}

	start() {
		if (this.closed) return;
		const server = new WebSocketServer({
			host: HOST,
			port: PORT,
			maxPayload: MAX_PAYLOAD,
			verifyClient: ({ origin }) => {
				const ok = originAllowed(origin);
				if (!ok) this.log(`refused a connection from ${origin}`);
				return ok;
			},
		});
		server.on("listening", () => {
			this.role = "hub";
			this.server = server;
			this.log(`hub on ${HOST}:${PORT}`);
			this.pingTimer = setInterval(() => this.#send(this.eda, { t: "ping" }), PING_MS);
			this.pingTimer.unref?.();
		});
		server.on("error", (err) => {
			if (this.server === server) return this.log("hub error " + err.message);
			if (err.code === "EADDRINUSE") this.#becomePeer();
			else {
				this.log("listen failed: " + err.message);
				this.#retry();
			}
		});
		server.on("connection", (socket) => this.#onHubConnection(socket));
	}

	#retry() {
		if (this.closed) return;
		const t = setTimeout(() => this.start(), 200 + Math.random() * 400);
		t.unref?.();
	}

	// ---------- hub side ----------
	#onHubConnection(socket) {
		socket.role = "unknown";
		socket.on("message", (data) => this.#onHubMessage(socket, data.toString()));
		socket.on("close", () => {
			if (socket === this.eda) {
				this.eda = null;
				this.edaInfo = null;
				this.log("EasyEDA disconnected");
				clearTimeout(this.graceTimer);
				if (this.forward.size) {
					this.graceTimer = setTimeout(() => {
						if (!this.eda) this.#failRunning("EasyEDA disconnected while the request was running");
					}, GRACE_MS);
					this.graceTimer.unref?.();
				}
			}
			for (const [id, f] of this.forward) if (f.peer === socket) this.forward.delete(id);
		});
		socket.on("error", () => {});
		// Ask who it is; the extension answers with hello.
		this.#send(socket, { t: "hello?" });
	}

	#onHubMessage(socket, text) {
		let msg;
		try {
			msg = JSON.parse(text);
		} catch {
			return;
		}
		if (msg.t === "chunk") {
			const key = msg.id;
			let parts = this.chunks.get(key);
			if (!parts) this.chunks.set(key, (parts = { n: 0, list: [] }));
			if (parts.list[msg.i] === undefined) parts.n++;
			parts.list[msg.i] = msg.d;
			if (parts.n === msg.total) {
				this.chunks.delete(key);
				this.#onHubMessage(socket, parts.list.join(""));
			}
			return;
		}
		if (msg.t === "hello") {
			socket.role = msg.role;
			if (msg.role === "eda") {
				if (this.eda && this.eda !== socket) {
					try {
						this.eda.close();
					} catch {}
				}
				this.eda = socket;
				clearTimeout(this.graceTimer);
				// Same runtime back on a new socket: its results will still arrive. A different
				// one means the page reloaded and whatever was running is gone.
				if (this.boot && msg.boot && this.boot !== msg.boot)
					this.#failRunning("EasyEDA reloaded while the request was running");
				this.boot = msg.boot ?? null;
				this.edaInfo = { ext: msg.ext, edaVersion: msg.edaVersion, client: msg.client, protocol: msg.protocol, since: Date.now() };
				this.log(`EasyEDA connected (ext ${msg.ext}, editor ${msg.edaVersion})`);
				for (const w of this.waiters) w();
			}
			return;
		}
		if (msg.t === "pong") return;
		if (socket.role === "eda" && msg.t === "result") {
			const f = this.forward.get(msg.id);
			if (!f) return;
			this.forward.delete(msg.id);
			this.#deliver(f, msg);
			return;
		}
		if (socket.role === "peer") {
			if (msg.t === "status?") {
				const answer = () => this.#send(socket, { t: "status", id: msg.id, eda: this.edaInfo });
				if (!this.eda && msg.waitMs) this.#waitForEda(msg.waitMs).then(answer);
				else answer();
				return;
			}
			if (msg.t === "exec") {
				this.#hubExec(msg, { peer: socket, peerId: msg.id });
			}
		}
	}

	#failRunning(message) {
		for (const [id, f] of this.forward) {
			this.forward.delete(id);
			this.#deliver(f, { t: "result", ok: false, error: { message } });
		}
	}

	#deliver(f, msg) {
		if (f.peer) this.#send(f.peer, { ...msg, id: f.peerId });
		else this.#settle(f.localId, msg);
	}

	async #hubExec(msg, origin) {
		if (!this.eda) await this.#waitForEda(msg.waitMs ?? 15000);
		if (!this.eda) {
			return this.#deliver(origin, {
				t: "result",
				ok: false,
				error: { message: "EasyEDA is not connected", notConnected: true },
			});
		}
		const id = "h" + ++this.seq;
		this.forward.set(id, origin);
		this.#send(this.eda, { t: "exec", id, code: msg.code, args: msg.args, timeoutMs: msg.timeoutMs }, true);
	}

	#waitForEda(ms) {
		return new Promise((resolve) => {
			const done = () => {
				clearTimeout(timer);
				this.waiters.delete(done);
				resolve();
			};
			const timer = setTimeout(done, ms);
			this.waiters.add(done);
		});
	}

	// ---------- peer side ----------
	#becomePeer() {
		const socket = new WebSocket(`ws://${HOST}:${PORT}`, { maxPayload: MAX_PAYLOAD });
		this.peerSocket = socket;
		socket.on("open", () => {
			this.role = "peer";
			this.hubSocket = socket;
			this.#send(socket, { t: "hello", role: "peer", pid: process.pid });
			this.log("peer of an existing hub");
		});
		socket.on("message", (data) => {
			let msg;
			try {
				msg = JSON.parse(data.toString());
			} catch {
				return;
			}
			if (msg.t === "result" || msg.t === "status") this.#settle(msg.id, msg);
		});
		const lost = () => {
			if (this.peerSocket === socket) {
				this.peerSocket = null;
				this.hubSocket = null;
				this.role = "starting";
				for (const [id] of this.pending)
					this.#settle(id, { ok: false, error: { message: "Lost the hub connection while the request was running; retry" } });
				this.#retry();
			}
		};
		socket.on("close", lost);
		socket.on("error", () => {});
	}

	// ---------- common ----------
	#send(socket, obj, chunked = false) {
		if (!socket || socket.readyState !== WebSocket.OPEN) return false;
		const text = JSON.stringify(obj);
		if (chunked && text.length > CHUNK) {
			const id = "s" + ++this.seq + "-" + Date.now().toString(36);
			const total = Math.ceil(text.length / CHUNK);
			for (let i = 0; i < total; i++)
				socket.send(JSON.stringify({ t: "chunk", id, i, total, d: text.slice(i * CHUNK, (i + 1) * CHUNK) }));
		} else socket.send(text);
		return true;
	}

	#settle(id, msg) {
		const p = this.pending.get(id);
		if (!p) return;
		this.pending.delete(id);
		clearTimeout(p.timer);
		p.resolve(msg);
	}

	#request(build, timeoutMs) {
		return new Promise((resolve) => {
			const id = "r" + process.pid + "-" + ++this.seq;
			const timer = setTimeout(() => {
				this.pending.delete(id);
				resolve({ ok: false, error: { message: `No answer from EasyEDA within ${timeoutMs} ms`, timeout: true } });
			}, timeoutMs);
			this.pending.set(id, { resolve, timer });
			build(id);
		});
	}

	async #ready() {
		for (let i = 0; i < 50 && this.role === "starting"; i++) await new Promise((r) => setTimeout(r, 100));
		if (this.role === "starting") throw new Error("Bridge is not ready (cannot listen on or connect to port " + PORT + ")");
	}

	/** Run code inside EasyEDA. Resolves to {ok, value|error, logs, ms}. */
	async exec(code, args, timeoutMs = 30000, waitMs = 15000) {
		await this.#ready();
		const total = timeoutMs + waitMs + 5000;
		return this.#request((id) => {
			const msg = { t: "exec", id, code, args, timeoutMs, waitMs };
			if (this.role === "hub") this.#hubExec(msg, { localId: id });
			else this.#send(this.hubSocket, msg);
		}, total);
	}

	/** waitMs: how long to wait for EasyEDA to (re)connect before reporting it as absent. */
	async status(waitMs = 0) {
		await this.#ready().catch(() => {});
		if (this.role === "hub") {
			if (!this.eda && waitMs) await this.#waitForEda(waitMs);
			return { role: "hub", port: PORT, eda: this.edaInfo };
		}
		if (this.role === "peer") {
			const r = await this.#request((id) => this.#send(this.hubSocket, { t: "status?", id, waitMs }), waitMs + 3000);
			return { role: "peer", port: PORT, eda: r.eda ?? null };
		}
		return { role: this.role, port: PORT, eda: null };
	}

	close() {
		this.closed = true;
		clearInterval(this.pingTimer);
		try {
			this.server?.close();
			for (const c of this.server?.clients ?? []) c.terminate();
			this.hubSocket?.terminate();
		} catch {}
	}
}
