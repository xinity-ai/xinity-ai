# Assets

`xinity.ico` is the Windows executable icon, generated from the dashboard's
`static/xinity-icon.png` padded to a square:

```bash
magick ../../xinity-ai-dashboard/static/xinity-icon.png -background none \
  -gravity center -extent 452x452 \
  -define icon:auto-resize=256,128,64,48,32,16 xinity.ico
```

Nothing consumes it yet. Bun's `--windows-icon` only works when the host is
Windows, and the release workflow cross-compiles every target from Linux.
Patching the resources afterwards needs a tool that keeps Bun's `.bun` payload
section intact, which rules out rcedit (see electron/rcedit#107, archived) and
`resedit` (refuses to grow `.rsrc` when a non-`.reloc` section follows it).
Worth picking up eventually. The two workable routes are compiling the Windows
target on a Windows runner, or a helper built on
https://github.com/Systemcluster/editpe.
