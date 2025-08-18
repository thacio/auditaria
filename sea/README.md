# Bun Executable Build

This directory contains the build script for creating a standalone Windows executable using Bun.

## Files

- `build-bun-unified.cjs` - Build script that creates the standalone executable with embedded locales

## How to Build

```bash
node sea/build-bun-unified.cjs
```

This creates `auditaria-standalone.exe` (~120MB) in the project root.

## Features

✅ **No warnings** - Locale files are embedded, no file system errors  
✅ **Fully standalone** - No Node.js, npm, or Bun required to run  
✅ **ESM support** - Handles top-level await natively  
✅ **Complete functionality** - All Auditaria CLI features work

## Requirements

**For building:**
- Node.js (to run the build script)
- Bun (to compile the executable)

**For running the executable:**
- Nothing! It's completely standalone

## How It Works

The build script:
1. Reads the original bundle
2. Embeds locale translations directly in the code
3. Suppresses file system warnings
4. Compiles with Bun into a single executable