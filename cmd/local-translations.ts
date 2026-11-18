import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { extractStringsToTranslate } from "./trans-dl";

// Keep this fork's tab label in the packaged translations without changing the
// downloaded cache or submitting translations to apptranslator.
export function addLocalTranslations(downloaded: string, sourceStrings = extractStringsToTranslate()): string {
  const lines = downloaded.trimEnd()
    ? downloaded.trimEnd().split(/\r?\n/)
    : ["AppTranslator: SumatraPDF", "0".repeat(40)];
  const label = ":Duplicate Tab";
  let start = lines.indexOf(label);
  if (start < 0) {
    start = lines.length;
    lines.push(label);
  }
  let end = start + 1;
  while (end < lines.length && !lines[end].startsWith(":")) end++;
  const otherLanguages = lines.slice(start + 1, end).filter((line) => !/^(cn|tw):/.test(line));
  lines.splice(start + 1, end - start - 1, "cn:复制标签页", "tw:複製分頁", ...otherLanguages);

  // The color picker adds an ellipsis to the existing translated command label.
  // Reuse that translation for every language until the new label is translated.
  const colorStart = lines.indexOf(":Set Tab Color");
  if (colorStart >= 0) {
    let colorEnd = colorStart + 1;
    while (colorEnd < lines.length && !lines[colorEnd].startsWith(":")) colorEnd++;
    const colorTranslations = lines.slice(colorStart + 1, colorEnd);
    let pickerStart = lines.indexOf(":Set Tab Color...");
    if (pickerStart < 0) {
      pickerStart = lines.length;
      lines.push(":Set Tab Color...");
    }
    let pickerEnd = pickerStart + 1;
    while (pickerEnd < lines.length && !lines[pickerEnd].startsWith(":")) pickerEnd++;
    const translatedLanguages = new Set(lines.slice(pickerStart + 1, pickerEnd).map((line) => line.split(":", 1)[0]));
    const missing = colorTranslations.filter((line) => !translatedLanguages.has(line.split(":", 1)[0]));
    lines.splice(pickerEnd, 0, ...missing.map((line) => line + "..."));
  }

  // A partial cache still needs every original string: debug translation lookup
  // asserts when an original is absent, but permits an untranslated original.
  // Match the source extraction used by trans-dl.ts, including command names.
  const originals = new Set(lines.filter((line) => line.startsWith(":")).map((line) => line.slice(1)));
  for (const original of sourceStrings) {
    if (originals.has(original)) continue;
    lines.push(":" + original);
    originals.add(original);
  }
  return lines.join("\n") + "\n";
}

export function prepareLocalTranslations(
  inputRoot = resolve(import.meta.dir, ".."),
  output = join(inputRoot, ".work", "local-translations.txt"),
): string {
  const cachedPath = join(inputRoot, ".work", "translations.txt");
  const bundledPath = join(inputRoot, "translations", "translations.txt");
  const cached = existsSync(cachedPath) ? readFileSync(cachedPath, "utf8") : "";
  const downloaded = cached.trim() ? cached : existsSync(bundledPath) ? readFileSync(bundledPath, "utf8") : "";
  const text = addLocalTranslations(downloaded);
  mkdirSync(dirname(output), { recursive: true });
  if (!existsSync(output) || readFileSync(output, "utf8") !== text) writeFileSync(output, text);
  return output;
}
