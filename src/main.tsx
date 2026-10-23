import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './ui/App'
import PwaUpdatePrompt from './ui/PwaUpdatePrompt'
import './ui/styles.css'

const pwaRegistration = import.meta.env.PROD && 'serviceWorker' in navigator
  ? navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`, { scope: import.meta.env.BASE_URL })
    .catch((error: unknown) => { console.warn('ELSim offline shell could not be registered.', error); return null })
  : null

createRoot(document.getElementById('root')!).render(
  <React.StrictMode><App /><PwaUpdatePrompt registrationPromise={pwaRegistration}/></React.StrictMode>,
)
