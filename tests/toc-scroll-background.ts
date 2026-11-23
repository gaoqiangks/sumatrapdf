// Native horizontal scrolling copies old row pixels. Fixed page labels and
// custom selection fills must match a full repaint at the same scroll offset.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ControlCommand, withControlledSumatra } from "./control.ts";
import { IS_WIN } from "./host.ts";
import { assemblePdf, EXE, runStandalone, tmpPath, USE_NG } from "./util.ts";
import { waitForFrame } from "./win-automation.ts";
import {
  captureWindowDCRegionPixels,
  captureWindowDCToPng,
  findVisibleChildWindow,
  getClientRect,
  getScrollInfo,
  repaintWindow,
  SB_HORZ,
  sendMessage,
  setProcessDpiAware,
} from "./winapi.ts";

function requireThat(ok: unknown, message: string): asserts ok {
  if (!ok) throw new Error(`toc-scroll-background: ${message}`);
}

function makeOutline(): string {
  const names = [
    "A long bookmark title ".repeat(16),
    "Section One",
    "Subsection One",
    "Another Section",
    "Final Chapter",
  ];
  return assemblePdf([
    "<< /Type /Catalog /Pages 2 0 R /Outlines 4 0 R /PageMode /UseOutlines >>",
    "<< /Type /Pages /Count 1 /Kids [3 0 R] >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>",
    "<< /Type /Outlines /First 5 0 R /Last 9 0 R /Count 5 >>",
    ...names.map(
      (title, i) =>
        `<< /Title (${title}) /Parent 4 0 R ${i > 0 ? `/Prev ${4 + i} 0 R` : ""} ${i < 4 ? `/Next ${6 + i} 0 R` : ""} /Dest [3 0 R /Fit] >>`,
    ),
  ]);
}

function capture(
  tree: number,
  dir: string,
  name: string,
  evidence: boolean,
): { width: number; height: number; data: Uint8Array } {
  const rect = getClientRect(tree);
  const width = rect.right,
    height = rect.bottom;
  const data = captureWindowDCRegionPixels(tree, 0, 0, width, height);
  requireThat(data && data.length === width * height * 4, "cannot capture existing tree surface");
  if (evidence) requireThat(captureWindowDCToPng(tree, join(dir, `${name}.png`)), "cannot save existing tree surface");
  return { width, height, data };
}

function background(image: ReturnType<typeof capture>, y: number, height: number): number {
  const colors = new Map<number, number>();
  for (let cy = y + 2; cy < Math.min(y + height - 2, image.height); cy++) {
    for (let x = 12; x < image.width - 30; x++) {
      const i = (cy * image.width + x) * 4;
      const color = (image.data[i]! << 16) | (image.data[i + 1]! << 8) | image.data[i + 2]!;
      colors.set(color, (colors.get(color) ?? 0) + 1);
    }
  }
  return [...colors].sort((a, b) => b[1] - a[1])[0]?.[0] ?? -1;
}

