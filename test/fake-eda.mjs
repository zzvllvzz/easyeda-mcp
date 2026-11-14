// A stand-in for EasyEDA Pro: loads the REAL extension bundle into a vm context
// and gives it a fake `eda` object with a tiny in-memory schematic.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { WebSocket } from "ws";

const HERE = dirname(fileURLToPath(import.meta.url));

class Wire {
	constructor(id, line, net) {
		this._id = id;
		this._line = line;
		this._net = net || "";
	}
	getState_PrimitiveType() {
		return "Wire";
	}
	getState_PrimitiveId() {
		return this._id;
	}
	getState_Line() {
		return this._line;
	}
	getState_Net() {
		return this._net;
	}
}
class Pin {
	constructor(id, num, name, x, y, rot) {
		Object.assign(this, { _id: id, _num: num, _name: name, _x: x, _y: y, _rot: rot });
	}
	getState_PrimitiveId() {
		return this._id;
	}
	getState_PinNumber() {
		return this._num;
	}
	getState_PinName() {
		return this._name;
	}
	getState_X() {
		return this._x;
	}
	getState_Y() {
		return this._y;
	}
	getState_Rotation() {
		return this._rot;
	}
	getState_PinLength() {
		return 10;
	}
	getState_NoConnected() {
		return false;
	}
}
class Part {
	constructor(id, type, des, x, y, net) {
		Object.assign(this, { _id: id, _type: type, _des: des, _x: x, _y: y, _rot: 0, _net: net });
	}
	getState_PrimitiveType() {
		return "Component";
	}
	getState_ComponentType() {
		return this._type;
	}
	getState_PrimitiveId() {
		return this._id;
	}
	getState_Designator() {
		return this._des;
	}
	getState_Name() {
		return this._type === "part" ? "10k" : undefined;
	}
	getState_Net() {
		return this._net;
	}
	getState_X() {
		return this._x;
	}
	getState_Y() {
		return this._y;
	}
	getState_Rotation() {
		return this._rot;
	}
	getState_Mirror() {
		return false;
	}
	getState_SubPartName() {
		return undefined;
	}
	getState_SupplierId() {
		return this._type === "part" ? "C25804" : undefined;
	}
}

