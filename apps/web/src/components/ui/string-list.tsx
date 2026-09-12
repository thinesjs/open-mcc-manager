import { Button } from "./button"
import { Input } from "./input"

export type StringListProps = {
	label: string
	values: readonly string[]
	issue: string | null
	onChange: (values: readonly string[]) => void
}

const atPosition = (values: readonly string[]): Array<{ value: string; id: string }> =>
	values.map((value, position) => ({ value, id: `entry-${position}` }))

export const StringList = ({ label, values, issue, onChange }: StringListProps) => (
	<fieldset className="space-y-3">
		<legend className="sr-only">{label}</legend>
		{atPosition(values).map((entry, index) => (
			<div key={entry.id} className="flex items-start gap-2">
				<Input
					aria-label={label}
					value={entry.value}
					onChange={(event) =>
						onChange(
							values.map((held, position) => (position === index ? event.target.value : held)),
						)
					}
				/>
				<Button
					type="button"
					variant="ghost"
					onClick={() => onChange(values.filter((_, position) => position !== index))}
				>
					Remove
				</Button>
			</div>
		))}
		<Button type="button" variant="outline" onClick={() => onChange([...values, ""])}>
			Add
		</Button>
		{issue === null ? null : <p className="text-sm text-destructive">{issue}</p>}
	</fieldset>
)
