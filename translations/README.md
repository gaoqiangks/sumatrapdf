# Bundled UI translations

`translations.txt` is an offline snapshot of the SumatraPDF language data from
[AppTranslator](https://www.apptranslator.org/app/SumatraPDF), retrieved on 2026-09-10.
It contains all 72 supported non-English languages; English uses the source strings.
Simplified and traditional Chinese cover all 936 current translatable UI strings.

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

Snapshot SHA-256: `000cc1403cb881b706b5bb5e0020600cd41bee680f3ac74d4a9dd8da841ee61a`.

`bun cmd/gen-docs.ts` (or `bun cmd/pack-embedded.ts`) embeds this snapshot when the
downloaded `.work/translations.txt` cache is absent or empty. A nonempty downloaded
cache takes precedence. The Visual Studio prebuild also seeds a missing or empty
cache from this file, so a clean offline build includes the language pack.

After updating the snapshot, run `bun cmd/gen-docs.ts`, then `bun cmd/build.ts -debug`.
