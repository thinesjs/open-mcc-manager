import {
	EXPRESS_HOST_KEY_CONFIRMATION,
	EXPRESS_KEY_MISMATCH_MESSAGE,
	EXPRESS_KEY_UNREADABLE_MESSAGE,
	EXPRESS_LOCKED_TITLE,
	EXPRESS_MANUAL_FALLBACK,
	EXPRESS_REFUSED_MESSAGE,
	type ExpressInstallResult,
	expressLockedPrompt,
	LOCKED_HAS_NO_PASSWORD,
	LOCKED_KEEPS_PASSWORD,
	type RootCredentialKind,
} from "@open-mcc/contracts"
import { useMutation } from "@tanstack/react-query"
import { CircleAlert, CircleCheck, KeyRound, TriangleAlert } from "lucide-react"
import { useState } from "react"
import { Alert } from "~/components/ui/alert"
import { Button } from "~/components/ui/button"
import { Choice } from "~/components/ui/choice"
import { Input } from "~/components/ui/input"
import { Label } from "~/components/ui/label"
import { Spinner } from "~/components/ui/spinner"
import { getErrorMessage } from "~/lib/errors"
import { useTRPC } from "~/lib/trpc"

const CREDENTIAL_OPTIONS = [
	{ value: "password", label: "Password" },
	{ value: "key", label: "SSH key" },
] as const

const failureMessage = (outcome: ExpressInstallResult): string | null => {
	switch (outcome.outcome) {
		case "ready":
		case "locked":
		case "credential-unreadable":
			return null
		case "refused":
			return EXPRESS_REFUSED_MESSAGE
		case "key-mismatch":
			return EXPRESS_KEY_MISMATCH_MESSAGE
		case "unreachable":
		case "script-failed":
			return outcome.reason
	}
}

export type ExpressInstallPanelProps = {
	hostname: string
	port: number
	username: string
	sshKeyId: string
	createAccount: boolean
	onReady: (fingerprint: string) => void
	onManual: () => void
}

