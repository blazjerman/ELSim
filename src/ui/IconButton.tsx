import type { ReactNode } from 'react'

export function IconButton({ title, children, onClick, active, disabled = false }: { title: string; children: ReactNode; onClick?: () => void; active?: boolean; disabled?: boolean }) {
  return <button className={`icon-button${active ? ' active' : ''}`} title={title} aria-label={title} aria-pressed={active} onClick={onClick} disabled={disabled}>{children}</button>
}
