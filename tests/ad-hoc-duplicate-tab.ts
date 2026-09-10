// Duplicate a document with a view different from the default, then compare
// the two tabs and navigate one independently. Run with:
//   bun tests/ad-hoc-duplicate-tab.ts [--no-build]
// Uses the existing debug control queries and window-message helpers.
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ControlClient, ControlCommand, withControlledSumatra } from "./control.ts";
import { EXE, cmdId, runStandalone, tmpPath } from "./util.ts";
import {
  findCanvas,
  openContextMenu,
  pressEscape,
  pressKey,
  sendCommandSync,
  waitForContextMenu,
  waitForFrame,
} from "./win-automation.ts";
import {
  captureWindowPixels,
  captureWindowToPng,
  clientToScreen,
  findChildWindow,
  getClientRect,
  getPopupMenuHandle,
  readMenuTree,
  setProcessDpiAware,
  VK_DOWN,
  VK_RETURN,
} from "./winapi.ts";

type Tab = { win: number; current: boolean; page: number; file: string };
type Pixels = NonNullable<ReturnType<typeof captureWindowPixels>>;

function fail(message: string): never {
  throw new Error(`duplicate-tab: ${message}`);
}

// Asymmetric content throughout each page makes a misplaced scroll position
// or rotation visible even when the viewport contains no text.
function makePdf(): Buffer {
  const objects: string[] = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  const kids: number[] = [];
  for (let page = 1; page <= 6; page++) {
    const pageObject = objects.length + 1;
    kids.push(pageObject);
    const lines: string[] = [];
    for (let row = 0; row < 16; row++) {
      const red = ((row + page) % 7) / 8;
      const green = ((row * 3 + page) % 9) / 10;
      lines.push(`${red} ${green} 0.7 rg 0 ${row * 48} 612 35 re f`);
      lines.push(`0 0 0 rg BT /F1 14 Tf 30 ${row * 48 + 10} Td (page ${page}, row ${row}) Tj ET`);
      lines.push(`0.9 0.4 0.1 rg ${40 + row * 23} ${row * 48} 11 35 re f`);
    }
    const content = lines.join("\n");
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${pageObject + 1} 0 R >>`,
      `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    );
  }
  objects[1] = `<< /Type /Pages /Kids [${kids.map((n) => `${n} 0 R`).join(" ")}] /Count ${kids.length} >>`;
  let pdf = "%PDF-1.7\n";
  const offsets: number[] = [];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf, "latin1"));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf, "latin1");
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, "latin1");
}

async function tabs(client: ControlClient): Promise<Tab[]> {
  const result = await client.request(ControlCommand.TestMarkdownFollowLink, ["", 0]);
  const text = String(result[1] ?? "");
  if (result[0] !== 0) {
    fail(`cannot query tabs: ${text}`);
  }
  const out: Tab[] = [];
  for (const match of text.matchAll(/^tab win=(\d+) current=(\d) pageNo=(\d+) file=(.+)$/gm)) {
    out.push({ win: +match[1]!, current: match[2] === "1", page: +match[3]!, file: match[4]!.trim() });
  }
  return out;
}

async function view(client: ControlClient): Promise<string> {
  const result = await client.request(ControlCommand.TestDisplayMode, ["get"]);
  if (result[0] !== 0) {
    fail(`cannot query view: ${result[1]}`);
  }
  return String(result[1]).trim();
}

function current(list: Tab[]): Tab {
  return list.find((tab) => tab.current && tab.win === 0) ?? fail(`no active tab: ${JSON.stringify(list)}`);
}

function assertSamePixels(before: Pixels, after: Pixels, label: string): void {
  if (before.w !== after.w || before.h !== after.h) {
    fail(`${label}: canvas size changed from ${before.w}x${before.h} to ${after.w}x${after.h}`);
  }
  let different = 0;
  let total = 0;
  // Ignore window edges and the notification area. Compare RGB, since DIB
  // alpha bytes are not meaningful. A small allowance covers raster rounding.
  for (let y = 80; y < before.h - 24; y += 3) {
    for (let x = 24; x < before.w - 24; x += 3) {
      const offset = (y * before.w + x) * 4;
      total++;
      if ([0, 1, 2].some((channel) => Math.abs(before.data[offset + channel]! - after.data[offset + channel]!) > 8)) {
        different++;
      }
    }
  }
  if (total < 1000 || different > total * 0.005) {
    fail(`${label}: ${different}/${total} sampled canvas pixels differ; see tests/tmp/duplicate-tab screenshots`);
  }
}

