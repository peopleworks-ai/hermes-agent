# Sarä Desktop Widget — fork of Hermes Desktop (`apps/desktop`)

This fork turns Hermes Desktop into the **Sarä menubar widget** (brief §5): a
**subtraction, not construction**. Keep Hermes's native shell / menubar / WSS /
backend runtime + electron-builder (signed installers); strip the Hermes chat/
gateway/skills/model-picker UI; add the Sarä menu + Chrome Sara lifecycle + our
no-key connector. The web chat lives at hcos (`/people/sarah`), NOT here.

> Build + test on **Windows/macOS** (`npm run dev`, then `npm run dist:win:nsis` /
> `dist:mac:dmg`). The GUI can't be exercised on a headless Linux box.

## KEEP (Hermes gives us free)
- `electron/main.cjs` shell + `preload.cjs`, `window-state.cjs`, `session-windows.cjs`.
- Backend/WSS/auth/runtime: `backend-*.cjs`, `gateway-ws-probe.cjs`,
  `connection-config.cjs`, `dashboard-token.cjs`, `oauth-net-request.cjs`.
- Update + hardening + `entitlements.mac.*`; electron-builder config + `dist:*` scripts.
- `src/components/ui` primitives, `i18n/`, icons in `assets/`.

## DELETE (strip the Hermes UI — do with the app running to catch route/import breaks)
- `src/app/{chat,messaging,skills,learning,gateway,starmap,agents,artifacts,command-center,command-palette,cron,pet-*,pet-generate}`
- `src/app/{model-picker-overlay,model-visibility-overlay,session-picker-overlay,session-switcher}.tsx`
- `src/components/{chat,assistant-ui,model-picker.tsx,model-visibility-dialog.tsx,gateway-connecting-overlay*,pet}`
- Prune `src/app/routes.ts` + `index.tsx` as you remove screens.

## ADD (the Sarä widget)
- **`electron/sara-tray.cjs`** — DONE (this fork). The §5 menubar: Workspace
  (Pause / Sara's Google Chrome Browser [default] / Whole Computer) + Learning
  (Off / Ask To Learn / Watch Me) + Current Work (live) + Open Sara Web App, with
  all the §5 popup rules (Whole-Computer confirm+indicator, Watch-Me → auto Whole
  Computer + Omi, revert-while-watching toast). Standard Electron Tray/Menu.
- **Wire it** in `main.cjs` `app.whenReady()`:
  ```js
  const { initSaraTray } = require('./sara-tray.cjs')
  initSaraTray(app, {
    iconPath: path.join(__dirname, '..', 'assets', 'icon.png'),
    webAppUrl: 'https://hcos.peopleworks.ai/people/sarah',
    getCurrentWork: async () => fetchCurrentWorkFromHcos(),   // GET sarah_current_work
    onWorkspaceChange: (mode) => saraController.setWorkspace(mode), // pause/chrome/whole
    onLearningChange:  (mode) => saraController.setLearning(mode),  // off/ask/watch (watch=start Omi)
    onOpenWebApp: () => openSaraWindow(),                     // or shell.openExternal(webAppUrl)
  })
  ```
- **Chrome Sara lifecycle** — launch real Chrome `--user-data-dir sara-chrome-profile` + CDP;
  Running/Pause/FinishPrompt. Port from our Stagehand path (`apps/hros/desktop/electron/adapters`).
- **Sarä branding** + About + "View licences" (keep Hermes + Omi LICENSE files, MIT §2).

## INTEGRATE (our existing code — reuse, don't rebuild)
- **No-key connector** (task bridge + local Anthropic sidecar so Hermes needs no
  key): port `apps/hros/desktop/connector/sara_connector.py` into the Electron
  main (Node), or bundle + spawn it. Hermes stays headless (`hermes -z`, later
  `hermes serve`).
- **Pairing** — `hros.api.sarah_desktop.generate_desktop_setup` + the loopback
  "Connect my desktop app" (hcos page already wired), or reuse `dashboard-token`.
- **Current Work** — `hros.api.sarah_current_work.get_current_work` → the tray feed.

## Rebrand (electron-builder — verify on the build machine)
`package.json`: `name`/`productName`/`description` → Sarä; `build.appId`
(`com.nousresearch.hermes` → e.g. `ai.peopleworks.sara`), `build.productName`.
Check the `afterSign`/`afterPack` hooks in `scripts/` for hard-coded "hermes"
paths + the updater (`update-*.cjs`) — repoint or disable Hermes's update server.

## Build + sign
`npm i` → `npm run dev` (iterate the tray/menu) → `npm run dist:win:nsis` (or
`dist:mac:dmg`). Add the Windows Authenticode / Apple Developer ID cert → the ONE
signed installer the client downloads. Host it on hcos; the page's Connect flow
pairs it over loopback.

## Exit gate (brief §5)
Clean install macOS + Windows · all Workspace states work (with popups) · Chrome
Sara lifecycle correct · Current Work renders (dummy feed OK).
