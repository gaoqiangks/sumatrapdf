// Classic Home: independent opened/closed order and configurable list columns.
// Uses disposable text files, private settings and posted window messages.
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { ControlClient, ControlCommand, withControlledSumatra } from "./control.ts";
import { IS_WIN } from "./host.ts";
import { cmdId, EXE, runStandalone, tmpPath, USE_NG } from "./util.ts";
import { findCanvas, sendCommand, waitForContextMenu, waitForFrame } from "./win-automation.ts";
import {
  captureWindowPixels,
  captureWindowToPng,
  clientToScreen,
  getMenuItemChecked,
  getMenuItemCount,
  getMenuItemDisabled,
  getMenuItemText,
  getPopupMenuHandle,
  packCoords,
  postMessage,
  sendCopyDataW,
  setProcessDpiAware,
  VK_ESCAPE,
  VK_RETURN,
  WM_CONTEXTMENU,
  WM_KEYDOWN,
  WM_LBUTTONDOWN,
  WM_LBUTTONUP,
} from "./winapi.ts";

type Row = { path: string; size: string; progress: string };
type Rect = [number, number, number, number];
type Cell = { row: number; column: string; rect: Rect; text: string };
type Home = {
  raw: string;
  rows: Row[];
  columns: Map<string, Rect>;
  cells: Cell[];
  sort: string;
  sortRect: Rect;
  headerRect: Rect;
};

const settingsName = "SumatraPDF-settings.txt";
const commonSettings = `UiLanguage = en
CheckForUpdates = false
RestoreSession = false
RememberOpenedFiles = true
RememberStatePerDocument = true
UseTabs = true
HomePageViewMode = list
HomePageSortByFrequentlyRead = false
ShowHomePageReadingProgress = true
OpenCountWeek = ${Math.floor((Date.now() - Date.UTC(2011, 0, 1)) / (7 * 24 * 60 * 60 * 1000))}
`;
const windowArgs = ["-window-pos", "2600x1400@0x0"];
const columnLabels: Record<string, string> = {
  path: "Path",
  size: "Size",
  opened: "Last opened",
  closed: "Last closed",
  modified: "Date modified",
  progress: "Reading progress",
};
const openedOrder = ["pinned-a.txt", "pinned-z.txt", "beta.txt", "alpha.txt", "legacy-first.txt", "legacy-second.txt"];
const closedOrder = ["pinned-a.txt", "pinned-z.txt", "alpha.txt", "beta.txt", "legacy-first.txt", "legacy-second.txt"];

function requireThat(value: unknown, message: string): asserts value {
  if (!value) throw new Error(`home-history: ${message}`);
}

function fileTime(date: string): string {
  const n = BigInt(Date.parse(date)) * 10000n + 116444736000000000n;
  return `${BigInt.asIntN(32, n >> 32n)} ${BigInt.asIntN(32, n)}`;
}

function timeTicks(date: string): bigint {
  return BigInt(Date.parse(date)) * 10000n + 116444736000000000n;
}

async function homeRows(client: ControlClient): Promise<Home> {
  const until = Date.now() + 15000;
  for (;;) {
    const [code, result] = await client.request(ControlCommand.TestHomeListRows, []);
    const raw = String(result ?? "");
    if (code === 0) {
      const rows: Row[] = [];
      for (const m of raw.matchAll(/^row=\d+ size='([^']*)' sizeRect=[-\d,]+ progress='([^']*)' path=(.*)$/gm)) {
        rows.push({ size: m[1]!, progress: m[2]!, path: m[3]!.trim() });
      }
      const columns = new Map<string, Rect>();
      for (const m of raw.matchAll(/^column name=(\w+) rect=([-\d,]+)/gm)) columns.set(m[1]!, parseRect(m[2]!));
      const cells: Cell[] = [];
      for (const m of raw.matchAll(/^cell row=(\d+) column=(\w+) rect=([-\d,]+) text=(.*)$/gm)) {
        cells.push({ row: +m[1]!, column: m[2]!, rect: parseRect(m[3]!), text: m[4]!.trim() });
      }
      return {
        raw,
        rows,
        columns,
        cells,
        sort: /home sort=(\w+)/.exec(raw)?.[1] ?? "",
        sortRect: parseRect(/sortRect=([-\d,]+)/.exec(raw)?.[1] ?? "0,0,0,0"),
        headerRect: parseRect(/headerRect=([-\d,]+)/.exec(raw)?.[1] ?? "0,0,0,0"),
      };
    }
    requireThat(code === 2 && Date.now() < until, `Home rows unavailable: ${raw}`);
    await Bun.sleep(50);
  }
}

