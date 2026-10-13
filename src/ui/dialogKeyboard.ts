import type { KeyboardEvent as ReactKeyboardEvent } from 'react'

/** Keep keyboard focus inside an open modal while allowing its visible controls to change. */
export function trapDialogTab(event: ReactKeyboardEvent<HTMLElement>) {
  if (event.key !== 'Tab') return
  const controls = [...event.currentTarget.querySelectorAll<HTMLElement>(
    'a[href], button, input, select, textarea, [contenteditable="true"], [tabindex]:not([tabindex="-1"])',
  )].filter((control) => !control.hidden && !control.matches(':disabled') && getComputedStyle(control).visibility !== 'hidden' && control.getClientRects().length > 0 && !control.closest('[aria-hidden="true"], [inert]'))
  const first = controls[0], last = controls.at(-1)
  if (!first || !last) { event.preventDefault(); return }
  if (event.shiftKey && (document.activeElement === first || !event.currentTarget.contains(document.activeElement))) {
    event.preventDefault(); last.focus()
  } else if (!event.shiftKey && (document.activeElement === last || !event.currentTarget.contains(document.activeElement))) {
    event.preventDefault(); first.focus()
  }
}