export function startFakeEda({ url } = {}) {
	let afterNetlist = false;
	const sockets = new Map();
	let opened = 0; // sockets ever opened by the extension
	let seq = 0;
	const wires = new Map();
	const parts = new Map();
	const addPart = (type, des, x, y, net) => {
		const p = new Part("e" + ++seq, type, des, x, y, net);
		parts.set(p._id, p);
		return p;
	};
	addPart("part", "R1", 100, 100);
	addPart("part", "R2", 300, 100);
	addPart("sheet", undefined, 0, 0);

	const eda = {
		sys_WebSocket: {
			register(id, uri, onMessage, onOpen) {
				const cur = sockets.get(id);
				if (cur && (cur.readyState === WebSocket.OPEN || cur.readyState === WebSocket.CONNECTING)) return;
				const s = new WebSocket(url || uri);
				opened++;
				sockets.set(id, s);
				s.on("open", () => onOpen && onOpen());
				s.on("message", (d) => onMessage && onMessage({ data: d.toString() }));
				s.on("error", () => {});
			},
			send(id, data) {
				const s = sockets.get(id);
				if (!s || s.readyState !== WebSocket.OPEN) throw new Error("socket not open");
				s.send(data);
			},
			close(id) {
				const s = sockets.get(id);
				if (s) s.terminate();
				sockets.delete(id);
			},
		},
		sys_Environment: { getEditorCurrentVersion: () => "3.2.209-fake", isClient: () => true },
		sys_Message: { showToastMessage() {} },
		dmt_Project: { getCurrentProjectInfo: async () => ({ uuid: "proj1", friendlyName: "fake" }) },
		dmt_SelectControl: { getCurrentDocumentInfo: async () => ({ documentType: 1, uuid: "page1", tabId: "tab1" }) },
		dmt_Schematic: {
			getCurrentSchematicInfo: async () => ({ uuid: "sch1", name: "Board" }),
			getCurrentSchematicPageInfo: async () => ({ uuid: "page1", name: "P1", parentSchematicUuid: "sch1" }),
			getCurrentSchematicAllSchematicPagesInfo: async () => [{ uuid: "page1", name: "P1", parentSchematicUuid: "sch1" }],
		},
		sch_PrimitiveWire: {
			async create(line, net) {
				if (net === "MERGE") return undefined; // imitates EasyEDA merging collinear wires
				const w = new Wire("e" + ++seq, line, net === "LIES" ? "" : net ? net.toUpperCase() : "");
				wires.set(w._id, w);
				return w;
			},
			async get(ids) {
				if (Array.isArray(ids)) return ids.map((i) => wires.get(i)).filter(Boolean);
				return wires.get(ids);
			},
			async getAll(net) {
				return [...wires.values()].filter((w) => !net || w._net === net);
			},
			async modify(id, prop) {
				const w = wires.get(id);
				if (prop.net !== undefined) w._net = prop.net;
				if (prop.line) {
					w._line = prop.line;
					w._net = "";
				}
				return w;
			},
			async delete(ids) {
				for (const i of [].concat(ids)) wires.delete(i);
				return true;
			},
		},
		sch_PrimitiveComponent: {
			async getAll(type) {
				return [...parts.values()].filter((p) => !type || p._type === type);
			},
			async get(id) {
				return parts.get(id);
			},
			async getAllPinsByPrimitiveId(id) {
				const p = parts.get(id);
				return [new Pin(id + "p1", "1", "1", p._x - 20, p._y, 180), new Pin(id + "p2", "2", "2", p._x + 20, p._y, 0)];
			},
			async createNetFlag(kind, net, x, y) {
				return addPart("netflag", undefined, x, y, net);
			},
			async createNetPort(dir, net, x, y) {
				return addPart("netport", undefined, x, y, net);
			},
			// Like editor 3.2.209: a new part is "R?", and rotation 90 is stored as 270 (and back).
			async create(device, x, y, sub, rot) {
				if (!device || !device.uuid) throw new Error("bad device");
				const p = addPart("part", "R?", x, y);
				p._rot = (360 - (rot || 0)) % 360;
				return p;
			},
			async modify(id, prop) {
				// Like editor 3.2.209: the first modify after a netlist fails once.
				if (afterNetlist) {
					afterNetlist = false;
					throw new Error("Cannot destructure property 'cmdKey' of 'i' as it is undefined.");
				}
				const p = parts.get(id);
				if (prop.x !== undefined) p._x = prop.x;
				if (prop.y !== undefined) p._y = prop.y;
				if (prop.rotation !== undefined) p._rot = prop.rotation;
				if (prop.designator) p._des = prop.designator;
				return p;
			},
			async delete(ids) {
				for (const i of [].concat(ids)) parts.delete(i);
				return true;
			},
		},
		sch_Netlist: {
			async getNetlist() {
				// Generating a netlist numbers the "R?" parts, as the real editor does.
				afterNetlist = true;
				for (const p of parts.values()) {
					if (!String(p._des || "").endsWith("?")) continue;
					const prefix = p._des.slice(0, -1);
					let n = 1;
					while ([...parts.values()].some((q) => q._des === prefix + n)) n++;
					p._des = prefix + n;
				}
				// A wire named SHORTME stands for a wire that ties VCC to GND; one named NEWNET for a new connection.
				const named = (n) => [...wires.values()].some((w) => w._net === n);
				if (named("SHORTME")) return "*PADS-PCB*\n*PART*\nR1 0603\nR2 0603\n*NET*\n*SIGNAL* GND\nR1.1 R2.1 R1.2\n*END*\n";
				return "*PADS-PCB*\n*PART*\nR1 0603\nR2 0603\n*NET*\n*SIGNAL* GND\nR1.1 R2.1\n*SIGNAL* VCC\nR1.2\n" + (named("NEWNET") ? "*SIGNAL* NEWNET\nR2.2\n" : "") + "*END*\n";
			},
		},
		sch_ManufactureData: {
			// Editor 3.2.209 has no getPdfFile, only this.
			async getExportDocumentFile(name, type) {
				if (type !== "PDF") throw new Error("fake exports only PDF");
				return new File([Buffer.from("%PDF-1.4 fake")], name || "sheet.pdf", { type: "application/pdf" });
			},
		},
		lib_Device: {
			async search(key, lib, cls, type, limit) {
				return Array.from({ length: Math.min(limit || 10, 3) }, (_, i) => ({ uuid: "dev-s" + i, libraryUuid: "lib", name: key + " #" + i, supplierId: "C" + (100 + i), footprintName: "C0402", otherProperty: { "JLCPCB Part Class": "Basic Part" } }));
			},
			async getByLcscIds(ids) {
				return [].concat(ids).filter((i) => i !== "C0").map((i) => ({ uuid: "dev-" + i, libraryUuid: "lib", name: "part " + i, supplierId: i }));
			},
		},
	};

	const context = vm.createContext({ eda, console, setTimeout, setInterval, clearTimeout, clearInterval, Blob, File, btoa, ArrayBuffer, Uint8Array, Date, Promise, JSON, Math, Map, Set, WeakSet, Object, Array, String, Number, Error });
	const code = readFileSync(join(HERE, "..", "extension", "dist", "index.js"), "utf8");
	vm.runInContext(code + "\nglobalThis.__ext = edaEsbuildExportName;", context);
	context.__ext.activate();
	// EasyEDA evaluates and activates the script twice in one page: do the same.
	vm.runInContext(code + "\nglobalThis.__ext2 = edaEsbuildExportName;", context);
	context.__ext2.activate();
	return {
		eda,
		wires,
		parts,
		opened: () => opened,
		stop() {
			context.__ext.deactivate();
		},
		drop() {
			// connection dies without the extension noticing
			for (const s of sockets.values()) s.terminate();
		},
	};
}
