# pi-file-viewer

Interactive file review extension for [pi](https://github.com/mariozechner/pi-coding-agent).

It tracks recent `write` and `edit` tool calls and opens them in a reusable TUI file viewer. You can navigate changes, search, add line comments, and paste those comments back into the prompt editor.

## Demo

https://github.com/user-attachments/assets/f4f06bfd-4d6d-4dd4-b758-265c5630076b

## Features

- Tracks `write` and `edit` tool calls from the current session
- Opens a searchable file viewer with line numbers and syntax highlighting
- Marks added, changed, and removed lines when diff information is available
- Supports comments on individual lines
- Can browse all files in the current project from the same picker

## Usage

- Run `/view-file` to select a file to view
- Press `Alt+W` to open the same picker from the keyboard

Viewer keys:

- `j` / `k` or arrow keys: move
- `d` / `u`: half page down/up
- `g` / `G`: top/bottom
- `/`: search
- `n` / `N`: next/previous search match
- `enter` or `c`: add or edit a comment on the selected line
- `x`: remove the selected line comment
- `C`: clear all comments
- `q`, `Esc`, or `Ctrl+C`: close

When you close the viewer, collected comments are pasted into the prompt editor.

## Install with pi from git

Install from the GitHub repository:

```bash
pi install git:github.com/tobias-walle/pi-file-viewer
```

To pin a branch, tag, or commit:

```bash
pi install git:github.com/tobias-walle/pi-file-viewer@v0.1.0
```

SSH works too:

```bash
pi install git:git@github.com:tobias-walle/pi-file-viewer
```

Restart pi or run `/reload` after installing.

## Copy into the extension folder

You can also clone the repository and copy the extension directly into pi's auto-loaded extension folder:

```bash
git clone https://github.com/tobias-walle/pi-file-viewer.git
mkdir -p ~/.pi/agent/extensions
cp -R pi-file-viewer/extension ~/.pi/agent/extensions/file-viewer
```

Then restart pi or run `/reload`.

## Development

Install dependencies and run all checks with Bun:

```bash
bun install
bun run check
```

The check command runs Biome, TypeScript, and the smoke tests. Biome enforces formatting, import sorting, and recommended lint rules. The smoke tests verify the pi package manifest points at a loadable extension entrypoint.

You can also run the smoke tests directly:

```bash
bun test
```

Test interactively without installing:

```bash
bun run dev
```

This runs:

```bash
pi -e .
```
