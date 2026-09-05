import { CopyButton } from "~/components/copy-button"

export type CommandBlockProps = {
	label: string
	command: string
	caption?: string
}

export const CommandBlock = ({ label, command, caption }: CommandBlockProps) => (
	<div className="space-y-1.5">
		<div className="flex items-center justify-between gap-3">
			<p className="text-sm font-medium text-foreground">{label}</p>
			<CopyButton value={command} label={label} />
		</div>
		{caption ? <p className="text-xs leading-relaxed text-muted-foreground">{caption}</p> : null}
		<pre className="overflow-x-auto rounded-[var(--radius)] border border-border bg-muted/40 p-3">
			<code className="font-mono text-xs leading-relaxed text-foreground">{command}</code>
		</pre>
	</div>
)
