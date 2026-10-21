# tio-server admin UI

React 19 + Vite + Tailwind v4 SPA for `tio-server`. The operator console is built
from [assistant-ui](https://github.com/assistant-ui/assistant-ui) primitives:
`AssistantRuntimeProvider` + `useLocalRuntime` with a custom `ChatModelAdapter`
that maps an operator message to `POST /api/sessions/{id}/command`, plus
`ThreadPrimitive`, `MessagePrimitive`, `ComposerPrimitive` and
`ActionBarPrimitive` for the chat surface. Raw device text is rendered as
monospace text parts (never markdown), and unsolicited RX streams into the
separate live pane over `/ws/console/{id}`.

```bash
npm ci
npm run dev     # http://localhost:5173, proxies /api and /ws to 127.0.0.1:8765
npm run build   # emits into ../src/tio_server/web/static (served by the Python app)
npm run lint
```

Layout:

```text
src/
├── App.tsx                  auth bootstrap, polling, hash router, toasts
├── components/
│   ├── Shell.tsx            sidebar, session list, mobile nav
│   ├── assistant-ui/thread.tsx   chat console (assistant-ui primitives)
│   └── ui/                  button, card, badge, input, dialog+switch
├── pages/                   Login, Overview, Console, Config, Logs, System
└── lib/                     API client, types, utils
```

The build output is committed so the Python package (and PyInstaller bundle)
works without Node.
