# agent-terminal admin UI

React 19 + Vite + Tailwind v4 SPA for `agent-terminal`: sessions, the xterm.js
terminal workspace, MCP status and the transcript/audit log. The browser never
touches the serial port — every byte goes through the Python server.

```bash
npm ci
npm run dev     # http://localhost:5173, proxies /api and /ws to 127.0.0.1:8765
npm run build   # emits into ../src/tio_server/web/static (served by the Python app)
npm run lint
```

Layout:

```text
src/
├── App.tsx                  polling, hash router, toasts
├── index.css                shared layout/primitive styling + theme effects
├── styles/fonts.css         self-hosted @font-face (Vite hashes them into assets/)
├── assets/fonts/            woff2 files (pixel + sheet themes)
├── components/
│   ├── Shell.tsx            the single shell — every theme shares this layout
│   ├── TerminalSettingsDialog.tsx  the Settings dialog: theme dropdown + custom
│   │                        JSON editor, terminal, keyboard capture, clipboard
│   ├── StatusPanel.tsx      live session rail
│   └── ui/                  button, card, badge, input, dialog+switch
├── pages/                   Sessions (overview + SSH hosts), Terminal workspace, MCP, Logs
└── lib/                     api, types, theme specs, terminal palettes, utils
```

## Themes

Themes are JSON specs (`lib/themeSpecs.ts`, webssh2-style): `label`,
`colorScheme`, a `vars` map of CSS custom properties (Tailwind v4 emits palette,
radius, shadow and type scale as variables, so a spec re-skins every utility
without forking components) and the xterm `term` palette. `applyTheme` writes
the vars onto `<html data-theme="…">`; the layout never changes per theme.

- **pixel** — phosphor green palette, zero radius, hard offset shadows, VT323
  body, Silkscreen labels, scanline overlay.
- **sheet** — paper palette, ink accents, hairline rules, Archivo + Space Mono.
- **dark / light** — the original zinc + emerald UI, kept for compatibility.
- **custom** — paste a JSON spec in the theme editor; it merges over the dark
  baseline, so a partial spec (a few `--color-*` vars and term colors) is
  enough. Invalid input is rejected with a reason.

`data-panel`, `data-btn`, `data-badge` and `data-input` mark the primitives so
theme effects can restyle them in CSS. The xterm palette comes from the same
spec via `lib/termTheme.ts`.

The build output is committed so the Python package (and PyInstaller bundle)
works without Node.
