# Icon Attribution

The application icon (`icon.ico`, `icon.png`) is restored from the HubFetch
0.1.0 archive at `archive/pyside-hubfetch-0.1.0:packaging/resources/hubfetch.ico`.

- Origin: owner-authored HubFetch icon (the PySide HubFetch 0.1.0 project).
- License: MIT — the archive is distributed under the MIT License, "Copyright
  (c) 2026 HubFetch" (see `archive/pyside-hubfetch-0.1.0:LICENSE`).
- Frames: the original ICO carries 16x16, 32x32, 48x48, and 256x256 PNG frames;
  `icon.png` is the 256x256 master upscaled to 1024x1024 (RGBA) with the pinned
  Node image tool `jimp@1.6.0` so window, tray, and electron-builder
  buildResources all resolve the HubFetch identity.

No third-party icon is used; the icon is HubFetch's own brand asset. The MIT
notice above is recorded per the migration plan (Todo 14 attribution step).
