import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import { ErrorBoundary } from '@/components/error-boundary'
import { ThemeProvider } from '@/themes/context'

import { SaraWidgetApp } from './sara-widget-app'

/**
 * Boot the Sarä widget window. Same bundle as the main app, mounted via `?win=widget` — the pattern
 * the pet overlay already established (see pet-overlay/overlay-root.tsx).
 *
 * Minimal provider tree ON PURPOSE: ThemeProvider only. No I18nProvider, no QueryClientProvider, no
 * HashRouter. So everything under this root must be i18n-free — which is why the widget composes
 * plain primitives rather than reaching for `app/overlays/panel.tsx` (that is a fixed-inset modal
 * that calls `translateNow`, and it would blow up here).
 *
 * Unlike the overlay, we do NOT force a transparent background: this is an opaque app window, and
 * the index.html pre-paint script already gives it the right themed colour with no white flash.
 */
export function mountSaraWidget(): void {
  const root = document.getElementById('root')

  if (!root) {
    return
  }

  createRoot(root).render(
    <StrictMode>
      <ErrorBoundary label="sara-widget">
        <ThemeProvider>
          <SaraWidgetApp />
        </ThemeProvider>
      </ErrorBoundary>
    </StrictMode>
  )
}
