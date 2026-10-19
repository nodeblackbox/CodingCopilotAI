import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './lib/monacoSetup'
import './styles/index.css'
import { installGlobalErrorLogging, logError } from './lib/sessionLog'

installGlobalErrorLogging()

/** Last-resort boundary: log the crash (with component stack) instead of leaving a blank window with no trace. */
class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { failed: boolean }> {
  state = { failed: false }

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    logError('react_crash', error, { componentStack: info.componentStack })
  }

  render(): React.ReactNode {
    if (!this.state.failed) return this.props.children
    return (
      <div style={{ padding: 24, color: '#e6e8ee', fontFamily: 'sans-serif' }}>
        <h2>Something broke in the UI.</h2>
        <p>The error was saved to the session log (Debug menu → Open session logs folder).</p>
        <button onClick={() => window.location.reload()}>Reload</button>
      </div>
    )
  }
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
)
