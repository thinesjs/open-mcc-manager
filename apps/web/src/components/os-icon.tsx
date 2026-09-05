import {
	siAlmalinux,
	siAlpinelinux,
	siArchlinux,
	siCentos,
	siDebian,
	siFedora,
	siLinux,
	siOpensuse,
	siRaspberrypi,
	siRedhat,
	siRockylinux,
	siUbuntu,
} from "simple-icons"
import { cn } from "~/lib/utils"

type Mark = { title: string; path: string }

const MARKS: Record<string, Mark> = {
	almalinux: siAlmalinux,
	alpine: siAlpinelinux,
	arch: siArchlinux,
	centos: siCentos,
	debian: siDebian,
	fedora: siFedora,
	opensuse: siOpensuse,
	"opensuse-leap": siOpensuse,
	"opensuse-tumbleweed": siOpensuse,
	raspbian: siRaspberrypi,
	rhel: siRedhat,
	rocky: siRockylinux,
	ubuntu: siUbuntu,
}

export const markFor = (osId: string | null): Mark =>
	(osId ? MARKS[osId.trim().toLowerCase()] : undefined) ?? siLinux

export type OsIconProps = {
	osId: string | null
	osName: string | null
	className?: string
}

export const OsIcon = ({ osId, osName, className }: OsIconProps) => {
	const mark = markFor(osId)
	const label = osName ?? mark.title
	return (
		<svg
			role="img"
			aria-label={label}
			viewBox="0 0 24 24"
			className={cn("size-4 shrink-0 fill-current", className)}
		>
			<title>{label}</title>
			<path d={mark.path} />
		</svg>
	)
}
