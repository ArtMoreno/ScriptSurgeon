import { Component, type ErrorInfo, type ReactNode } from 'react'
import { reportClientError } from '../lib/clientErrors'
import { PRODUCT_NAME } from '../lib/branding'

interface Props {
  children: ReactNode
}

interface State {
  failed: boolean
}

export default class AppErrorBoundary extends Component<Props, State> {
  state: State = { failed: false }

  static getDerivedStateFromError(): State {
    return { failed: true }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    reportClientError(error, {
      source: 'react',
      componentStack: info.componentStack,
    })
  }

  private retry = () => {
    this.setState({ failed: false })
  }

  private reload = () => {
    // Reloading the current URL intentionally preserves the desktop auth token.
    window.location.reload()
  }

  render() {
    if (!this.state.failed) return this.props.children

    return (
      <main className="min-h-screen bg-canvas text-ink grid place-items-center px-6 py-10">
        <section
          className="w-full max-w-lg rounded-2xl border border-danger/25 bg-canvas-raised px-7 py-8 shadow-2xl shadow-ink/15"
          role="alert"
          aria-labelledby="scriptsurgeon-error-title"
        >
          <div className="h-11 w-11 rounded-xl bg-danger-soft text-danger grid place-items-center" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-6 w-6">
              <path d="M12 3 2.8 19h18.4L12 3Z" />
              <path d="M12 9v4" />
              <path d="M12 17h.01" />
            </svg>
          </div>
          <h1 id="scriptsurgeon-error-title" className="mt-5 text-xl font-semibold tracking-tight text-ink">
            {PRODUCT_NAME} hit a display problem
          </h1>
          <p className="mt-2 text-sm leading-6 text-ink-muted">
            Your project files are still stored locally. Reload the interface to recover; the problem has been written to the local diagnostic log.
          </p>
          <div className="mt-6 flex flex-wrap gap-3">
            <button
              type="button"
              onClick={this.reload}
              className="h-10 rounded-lg bg-ember px-4 text-sm font-semibold text-on-accent hover:bg-ember-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ember"
            >
              Reload {PRODUCT_NAME}
            </button>
            <button
              type="button"
              onClick={this.retry}
              className="h-10 rounded-lg border border-line-strong bg-canvas-raised px-4 text-sm font-medium text-ink hover:bg-canvas-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ember"
            >
              Try interface again
            </button>
          </div>
        </section>
      </main>
    )
  }
}
