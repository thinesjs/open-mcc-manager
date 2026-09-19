import { LayoutGrid, Rows3 } from "lucide-react"
import { useEffect, useState } from "react"
import { Button } from "~/components/ui/button"
import { DEFAULT_VIEW_MODE, readViewMode, type ViewMode, writeViewMode } from "~/lib/view-mode"

export const useViewMode = (key: string): [ViewMode, (mode: ViewMode) => void] => {
	const [mode, setMode] = useState<ViewMode>(DEFAULT_VIEW_MODE)

	useEffect(() => {
		setMode(readViewMode(key))
	}, [key])

	return [
		mode,
		(next: ViewMode) => {
			setMode(next)
			writeViewMode(key, next)
		},
	]
}

export type ViewToggleProps = {
	mode: ViewMode
	onChange: (mode: ViewMode) => void
	label: string
}

export const ViewToggle = ({ mode, onChange, label }: ViewToggleProps) => (
	<fieldset className="flex gap-1">
		<legend className="sr-only">{label}</legend>
		<Button
			type="button"
			size="icon-sm"
			variant={mode === "cards" ? "secondary" : "ghost"}
			aria-pressed={mode === "cards"}
			aria-label="Card view"
			onClick={() => onChange("cards")}
		>
			<LayoutGrid />
		</Button>
		<Button
			type="button"
			size="icon-sm"
			variant={mode === "list" ? "secondary" : "ghost"}
			aria-pressed={mode === "list"}
			aria-label="List view"
			onClick={() => onChange("list")}
		>
			<Rows3 />
		</Button>
	</fieldset>
)