function snapshot(canvas: number, dir: string, label: string): Pixels {
  const pixels = captureWindowPixels(canvas) ?? fail(`${label}: cannot capture canvas`);
  captureWindowToPng(canvas, join(dir, `${label}.png`));
  return pixels;
}

async function prepareView(client: ControlClient, frame: number, rotate: boolean): Promise<void> {
  sendCommandSync(frame, cmdId("CmdZoom200"));
  if (rotate) {
    sendCommandSync(frame, cmdId("CmdRotateRight"));
  }
  sendCommandSync(frame, cmdId("CmdGoToNextPage"));
  sendCommandSync(frame, cmdId("CmdGoToNextPage"));
  await client.waitForRenderIdle();
  for (let i = 0; i < 5; i++) {
    // Single-page vertical scrollbar navigation changes pages. Exercise the
    // horizontal scroll there, and vertical scrolling in continuous mode.
    sendCommandSync(frame, cmdId(rotate ? "CmdScrollRight" : "CmdScrollDown"));
  }
  await pressEscape(findCanvas(frame));
  await client.waitForRenderIdle();
}

async function runScenario(
  dir: string,
  name: string,
  useTabs: boolean,
  rotate: boolean,
  background: boolean,
  missing = false,
  language = "en",
): Promise<void> {
  const appdata = join(dir, name);
  mkdirSync(appdata, { recursive: true });
  writeFileSync(
    join(appdata, "SumatraPDF-settings.txt"),
    `UiLanguage = ${language}\nCheckForUpdates = false\nRestoreSession = false\nRememberOpenedFiles = false\nRememberStatePerDocument = false\nUseTabs = ${useTabs}\nNoHomeTab = true\nShowToc = false\nShowFavorites = false\nEscToExit = false\nReloadModifiedDocuments = false\nDefaultDisplayMode = ${rotate ? "single page" : "continuous"}\nDefaultZoom = 100\nScrollbars = windows\nScrollbarInSinglePage = true\nSmoothScroll = false\nTabWidth = 240\n`,
  );
  const source = join(dir, missing ? "missing-source.pdf" : "source.pdf");
  if (missing) {
    writeFileSync(source, makePdf());
    rmSync(`${source}.moved`, { force: true });
  }
  const other = join(dir, "other.pdf");
  await withControlledSumatra(
    EXE,
    async (client, proc) => {
      // A modal menu that did not accept the synthetic keys must fail the
      // probe instead of leaving a control request waiting indefinitely.
      client.socket.setTimeout(20000, () => client.socket.destroy());
      const frame = (await waitForFrame(proc.pid!)) || fail(`${name}: no frame`);
      const canvas = findCanvas(frame) || fail(`${name}: no canvas`);
      await client.waitForRenderIdle();
      const initial = await tabs(client);
      if (initial.length !== (background ? 2 : 1)) {
        fail(`${name}: unexpected initial tabs: ${JSON.stringify(initial)}`);
      }
      if (background && current(initial).file !== source) {
        sendCommandSync(frame, cmdId("CmdPrevTab"));
        await client.waitForRenderIdle();
      }
      await prepareView(client, frame, rotate);
      const sourceTab = current(await tabs(client));
      if (sourceTab.file !== source || sourceTab.page < 2 || sourceTab.page >= 6) {
        fail(`${name}: source view was not prepared: ${JSON.stringify(sourceTab)}`);
      }
      const sourceView = await view(client);
      const before = snapshot(canvas, dir, `${name}-before`);
      let beforeFailedLoad: Tab[] = [];
      let beforeFailedView = "";

      if (background) {
        sendCommandSync(frame, cmdId("CmdNextTab"));
        await client.waitForRenderIdle();
        if (current(await tabs(client)).file !== other) {
          fail(`${name}: background source is still selected`);
        }
        if (missing) {
          // The source remains loaded in its background tab, but loading a
          // second controller now fails before a new tab can be created.
          beforeFailedLoad = await tabs(client);
          beforeFailedView = await view(client);
          renameSync(source, `${source}.moved`);
        }
        const tabBar = findChildWindow(frame, "SumatraTabsCtrlClass") || fail(`${name}: no tab bar`);
        const rect = getClientRect(tabBar);
        const pt = clientToScreen(tabBar, 20, Math.floor((rect.bottom - rect.top) / 2));
        openContextMenu(tabBar, pt.x, pt.y);
        const menu = (await waitForContextMenu()) || fail(`${name}: no tab context menu`);
        const items = readMenuTree(getPopupMenuHandle(menu));
        const duplicateLabel = language === "cn" ? "复制标签页" : "Duplicate Tab";
        const itemIndex = items.findIndex((item) => item.text === duplicateLabel);
        if (itemIndex < 0) {
          await pressEscape(frame);
          fail(`${name}: ${duplicateLabel} is missing from the context menu: ${JSON.stringify(items)}`);
        }
        // Menu keyboard navigation skips the separators readMenuTree omits.
        // Posted key messages are consumed by TrackPopupMenu's modal loop.
        for (let i = 0; i <= itemIndex; i++) {
          await pressKey(frame, VK_DOWN, 20);
        }
        await pressKey(frame, VK_RETURN, 50);
      } else {
        sendCommandSync(frame, cmdId("CmdDuplicateInNewTab"));
      }
      await client.waitForRenderIdle();

      const copiedTabs = await tabs(client);
      if (missing) {
        if (
          JSON.stringify(copiedTabs) !== JSON.stringify(beforeFailedLoad) ||
          (await view(client)) !== beforeFailedView
        ) {
          fail(
            `${name}: failed duplication changed the active document: ${JSON.stringify(copiedTabs)}; ${await view(client)}`,
          );
        }
        console.log(`duplicate-tab ${name}: failed background duplication preserved both tabs and the active view`);
        return;
      }
      const copies = copiedTabs.filter((tab) => tab.file === source);
      if (copies.length !== 2 || copiedTabs.length !== initial.length + 1 || copiedTabs.some((tab) => tab.win !== 0)) {
        fail(`${name}: expected a second document tab in the same window: ${JSON.stringify(copiedTabs)}`);
      }
      const duplicate = current(copiedTabs);
      if (duplicate.file !== source || duplicate.page !== sourceTab.page || (await view(client)) !== sourceView) {
        fail(
          `${name}: duplicate changed the page, layout or zoom: ${JSON.stringify(copiedTabs)}; ${await view(client)}`,
        );
      }
      const after = snapshot(canvas, dir, `${name}-after`);
      // With UseTabs=false, the newly visible tab bar changes canvas height.
      if (useTabs) {
        assertSamePixels(before, after, name);
      }

      sendCommandSync(frame, cmdId("CmdGoToLastPage"));
      await client.waitForRenderIdle();
      const moved = await tabs(client);
      if (
        current(moved).page !== 6 ||
        moved.find((tab) => !tab.current && tab.file === source)?.page !== sourceTab.page
      ) {
        fail(`${name}: navigating the copy changed the original: ${JSON.stringify(moved)}`);
      }
      // The copy is appended, so wrapping forward returns to the source.
      sendCommandSync(frame, cmdId("CmdNextTab"));
      await client.waitForRenderIdle();
      if (current(await tabs(client)).file !== source || (await view(client)) !== sourceView) {
        fail(`${name}: switching back did not preserve the original view`);
      }
      if (useTabs) {
        assertSamePixels(before, snapshot(canvas, dir, `${name}-original`), `${name}: original`);
      }
      console.log(
        `duplicate-tab ${name}: same-window copy preserved page ${sourceTab.page}, zoom, view and independent navigation`,
      );
    },
    ["-appdata", appdata, source, ...(background ? [other] : [])],
  );
}

export async function testit(): Promise<void> {
  setProcessDpiAware();
  const dir = tmpPath("duplicate-tab");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "source.pdf"), makePdf());
  writeFileSync(join(dir, "other.pdf"), makePdf());
  const failures: string[] = [];
  const scenarios: [string, boolean, boolean, boolean, boolean, string][] = [
    ["continuous", true, false, false, false, "en"],
    ["rotated", true, true, false, false, "en"],
    ["tabs-disabled", false, false, false, false, "en"],
    ["background", true, true, true, false, "en"],
    ["missing-background", true, false, true, true, "en"],
    ["background-cn", true, true, true, false, "cn"],
  ];
  for (const [name, useTabs, rotate, background, missing, language] of scenarios) {
    try {
      await runScenario(dir, name, useTabs, rotate, background, missing, language);
    } catch (error) {
      failures.push(String(error));
    }
  }
  if (failures.length) {
    fail(failures.join("\n"));
  }
}

if (import.meta.main) {
  await runStandalone(testit);
}
