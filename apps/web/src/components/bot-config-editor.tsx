import type { InstanceConfigInput } from "@open-mcc/contracts"
import {
	BOT_CONFIG_BOOLEAN_NAMES,
	type BotConfigName,
} from "@open-mcc/contracts/boundary/mcc-config-keys"
import {
	type BotConfigDraft,
	type BotConfigIssues,
	clearValue,
	effectiveValue,
	isStored,
	storeValue,
	unmetDependency,
} from "~/lib/bot-config"
import {
	BOT_CONFIG_ENUM_OPTIONS,
	BOT_CONFIG_FIELDS,
	BOT_CONFIG_LIST_NAMES,
	BOT_CONFIG_SECTION_LABEL,
	BOT_CONFIG_SECTION_PURPOSE,
	BOT_CONFIG_SECTIONS,
	type BotConfigEnumOption,
} from "~/lib/bot-config-fields"
import { Button } from "./ui/button"
import { Choice } from "./ui/choice"
import { Input } from "./ui/input"
import { StringList } from "./ui/string-list"

export type BotConfigEditorProps = {
	draft: BotConfigDraft
	issues: BotConfigIssues
	instance: InstanceConfigInput
	onChange: (draft: BotConfigDraft) => void
}

const ON_OFF = [
	{ value: "true", label: "On" },
	{ value: "false", label: "Off" },
] as const

const ENUM_OPTIONS: Partial<Record<BotConfigName, readonly BotConfigEnumOption[]>> =
	BOT_CONFIG_ENUM_OPTIONS

const asText = (value: string | readonly string[]): string =>
	typeof value === "string" ? value : ""

const asList = (value: string | readonly string[]): readonly string[] =>
	typeof value === "string" ? [] : value

const BotField = ({
	name,
	draft,
	issues,
	instance,
	onChange,
}: { name: BotConfigName } & Omit<BotConfigEditorProps, "draft"> & { draft: BotConfigDraft }) => {
	const field = BOT_CONFIG_FIELDS[name]
	const value = effectiveValue(draft, name)
	const issue = issues[name]
	const blocked = unmetDependency(draft, instance, name)
	const members = ENUM_OPTIONS[name]
	const set = (next: string | readonly string[]) => onChange(storeValue(draft, name, next))

	return (
		<div className="space-y-1.5">
			<div className="flex items-baseline justify-between gap-3">
				<span className="text-sm text-foreground">{field.label}</span>
				{isStored(draft, name) ? (
					<Button
						type="button"
						variant="ghost"
						size="sm"
						onClick={() => onChange(clearValue(draft, name))}
					>
						Use client default
					</Button>
				) : null}
			</div>
			{BOT_CONFIG_LIST_NAMES.includes(name) ? (
				<StringList
					label={field.label}
					values={asList(value)}
					issue={issue ?? null}
					onChange={set}
				/>
			) : members === undefined ? (
				BOT_CONFIG_BOOLEAN_NAMES.includes(name) ? (
					<Choice label={field.label} value={asText(value)} options={ON_OFF} onChange={set} />
				) : (
					<Input
						aria-label={field.label}
						value={asText(value)}
						onChange={(event) => set(event.target.value)}
					/>
				)
			) : (
				<Choice label={field.label} value={asText(value)} options={members} onChange={set} />
			)}
			{field.description === undefined ? null : (
				<p className="text-xs text-muted-foreground">{field.description}</p>
			)}
			{blocked === undefined ? null : (
				<p className="text-xs text-muted-foreground">
					Does nothing until {blocked.requires} is on.
				</p>
			)}
			{issue === undefined || BOT_CONFIG_LIST_NAMES.includes(name) ? null : (
				<p className="text-sm text-destructive">{issue}</p>
			)}
		</div>
	)
}

export const BotConfigEditor = ({ draft, issues, instance, onChange }: BotConfigEditorProps) => (
	<div className="gap-4 lg:columns-2">
		{BOT_CONFIG_SECTIONS.map((section) => {
			const toggle = section.keys[0]
			if (toggle === undefined) return null
			const on = effectiveValue(draft, toggle) === "true"
			const rest = section.keys.slice(1)
			const needs = unmetDependency(draft, instance, toggle)
			const hidden = on ? [] : rest.filter((name) => issues[name] !== undefined)
			return (
				<section
					key={section.name}
					className="mb-4 break-inside-avoid space-y-3 rounded-[var(--radius)] border border-border bg-card p-4"
				>
					<div className="flex items-start justify-between gap-4">
						<div className="space-y-0.5">
							<h3 className="text-sm font-semibold text-foreground">
								{BOT_CONFIG_SECTION_LABEL[section.name]}
							</h3>
							<p className="text-xs text-muted-foreground">
								{BOT_CONFIG_SECTION_PURPOSE[section.name]}
							</p>
							{needs === undefined ? null : (
								<p className="text-xs text-muted-foreground">
									Does nothing until {needs.requires} is on.
								</p>
							)}
							{hidden.length === 0 ? null : (
								<p className="text-xs text-destructive">
									Turn this back on to fix {hidden.length} setting
									{hidden.length === 1 ? "" : "s"} before saving.
								</p>
							)}
						</div>
						<div className="shrink-0">
							<Choice
								label={`${BOT_CONFIG_SECTION_LABEL[section.name]} on or off`}
								value={on ? "true" : "false"}
								options={ON_OFF}
								onChange={(next) => onChange(storeValue(draft, toggle, next))}
							/>
						</div>
					</div>
					{on ? (
						<div className="space-y-3 border-t border-border pt-3">
							{rest.map((name) => (
								<BotField
									key={name}
									name={name}
									draft={draft}
									issues={issues}
									instance={instance}
									onChange={onChange}
								/>
							))}
						</div>
					) : null}
				</section>
			)
		})}
	</div>
)
