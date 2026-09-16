import {
	ACCOUNT_NAME_PATTERN,
	ACCOUNT_NAME_REQUIREMENT,
	ADDRESS_PROBE_MESSAGES,
	type AddressProbeOutcome,
	EXPRESS_WARNING,
	EXPRESS_WARNING_TITLE,
	fingerprintCommand,
	HOST_KEY_FINGERPRINT_PATTERN,
	hostSetupScript,
	type InstallMode,
	setupSummary,
} from "@open-mcc/contracts"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { CircleAlert, CircleCheck, Info, TriangleAlert } from "lucide-react"
import { useState } from "react"
import { CommandBlock } from "~/components/command-block"
import { CopyButton } from "~/components/copy-button"
import { ExpressInstallPanel } from "~/components/express-install-panel"
import { HostCheckList } from "~/components/host-check-list"
import { SetupCommand } from "~/components/setup-command"
import { Alert } from "~/components/ui/alert"
import { Button } from "~/components/ui/button"
import { Choice } from "~/components/ui/choice"
import { Input } from "~/components/ui/input"
import { Label } from "~/components/ui/label"
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "~/components/ui/select"
import { Spinner } from "~/components/ui/spinner"
import { StepIndicator, Steps } from "~/components/ui/steps"
import { getErrorMessage } from "~/lib/errors"
import { clampStep, directionBetween, isLastStep } from "~/lib/steps"
import { useTRPC } from "~/lib/trpc"

export const ENROLL_STEPS = ["Access", "Address", "Account", "Prepare", "Verify"] as const

export const DEFAULT_ACCOUNT = "mcc"

export const STALE_COMMAND_NOTICE =
	"The setup command you copied is out of date. Copy it again and run it on the server."

const ACCOUNT_OPTIONS = [
	{
		value: "create",
		label: "Create it for me",
		description: "The setup command adds the account if it is missing.",
	},
	{
		value: "existing",
		label: "I already have one",
		description: "The setup command uses the account you name below.",
	},
] as const

type AccountMode = (typeof ACCOUNT_OPTIONS)[number]["value"]

const INSTALL_OPTIONS = [
	{
		value: "express",
		label: "Set it up for me",
		description: "OpenMCC signs in as root and runs the setup over SSH.",
	},
	{
		value: "manual",
		label: "I will run the command",
		description: "Copy one command and run it on the server yourself.",
	},
] as const

const PROBE_TONE: Record<AddressProbeOutcome, "success" | "warning" | "error"> = {
	answered: "success",
	"no-answer": "error",
	refused: "error",
	"timed-out": "error",
	"not-ssh": "error",
	unclear: "warning",
}

export type EnrollHostStepsProps = {
	onEnrolled: (hostId: string) => void
}

const PORT_DIGITS = /^[0-9]{1,5}$/

const portFrom = (value: string): number | null => {
	if (!PORT_DIGITS.test(value)) return null
	const port = Number(value)
	return port >= 1 && port <= 65535 ? port : null
}

