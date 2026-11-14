// Packs extension/ into easyeda-mcp-bridge.eext (a plain zip). No dependencies.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { deflateRawSync, deflateSync, crc32 } from "node:zlib";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const ext = join(root, "extension");

// A logo is required by the manifest; generate a plain square if none is provided.
function png(size, [r, g, b]) {
	const chunk = (type, data) => {
		const body = Buffer.concat([Buffer.from(type), data]);
		const len = Buffer.alloc(4);
		len.writeUInt32BE(data.length);
		const crc = Buffer.alloc(4);
		crc.writeUInt32BE(crc32(body) >>> 0);
		return Buffer.concat([len, body, crc]);
	};
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(size, 0);
	ihdr.writeUInt32BE(size, 4);
	ihdr[8] = 8;
	ihdr[9] = 2;
	const row = Buffer.alloc(1 + size * 3);
	for (let x = 0; x < size; x++) row.set([r, g, b], 1 + x * 3);
	const raw = Buffer.concat(Array.from({ length: size }, () => row));
	return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
const logoPath = join(ext, "images", "logo.png");
if (!existsSync(logoPath)) writeFileSync(logoPath, png(128, [38, 110, 190]));

const files = ["extension.json", "dist/index.js", "images/logo.png"];
const local = [];
const central = [];
let offset = 0;
for (const name of files) {
	const data = readFileSync(join(ext, name));
	const packed = deflateRawSync(data, { level: 9 });
	const nameBuf = Buffer.from(name);
	const crc = crc32(data) >>> 0;
	const head = Buffer.alloc(30);
	head.writeUInt32LE(0x04034b50, 0);
	head.writeUInt16LE(20, 4);
	head.writeUInt16LE(0x0800, 6);
	head.writeUInt16LE(8, 8);
	head.writeUInt16LE(0, 10);
	head.writeUInt16LE(0x21, 12); // 1980-01-01
	head.writeUInt32LE(crc, 14);
	head.writeUInt32LE(packed.length, 18);
	head.writeUInt32LE(data.length, 22);
	head.writeUInt16LE(nameBuf.length, 26);
	local.push(head, nameBuf, packed);
	const cen = Buffer.alloc(46);
	cen.writeUInt32LE(0x02014b50, 0);
	cen.writeUInt16LE(20, 4);
	cen.writeUInt16LE(20, 6);
	cen.writeUInt16LE(0x0800, 8);
	cen.writeUInt16LE(8, 10);
	cen.writeUInt16LE(0, 12);
	cen.writeUInt16LE(0x21, 14);
	cen.writeUInt32LE(crc, 16);
	cen.writeUInt32LE(packed.length, 20);
	cen.writeUInt32LE(data.length, 24);
	cen.writeUInt16LE(nameBuf.length, 28);
	cen.writeUInt32LE(offset, 42);
	central.push(cen, nameBuf);
	offset += 30 + nameBuf.length + packed.length;
}
const centralBuf = Buffer.concat(central);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(files.length, 8);
end.writeUInt16LE(files.length, 10);
end.writeUInt32LE(centralBuf.length, 12);
end.writeUInt32LE(offset, 16);
const out = join(root, "easyeda-mcp-bridge.eext");
writeFileSync(out, Buffer.concat([...local, centralBuf, end]));
console.log(`${out} (${files.length} files, ${offset + centralBuf.length + 22} bytes)`);
