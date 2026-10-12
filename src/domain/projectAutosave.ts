export type ProjectAutosaveSnapshot = { json: string; savedAt: number }

const DATABASE_NAME = 'elsim-local-projects'
const DATABASE_VERSION = 1
const STORE_NAME = 'autosaves'
const CURRENT_PROJECT_KEY = 'current-project'
let databasePromise: Promise<IDBDatabase> | null = null
let writeQueue: Promise<void> = Promise.resolve()

function openDatabase(): Promise<IDBDatabase> {
  if (databasePromise) return databasePromise
  const opening = new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB is not available in this browser context.'))
      return
    }
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION)
    let settled = false
    const timeout = window.setTimeout(() => {
      if (settled) return
      settled = true
      reject(new Error('Opening browser recovery storage timed out.'))
    }, 1500)
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) request.result.createObjectStore(STORE_NAME)
    }
    request.onsuccess = () => {
      window.clearTimeout(timeout)
      if (settled) { request.result.close(); return }
      settled = true
      request.result.onversionchange = () => request.result.close()
      resolve(request.result)
    }
    request.onerror = () => {
      window.clearTimeout(timeout)
      if (settled) return
      settled = true
      reject(request.error ?? new Error('Could not open browser recovery storage.'))
    }
    request.onblocked = () => {
      window.clearTimeout(timeout)
      if (settled) return
      settled = true
      reject(new Error('Browser recovery storage is blocked by another open tab.'))
    }
  }).catch((error): never => {
    databasePromise = null
    throw error
  })
  databasePromise = opening
  return opening
}

export async function readProjectAutosave(): Promise<ProjectAutosaveSnapshot | null> {
  const database = await openDatabase()
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, 'readonly')
    const request = transaction.objectStore(STORE_NAME).get(CURRENT_PROJECT_KEY)
    request.onsuccess = () => resolve((request.result as ProjectAutosaveSnapshot | undefined) ?? null)
    request.onerror = () => reject(request.error ?? new Error('Could not read browser recovery storage.'))
    transaction.onabort = () => reject(transaction.error ?? new Error('Reading browser recovery storage was interrupted.'))
  })
}

function enqueueWrite(operation: () => Promise<void>): Promise<void> {
  const next = writeQueue.then(operation)
  writeQueue = next.catch(() => {})
  return next
}

export function writeProjectAutosave(snapshot: ProjectAutosaveSnapshot): Promise<void> {
  return enqueueWrite(async () => {
    const database = await openDatabase()
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, 'readwrite')
      transaction.objectStore(STORE_NAME).put(snapshot, CURRENT_PROJECT_KEY)
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error ?? new Error('Could not write browser recovery storage.'))
      transaction.onabort = () => reject(transaction.error ?? new Error('Writing browser recovery storage was interrupted.'))
    })
  })
}

export function clearProjectAutosave(): Promise<void> {
  return enqueueWrite(async () => {
    const database = await openDatabase()
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, 'readwrite')
      transaction.objectStore(STORE_NAME).delete(CURRENT_PROJECT_KEY)
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error ?? new Error('Could not clear browser recovery storage.'))
      transaction.onabort = () => reject(transaction.error ?? new Error('Clearing browser recovery storage was interrupted.'))
    })
  })
}
