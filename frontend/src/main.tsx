import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { registerSW } from 'virtual:pwa-register'
import './index.css'
import App from './App.tsx'

// The installed app runs from its own cache and only learns of a new deploy
// when it asks. Asking only on page load left open windows on the old version
// for hours, so it also asks whenever the window comes back into view: a new
// version then loads the moment the user returns, not in the middle of work.
registerSW({
  immediate: true,
  onRegisteredSW(_swUrl, registration) {
    if (!registration) return
    const checkForUpdate = () => {
      if (document.visibilityState === 'visible' && navigator.onLine) {
        registration.update().catch(() => {
          // Offline or the server is unreachable: try again next time.
        })
      }
    }
    document.addEventListener('visibilitychange', checkForUpdate)
    window.addEventListener('focus', checkForUpdate)
  },
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
