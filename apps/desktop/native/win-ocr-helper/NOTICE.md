# win-ocr-helper

Native Windows OCR + foreground-window helper for Sarä "Learn by Watching".
Extracted from **Omi** (github.com/BasedHardware/omi, MIT License) —
`desktop/windows/src/main/ocr/win-ocr-helper/`. Uses `Windows.Media.Ocr` (WinRT)
+ user32.dll. Long-running stdio subprocess; framed binary protocol
(opcode 1 = OCR jpeg→text, opcode 2 = foreground window). See electron/ocr/.

Build (Windows, needs the .NET 8 SDK):
    dotnet publish native/win-ocr-helper -c Release -o resources/win-ocr-helper
Produces resources/win-ocr-helper/win-ocr-helper.exe (self-contained, single-file).
