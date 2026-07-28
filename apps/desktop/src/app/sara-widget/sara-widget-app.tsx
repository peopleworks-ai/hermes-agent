import type { ReactNode } from 'react'

import { cn } from '@/lib/utils'
import {
  SARA_LEARNING_HINT,
  SARA_LEARNING_LABEL,
  SARA_WORKSPACE_HINT,
  SARA_WORKSPACE_LABEL,
  type SaraLearning,
  type SaraWidgetState,
  type SaraWorkspace,
  watchLabel
} from '@/store/sara'

import { useSaraState } from './use-sara-state'

const WORKSPACES: SaraWorkspace[] = ['pause', 'chrome', 'whole']
const LEARNINGS: SaraLearning[] = ['off', 'ask', 'watch']

function WidgetCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-lg border border-border bg-card p-3">
      <h2 className="mb-2 text-[0.625rem] font-semibold uppercase tracking-wider text-muted-foreground">{title}</h2>
      {children}
    </section>
  )
}

/**
 * A radio row rather than a one-line SegmentedControl: the labels are sentences
 * ("Ask Sarä to learn on her own"), and a 380px window has no room to squeeze three of those onto
 * one line. It also keeps the tray's semantics — these are mutually exclusive modes, not tabs.
 */
function RadioRow({
  label,
  hint,
  checked,
  danger,
  onSelect
}: {
  label: string
  hint: string
  checked: boolean
  danger?: boolean
  onSelect: () => void
}) {
  return (
    <button
      aria-checked={checked}
      className={cn(
        'flex w-full items-start gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors',
        checked ? 'bg-accent' : 'hover:bg-accent/50'
      )}
      onClick={onSelect}
      role="radio"
      type="button"
    >
      <span
        className={cn(
          'mt-[3px] size-3 shrink-0 rounded-full border',
          checked
            ? danger
              ? 'border-red-500 bg-red-500'
              : 'border-primary bg-primary'
            : 'border-muted-foreground/40'
        )}
      />
      <span className="min-w-0">
        <span className="block text-xs font-medium text-foreground">{label}</span>
        <span className="block text-[0.6875rem] leading-snug text-muted-foreground">{hint}</span>
      </span>
    </button>
  )
}

/**
 * The status pill. It renders `recording` — the connector's truth — and NOT the `learning` radio.
 * That distinction is the whole point of the state refactor: the widget used to be able to show
 * "Off" while sara-capture was uploading the screen. "Armed" is a real, honest third state (the
 * capture is starting, or failed to), and it must not be dressed up as a live recording.
 */
function StatusPill({ state }: { state: SaraWidgetState }) {
  if (state.recording) {
    return (
      <span className="flex items-center gap-1.5 rounded-full bg-red-500/15 px-2 py-0.5 text-[0.625rem] font-semibold text-red-600 dark:text-red-400">
        <span className="size-1.5 animate-pulse rounded-full bg-red-500" />
        Recording · {watchLabel(state.watch)}
      </span>
    )
  }

  if (state.learning === 'watch') {
    return (
      <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[0.625rem] font-semibold text-amber-600 dark:text-amber-400">
        Watch armed — not recording
      </span>
    )
  }

  return (
    <span className="rounded-full bg-muted px-2 py-0.5 text-[0.625rem] font-medium text-muted-foreground">
      {state.workspace === 'pause' ? 'Paused' : 'Idle'}
    </span>
  )
}

