// Only the caret bookmark is selected by default. Other bookmarks sharing its
// page must not acquire inactive-selection backgrounds; matching rows are opt-in.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ControlClient, ControlCommand, withControlledSumatra } from "./control.ts";
import { IS_WIN } from "./host.ts";
import { assemblePdf, cmdId, EXE, runStandalone, tmpPath, USE_NG } from "./util.ts";
import { findCanvas, sendCommand, waitForFrame } from "./win-automation.ts";
import {
  captureWindowPixels,
  captureWindowToPng,
  findVisibleChildWindow,
  getFocusedHwnd,
  packCoords,
  postMessage,
  repaintWindow,
  setProcessDpiAware,
  treeExpandRecursively,
  treeGetNextItem,
  treeGetSelection,
  TVE_EXPAND,
  TVGN_FIRSTVISIBLE,
  TVGN_NEXTVISIBLE,
  WM_LBUTTONDOWN,
  WM_LBUTTONUP,
  WM_MOUSELEAVE,
  WM_MOUSEMOVE,
} from "./winapi.ts";

type Row = { y: number; height: number; title: string; selected: boolean; left: string; label: string };
type State = { name: string; focus: "tree" | "canvas" | "other"; rows: Row[]; width: number; height: number };
type Case = { theme: string; matches: boolean; states: State[] };
type Image = NonNullable<ReturnType<typeof captureWindowPixels>>;

function requireThat(ok: unknown, message: string): asserts ok {
  if (!ok) throw new Error(`toc-background: ${message}`);
}

// Same-page chapter, section and topic; later rows go to different pages.
function makeOutline(): string {
  return assemblePdf([
    "<< /Type /Catalog /Pages 2 0 R /Outlines 7 0 R /PageMode /UseOutlines >>",
    "<< /Type /Pages /Count 4 /Kids [3 0 R 4 0 R 5 0 R 6 0 R] >>",
    ...Array.from({ length: 4 }, () => "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>"),
    "<< /Type /Outlines /First 8 0 R /Last 13 0 R /Count 6 >>",
    "<< /Title (Chapter A) /Parent 7 0 R /Next 13 0 R /First 9 0 R /Last 12 0 R /Count 4 /Dest [3 0 R /Fit] >>",
    "<< /Title (Section A1) /Parent 8 0 R /Next 12 0 R /First 10 0 R /Last 11 0 R /Count 2 /Dest [3 0 R /Fit] >>",
    "<< /Title (Topic A1a) /Parent 9 0 R /Next 11 0 R /Dest [3 0 R /Fit] >>",
    "<< /Title (Topic A1b) /Parent 9 0 R /Prev 10 0 R /Dest [4 0 R /Fit] >>",
    "<< /Title (Section A2) /Parent 8 0 R /Prev 9 0 R /Dest [5 0 R /Fit] >>",
    "<< /Title (Chapter B) /Parent 7 0 R /Prev 8 0 R /Dest [6 0 R /Fit] >>",
  ]);
}

function dominant(image: Image, x0: number, y0: number, width: number, height: number): string {
  const counts = new Map<number, number>();
  for (let y = Math.max(0, y0); y < Math.min(image.h, y0 + height); y++) {
    for (let x = Math.max(0, x0); x < Math.min(image.w, x0 + width); x++) {
      const off = (y * image.w + x) * 4;
      const color = (image.data[off + 2]! << 16) | (image.data[off + 1]! << 8) | image.data[off]!;
      counts.set(color, (counts.get(color) ?? 0) + 1);
    }
  }
  const [color, count] = [...counts].sort((a, b) => b[1] - a[1])[0] ?? [-1, 0];
  requireThat(count! > 0, "sample region is outside the tree capture");
  return `#${color!.toString(16).padStart(6, "0")}`;
}

async function state(
  client: ControlClient,
  frame: number,
  tree: number,
  dir: string,
  name: string,
  evidence: boolean,
): Promise<State> {
  repaintWindow(tree);
  await Bun.sleep(100);
  const [code, response] = await client.request(ControlCommand.TestTocRows, []);
  requireThat(code === 0, `TOC rows unavailable: ${response}`);
  const image = captureWindowPixels(tree);
  requireThat(image && image.w > 150 && image.h > 100, "cannot capture bookmark tree");
  if (evidence) requireThat(captureWindowToPng(tree, join(dir, `${name}.png`)), "cannot save bookmark tree capture");
  const rows: Row[] = [];
  let item = treeGetNextItem(tree, TVGN_FIRSTVISIBLE);
  const selected = treeGetSelection(tree);
  for (const m of String(response).matchAll(/^row y=(\d+) dy=(\d+) title=(.*)$/gm)) {
    const y = +m[1]!,
      height = +m[2]!;
    if (y + height > image.h) break;
    rows.push({
      y,
      height,
      title: m[3]!.trim(),
      selected: item === selected,
      left: dominant(image, 2, y + 3, 6, height - 6),
      label: dominant(image, Math.floor(image.w * 0.65), y + 3, Math.floor(image.w * 0.18), height - 6),
    });
    item = treeGetNextItem(tree, TVGN_NEXTVISIBLE, item);
  }
  requireThat(rows.length === 6, `expected all six expanded bookmark rows, got ${rows.length}`);
  const focused = getFocusedHwnd(frame);
  return {
    name,
    focus: focused === tree ? "tree" : focused === findCanvas(frame) ? "canvas" : "other",
    rows,
    width: image.w,
    height: image.h,
  };
}