async function runTheme(exe: string, root: string, theme: string, evidence: boolean): Promise<void> {
  const dir = join(root, theme.toLowerCase());
  mkdirSync(dir, { recursive: true });
  const document = join(dir, "long-outline.pdf");
  writeFileSync(document, makeOutline(), "latin1");
  writeFileSync(
    join(dir, "SumatraPDF-settings.txt"),
    `UiLanguage = en
Theme = ${theme}
ShowToc = true
ShowTocPageNumbers = true
TocWrapText = false
ShowFavorites = false
SidebarDx = 600
RestoreSession = false
CheckForUpdates = false
`,
  );
  await withControlledSumatra(
    exe,
    async (client, proc) => {
      const frame = await waitForFrame(proc.pid!);
      requireThat(frame, "no owned frame");
      await client.waitForRenderIdle();
      await client.setNotificationsEnabled(false);
      const tree = findVisibleChildWindow(frame, "SysTreeView32");
      requireThat(tree, "no bookmarks tree");
      const [code, raw] = await client.request(ControlCommand.TestTocRows, []);
      requireThat(code === 0, `cannot read rows: ${raw}`);
      const rows = [...String(raw).matchAll(/^row y=(\d+) dy=(\d+) /gm)].map((m) => ({ y: +m[1]!, h: +m[2]! }));
      requireThat(rows.length === 5, "fixture bookmarks missing");
      const start = getScrollInfo(tree, SB_HORZ);
      requireThat(start.max >= start.page + 100, `no real horizontal scroll range: ${JSON.stringify(start)}`);
      repaintWindow(tree);
      await Bun.sleep(100);
      const baseline = capture(tree, dir, "before-scroll", evidence);
      const colors = new Set<number>();
      for (let i = 0; i < baseline.data.length; i += 4)
        colors.add((baseline.data[i]! << 16) | (baseline.data[i + 1]! << 8) | baseline.data[i + 2]!);
      requireThat(colors.size > 10, `window DC is not a rendered tree (${colors.size} colors)`);

      const WM_HSCROLL = 0x0114;
      const SB_LINELEFT = 0;
      const SB_LINERIGHT = 1;
      const SB_THUMBPOSITION = 4;
      const results: { action: string; before: number; after: number; different: number; pixels: number }[] = [];
      for (const [action, command, repeats] of [
        ["line-right", SB_LINERIGHT, 12],
        ["line-left", SB_LINELEFT, 6],
        ["thumb-right", SB_THUMBPOSITION | (180 << 16), 1],
        ["thumb-back", SB_THUMBPOSITION | (10 << 16), 1],
      ] as const) {
        const before = getScrollInfo(tree, SB_HORZ).pos;
        for (let i = 0; i < repeats; i++) {
          sendMessage(tree, WM_HSCROLL, command, 0);
          await Bun.sleep(25);
        }
        const after = getScrollInfo(tree, SB_HORZ).pos;
        requireThat(after !== before, `${action} did not actually change horizontal offset ${before}`);
        await Bun.sleep(80);
        // BitBlt existing pixels BEFORE any PrintWindow/full invalidation.
        const incremental = capture(tree, dir, `${action}-incremental`, evidence);
        repaintWindow(tree);
        await Bun.sleep(100);
        const full = capture(tree, dir, `${action}-full`, evidence);
        requireThat(getScrollInfo(tree, SB_HORZ).pos === after, "full repaint changed scroll position");
        const normal = background(full, rows.at(-1)!.y + rows.at(-1)!.h + 12, 30);
        for (const row of rows.slice(1)) {
          const color = background(full, row.y, row.h);
          requireThat(
            color === normal,
            `${theme} ${action}: unselected row y=${row.y} has background ${color.toString(16)}, theme background ${normal.toString(16)}`,
          );
        }
        let different = 0,
          pixels = 0;
        // Short-title rows leave a wide empty band before their fixed page labels.
        for (const row of rows.slice(1)) {
          for (let y = row.y + 2; y < row.y + row.h - 2; y++) {
            for (let x = Math.max(0, full.width - 220); x < full.width - 3; x++) {
              const p = (y * full.width + x) * 4;
              pixels++;
              if ([0, 1, 2].some((channel) => incremental.data[p + channel] !== full.data[p + channel])) different++;
            }
          }
        }
        results.push({ action, before, after, different, pixels });
      }
      if (evidence)
        writeFileSync(join(dir, "scroll-results.json"), JSON.stringify({ theme, initial: start, results }, null, 2));
      for (const row of results)
        requireThat(
          row.different === 0,
          `${theme} ${row.action}: incremental repaint differs from full repaint at x=${row.after}: ${row.different}/${row.pixels} label-band pixels`,
        );
    },
    ["-appdata", dir, "-window-pos", "1700x1100@0x0", document],
  );
}

export async function testTocScroll(exe: string, dir: string, evidence = false): Promise<void> {
  if (!IS_WIN || USE_NG) return;
  setProcessDpiAware();
  await runTheme(exe, dir, "Light", evidence);
  await runTheme(exe, dir, "Dark", evidence);
  console.log("PASS: horizontal offsets change and incremental page-label pixels match a full repaint");
}

export async function testit(): Promise<void> {
  await testTocScroll(EXE, tmpPath(`toc-scroll-background-${Date.now()}`));
}

if (import.meta.main) await runStandalone(testit);
