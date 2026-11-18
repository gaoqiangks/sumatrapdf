# Bundled UI translations

`translations.txt` is an offline snapshot of the SumatraPDF language data from
[AppTranslator](https://www.apptranslator.org/app/SumatraPDF), retrieved on 2026-09-10.
It contains all 72 supported non-English languages; English uses the source strings.
Simplified and traditional Chinese cover all 936 UI strings from that snapshot.
Strings added upstream since then fall back to English until translated.
On 2026-11-18, the bundled file was extended offline with the current source
originals and local tab labels, preserving the earlier translations. It contains
1,596 originals, including all 1,492 currently extracted originals.

The snapshot was generated from the public, read-only history endpoint
`https://www.apptranslator.org/api/transhist?app=SumatraPDF&lang=<code>` for each
non-English language in `cmd/trans-gen.ts`. For each original string and language,
the revision with the greatest timestamp was selected. Actual tabs and newlines
were escaped for the runtime text format. Only current source/command originals
were retained. No credentials or translation submissions were involved.

`cmd/local-translations.ts` supplies the local Duplicate Tab labels and the ellipsis
variant of Set Tab Color, and retains untranslated internal command originals for
debug lookup. Other languages may fall back to English for new untranslated labels.
The file's second line is the SHA-1 of its UTF-8 body, including the final newline.

Bundled file SHA-256: `42d21f1906b1a69cc31fab70abb0802439f58a9bac58a08bec7cea0a57608ede`.

The build's embedded-data preparation uses this snapshot when the
downloaded `.work/translations.txt` cache is absent or empty. A nonempty downloaded
cache takes precedence and is never modified by build preparation. `cmd/build.ts`
prepares a fresh `.work/local-translations.txt` overlay and passes its path only to
that build process. The ng packer prepares its own overlay. Raw Visual Studio
builds use the downloaded cache or this snapshot directly, ignoring old overlays.
Use `cmd/build.ts` when a downloaded cache predates the current source: it adds
missing originals before packaging so debug translation lookups remain valid.

After updating the snapshot, run `bun cmd/build.ts -dbg`.