async function click(hwnd: number, x: number, y: number): Promise<void> {
  const pt = packCoords(x, y);
  postMessage(hwnd, WM_LBUTTONDOWN, 1, pt);
  postMessage(hwnd, WM_LBUTTONUP, 0, pt);
  await Bun.sleep(150);
}

async function captureCase(
  exe: string,
  root: string,
  theme: string,
  matches: boolean,
  evidence: boolean,
): Promise<Case> {
  const dir = join(root, `${theme.toLowerCase()}-${matches ? "matches" : "default"}`);
  mkdirSync(dir, { recursive: true });
  const document = join(dir, "outline-fixture.pdf");
  writeFileSync(document, makeOutline(), "latin1");
  writeFileSync(
    join(dir, "SumatraPDF-settings.txt"),
    `UiLanguage = en
Theme = ${theme}
ShowToc = true
ShowTocPageNumbers = true
${matches ? "ShowTocPageMatches = true\n" : ""}TocWrapText = false
ShowFavorites = false
SidebarDx = 720
CheckForUpdates = false
RestoreSession = false
`,
  );
  const states = await withControlledSumatra(
    exe,
    async (client, proc) => {
      const frame = await waitForFrame(proc.pid!);
      requireThat(frame, "no owned frame");
      await client.waitForRenderIdle();
      await client.setNotificationsEnabled(false);
      const tree = findVisibleChildWindow(frame, "SysTreeView32");
      requireThat(tree, "bookmarks tree not shown");
      treeExpandRecursively(tree, TVE_EXPAND);
      const states: State[] = [];
      const capture = async (name: string) => {
        const next = await state(client, frame, tree, dir, name, evidence);
        states.push(next);
        return next;
      };
      let last = await capture("startup");
      await click(tree, 200, last.rows[0]!.y + Math.floor(last.rows[0]!.height / 2));
      last = await capture("tree-focused");
      const hovered = last.rows[2]!;
      postMessage(tree, WM_MOUSEMOVE, 0, packCoords(200, hovered.y + Math.floor(hovered.height / 2)));
      await capture("same-page-hover");
      const other = last.rows[3]!;
      postMessage(tree, WM_MOUSEMOVE, 0, packCoords(200, other.y + Math.floor(other.height / 2)));
      await capture("other-page-hover");
      postMessage(tree, WM_MOUSELEAVE, 0, 0);
      await capture("hover-left");
      await click(findCanvas(frame), 400, 300);
      await capture("canvas-focused");
      sendCommand(frame, cmdId("CmdGoToNextPage"));
      await client.waitForRenderIdle();
      await capture("next-page");
      sendCommand(frame, cmdId("CmdGoToLastPage"));
      await client.waitForRenderIdle();
      await capture("last-page");
      return states;
    },
    ["-appdata", dir, "-window-pos", "1900x1200@0x0", document],
  );
  const result = { theme, matches, states };
  if (evidence) writeFileSync(join(dir, "colors.json"), JSON.stringify(result, null, 2));
  return result;
}

function checkDefault(result: Case): void {
  for (const state of result.states) {
    const ordinary = state.rows[4]!;
    requireThat(!ordinary.selected, `${state.name}: ordinary comparison row unexpectedly selected`);
    for (const row of state.rows) {
      if (row.selected) {
        requireThat(row.label !== ordinary.label, `${result.theme} ${state.name}: caret has no visible selection`);
      } else if (!state.name.endsWith("-hover")) {
        requireThat(
          row.label === ordinary.label,
          `${result.theme} ${state.name}: unselected '${row.title}' has ${row.label}, ordinary row ${ordinary.label}`,
        );
      }
      requireThat(
        row.left === row.label,
        `${result.theme} ${state.name}: '${row.title}' has mixed indent/label backgrounds ${row.left}/${row.label}`,
      );
    }
  }
  const focused = result.states.find((item) => item.name === "tree-focused")!;
  requireThat(focused.focus === "tree" && focused.rows[0]!.selected, "click did not focus/select the chapter");
  const canvas = result.states.find((item) => item.name === "canvas-focused")!;
  requireThat(canvas.focus !== "tree", "canvas click did not move focus out of tree");
  const last = result.states.find((item) => item.name === "last-page")!;
  requireThat(last.rows[5]!.selected, "page navigation did not move caret to Chapter B");
}

function checkOptIn(result: Case): void {
  const state = result.states.find((item) => item.name === "tree-focused")!;
  const ordinary = state.rows[4]!.label;
  requireThat(
    state.rows[1]!.label !== ordinary && state.rows[2]!.label !== ordinary,
    "explicit matching-bookmark highlight no longer works",
  );
}

export async function testTocBackground(exe: string, dir: string, evidence = false): Promise<void> {
  if (!IS_WIN || USE_NG) return;
  setProcessDpiAware();
  const results = [
    await captureCase(exe, dir, "Light", false, evidence),
    await captureCase(exe, dir, "Light", true, evidence),
  ];
  if (evidence) writeFileSync(join(dir, "colors.json"), JSON.stringify(results, null, 2));
  checkDefault(results[0]!);
  checkOptIn(results[1]!);
  const dark = await captureCase(exe, dir, "Dark", false, evidence);
  checkDefault(dark);
  console.log("PASS: default single selection, focus/navigation, and opt-in matching bookmarks");
}

export async function testit(): Promise<void> {
  await testTocBackground(EXE, tmpPath(`toc-background-${Date.now()}`));
}

if (import.meta.main) await runStandalone(testit);
