import {
	claudeDesktopDeeplink,
	cursorDeeplink,
	receiverPrompt,
	SIGNATURE_VERSION,
	SUBSCRIPTION_KINDS,
	SUBSCRIPTION_LABELS,
	withinDeeplinkLimit,
} from "@open-mcc/contracts"
import { CopyButton } from "~/components/copy-button"

const EXAMPLE = `{
  "type": "instance.disconnected",
  "timestamp": "2026-09-07T12:00:00.000Z",
  "data": {
    "id": "ntf_9xK2",
    "title": "LiveBot left the server",
    "body": "It has not managed to get back on.",
    "subject": { "type": "instance", "id": "inst_4b1" }
  }
}`

const PROMPT = receiverPrompt()

const CURSOR_URL = cursorDeeplink(PROMPT)

const CLAUDE_URL = claudeDesktopDeeplink(PROMPT)

export const WebhookContract = () => (
	<div className="space-y-5 text-sm">
		<section className="space-y-2 rounded-[var(--radius)] border border-border bg-muted/40 p-3">
			<h3 className="font-medium text-foreground">Get an AI to build your receiver</h3>
			<p className="text-muted-foreground">
				Hand this to an AI tool and it will build a receiver that verifies these requests correctly,
				reading the signing key from an environment variable rather than the code.
			</p>
			<div className="flex flex-wrap items-center gap-2">
				<CopyButton value={PROMPT} label="Copy the prompt" />
				{withinDeeplinkLimit(CURSOR_URL) ? (
					<a
						href={CURSOR_URL}
						className="rounded-[var(--radius)] border border-border px-2.5 py-1.5 text-xs text-foreground transition-colors hover:bg-accent"
					>
						Open in Cursor
					</a>
				) : null}
				<a
					href={CLAUDE_URL}
					className="rounded-[var(--radius)] border border-border px-2.5 py-1.5 text-xs text-foreground transition-colors hover:bg-accent"
				>
					Open in Claude
				</a>
			</div>
			<p className="text-xs text-muted-foreground">
				Both links only fill in the prompt. Nothing runs until you say so.
			</p>
		</section>

		<section className="space-y-2">
			<h3 className="font-medium text-foreground">What arrives</h3>
			<p className="text-muted-foreground">
				A <code className="font-mono text-xs">POST</code> with a JSON body. The{" "}
				<code className="font-mono text-xs">type</code> field is the event, and matches the alerts
				you chose.
			</p>
			<pre className="overflow-x-auto rounded-[var(--radius)] border border-border bg-muted p-3 font-mono text-xs">
				{EXAMPLE}
			</pre>
		</section>

		<section className="space-y-2">
			<h3 className="font-medium text-foreground">Proving it came from OpenMCC</h3>
			<p className="text-muted-foreground">Three headers accompany every request:</p>
			<dl className="space-y-1.5">
				<div className="flex gap-2">
					<dt className="w-44 shrink-0 font-mono text-xs text-foreground">webhook-id</dt>
					<dd className="text-muted-foreground">
						Unique per alert. Reject a repeat of one you have already handled.
					</dd>
				</div>
				<div className="flex gap-2">
					<dt className="w-44 shrink-0 font-mono text-xs text-foreground">webhook-timestamp</dt>
					<dd className="text-muted-foreground">
						Unix seconds. Reject anything far from your own clock.
					</dd>
				</div>
				<div className="flex gap-2">
					<dt className="w-44 shrink-0 font-mono text-xs text-foreground">webhook-signature</dt>
					<dd className="text-muted-foreground">
						<code className="font-mono text-xs">{SIGNATURE_VERSION},&lt;signature&gt;</code>, space
						separated if more than one.
					</dd>
				</div>
			</dl>
			<p className="text-muted-foreground">
				The signature is an HMAC-SHA256 over the id, the timestamp and the body joined with a{" "}
				<code className="font-mono text-xs">.</code> between each, base64 encoded. The key is your
				signing key with its prefix removed and the rest base64 decoded — the raw bytes, not the
				string you were shown. Compare in constant time.
			</p>
			<p className="text-muted-foreground">
				During a rotation two signatures are sent. Accept the request if either matches.
			</p>
		</section>

		<section className="space-y-2">
			<h3 className="font-medium text-foreground">What OpenMCC expects back</h3>
			<p className="text-muted-foreground">
				Any 2xx means delivered. A 429 or 5xx is retried, and OpenMCC waits at least as long as a{" "}
				<code className="font-mono text-xs">Retry-After</code> header asks. A 410 stops delivery and
				disables the destination. Redirects are never followed.
			</p>
		</section>

		<section className="space-y-2">
			<h3 className="font-medium text-foreground">Event types</h3>
			<dl className="space-y-1">
				{SUBSCRIPTION_KINDS.map((kind) => (
					<div key={kind} className="flex gap-2">
						<dt className="w-64 shrink-0 font-mono text-xs text-foreground">{kind}</dt>
						<dd className="text-muted-foreground">{SUBSCRIPTION_LABELS[kind]}</dd>
					</div>
				))}
			</dl>
			<p className="text-muted-foreground">
				A recovery arrives for anything you subscribed to — for example{" "}
				<code className="font-mono text-xs">instance.reconnected</code> after{" "}
				<code className="font-mono text-xs">instance.disconnected</code> — and only if the problem
				was reported first.
			</p>
		</section>
	</div>
)