export function SaraWidgetApp() {
  const { state, setWorkspace, setLearning, openWebApp, openSetup, repairEngine, quit } = useSaraState()

  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      {/* titleBarStyle:'hidden' means the OS paints only the ✕ — this strip has to BE the titlebar,
          or the window cannot be moved at all. Same Tailwind arbitrary-property trick the rest of
          the app uses (thread/list.tsx, pane-shell.tsx) rather than an inline style, which TS would
          reject: WebkitAppRegion isn't on CSSProperties. */}
      <header className="flex items-center justify-between gap-2 border-b border-border px-3 pb-2 pt-[calc(var(--titlebar-height,34px)*0.6+0.25rem)] [-webkit-app-region:drag]">
        <span className="flex items-center gap-1.5 text-sm font-semibold">
          <span className="size-2 rounded-full bg-primary" />
          Sarä
        </span>
        <StatusPill state={state} />
      </header>

      <div className="flex-1 space-y-2.5 overflow-y-auto p-3">
        {/* Status first, settings below: the first thing a first-run user sees must be what Sarä is
            DOING, not a form. Connection itself lives on ONE surface — the /people/desktop page,
            which pairs this app automatically — so the unpaired card only points there ("connected
            in two places is not UX"). The radios underneath are optional preferences, and putting
            them after the status card is what stops them reading as required setup steps. */}
        <WidgetCard title="Current Work">
          {state.authBad ? (
            /* Creds exist but the server rejects them — the account's token was re-generated
               elsewhere. Without this card the app LOOKS connected while every call fails
               silently (the exact incident behind "Watch armed — not recording"). */
            <div className="py-2 text-center">
              <p className="text-xs font-semibold text-amber-600 dark:text-amber-400">
                Connection expired
              </p>
              <p className="mt-0.5 text-[0.6875rem] leading-snug text-muted-foreground">
                Sarä can’t reach {state.account ? <b>{state.account}</b> : 'your account'} any more —
                tasks and recording are not running.
              </p>
              <button
                className="mt-2 rounded-md border border-border px-2 py-1 text-[0.6875rem] font-medium hover:bg-accent"
                onClick={openSetup}
                type="button"
              >
                Open the setup page to Re-connect
              </button>
            </div>
          ) : state.repairing ? (
            /* The engine installer is running — narrate it. Bootstrap progress used to render
               only into the never-shown main window, so install failures were invisible. */
            <div className="py-2 text-center">
              <p className="text-xs font-semibold text-foreground">Memasang enjin Sarä…</p>
              <p className="mt-0.5 text-[0.6875rem] leading-snug text-muted-foreground">
                {state.repairProgress || 'Ini mungkin mengambil beberapa minit. Tugasan menunggu sehingga siap.'}
              </p>
            </div>
          ) : state.engineBroken && state.paired ? (
            /* The Hermes CLI is missing — every task would fail. Same honesty contract as the
               expired-token card: a machine that can't run tasks must not look healthy-idle. */
            <div className="py-2 text-center">
              <p className="text-xs font-semibold text-amber-600 dark:text-amber-400">
                Enjin Sarä belum siap dipasang
              </p>
              <p className="mt-0.5 text-[0.6875rem] leading-snug text-muted-foreground">
                Tugasan tidak dapat berjalan pada komputer ini sehingga enjin dipasang.
                {state.repairProgress ? ` (${state.repairProgress})` : ''}
              </p>
              <button
                className="mt-2 rounded-md border border-border px-2 py-1 text-[0.6875rem] font-medium hover:bg-accent"
                onClick={repairEngine}
                type="button"
              >
                Baiki enjin Sarä
              </button>
            </div>
          ) : !state.paired ? (
            <div className="py-2 text-center">
              <p className="text-xs font-medium text-foreground">Finishing setup…</p>
              <p className="mt-0.5 text-[0.6875rem] leading-snug text-muted-foreground">
                Sarä connects automatically on the setup page that just opened in your browser —
                nothing to choose here.
              </p>
              <button
                className="mt-2 rounded-md border border-border px-2 py-1 text-[0.6875rem] font-medium hover:bg-accent"
                onClick={openSetup}
                type="button"
              >
                Open the setup page
              </button>
            </div>
          ) : (
            <>
              {state.currentWork.length === 0 ? (
                <p className="py-2 text-center text-[0.6875rem] text-muted-foreground">
                  Nothing running
                </p>
              ) : (
                <ul className="space-y-1">
                  {state.currentWork.map((w, i) => (
                    <li className="flex items-start gap-2 text-xs" key={`${w.label}-${i}`}>
                      <span className="mt-1 size-1.5 shrink-0 animate-pulse rounded-full bg-primary" />
                      <span className="min-w-0 truncate text-foreground">{w.label}</span>
                    </li>
                  ))}
                </ul>
              )}
              {state.account ? (
                /* Work and recordings land in THIS account — load-bearing on shared computers. */
                <p className="mt-1.5 truncate text-center text-[0.625rem] text-muted-foreground">
                  Connected as <b>{state.account}</b>
                </p>
              ) : null}
            </>
          )}
        </WidgetCard>

        <WidgetCard title="Sarä Workspace">
          <div className="space-y-0.5" role="radiogroup">
            {WORKSPACES.map(mode => (
              <RadioRow
                checked={state.workspace === mode}
                hint={
                  // Honesty: if the boot probe could not confirm --toolsets, Chrome mode does NOT
                  // actually fence Sarä in — say so instead of promising a boundary that isn't real.
                  mode === 'chrome' && !state.gated
                    ? 'Prefers her own browser (restriction not enforced on this machine).'
                    : SARA_WORKSPACE_HINT[mode]
                }
                key={mode}
                label={SARA_WORKSPACE_LABEL[mode]}
                onSelect={() => void setWorkspace(mode)}
              />
            ))}
          </div>
        </WidgetCard>

        <WidgetCard title="Learning Mode">
          <div className="space-y-0.5" role="radiogroup">
            {LEARNINGS.map(mode => (
              <RadioRow
                checked={state.learning === mode}
                danger={mode === 'watch'}
                hint={SARA_LEARNING_HINT[mode]}
                key={mode}
                label={SARA_LEARNING_LABEL[mode]}
                onSelect={() => void setLearning(mode)}
              />
            ))}
          </div>
          {state.learning === 'watch' ? (
            /* On a shared computer the recording follows the PAIRING, not the person at the
               keyboard — say whose account it lands in right where watching is switched on. */
            <p className="mt-1.5 text-[0.625rem] leading-snug text-muted-foreground">
              Everything on this screen is recorded into{' '}
              {state.account ? <b>{state.account}</b> : 'the connected account'}’s Screen Activity.
            </p>
          ) : null}
          {state.recording ? (
            <button
              className="mt-2 w-full rounded-md border border-red-500/40 bg-red-500/10 px-2 py-1 text-[0.6875rem] font-semibold text-red-600 hover:bg-red-500/20 dark:text-red-400"
              onClick={() => void setLearning('off')}
              type="button"
            >
              Stop watching
            </button>
          ) : null}
        </WidgetCard>

      </div>

      <footer className="flex items-center justify-between gap-2 border-t border-border p-2">
        <button
          className="rounded-md px-2 py-1 text-[0.6875rem] font-medium text-muted-foreground hover:bg-accent hover:text-foreground"
          onClick={openWebApp}
          type="button"
        >
          Open Sarä Web App
        </button>
        <button
          className="rounded-md px-2 py-1 text-[0.6875rem] font-medium text-muted-foreground hover:bg-accent hover:text-foreground"
          onClick={quit}
          type="button"
        >
          Quit Sarä
        </button>
      </footer>
    </div>
  )
}
