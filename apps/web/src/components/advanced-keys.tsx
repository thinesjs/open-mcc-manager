import {
	ADVANCED_ENUM_SHAPE,
	type AdvancedKeyName,
	type AdvancedKeyRow,
} from "@open-mcc/contracts/boundary/mcc-config-keys"
import {
	ADVANCED_KEY_OPTIONS,
	addAdvancedKeyRow,
	editAdvancedKeyRow,
	removeAdvancedKeyRow,
	selectAdvancedKeyRow,
} from "~/lib/advanced-key-rows"
import { Button } from "./ui/button"
import { Choice } from "./ui/choice"
import { Input } from "./ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select"

const keyNamed = (value: string): AdvancedKeyName | undefined =>
	ADVANCED_KEY_OPTIONS.find((name) => name === value)

const ENUM_MEMBERS: Record<string, readonly string[]> = Object.fromEntries(
	Object.entries(ADVANCED_ENUM_SHAPE).map(([name, schema]) => [name, schema.options]),
)

export type AdvancedKeysProps = {
	rows: readonly AdvancedKeyRow[]
	issues: readonly (string | null)[]
	onChange: (rows: readonly AdvancedKeyRow[]) => void
}

const numbered = (rows: readonly AdvancedKeyRow[]): Array<AdvancedKeyRow & { id: string }> => {
	const seen = new Map<string, number>()
	return rows.map((row) => {
		const name = row.key ?? "unselected"
		const occurrence = (seen.get(name) ?? 0) + 1
		seen.set(name, occurrence)
		return { ...row, id: `${name}#${occurrence}` }
	})
}

export const AdvancedKeys = ({ rows, issues, onChange }: AdvancedKeysProps) => (
	<div className="space-y-3">
		{numbered(rows).map((row, index) => {
			const issue = issues[index] ?? null
			const members = row.key === null ? undefined : ENUM_MEMBERS[row.key]
			return (
				<div key={row.id} className="space-y-2">
					<div className="flex items-start gap-2">
						<Select
							value={row.key ?? ""}
							onValueChange={(value) => {
								const name = value === null ? undefined : keyNamed(value)
								if (name === undefined) return
								onChange(selectAdvancedKeyRow(rows, index, name))
							}}
						>
							<SelectTrigger aria-label="Key">
								<SelectValue placeholder="Choose a key">
									{() => row.key ?? "Choose a key"}
								</SelectValue>
							</SelectTrigger>
							<SelectContent>
								{ADVANCED_KEY_OPTIONS.map((name) => (
									<SelectItem key={name} value={name}>
										{name}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
						<Button
							type="button"
							variant="ghost"
							onClick={() => onChange(removeAdvancedKeyRow(rows, index))}
						>
							Remove
						</Button>
					</div>
					{members === undefined ? (
						<Input
							aria-label="Value"
							value={row.value}
							onChange={(event) => onChange(editAdvancedKeyRow(rows, index, event.target.value))}
						/>
					) : (
						<Choice
							label="Value"
							value={row.value}
							options={members.map((member) => ({ value: member, label: member }))}
							onChange={(value) => onChange(editAdvancedKeyRow(rows, index, value))}
						/>
					)}
					{issue === null ? null : <p className="text-sm text-destructive">{issue}</p>}
				</div>
			)
		})}
		<Button type="button" variant="outline" onClick={() => onChange(addAdvancedKeyRow(rows))}>
			Add a key
		</Button>
	</div>
)
