import { HardDrive } from "lucide-react"
import { cn } from "~/lib/utils"

export const labelFor = (osId: string | null, osName: string | null): string | undefined => {
	const named = osName?.trim()
	if (named) return named
	const identified = osId?.trim()
	return identified ? identified : undefined
}

export type OsIconProps = {
	osId: string | null
	osName: string | null
	className?: string
}

export const OsIcon = ({ osId, osName, className }: OsIconProps) => {
	const label = labelFor(osId, osName)
	if (!label) return null
	return <HardDrive role="img" aria-label={label} className={cn("size-4 shrink-0", className)} />
}
