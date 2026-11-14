// Run code inside EasyEDA from the command line, through the hub of a running MCP server.
// For generator scripts whose operations live in a file and are too long to pass inline.
//
//   node scripts/run.mjs draw <ops.json> [--trial] [--no-guard] [--allow-shorts] [--verbose] [--timeout ms]
//       ops.json: an array of sch_draw ops, or an object with an `ops` array (and optional `expect`)
//   node scripts/run.mjs exec <code.js> [args.json] [--timeout ms]
//       code.js: body of an async function, as for eda_exec
//
// Prints the reply as JSON. Exit code 1 when the call failed or the change was taken back.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Link } from "../server/link.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const flag = (name) => {
	const i = argv.indexOf(name);
	if (i < 0) return false;
	argv.splice(i, 1);
	return true;
};
const option = (name, fallback) => {
	const i = argv.indexOf(name);
	if (i < 0) return fallback;
	const v = argv[i + 1];
	argv.splice(i, 2);
	return v;
};

const timeoutMs = Number(option("--timeout", 300000));
const trial = flag("--trial");
const noGuard = flag("--no-guard");
const allowShorts = flag("--allow-shorts");
const verbose = flag("--verbose");
const [mode, file, argsFile] = argv;
if (!["draw", "exec"].includes(mode) || !file) {
	console.error("usage: run.mjs draw <ops.json> [--trial] [--no-guard] [--allow-shorts] [--verbose] | run.mjs exec <code.js> [args.json]");
	process.exit(2);
}

const helpers = readFileSync(join(HERE, "..", "server", "helpers.js"), "utf8").trim().replace(/;$/, "");
const wrap = (code) => `const h = (${helpers})(eda, console, store);\n${code}`;

let code, args;
if (mode === "draw") {
	const data = JSON.parse(readFileSync(file, "utf8"));
	const ops = Array.isArray(data) ? data : data.ops;
	const opts = { trial, verbose, guard: !noGuard };
	if (allowShorts) opts.allowShorts = true;
	if (!Array.isArray(data) && data.expect) opts.expect = data.expect;
	code = "return await h.draw(args.ops, args.opts);";
	args = { ops, opts };
} else {
	code = readFileSync(file, "utf8");
	args = argsFile ? JSON.parse(readFileSync(argsFile, "utf8")) : null;
}

const link = new Link(() => {});
link.start();
const reply = await link.exec(wrap(code), args, timeoutMs);
link.close();
console.log(JSON.stringify(reply.ok ? reply.value : reply, null, 1));
const failed = !reply.ok || (mode === "draw" && reply.value && reply.value.ok === false);
process.exit(failed ? 1 : 0);
