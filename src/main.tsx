import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './ui/App'
import './ui/styles.css'

const PwaUpdatePrompt = React.lazy(() => import('./ui/PwaUpdatePrompt'))

const pwaRegistration = import.meta.env.PROD && 'serviceWorker' in navigator
  ? navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`, { scope: import.meta.env.BASE_URL })
    .catch((error: unknown) => { console.warn('ELSim offline shell could not be registered.', error); return null })
  : null

createRoot(document.getElementById('root')!).render(
  <React.StrictMode><App /><React.Suspense fallback={null}><PwaUpdatePrompt registrationPromise={pwaRegistration}/></React.Suspense></React.StrictMode>,
)
