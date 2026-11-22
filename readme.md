[![Build](https://github.com/sumatrapdfreader/sumatrapdf/actions/workflows/build.yml/badge.svg?branch=master)](https://github.com/sumatrapdfreader/sumatrapdf/actions/workflows/build.yml)

## SumatraPDF Reader

SumatraPDF is a multi-format (PDF, EPUB, MOBI, CBZ, CBR, FB2, CHM, XPS, DjVu) reader
for Windows under (A)GPLv3 license, with some code under BSD license (see
AUTHORS).

More Information:

- [Website](https://www.sumatrapdfreader.org/free-pdf-reader)
- [Manual](https://www.sumatrapdfreader.org/manual)
- [Developer Information](https://www.sumatrapdfreader.org/docs/Contribute-to-SumatraPDF)

## Fork builds

Windows builds produce both editions. Run `bun cmd/build.ts -dbg` for debug,
`bun cmd/build.ts -rel` for release, or `bun cmd/build.ts -all` for release
executables with both dynamic and static linking.

| Edition               | Release executable                        | Windows application ID   |
| --------------------- | ----------------------------------------- | ------------------------ |
| Standard icon         | `out/rel64/SumatraPDF.exe`                | `SumatraPDF`             |
| Custom TeXstudio icon | `out/rel64/texstudio37/SumatraPDF3.7.exe` | `SumatraPDF.TeXstudio37` |

The editions use separate window classes, DDE services, QuickLook agents and
fallback settings directories. Keep their portable executables in separate
directories so each has its own `SumatraPDF-settings.txt`. Both retain this fork's cache-directory
setting and duplicate-tab behavior. Static executables have `-static` appended
to their names.

On the Home page, click the sort selector to choose Recently Opened,
Recently Closed or Frequently Read. In list view, right-click the column
headers to show or hide the path, size, last opened time, last closed time,
modification time and reading progress. Name stays visible. Pinned files
stay first. Older history entries gain timestamps as you open and close them.

To run UI tests against the custom edition, set `SUMATRA_TEST_VARIANT=custom`
and select its executable with `-exe out/dbg64/texstudio37/SumatraPDF3.7.exe`
or `SUMATRA_TEST_EXE`. Tests default to the standard edition.