function parseRect(text: string): Rect {
  return text.split(",").map(Number) as Rect;
}

async function snapshotSettings(client: ControlClient): Promise<string> {
  const [code, raw] = await client.request(ControlCommand.TestSettingsSnapshot, []);
  requireThat(code === 0, `cannot serialize private settings: ${raw}`);
  return String(raw);
}

function stateTime(raw: string, name: string, field: string): bigint {
  const lines = raw.split(/\r?\n/);
  const start = lines.findIndex((line) => /^\s*FilePath\s*=/.test(line) && line.trim().endsWith(name));
  requireThat(start >= 0, `no serialized history for ${name}`);
  let nesting = 0;
  for (const line of lines.slice(start + 1)) {
    if (/\[\s*$/.test(line)) nesting++;
    if (/^\s*\]\s*$/.test(line)) {
      if (nesting === 0) break;
      nesting--;
    }
    if (nesting !== 0) continue;
    const match = new RegExp(`^\\s*${field}\\s*=\\s*(-?\\d+)\\s+(-?\\d+)`).exec(line);
    if (match) return (BigInt.asUintN(32, BigInt(match[1]!)) << 32n) | BigInt.asUintN(32, BigInt(match[2]!));
  }
  return 0n;
}

// Posted events avoid a modal menu blocking SendMessage and never move the cursor.
function clickRect(canvas: number, rect: Rect): void {
  requireThat(rect[2] > 0 && rect[3] > 0, `missing click target ${rect}`);
  const at = packCoords(rect[0] + Math.floor(rect[2] / 2), rect[1] + Math.floor(rect[3] / 2));
  postMessage(canvas, WM_LBUTTONDOWN, 1, at);
  postMessage(canvas, WM_LBUTTONUP, 0, at);
}

async function menuAction(
  canvas: number,
  home: Home,
  column: boolean,
  choose: string,
  expectedChecked: boolean,
): Promise<void> {
  if (column) {
    const [x, y, w, h] = home.headerRect;
    requireThat(w > 0 && h > 0, "list header has no hit target");
    const pt = clientToScreen(canvas, x + Math.floor(w / 2), y + Math.floor(h / 2));
    postMessage(canvas, WM_CONTEXTMENU, canvas, packCoords(pt.x, pt.y));
  } else clickRect(canvas, home.sortRect);
  const popup = await waitForContextMenu(3000);
  requireThat(popup, `no ${column ? "column" : "sort"} menu`);
  try {
    const menu = getPopupMenuHandle(popup);
    let selected = -1;
    const labels: string[] = [];
    for (let i = 0; i < getMenuItemCount(menu); i++) {
      const label = getMenuItemText(menu, i);
      if (label) labels.push(label);
      if (label === "Name")
        requireThat(getMenuItemChecked(menu, i) && getMenuItemDisabled(menu, i), "Name must remain visible");
      if (label !== choose) continue;
      requireThat(getMenuItemChecked(menu, i) === expectedChecked, `${choose} menu check state is wrong`);
      requireThat(!getMenuItemDisabled(menu, i), `${choose} is disabled`);
      selected = i;
    }
    requireThat(selected >= 0, `${choose} missing from ${labels}`);
    const MN_SELECTITEM = 0x01e5;
    postMessage(popup, MN_SELECTITEM, selected, 0);
    postMessage(popup, WM_KEYDOWN, VK_RETURN, 0);
  } finally {
    await Bun.sleep(150);
    postMessage(popup, WM_KEYDOWN, VK_ESCAPE, 0);
  }
  await Bun.sleep(80);
}

function checkColumns(home: Home, expected: string[]): void {
  const visible = [...home.columns]
    .filter(([, r]) => r[2] > 0 && r[3] > 0)
    .map(([name]) => name)
    .sort();
  requireThat(
    JSON.stringify(visible) === JSON.stringify(["name", ...expected].sort()),
    `visible columns ${visible}, expected name,${expected}\n${home.raw}`,
  );
  const rects = [...home.columns].filter(([, r]) => r[2] > 0).sort((a, b) => a[1][0] - b[1][0]);
  for (let i = 1; i < rects.length; i++) {
    const a = rects[i - 1]![1],
      b = rects[i]![1];
    requireThat(a[0] + a[2] <= b[0], `column headers overlap: ${rects[i - 1]![0]}, ${rects[i]![0]}`);
  }
}

