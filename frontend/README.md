# tio-server admin UI

React 19 + Vite + Tailwind v4 SPA for `tio-server`: sessions, the xterm.js
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
├── index.css                the four themes + shell/primitive styling
├── styles/fonts.css         self-hosted @font-face (Vite hashes them into assets/)
├── assets/fonts/            woff2 files (pixel + sheet themes)
├── components/
│   ├── Shell.tsx            three shells: classic sidebar, pixel cabinet, sheet frame
│   ├── ThemeSwitch.tsx      pixel / sheet / dark / light
│   ├── StatusPanel.tsx      live session rail
│   └── ui/                  button, card, badge, input, dialog+switch
├── pages/                   Sessions (overview + SSH hosts), Terminal workspace, MCP, Logs
└── lib/                     api, types, theme, terminal palettes, utils
```

## Themes

`<html data-theme="pixel|sheet|dark|light">` drives everything. Tailwind v4 emits
palette, radius, shadow and type scale as CSS variables, so each theme re-skins
the utility classes instead of forking components:

- **pixel** — phosphor green palette, zero radius, hard offset shadows, VT323
  body, Silkscreen labels, Press Start 2P wordmark, scanline overlay.
- **sheet** — paper palette, ink accents, hairline rules, Archivo + Space Mono,
  framed page with a drawing title block.
- **dark / light** — the original zinc + emerald UI, kept for compatibility.

`data-panel`, `data-btn`, `data-badge` and `data-input` mark the primitives so a
theme can restyle them in CSS. The xterm palette comes from `lib/termTheme.ts`.

Lint: Tailwind classes stay in the page components; theme-specific chrome lives
in `index.css` under the `.px-*` (pixel shell) and `.sh-*` (sheet shell) blocks.

The build output is committed so the Python package (and PyInstaller bundle)
works without Node.
