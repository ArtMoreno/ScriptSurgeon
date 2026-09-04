import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'

export interface TranscriptMenuAction {
  id: string
  label: string
  onSelect: () => void
  destructive?: boolean
  dividerBefore?: boolean
  returnFocus?: boolean
}

interface Props {
  x: number
  y: number
  label: string
  actions: TranscriptMenuAction[]
  onClose: (restoreFocus: boolean) => void
}

export default function TranscriptContextMenu({ x, y, label, actions, onClose }: Props) {
  const menuRef = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState({ left: x, top: y })

  useLayoutEffect(() => {
    const menu = menuRef.current
    if (!menu) return
    const bounds = menu.getBoundingClientRect()
    const left = Math.max(8, Math.min(x, window.innerWidth - bounds.width - 8))
    const top = Math.max(8, Math.min(y, window.innerHeight - bounds.height - 8))
    setPosition({ left, top })
    const frame = window.requestAnimationFrame(() => {
      menu.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus({ preventScroll: true })
    })
    return () => window.cancelAnimationFrame(frame)
  }, [x, y, label])

  useEffect(() => {
    const closeOnPointerDown = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) onClose(false)
    }
    const closeWithoutMovingFocus = () => onClose(false)
    document.addEventListener('pointerdown', closeOnPointerDown, true)
    window.addEventListener('resize', closeWithoutMovingFocus)
    window.addEventListener('scroll', closeWithoutMovingFocus, true)
    return () => {
      document.removeEventListener('pointerdown', closeOnPointerDown, true)
      window.removeEventListener('resize', closeWithoutMovingFocus)
      window.removeEventListener('scroll', closeWithoutMovingFocus, true)
    }
  }, [onClose])

  const moveFocus = (event: KeyboardEvent<HTMLDivElement>, destination: 'next' | 'previous' | 'first' | 'last') => {
    const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)'))
    if (!items.length) return
    const current = items.indexOf(document.activeElement as HTMLButtonElement)
    const index = destination === 'first'
      ? 0
      : destination === 'last'
        ? items.length - 1
        : destination === 'next'
          ? (current + 1 + items.length) % items.length
          : (current - 1 + items.length) % items.length
    items[index].focus({ preventScroll: true })
  }

  return (
    <div
      ref={menuRef}
      role="menu"
      aria-label={label}
      className="fixed z-[80] min-w-[220px] max-w-[calc(100vw-16px)] rounded-xl border border-line-strong bg-canvas-raised p-1.5 text-[12px] text-ink shadow-2xl shadow-ink/20 backdrop-blur-xl"
      style={position}
      onContextMenu={(event) => event.preventDefault()}
      onKeyDown={(event) => {
        if (event.key === 'ArrowDown') {
          event.preventDefault()
          moveFocus(event, 'next')
        } else if (event.key === 'ArrowUp') {
          event.preventDefault()
          moveFocus(event, 'previous')
        } else if (event.key === 'Home') {
          event.preventDefault()
          moveFocus(event, 'first')
        } else if (event.key === 'End') {
          event.preventDefault()
          moveFocus(event, 'last')
        } else if (event.key === 'Escape') {
          event.preventDefault()
          event.stopPropagation()
          onClose(true)
        }
      }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) onClose(false)
      }}
    >
      {actions.map((action) => (
        <div key={action.id}>
          {action.dividerBefore && <div role="separator" className="my-1 border-t border-line" />}
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              action.onSelect()
              onClose(action.returnFocus !== false)
            }}
            className={`flex h-9 w-full items-center rounded-lg px-3 text-left font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset ${
              action.destructive
                ? 'text-danger-dark hover:bg-danger-soft focus-visible:ring-danger'
                : 'text-ink hover:bg-canvas-soft focus-visible:ring-ember'
            }`}
          >
            {action.label}
          </button>
        </div>
      ))}
    </div>
  )
}