function checkTimes(home: Home): void {
  for (const column of ["opened", "closed"]) {
    for (const name of ["alpha.txt", "beta.txt", "legacy-first.txt", "legacy-second.txt"]) {
      const row = home.rows.findIndex((r) => basename(r.path) === name);
      const cell = home.cells.find((c) => c.row === row && c.column === column);
      requireThat(cell && cell.rect[2] > 0, `${column} cell missing for ${name}`);
      requireThat(
        name.startsWith("legacy") ? cell.text === "" : /\d/.test(cell.text),
        `${column} must preserve unknown timestamps: ${name}: '${cell.text}'`,
      );
    }
  }
}

function captureHome(canvas: number, dir: string, name: string, home: Home): void {
  requireThat(captureWindowToPng(canvas, join(dir, `${name}.png`)), "Home capture failed");
  writeFileSync(join(dir, `${name}.txt`), home.raw);
  const image = captureWindowPixels(canvas);
  requireThat(image, "no Home pixels");
  const alpha = home.rows.findIndex((row) => basename(row.path) === "alpha.txt");
  for (const column of ["opened", "closed"]) {
    const cell = home.cells.find((item) => item.row === alpha && item.column === column);
    requireThat(cell && cell.rect[2] > 0 && cell.rect[3] > 0, `no physical ${column} cell`);
    const [x, y, w, h] = cell.rect;
    const colors = new Set<number>();
    for (let cy = y + 3; cy < Math.min(y + h - 3, image.h); cy++) {
      for (let cx = x + 3; cx < Math.min(x + w - 3, image.w); cx++) {
        const p = (cy * image.w + cx) * 4;
        colors.add(image.data[p]! | (image.data[p + 1]! << 8) | (image.data[p + 2]! << 16));
      }
    }
    requireThat(colors.size > 4, `${column} cell says '${cell.text}' but its pixels are blank`);
  }
}

function expectOrder(home: Home, names: string[], label: string): void {
  const got = home.rows.map((row) => basename(row.path));
  requireThat(JSON.stringify(got) === JSON.stringify(names), `${label}: expected ${names}, got ${got}\n${home.raw}`);
}

function textFixture(dir: string, name: string): string {
  const path = join(dir, name);
  writeFileSync(path, `${name}\r\n${"Private Home history regression.\r\n".repeat(80)}`);
  return path;
}

