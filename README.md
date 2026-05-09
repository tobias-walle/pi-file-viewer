# pi-file-viewer

Interactive file review extension for [pi](https://github.com/mariozechner/pi-coding-agent).

It tracks recent `write` and `edit` tool calls and opens them in a reusable TUI file viewer. You can navigate changes, search, add line comments, and paste those comments back into the prompt editor.

## Features

- Tracks `write` and `edit` tool calls from the current session
- Opens a searchable file viewer with line numbers and syntax highlighting
- Marks added, changed, and removed lines when diff information is available
- Supports comments on individual lines
- Can browse all files in the current project from the same picker

## Usage

- Run `/review-file` to select a file to review
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

Push this repository to a git host, then install it with pi:

```bash
pi install git:github.com/<user>/pi-file-viewer
```

To pin a branch, tag, or commit:

```bash
pi install git:github.com/<user>/pi-file-viewer@v0.1.0
```

SSH works too:

```bash
pi install git:git@github.com:<user>/pi-file-viewer
```

Restart pi or run `/reload` after installing.

## Copy into the extension folder

You can also copy the extension directly into pi's auto-loaded extension folder:

```bash
mkdir -p ~/.pi/agent/extensions
cp -R extensions/file-viewer ~/.pi/agent/extensions/file-viewer
cp -R extensions/shared ~/.pi/agent/extensions/shared
```

Then restart pi or run `/reload`.

If you already have a `shared` extension helper folder, copy only the missing files or merge the folders manually.

## Development

Install dependencies and typecheck with Bun:

```bash
bun install
bun run typecheck
```

Test without installing:

```bash
pi -e /Users/tobias.walle/Projects/pi-file-viewer
```
