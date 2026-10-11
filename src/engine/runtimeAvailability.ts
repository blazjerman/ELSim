type AssetResponse = Pick<Response, 'ok' | 'headers'>

function hasContentType(response: AssetResponse, accepted: readonly string[]): boolean {
  if (!response.ok) return false
  const contentType = response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase()
  return Boolean(contentType && accepted.includes(contentType))
}

/** Vite's SPA fallback can return index.html with status 200 for missing assets. */
export function hasNgspiceRuntimeAssets(moduleResponse: AssetResponse, wasmResponse: AssetResponse): boolean {
  return hasContentType(moduleResponse, ['text/javascript', 'application/javascript']) &&
    hasContentType(wasmResponse, ['application/wasm', 'application/octet-stream'])
}