export const ExpressInstallPanel = ({
	hostname,
	port,
	username,
	sshKeyId,
	createAccount,
	onReady,
	onManual,
}: ExpressInstallPanelProps) => {
	const trpc = useTRPC()
	const readKeyMutation = useMutation(trpc.host.readHostKey.mutationOptions())
	const installMutation = useMutation(trpc.host.expressInstall.mutationOptions())

	const [credentialKind, setCredentialKind] = useState<RootCredentialKind>("password")
	const [password, setPassword] = useState("")
	const [privateKey, setPrivateKey] = useState("")
	const [confirmed, setConfirmed] = useState("")
	const [outcome, setOutcome] = useState<ExpressInstallResult | null>(null)

	const failure = outcome === null ? null : failureMessage(outcome)
	const secretReady = credentialKind === "password" ? password.length > 0 : privateKey.length > 0
	const readKey = readKeyMutation.data
	const installing = installMutation.isPending

	const forget = () => {
		setPassword("")
		setPrivateKey("")
		installMutation.reset()
	}

	const install = (unlock: boolean) => {
		setOutcome(null)
		installMutation.mutate(
			{
				hostname,
				port,
				username,
				sshKeyId,
				createAccount,
				expectedFingerprint: confirmed,
				unlock,
				credential:
					credentialKind === "password"
						? { kind: "password", password }
						: { kind: "key", privateKey },
			},
			{
				onSuccess: (result) => {
					setOutcome(result)
					if (result.outcome === "ready") {
						forget()
						onReady(result.fingerprint)
					}
				},
			},
		)
	}

	const leaveForManual = () => {
		forget()
		setOutcome(null)
		onManual()
	}

	return (
		<div className="space-y-4">
			<div className="space-y-3 rounded-[var(--radius)] border border-border p-3">
				<Choice
					label="How OpenMCC signs in as root"
					value={credentialKind}
					options={CREDENTIAL_OPTIONS}
					onChange={(value) => {
						setCredentialKind(value)
						setOutcome(null)
					}}
				/>

				{credentialKind === "password" ? (
					<div className="space-y-1.5">
						<Label htmlFor="express-password">Root password</Label>
						<Input
							id="express-password"
							type="password"
							autoComplete="off"
							value={password}
							onChange={(event) => setPassword(event.target.value)}
						/>
					</div>
				) : (
					<div className="space-y-1.5">
						<Label htmlFor="express-key">Root private key</Label>
						<textarea
							id="express-key"
							autoComplete="off"
							spellCheck={false}
							value={privateKey}
							onChange={(event) => setPrivateKey(event.target.value)}
							className="min-h-24 w-full rounded-lg border border-input bg-background px-3 py-2 font-mono text-xs text-foreground outline-none ring-ring/24 transition-shadow placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] dark:bg-input/32"
							placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
						/>
					</div>
				)}

				<p className="text-xs text-muted-foreground">
					Used once for this setup. It is never stored.
				</p>
			</div>

			<div className="space-y-3 rounded-[var(--radius)] border border-border p-3">
				<div className="flex items-start justify-between gap-3">
					<div>
						<p className="text-sm font-medium text-foreground">Confirm the host key</p>
						<p className="mt-0.5 text-xs text-muted-foreground">
							Read before anything is sent to {hostname || "the server"}.
						</p>
					</div>
					<Button
						type="button"
						size="sm"
						variant="secondary"
						disabled={hostname.length === 0 || readKeyMutation.isPending}
						onClick={() => {
							setConfirmed("")
							setOutcome(null)
							readKeyMutation.mutate({ hostname, port })
						}}
					>
						{readKeyMutation.isPending ? <Spinner label="Reading" /> : "Read host key"}
					</Button>
				</div>

				{readKeyMutation.isError ? (
					<Alert variant="error" icon={<CircleAlert />}>
						{getErrorMessage(readKeyMutation.error)}
					</Alert>
				) : null}

				{readKey ? (
					<div className="space-y-2">
						<p className="break-all font-mono text-xs text-foreground">{readKey.fingerprint}</p>
						<p className="text-xs text-muted-foreground">{EXPRESS_HOST_KEY_CONFIRMATION}</p>
						{confirmed === readKey.fingerprint ? (
							<Alert variant="success" icon={<CircleCheck />}>
								Host key confirmed.
							</Alert>
						) : (
							<Button
								type="button"
								size="sm"
								variant="secondary"
								onClick={() => setConfirmed(readKey.fingerprint)}
							>
								This matches my provider's console
							</Button>
						)}
					</div>
				) : null}
			</div>

			{installMutation.isError ? (
				<Alert variant="error" icon={<CircleAlert />}>
					{getErrorMessage(installMutation.error)}
				</Alert>
			) : null}

			{outcome?.outcome === "locked" ? (
				<Alert variant="warning" icon={<TriangleAlert />}>
					<p className="font-medium">{EXPRESS_LOCKED_TITLE}</p>
					<p>
						{outcome.keepsPassword ? LOCKED_KEEPS_PASSWORD : LOCKED_HAS_NO_PASSWORD} Nobody can
						answer a terminal here, so nothing was changed.
					</p>
					<div className="flex flex-wrap gap-2 pt-1">
						<Button type="button" size="sm" disabled={installing} onClick={() => install(true)}>
							{expressLockedPrompt(outcome.account)}
						</Button>
						<Button type="button" size="sm" variant="secondary" onClick={leaveForManual}>
							{EXPRESS_MANUAL_FALLBACK}
						</Button>
					</div>
				</Alert>
			) : null}

			{outcome?.outcome === "credential-unreadable" ? (
				<Alert variant="error" icon={<CircleAlert />}>
					{EXPRESS_KEY_UNREADABLE_MESSAGE}
				</Alert>
			) : null}

			{failure !== null ? (
				<Alert variant="error" icon={<CircleAlert />}>
					<p>{failure}</p>
					<div className="flex flex-wrap gap-2 pt-1">
						<Button type="button" size="sm" variant="secondary" onClick={leaveForManual}>
							{EXPRESS_MANUAL_FALLBACK}
						</Button>
					</div>
				</Alert>
			) : null}

			<Button
				type="button"
				size="sm"
				disabled={confirmed.length === 0 || !secretReady || installing}
				onClick={() => install(false)}
			>
				{installing ? (
					<Spinner label="Setting up" />
				) : (
					<>
						<KeyRound />
						Set up the server
					</>
				)}
			</Button>
		</div>
	)
}