async function seededHistory(exe: string, dir: string): Promise<void> {
  mkdirSync(dir, { recursive: true });
  const states = [
    ["legacy-first.txt", ""],
    [
      "alpha.txt",
      `LastOpenedTime = ${fileTime("2020-01-01T00:00:00Z")}\nLastClosedTime = ${fileTime("2023-01-01T00:00:00Z")}`,
    ],
    [
      "beta.txt",
      `LastOpenedTime = ${fileTime("2021-01-01T00:00:00Z")}\nLastClosedTime = ${fileTime("2022-01-01T00:00:00Z")}`,
    ],
    ["legacy-second.txt", ""],
    ["pinned-z.txt", "IsPinned = true"],
    ["pinned-a.txt", "IsPinned = true"],
  ].map(
    ([name, fields]) =>
      `[\nFilePath = ${textFixture(dir, name!)}\nOpenCount = ${name === "alpha.txt" ? 5 : name === "beta.txt" ? 2 : 1}\n${fields}\n]`,
  );
  writeFileSync(
    join(dir, settingsName),
    `${commonSettings}HomePageSortBy = opened\nHomePageListColumns = path,size,opened,closed,modified,progress\nFileStates [\n${states.join("\n")}\n]\n`,
  );
  let serialized = "";
  let nameOnly = "";
  await withControlledSumatra(
    exe,
    async (client, proc) => {
      const frame = await waitForFrame(proc.pid!);
      requireThat(frame, "no owned Home frame");
      const canvas = findCanvas(frame);
      await client.setNotificationsEnabled(false);
      let home = await homeRows(client);
      writeFileSync(join(dir, "initial-rows.txt"), home.raw);
      expectOrder(home, openedOrder, "opened timestamps and legacy fallback");
      checkColumns(home, Object.keys(columnLabels));
      checkTimes(home);
      captureHome(canvas, dir, "all-columns-en", home);

      await menuAction(canvas, home, false, "Recently Closed", false);
      home = await homeRows(client);
      expectOrder(home, closedOrder, "closed timestamps");
      requireThat(home.sort === "closed", "sort label not refreshed");
      await menuAction(canvas, home, false, "Recently Closed", true);
      home = await homeRows(client);
      await menuAction(canvas, home, false, "Frequently Read", false);
      home = await homeRows(client);
      expectOrder(home, closedOrder, "frequent compatibility");
      await menuAction(canvas, home, false, "Frequently Read", true);
      home = await homeRows(client);

      clickRect(canvas, home.columns.get("opened")!);
      await Bun.sleep(100);
      home = await homeRows(client);
      expectOrder(home, openedOrder, "opened header click");
      requireThat(home.sort === "opened", "header click did not leave frequency sort");
      clickRect(canvas, home.columns.get("closed")!);
      await Bun.sleep(100);
      home = await homeRows(client);
      expectOrder(home, closedOrder, "closed header click");

      const columns = Object.keys(columnLabels);
      for (const [column, label] of Object.entries(columnLabels)) {
        await menuAction(canvas, home, true, label, true);
        home = await homeRows(client);
        checkColumns(
          home,
          columns.filter((item) => item !== column),
        );
        await menuAction(canvas, home, true, label, false);
        home = await homeRows(client);
        checkColumns(home, columns);
      }
      await menuAction(canvas, home, true, "Path", true);
      home = await homeRows(client);
      await menuAction(canvas, home, true, "Reading progress", true);
      home = await homeRows(client);
      checkColumns(home, ["size", "opened", "closed", "modified"]);
      serialized = await snapshotSettings(client);
      requireThat(/HomePageSortBy\s*=\s*closed/.test(serialized), "sort preference missing from serializer");
      for (const [name, opened, closed] of [
        ["alpha.txt", "2020-01-01T00:00:00Z", "2023-01-01T00:00:00Z"],
        ["beta.txt", "2021-01-01T00:00:00Z", "2022-01-01T00:00:00Z"],
      ]) {
        requireThat(
          stateTime(serialized, name!, "LastOpenedTime") === timeTicks(opened!),
          `${name} opened FILETIME did not round-trip`,
        );
        requireThat(
          stateTime(serialized, name!, "LastClosedTime") === timeTicks(closed!),
          `${name} closed FILETIME did not round-trip`,
        );
      }
      for (const name of ["legacy-first.txt", "legacy-second.txt"]) {
        requireThat(
          stateTime(serialized, name, "LastOpenedTime") === 0n && stateTime(serialized, name, "LastClosedTime") === 0n,
          `invented legacy timestamps for ${name}`,
        );
      }
      for (const column of ["size", "opened", "closed", "modified"]) {
        await menuAction(canvas, home, true, columnLabels[column]!, true);
        home = await homeRows(client);
      }
      checkColumns(home, []);
      nameOnly = await snapshotSettings(client);
    },
    ["-appdata", dir, ...windowArgs],
  );
  const reloadDir = join(dir, "reload");
  mkdirSync(reloadDir, { recursive: true });
  writeFileSync(join(reloadDir, settingsName), serialized);
  await withControlledSumatra(
    exe,
    async (client) => {
      const home = await homeRows(client);
      expectOrder(home, closedOrder, "serialized sort reload");
      checkColumns(home, ["size", "opened", "closed", "modified"]);
      checkTimes(home);
    },
    ["-appdata", reloadDir, ...windowArgs],
  );
  const nameDir = join(dir, "name-only");
  mkdirSync(nameDir, { recursive: true });
  writeFileSync(join(nameDir, settingsName), nameOnly);
  await withControlledSumatra(exe, async (client) => checkColumns(await homeRows(client), []), [
    "-appdata",
    nameDir,
    ...windowArgs,
  ]);

  const chineseDir = join(dir, "chinese");
  mkdirSync(chineseDir, { recursive: true });
  writeFileSync(join(chineseDir, settingsName), serialized.replace(/UiLanguage\s*=\s*\S+/, "UiLanguage = zh-CN"));
  await withControlledSumatra(
    exe,
    async (client, proc) => {
      const frame = await waitForFrame(proc.pid!);
      requireThat(frame, "no Chinese Home frame");
      await client.setNotificationsEnabled(false);
      const home = await homeRows(client);
      captureHome(findCanvas(frame), chineseDir, "home-columns-zh", home);
    },
    ["-appdata", chineseDir, ...windowArgs],
  );
  console.log(
    "PASS: seeded order, legacy dates, all column toggles, menu checks, serializer reload and Chinese rendering",
  );
}

