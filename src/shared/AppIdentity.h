/* Copyright 2026 the SumatraPDF project authors (see AUTHORS file).
   License: GPLv3 */

#ifndef SUMATRA_APP_IDENTITY_H
#define SUMATRA_APP_IDENTITY_H

#if defined(SUMATRA_TEXSTUDIO37)
constexpr const wchar_t* kFrameClassName = L"SUMATRA_TEXSTUDIO37_PDF_FRAME";
constexpr const wchar_t* kCanvasClassName = L"SUMATRA_TEXSTUDIO37_PDF_CANVAS";
constexpr const wchar_t* kSumatraDdeServer = L"SUMATRA_TEXSTUDIO37";
constexpr const wchar_t* kAppUserModelId = L"SumatraPDF.TeXstudio37";
constexpr char kAppDataDirName[] = "SumatraPDF-TeXstudio37";
#else
constexpr const wchar_t* kFrameClassName = L"SUMATRA_PDF_FRAME";
constexpr const wchar_t* kCanvasClassName = L"SUMATRA_PDF_CANVAS";
constexpr const wchar_t* kSumatraDdeServer = L"SUMATRA";
constexpr const wchar_t* kAppUserModelId = L"SumatraPDF";
constexpr char kAppDataDirName[] = "SumatraPDF";
#endif

#endif