export const EnrollHostSteps = ({ onEnrolled }: EnrollHostStepsProps) => {
	const trpc = useTRPC()
	const queryClient = useQueryClient()
	const sshKeysQuery = useQuery(trpc.sshKey.list.queryOptions())
	const enrollMutation = useMutation(trpc.host.enroll.mutationOptions())
	const checkMutation = useMutation(trpc.host.check.mutationOptions())
	const probeMutation = useMutation(trpc.host.probeAddress.mutationOptions())

	const [step, setStep] = useState(0)
	const [direction, setDirection] = useState<1 | -1>(1)
	const [sshKeyId, setSshKeyId] = useState("")
	const [name, setName] = useState("")
	const [hostname, setHostname] = useState("")
	const [port, setPort] = useState("22")
	const [username, setUsername] = useState(DEFAULT_ACCOUNT)
	const [accountMode, setAccountMode] = useState<AccountMode>("create")
	const [expectedFingerprint, setExpectedFingerprint] = useState("")
	const [copiedCommand, setCopiedCommand] = useState("")
	const [installMode, setInstallMode] = useState<InstallMode>("manual")

	const keys = sshKeysQuery.data ?? []
	const selectedKey = keys.find((key) => key.id === sshKeyId)

	const goTo = (next: number) => {
		const target = clampStep(next, ENROLL_STEPS.length)
		setDirection(directionBetween(step, target))
		setStep(target)
	}

	const checkedInput =
		(current: string, set: (value: string) => void) =>
		(value: string): void => {
			if (value === current) return
			checkMutation.reset()
			set(value)
		}

	const addressInput =
		(current: string, set: (value: string) => void) =>
		(value: string): void => {
			if (value === current) return
			probeMutation.reset()
			checkMutation.reset()
			set(value)
		}

	const portNumber = portFrom(port)
	const addressReady = name.length > 0 && hostname.length > 0 && portNumber !== null
	const accountReady = ACCOUNT_NAME_PATTERN.test(username)
	const fingerprintReady = HOST_KEY_FINGERPRINT_PATTERN.test(expectedFingerprint)

	const createAccount = accountMode === "create"
	const setupCommand = selectedKey
		? hostSetupScript(username, selectedKey.publicKey, createAccount)
		: ""
	const commandStale = copiedCommand.length > 0 && copiedCommand !== setupCommand

	const target =
		portNumber === null
			? null
			: { hostname, port: portNumber, username, sshKeyId, expectedFingerprint }
	const canCheck =
		target !== null && addressReady && accountReady && sshKeyId.length > 0 && fingerprintReady
	const canProbe = hostname.length > 0 && portNumber !== null

	const checked = checkMutation.variables
	const checkedReady =
		checkMutation.data?.ready === true &&
		checked !== undefined &&
		checked.sshKeyId === sshKeyId &&
		checked.hostname === hostname &&
		checked.port === portNumber &&
		checked.username === username &&
		checked.expectedFingerprint === expectedFingerprint

	const canAdvance =
		step === 0 ? sshKeyId.length > 0 : step === 1 ? addressReady : step === 2 ? accountReady : true

	const staleNotice = commandStale ? (
		<Alert variant="warning" icon={<TriangleAlert />}>
			{STALE_COMMAND_NOTICE}
		</Alert>
	) : null

	const submit = () => {
		if (portNumber === null) return
		enrollMutation.mutate(
			{
				name,
				hostname,
				port: portNumber,
				username,
				sshKeyId,
				expectedFingerprint,
			},
			{
				onSuccess: (host) => {
					queryClient.invalidateQueries({ queryKey: trpc.host.list.queryKey() })
					onEnrolled(host.id)
				},
			},
		)
	}

	return (
		<div className="space-y-5">
			<StepIndicator total={ENROLL_STEPS.length} current={step} labels={ENROLL_STEPS} />

			<Steps step={step} direction={direction}>
				{step === 0 ? (
					<div className="space-y-4 pb-1">
						<Choice
							label="How this server gets set up"
							value={installMode}
							options={INSTALL_OPTIONS}
							onChange={setInstallMode}
						/>

						{installMode === "express" ? (
							<Alert variant="warning" icon={<TriangleAlert />}>
								<p className="font-medium">{EXPRESS_WARNING_TITLE}</p>
								<p>{EXPRESS_WARNING}</p>
							</Alert>
						) : null}

						<div>
							<h3 className="text-sm font-medium text-foreground">
								Choose the key to connect with
							</h3>
							<p className="mt-1 text-sm text-muted-foreground">
								Choose the key OpenMCC will use to reach this server.
							</p>
						</div>

						{sshKeysQuery.data && keys.length === 0 ? (
							<Alert variant="info" icon={<Info />}>
								No SSH keys yet.{" "}
								<Link to="/ssh-keys" className="underline underline-offset-4">
									Create one first
								</Link>
								.
							</Alert>
						) : null}

						<div className="space-y-1.5">
							<Label htmlFor="enroll-key">SSH key</Label>
							<Select
								value={sshKeyId}
								onValueChange={(value) => checkedInput(sshKeyId, setSshKeyId)(value ?? "")}
							>
								<SelectTrigger id="enroll-key">
									<SelectValue placeholder="Select a key">
										{() => keys.find((key) => key.id === sshKeyId)?.name}
									</SelectValue>
								</SelectTrigger>
								<SelectContent>
									{keys.map((key) => (
										<SelectItem key={key.id} value={key.id}>
											{key.name}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</div>

						{staleNotice}

						{selectedKey ? (
							<div className="flex items-start justify-between gap-3 rounded-[var(--radius)] border border-border p-3">
								<p className="min-w-0 break-all font-mono text-xs text-muted-foreground">
									{selectedKey.publicKey}
								</p>
								<CopyButton value={selectedKey.publicKey} label="Public key" />
							</div>
						) : null}
					</div>
				) : null}

				{step === 1 ? (
					<div className="space-y-4 pb-1">
						<div>
							<h3 className="text-sm font-medium text-foreground">Where the server is</h3>
							<p className="mt-1 text-sm text-muted-foreground">
								Enter an address OpenMCC can reach.
							</p>
						</div>

						<div className="space-y-1.5">
							<Label htmlFor="enroll-name">Name</Label>
							<Input
								id="enroll-name"
								value={name}
								placeholder="vps-sg-1"
								onChange={(event) => setName(event.target.value)}
							/>
						</div>

						<div className="grid gap-3 sm:grid-cols-[1fr_7rem]">
							<div className="space-y-1.5">
								<Label htmlFor="enroll-hostname">Hostname or IP</Label>
								<Input
									id="enroll-hostname"
									value={hostname}
									placeholder="100.64.0.9"
									onChange={(event) => addressInput(hostname, setHostname)(event.target.value)}
								/>
							</div>
							<div className="space-y-1.5">
								<Label htmlFor="enroll-port">Port</Label>
								<Input
									id="enroll-port"
									value={port}
									inputMode="numeric"
									aria-invalid={portNumber === null}
									onChange={(event) => addressInput(port, setPort)(event.target.value)}
								/>
							</div>
						</div>

						<div className="space-y-3 rounded-[var(--radius)] border border-border p-3">
							<div className="flex items-start justify-between gap-3">
								<div>
									<p className="text-sm font-medium text-foreground">Test the connection</p>
									<p className="mt-0.5 text-xs text-muted-foreground">
										Optional. Checks the address before you run anything on the server.
									</p>
								</div>
								<Button
									type="button"
									size="sm"
									variant="secondary"
									disabled={!canProbe || probeMutation.isPending}
									onClick={() => {
										if (portNumber !== null) probeMutation.mutate({ hostname, port: portNumber })
									}}
								>
									{probeMutation.isPending ? <Spinner label="Testing" /> : "Test connection"}
								</Button>
							</div>
							{probeMutation.isError ? (
								<Alert variant="error" icon={<CircleAlert />}>
									{getErrorMessage(probeMutation.error)}
								</Alert>
							) : null}
							{probeMutation.data ? (
								<Alert
									variant={PROBE_TONE[probeMutation.data.outcome]}
									icon={
										probeMutation.data.outcome === "answered" ? <CircleCheck /> : <CircleAlert />
									}
								>
									{ADDRESS_PROBE_MESSAGES[probeMutation.data.outcome]}
								</Alert>
							) : null}
						</div>
					</div>
				) : null}

				{step === 2 ? (
					<div className="space-y-4 pb-1">
						<div>
							<h3 className="text-sm font-medium text-foreground">The account bots run as</h3>
							<p className="mt-1 text-sm text-muted-foreground">
								Bots run as an ordinary account on the server, never as root.
							</p>
						</div>

						<Choice
							label="Account for the bots"
							value={accountMode}
							options={ACCOUNT_OPTIONS}
							onChange={setAccountMode}
						/>

						<div className="space-y-1.5">
							<Label htmlFor="enroll-username">Account name</Label>
							<Input
								id="enroll-username"
								value={username}
								aria-invalid={!accountReady}
								onChange={(event) => checkedInput(username, setUsername)(event.target.value)}
							/>
							<p className="text-xs text-muted-foreground">
								{accountReady
									? `Leave it as ${DEFAULT_ACCOUNT} if you have no preference.`
									: ACCOUNT_NAME_REQUIREMENT}
							</p>
						</div>

						{staleNotice}
					</div>
				) : null}

				{step === 3 ? (
					<div className="space-y-4 pb-1">
						<div>
							<h3 className="text-sm font-medium text-foreground">Prepare the host</h3>
							<p className="mt-1 text-sm text-muted-foreground">
								{installMode === "express"
									? `OpenMCC sets ${username} up on ${hostname || "the host"} to run bots in Podman.`
									: `Run once on ${hostname || "the host"}. It sets up ${username} to run bots in Podman and prints the fingerprint for the next step.`}
							</p>
						</div>

						{installMode === "express" ? (
							<ExpressInstallPanel
								hostname={hostname}
								port={portNumber ?? 22}
								username={username}
								sshKeyId={sshKeyId}
								createAccount={createAccount}
								onReady={(fingerprint) => {
									setExpectedFingerprint(fingerprint)
									goTo(4)
								}}
								onManual={() => setInstallMode("manual")}
							/>
						) : null}

						{installMode === "manual" ? staleNotice : null}

						{installMode === "manual" && selectedKey ? (
							<SetupCommand
								command={setupCommand}
								summary={setupSummary(username, selectedKey.name, createAccount)}
								onCopied={() => setCopiedCommand(setupCommand)}
							/>
						) : null}
					</div>
				) : null}

				{step === 4 ? (
					<div className="space-y-4 pb-1">
						<div>
							<h3 className="text-sm font-medium text-foreground">Confirm the host's identity</h3>
							<p className="mt-1 text-sm text-muted-foreground">
								Paste the fingerprint printed by the setup command to confirm this is the same
								server.
							</p>
						</div>

						<div className="space-y-1.5">
							<Label htmlFor="enroll-fingerprint">Server fingerprint</Label>
							<Input
								id="enroll-fingerprint"
								value={expectedFingerprint}
								placeholder="SHA256:…"
								onChange={(event) =>
									checkedInput(expectedFingerprint, setExpectedFingerprint)(event.target.value)
								}
							/>
						</div>

						<CommandBlock
							label="If you no longer have that output"
							command={fingerprintCommand()}
							caption="Run on the host. Source the fingerprint from the host, never from this dashboard: on a mismatch, the dashboard is the untrusted side."
						/>

						<div className="space-y-3 rounded-[var(--radius)] border border-border p-3">
							<div className="flex items-start justify-between gap-3">
								<div>
									<p className="text-sm font-medium text-foreground">Host check</p>
									<p className="mt-0.5 text-xs text-muted-foreground">
										Enroll once this server is ready for bots.
									</p>
								</div>
								<Button
									type="button"
									size="sm"
									variant="secondary"
									disabled={!canCheck || checkMutation.isPending}
									onClick={() => {
										if (target !== null) checkMutation.mutate(target)
									}}
								>
									{checkMutation.isPending ? <Spinner label="Checking" /> : "Check host"}
								</Button>
							</div>
							{checkMutation.isError ? (
								<Alert variant="error" icon={<CircleAlert />}>
									{getErrorMessage(checkMutation.error)}
								</Alert>
							) : null}
							{checkMutation.data ? <HostCheckList report={checkMutation.data} /> : null}
						</div>

						<dl className="grid gap-x-6 gap-y-2 rounded-[var(--radius)] border border-border p-3 text-sm sm:grid-cols-2">
							<div>
								<dt className="text-muted-foreground">Host</dt>
								<dd className="text-foreground">{name || "—"}</dd>
							</div>
							<div>
								<dt className="text-muted-foreground">Address</dt>
								<dd className="truncate text-foreground">
									{username}@{hostname || "—"}:{port}
								</dd>
							</div>
						</dl>
					</div>
				) : null}
			</Steps>

			{enrollMutation.isError ? (
				<Alert variant="error" icon={<CircleAlert />}>
					{getErrorMessage(enrollMutation.error)}
				</Alert>
			) : null}

			<div className="flex justify-between gap-2">
				<Button
					size="sm"
					variant="secondary"
					disabled={step === 0 || enrollMutation.isPending}
					onClick={() => goTo(step - 1)}
				>
					Back
				</Button>
				{isLastStep(step, ENROLL_STEPS.length) ? (
					<Button
						size="sm"
						disabled={enrollMutation.isPending || !fingerprintReady || !checkedReady}
						onClick={submit}
					>
						{enrollMutation.isPending ? <Spinner label="Enrolling" /> : "Enroll host"}
					</Button>
				) : (
					<Button size="sm" disabled={!canAdvance} onClick={() => goTo(step + 1)}>
						Continue
					</Button>
				)}
			</div>
		</div>
	)
}