async function openText(client: ControlClient, frame: number, path: string): Promise<void> {
  const WM_COPYDATA_DDEW = 0x44646557;
  requireThat(
    sendCopyDataW(frame, WM_COPYDATA_DDEW, `[Open("${path}", 0, 1, 0)]`),
    "owned receiver rejected file open",
  );
  await client.waitForRenderIdle();
  const [code, raw] = await client.request(ControlCommand.TestCurrentTab, []);
  requireThat(code === 0 && String(raw).includes(path), `document did not load: ${raw}`);
}

async function closeCurrent(client: ControlClient, frame: number): Promise<void> {
  sendCommand(frame, cmdId("CmdClose"));
  await Bun.sleep(80);
  await client.request(ControlCommand.Ping, []);
}

async function liveHistory(exe: string, dir: string, rememberState: boolean): Promise<void> {
  mkdirSync(dir, { recursive: true });
  const a = textFixture(dir, "opened-first.txt");
  const b = textFixture(dir, "opened-second.txt");
  const settings = commonSettings.replace(
    "RememberStatePerDocument = true",
    `RememberStatePerDocument = ${rememberState}`,
  );
  writeFileSync(join(dir, settingsName), settings + "HomePageSortBy = opened\nHomePageListColumns = opened,closed\n");
  let serialized = "";
  await withControlledSumatra(
    exe,
    async (client, proc) => {
      const frame = await waitForFrame(proc.pid!);
      requireThat(frame, "no owned frame for live history");
      await openText(client, frame, a);
      await Bun.sleep(20);
      await openText(client, frame, b);
      const before = await snapshotSettings(client);
      const openedA = stateTime(before, "opened-first.txt", "LastOpenedTime");
      const openedB = stateTime(before, "opened-second.txt", "LastOpenedTime");
      requireThat(openedA > 0n && openedB > openedA, "actual opens did not record independent chronological times");
      requireThat(
        stateTime(before, "opened-first.txt", "LastClosedTime") === 0n &&
          stateTime(before, "opened-second.txt", "LastClosedTime") === 0n,
        "loading a second tab recorded a false close",
      );

      // Open A, B; close B, A: closed order must oppose opened order.
      await closeCurrent(client, frame);
      const partial = await snapshotSettings(client);
      const closedB = stateTime(partial, "opened-second.txt", "LastClosedTime");
      requireThat(
        closedB >= openedB && stateTime(partial, "opened-first.txt", "LastClosedTime") === 0n,
        "first close recorded the wrong document",
      );
      await Bun.sleep(20);
      await closeCurrent(client, frame);
      let home = await homeRows(client);
      expectOrder(home, ["opened-second.txt", "opened-first.txt"], "close must not rewrite recently opened order");
      await menuAction(findCanvas(frame), home, false, "Recently Closed", false);
      home = await homeRows(client);
      expectOrder(home, ["opened-first.txt", "opened-second.txt"], "opposite actual close order");
      serialized = await snapshotSettings(client);
      requireThat(
        stateTime(serialized, "opened-first.txt", "LastClosedTime") > closedB,
        "second close timestamp not updated",
      );
      requireThat(
        stateTime(serialized, "opened-first.txt", "LastOpenedTime") === openedA &&
          stateTime(serialized, "opened-second.txt", "LastOpenedTime") === openedB,
        "closing changed open timestamps",
      );
      writeFileSync(join(dir, "after-actions.txt"), home.raw);
    },
    ["-appdata", dir, ...windowArgs],
  );
  const reload = join(dir, "reload");
  mkdirSync(reload, { recursive: true });
  writeFileSync(join(reload, settingsName), serialized);
  await withControlledSumatra(
    exe,
    async (client) => {
      expectOrder(await homeRows(client), ["opened-first.txt", "opened-second.txt"], "actual close history reload");
    },
    ["-appdata", reload, ...windowArgs],
  );
  console.log(`PASS: real opens and opposite closes, RememberStatePerDocument=${rememberState}, reload`);
}

export async function testHomeHistory(exe: string, dir: string): Promise<void> {
  if (!IS_WIN || USE_NG) return;
  setProcessDpiAware();
  await seededHistory(exe, join(dir, "seeded"));
  await liveHistory(exe, join(dir, "live"), true);
  await liveHistory(exe, join(dir, "without-view-history"), false);
}

export async function testit(): Promise<void> {
  await testHomeHistory(EXE, tmpPath(`home-history-${Date.now()}`));
}

if (import.meta.main) await runStandalone(testit);
