import { type RefObject, useCallback, useEffect, useRef, useState } from "react"

export const NAV_STATIC_WIDTH = 1024

const FOCUSABLE =
	'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

const focusablesIn = (panel: HTMLElement): readonly HTMLElement[] => [
	...panel.querySelectorAll<HTMLElement>(FOCUSABLE),
]

export type NavDrawer = {
	readonly open: boolean
	readonly panelRef: RefObject<HTMLElement | null>
	readonly openerRef: RefObject<HTMLButtonElement | null>
	readonly show: () => void
	readonly close: () => void
}

export const useNavDrawer = (): NavDrawer => {
	const [open, setOpen] = useState(false)
	const panelRef = useRef<HTMLElement>(null)
	const openerRef = useRef<HTMLButtonElement>(null)
	const restoring = useRef(false)

	const close = useCallback(() => {
		restoring.current = true
		setOpen(false)
	}, [])

	const show = useCallback(() => setOpen(true), [])

	useEffect(() => {
		if (open || !restoring.current) return
		restoring.current = false
		openerRef.current?.focus()
	}, [open])

	useEffect(() => {
		if (!open) return
		panelRef.current?.focus()
		const onKey = (event: KeyboardEvent) => {
			if (event.key === "Escape") {
				event.preventDefault()
				close()
				return
			}
			if (event.key !== "Tab") return
			const panel = panelRef.current
			if (panel === null) return
			const focusables = focusablesIn(panel)
			const first = focusables[0]
			const last = focusables[focusables.length - 1]
			if (first === undefined || last === undefined) return
			const active = document.activeElement
			if (event.shiftKey && (active === first || active === panel)) {
				event.preventDefault()
				last.focus()
				return
			}
			if (!event.shiftKey && active === last) {
				event.preventDefault()
				first.focus()
			}
		}
		document.addEventListener("keydown", onKey)
		return () => document.removeEventListener("keydown", onKey)
	}, [open, close])

	useEffect(() => {
		if (!open) return
		const onResize = () => {
			if (window.innerWidth >= NAV_STATIC_WIDTH) setOpen(false)
		}
		window.addEventListener("resize", onResize)
		return () => window.removeEventListener("resize", onResize)
	}, [open])

	return { open, panelRef, openerRef, show, close }
}
