import { motion, useReducedMotion } from "motion/react"
import { useId } from "react"
import { cn } from "~/lib/utils"

export type ChoiceOption<Value extends string> = {
	value: Value
	label: string
	description: string
}

export type ChoiceProps<Value extends string> = {
	label: string
	value: Value
	options: readonly ChoiceOption<Value>[]
	onChange: (value: Value) => void
}

export const Choice = <Value extends string>({
	label,
	value,
	options,
	onChange,
}: ChoiceProps<Value>) => {
	const name = useId()
	const reduced = useReducedMotion()

	return (
		<fieldset className="grid gap-2 sm:grid-cols-2">
			<legend className="sr-only">{label}</legend>
			{options.map((option) => {
				const selected = option.value === value
				return (
					<label
						key={option.value}
						className={cn(
							"relative isolate cursor-pointer rounded-[var(--radius)] border p-3 transition-colors",
							"has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring has-[:focus-visible]:ring-offset-2 has-[:focus-visible]:ring-offset-background",
							selected
								? "border-foreground/24"
								: "border-border hover:border-foreground/16 hover:bg-accent/40",
						)}
					>
						<input
							type="radio"
							name={name}
							value={option.value}
							checked={selected}
							onChange={() => onChange(option.value)}
							className="sr-only"
						/>
						{selected ? (
							<motion.span
								aria-hidden
								layoutId={`${name}-selected`}
								transition={
									reduced ? { duration: 0 } : { type: "spring", bounce: 0.18, duration: 0.4 }
								}
								className="absolute inset-0 -z-10 rounded-[var(--radius)] bg-accent"
							/>
						) : null}
						<span className="block text-sm font-medium text-foreground">{option.label}</span>
						<span className="mt-1 block text-xs leading-relaxed text-muted-foreground">
							{option.description}
						</span>
					</label>
				)
			})}
		</fieldset>
	)
}
