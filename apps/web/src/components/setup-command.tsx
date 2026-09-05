import { Check, ChevronRight } from "lucide-react"
import { CopyButton } from "~/components/copy-button"

export type SetupCommandProps = {
	command: string
	summary: readonly string[]
}

export const SetupCommand = ({ command, summary }: SetupCommandProps) => (
	<div className="space-y-3 rounded-[var(--radius)] border border-border p-3">
		<div className="flex items-start justify-between gap-3">
			<div className="min-w-0">
				<p className="text-sm font-medium text-foreground">Setup command</p>
				<p className="mt-0.5 text-xs text-muted-foreground">
					Run once on the host. Omit the leading sudo when already root.
				</p>
			</div>
			<CopyButton value={command} label="Setup command" />
		</div>

		<ul className="space-y-1.5">
			{summary.map((item) => (
				<li key={item} className="flex items-start gap-2 text-xs text-muted-foreground">
					<Check className="mt-px size-3.5 shrink-0 text-success" aria-hidden />
					<span>{item}</span>
				</li>
			))}
		</ul>

		<details className="group">
			<summary className="flex cursor-pointer list-none items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background">
				<ChevronRight
					className="size-3.5 transition-transform duration-200 group-open:rotate-90 motion-reduce:transition-none"
					aria-hidden
				/>
				Review the script
			</summary>
			<pre className="mt-2 max-h-64 overflow-auto rounded-[var(--radius)] border border-border bg-muted/40 p-3">
				<code className="font-mono text-xs leading-relaxed text-foreground">{command}</code>
			</pre>
		</details>
	</div>
)
