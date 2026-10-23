import { useEffect, useRef, useState } from 'react'
import { RefreshCw, X } from 'lucide-react'

export default function PwaUpdatePrompt({ registrationPromise }: { registrationPromise: Promise<ServiceWorkerRegistration | null> | null }) {
  const [waitingWorker, setWaitingWorker] = useState<ServiceWorker | null>(null)
  const acceptedUpdate = useRef(false)
  const reloading = useRef(false)

  useEffect(() => {
    if (!('serviceWorker' in navigator)) return
    let active = true
    let registration: ServiceWorkerRegistration | null = null
    let installingWorker: ServiceWorker | null = null

    const showWaitingWorker = () => {
      if (registration?.waiting && navigator.serviceWorker.controller) setWaitingWorker(registration.waiting)
    }
    const watchInstallingWorker = () => {
      const worker = registration?.installing
      if (!worker || worker === installingWorker) return
      installingWorker = worker
      worker.addEventListener('statechange', showWaitingWorker)
    }
    const attach = async () => {
      const resolvedRegistration = await registrationPromise
      if (!active) return
      registration = resolvedRegistration
      if (!registration) return
      registration.addEventListener('updatefound', watchInstallingWorker)
      watchInstallingWorker()
      showWaitingWorker()
    }
    const onControllerChange = () => {
      if (acceptedUpdate.current && !reloading.current) {
        reloading.current = true
        window.location.reload()
      }
    }
    void attach().catch((error: unknown) => console.warn('ELSim update check could not be attached.', error))
    navigator.serviceWorker.addEventListener('controllerchange', onControllerChange)
    return () => {
      active = false
      registration?.removeEventListener('updatefound', watchInstallingWorker)
      installingWorker?.removeEventListener('statechange', showWaitingWorker)
      navigator.serviceWorker.removeEventListener('controllerchange', onControllerChange)
    }
  }, [registrationPromise])

  if (!waitingWorker) return null
  return <aside className="pwa-update-notice" role="status" aria-label="App update ready">
    <span>A new version of ELSim is ready.</span>
    <button type="button" onClick={() => {
      acceptedUpdate.current = true
      waitingWorker.postMessage({ type: 'SKIP_WAITING' })
    }}><RefreshCw size={14}/> Reload to update</button>
    <button type="button" className="pwa-update-dismiss" aria-label="Dismiss update notice" onClick={() => setWaitingWorker(null)}><X size={14}/></button>
  </aside>
}
