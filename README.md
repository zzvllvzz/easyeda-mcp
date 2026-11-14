# easyeda-mcp

An MCP server that lets Claude Code (or any MCP client) read and draw schematics and PCBs in EasyEDA Pro.

A tiny extension inside the editor does one thing: it runs the JavaScript the server sends, with access to the `eda` API, and returns the result. All tool logic lives in the server, so fixes and new tools never require reinstalling the extension.

Edits are guarded: `sch_draw` and `pcb_draw` apply a whole batch of operations or nothing, and take the change back by themselves when it shorts two named nets on the schematic or adds a design rule error on the board.

## Requirements

- EasyEDA Pro desktop client 3.x (tested on 3.2.209 for Windows).
- Node.js 20 or newer on `PATH`.
- Claude Code, or another MCP client that runs stdio servers.

## Install

### 1. The bridge extension in EasyEDA Pro

1. Download [`easyeda-mcp-bridge.eext`](https://github.com/zzvllvzz/easyeda-mcp/releases/latest/download/easyeda-mcp-bridge.eext) from the latest release.
2. In EasyEDA Pro open the extension manager and import the file.
3. Allow the extension External Interaction. It needs it to reach the local server.
4. Restart EasyEDA. The extension starts only when the editor starts.

The extension connects to `ws://127.0.0.1:49731` by itself and reconnects when the link drops. The editor gets an MCP menu with Reconnect and Status.

### 2. The server in Claude Code

As a plugin, in a Claude Code session:

```
/plugin install easyeda --marketplace zzvllvzz/easyeda-mcp
```

On Claude Code older than 2.1.275, add the marketplace first:

```
/plugin marketplace add zzvllvzz/easyeda-mcp
/plugin install easyeda@easyeda-mcp
```

Then run `/reload-plugins` or start a new session.

Or from npm, without the plugin:

```sh
# macOS, Linux
claude mcp add easyeda -s user -- npx -y easyeda-pro-mcp
# Windows
claude mcp add easyeda -s user -- cmd /c npx -y easyeda-pro-mcp
```

Or from source:

```sh
git clone https://github.com/zzvllvzz/easyeda-mcp
cd easyeda-mcp
npm install
claude mcp add easyeda -s user -- node /absolute/path/to/easyeda-mcp/server/index.mjs
```

Other MCP clients: run `npx -y easyeda-pro-mcp` as a stdio server.

### 3. Check

With EasyEDA open, ask Claude to check the EasyEDA connection. `eda_status` should answer `connected` with the editor and extension versions and the active project.

## Tools

- `eda_status`: is the editor connected, versions, active project and sheet, state of the bridge.
- `eda_exec`: run JS inside EasyEDA (`eda`, helpers `h`, `args`, `console`, `store`).
- `eda_call`: call one API method by its path.
- `eda_api`: search the API reference.
- `sch_read`: read a sheet: summary, parts with pins, wires, nets, check (`check`), overlaps (`overlaps`), free room (`free`).
- `sch_draw`: a batch of operations on the sheet as one guarded change (see below).
- `sch_export`: PDF, PNG, SVG, netlist, BOM to a file.
- `lib_search`: find parts in the library by words or LCSC numbers.
- `pcb_read`: the board: info, parts with pads, tracks, vias, pours and regions, nets, unrouted connections, DRC.
- `pcb_draw`: a batch of operations on the board as one change guarded by DRC.
- `pcb_do`: open a board, import changes from the schematic, refill pours, autoroute, remove routing.
- `pcb_export`: Gerber, pick and place, BOM, STEP/OBJ, DXF, DSN, IPC-356, IPC-2581, ODB++, PDF and more.

The helpers `h` live in `server/helpers.js` and are read again on every call, so the file can be edited while the server runs.

## Guard, trial run and rollback

`sch_draw` and `pcb_draw` apply the list of operations as a whole or not at all.

On the schematic a netlist is taken before and after the change. If nets with different names given by a person merged into one, that is a short: the change is taken back and the report names the nets and the pins. A change in which an operation failed, or an `expect` (`{NET: [pins]}`) did not hold, is taken back the same way. After a rollback the netlist is compared with the original and the report says `restored: true`. `allowShorts` permits an intended merge. The report always shows what happened to the nets: what got connected, what dropped off, what split, what was renamed.

On the board DRC runs before and after the change. A new error other than a connection that is not routed yet (clearance, short, entering a keep-out) takes the change back. Pours are refilled before the check. `allowErrors` keeps a change with errors.

`trial: true` performs the change in the editor, shows the report and takes it back in any case. A rollback restores moved parts, properties, the no-connect mark, wire names and shapes, deleted wires, tracks and vias. Deleted parts, texts and shapes cannot be restored, so a trial run that deletes parts is refused up front.

The guard forbids nothing in advance by geometry: EasyEDA itself decides, and the netlist or DRC judges the result. It gives no false refusals.

## Security

The extension runs whatever code the local server sends, with full access to the editor API and your EasyEDA account. Keep that in mind:

- The server listens on `127.0.0.1` only. Browsers can open WebSockets to localhost from any site, so the server refuses connections that carry a browser Origin other than EasyEDA's own (`https://*.easyeda.com`, `https://*.lceda.cn`). More origins can be allowed with `EASYEDA_MCP_ORIGINS`, comma separated. Local programs (other sessions of this server, `scripts/run.mjs`) send no Origin and are accepted, as with any local developer tool.
- `eda_exec` can call any editor function, including the ordering ones (`placePcbOrder`, `placeComponentsOrder` and similar). The tool description tells the model never to call them.
- EasyEDA saves changes to the cloud by itself a few seconds after an edit, and the API has no undo. Try risky edits with `trial: true` or on a scratch sheet or project.

## How it works

- `extension/dist/index.js`: the extension, written by hand without a bundler.
- `server/link.mjs`: the link to the editor. The first server started owns the port; servers of other Claude sessions go through it. If the first one exits, the next one takes the port.
- `server/index.mjs`: MCP over stdio and the tools. Large answers are saved to `~/.easyeda-mcp/out/`, the reply carries the beginning and the path.
- `server/api-index.mjs`: parses the API typings for search.

Environment variables: `EASYEDA_MCP_PORT` (the port in the extension has to change too), `EASYEDA_MCP_OUT`, `EASYEDA_MCP_ORIGINS`.

## Development

- `npm test` runs real server processes and the real extension code against a fake `eda` (`test/fake-eda.mjs`). It does not check the behaviour of a live EasyEDA.
- `npm run build:ext` packs `extension/` into `easyeda-mcp-bridge.eext` (needs Node 20.15 or 22.2 and newer).
- `node scripts/run.mjs draw <ops.json> [--trial] [--no-guard]` and `node scripts/run.mjs exec <code.js> [args.json]` run `sch_draw` operations or code from a file through the hub of a running server. Useful for generators with hundreds of operations.

Updating the extension without the import dialog: if EasyEDA runs with a debugging port (`easyeda-pro.exe --remote-debugging-port=9333 --remote-allow-origins=*`), a new build can be put into its extension storage directly: `npm run build:ext`, then `node scripts/push-ext.mjs`, then restart EasyEDA. The very first install still goes through the import dialog.

## Tested on a live EasyEDA Pro 3.2.209

Schematic: reading, every `sch_draw` operation, short protection, trial run and rollback (six scenarios, the sheet came back identical), check, overlaps, free room search, export pdf/png/svg/netlist/bom/view. Load: 260 operations in one call (120 parts, 130 wires, 10 ground symbols) with a check of 130 nets took 100 seconds with the window hidden.

Board (in a scratch project): import from the schematic, moving parts, tracks, vias, a pour with fill, a keep-out region, text, outline, DRC, protection against shorted tracks and entering a keep-out, autorouting, export gerber/pnp/bom/step/dxf/dsn/ipc356/odb/altium/pdf/netlist.

Link: works with the window minimized, recovers after a dropped socket and after the computer sleeps.

Not tested: multilayer boards and blind vias, net classes and differential pairs (available through the raw API), boards and sheets with hundreds of parts, the web editor, macOS and Linux.

## Known limitations

- A modal dialog in the editor blocks the API call that opened it, and the bridge does not see it: the call waits until its timeout. Example: "this device has been updated, update in the project?" when placing a part whose symbol changed after its first use in the project. Press the button in the editor, or find the dialog in `top.document` from `eda_exec` and click it there.
- No tools for creating sheets, changing the sheet format or editing library symbols. The raw API is available through `eda_exec`.
- `sch_draw` takes its operations inline only; for long lists use `scripts/run.mjs`. `trial` and the `part` op do not return pin coordinates, and the `set` op cannot mark a part as not placed (DNP).
- `lib_search` cuts descriptions at about 120 characters.

## Editor quirks the helpers work around

- The list of wires on a sheet (`getAll`, `getAllPrimitiveId`) lags about a second behind wire creation, `get(ids)` sees them at once. `h.draw` waits for the update; after the raw API call `h.settle(ids)`.
- `sch_PrimitiveComponent.create` stores rotation 90 as 270 and the other way round; `modify` is correct.
- `sch_PrimitivePin.modify` without `y` flips the sign of the pin's y and the pin flies off the part. Pass the current `y`.
- Right after a netlist is generated the editor rejects edits: `modify` throws `cmdKey`, a wire create throws `create failed!`, `delete` silently returns `false`. A retry a moment later succeeds.
- Connectivity lags about a second behind a wire deletion: a netlist taken at once still shows the old nets.
- A new wire merges with every wire whose end it touches; `create` returns the old wire's id.
- A power symbol or a port cannot be modified, only deleted and created again. Rotation 90 is stored as 270 on creation for them too. A symbol right on a pin end hangs on a zero-length wire that cannot be created by hand: after moving the part away and back the symbol is attached anew.
- Every operation on a sheet gets slower as the sheet fills up; creating a part takes 0.5 to 0.7 s, so parts are placed in batches of eight.
- `sch_Drc.check` returns only the number of findings per severity; the list exists only in the editor panel.
- Board: `pcb_Primitive.getPrimitiveTypeByPrimitiveId` always answers `undefined`; a pour is refilled with the object's `rebuildCopperRegion()`; `importChanges()` only opens a confirmation dialog, `h.pcb.import` presses its button; `getPdfFile` without content settings never answers; `dmt_Project.deleteProject` returns `false` and does not delete the project.
- Generating a netlist numbers the "R?" parts across the whole project. The API has no separate call for annotation.
- `getPdfFile` does not exist in the editor, `getPngFile` and `getSvgFile` never resolve. `getExportDocumentFile` does all of it.
- The extension script may run twice in a page, so there is one runtime per page (`globalThis.__easyedaMcpBridge__`, `info()` shows its state).
- In a minimized or hidden window page timers fire once a second, and after the fifth in a chain once a minute (measured: twelve pauses of 0.1 s took 3.7 minutes). So the connection watchdog and the helpers' pauses (`h.sleep`, `h.limit`, `h.settle`) run on a timer in a worker: thirty such pauses take 3.3 s. The editor's own timers suffered the same way (netlist 53 s instead of 2 s, creating a part 24 s), so while the window is hidden the helpers move the page's `setTimeout` and `setInterval` onto the same worker. With a visible window the timers are native. Turn it off with `h.pageTimers(false)`.

## License

MIT.
