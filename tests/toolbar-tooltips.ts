// A stationary cursor over Find should register a native toolbar tip only when enabled.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ControlCommand, withControlledSumatra } from "./control.ts";
import { IS_WIN } from "./host.ts";
import { cmdId, EXE, pollUntil, ROOT, runStandalone, tmpPath, USE_NG } from "./util.ts";
import { findChildByClass, waitForFrame } from "./win-automation.ts";
import {
  clientToScreen,
  enumWindows,
  getClassName,
  getCursorPos,
  getWindowPid,
  getWindowRect,
  packCoords,
  sendMessage,
  setProcessDpiAware,
  setWindowPos,
  WM_LBUTTONDOWN,
  WM_LBUTTONUP,
  WM_MOUSELEAVE,
  WM_MOUSEMOVE,
} from "./winapi.ts";

const WM_SETCURSOR = 0x20;
const TTM_GETTOOLCOUNT = 0x040d;

function toolCount(pid: number): number {
  let count = 0;
  enumWindows((hwnd) => {
    if (getWindowPid(hwnd) === pid && getClassName(hwnd) === "tooltips_class32") {
      count += Number(sendMessage(hwnd, TTM_GETTOOLCOUNT, 0, 0));
    }
    return true;
  });
  return count;
}

export async function testToolbarTooltips(exe: string, root: string): Promise<void> {
  if (!IS_WIN || USE_NG) return;
  setProcessDpiAware();
  for (const enabled of [true, false]) {
    const dir = join(root, enabled ? "enabled" : "default");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "SumatraPDF-settings.txt"),
      "UiLanguage = en\nSearchUIFloating = false\n" + (enabled ? "ShowToolbarTooltips = true\n" : ""),
    );
    await withControlledSumatra(
      exe,
      async (client, proc) => {
        const frame = await waitForFrame(proc.pid!);
        const bar = findChildByClass(frame, "SUMATRA_VIRT_TOOLBAR");
        if (!bar) throw new Error("Toolbar window missing");
        await client.waitForRenderIdle();
        const raw = String((await client.request(ControlCommand.TestToolbarButtons, []))[1]);
        const rect = new RegExp(
          `^idx=\\d+ cmd=${cmdId("CmdFindFirst")} hidden=0 rect=(-?\\d+),(-?\\d+),(-?\\d+),(-?\\d+)`,
          "m",
        ).exec(raw);
        if (!rect) throw new Error("Visible Find button missing");
        const x = Math.floor((Number(rect[1]) + Number(rect[3])) / 2);
        const y = Math.floor((Number(rect[2]) + Number(rect[4])) / 2);
        // WM_SETCURSOR uses GetCursorPos. Move the test window under the pointer
        // so the same path works on an inactive desktop without moving the mouse.
        const pt = getCursorPos();
        const at = clientToScreen(bar, x, y);
        const box = getWindowRect(frame);
        if (
          !setWindowPos(
            frame,
            box.left + pt.x - at.x,
            box.top + pt.y - at.y,
            box.right - box.left,
            box.bottom - box.top,
          )
        )
          throw new Error("Could not position Find under the cursor");
        const current = clientToScreen(bar, x, y);
        if (Math.abs(current.x - pt.x) > 2 || Math.abs(current.y - pt.y) > 2)
          throw new Error(`Could not place Find at ${pt.x},${pt.y}; got ${current.x},${current.y}`);
        const pos = packCoords(x, y);
        sendMessage(bar, WM_MOUSELEAVE, 0, 0);
        const before = toolCount(proc.pid!);
        sendMessage(bar, WM_SETCURSOR, bar, packCoords(1, WM_MOUSEMOVE));
        const hovered = toolCount(proc.pid!);
        sendMessage(bar, WM_MOUSELEAVE, 0, 0);
        const left = toolCount(proc.pid!);
        if (hovered !== before + (enabled ? 1 : 0) || left !== before) {
          throw new Error(
            `Toolbar tooltip ${enabled ? "enabled" : "default"}: before=${before}, hovered=${hovered}, left=${left}`,
          );
        }
        sendMessage(bar, WM_LBUTTONDOWN, 1, pos);
        sendMessage(bar, WM_LBUTTONUP, 0, pos);
        await pollUntil(
          async () => String((await client.request(ControlCommand.TestFindUiState, ["state"]))[1]),
          (s) => s.includes("compact=1"),
          { error: (s) => `Find button did not open the search bar: ${s}` },
        );
      },
      ["-appdata", dir, "-window-pos", "1400x900@60x60", join(ROOT, "tests", "issue-2423.pdf")],
    );
  }
}

export async function testit(): Promise<void> {
  await testToolbarTooltips(EXE, tmpPath("toolbar-tooltips"));
}

if (import.meta.main) await runStandalone(testit);
