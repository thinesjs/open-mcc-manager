import type { MinecraftVersion } from "@open-mcc/contracts"
import { MINECRAFT_VERSION_AUTO, MINECRAFT_VERSION_OPTIONS } from "@open-mcc/contracts"
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "~/components/ui/select"

export const AUTO_DETECT_LABEL = "Auto-detect"

export const MINECRAFT_VERSION_CHOICES: readonly MinecraftVersion[] = [
	MINECRAFT_VERSION_AUTO,
	...MINECRAFT_VERSION_OPTIONS,
]

export const minecraftVersionLabel = (version: MinecraftVersion): string =>
	version === MINECRAFT_VERSION_AUTO ? AUTO_DETECT_LABEL : version

export type MinecraftVersionSelectProps = {
	id: string
	value: MinecraftVersion
	onChange: (value: MinecraftVersion) => void
}

export const MinecraftVersionSelect = ({ id, value, onChange }: MinecraftVersionSelectProps) => (
	<Select
		value={value}
		onValueChange={(chosen) => {
			const picked = MINECRAFT_VERSION_CHOICES.find((candidate) => candidate === chosen)
			if (picked) onChange(picked)
		}}
	>
		<SelectTrigger id={id}>
			<SelectValue>{() => minecraftVersionLabel(value)}</SelectValue>
		</SelectTrigger>
		<SelectContent>
			{MINECRAFT_VERSION_CHOICES.map((option) => (
				<SelectItem key={option} value={option}>
					{minecraftVersionLabel(option)}
				</SelectItem>
			))}
		</SelectContent>
	</Select>
)
