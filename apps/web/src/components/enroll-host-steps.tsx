import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { CircleAlert, Info } from "lucide-react"
import { useState } from "react"
import { CopyButton } from "~/components/copy-button"
import { Alert } from "~/components/ui/alert"
import { Button } from "~/components/ui/button"
import { Input } from "~/components/ui/input"
import { Label } from "~/components/ui/label"
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "~/components/ui/select"
import { StepIndicator, Steps } from "~/components/ui/steps"
import { getErrorMessage } from "~/lib/errors"
import { clampStep, directionBetween, isLastStep } from "~/lib/steps"
import { useTRPC } from "~/lib/trpc"

export const ENROLL_STEPS = ["Access", "Address", "Verification"] as const

export type EnrollHostStepsProps = {
	onEnrolled: (hostId: string) => void
}

export const EnrollHostSteps = ({ onEnrolled }: EnrollHostStepsProps) => {
	const trpc = useTRPC()
	const queryClient = useQueryClient()
	const sshKeysQuery = useQuery(trpc.sshKey.list.queryOptions())
	const enrollMutation = useMutation(trpc.host.enroll.mutationOptions())

	const [step, setStep] = useState(0)
	const [direction, setDirection] = useState<1 | -1>(1)
	const [sshKeyId, setSshKeyId] = useState("")
	const [name, setName] = useState("")
	const [hostname, setHostname] = useState("")
	const [port, setPort] = useState("22")
	const [username, setUsername] = useState("root")
	const [expectedFingerprint, setExpectedFingerprint] = useState("")

	const keys = sshKeysQuery.data ?? []
	const selectedKey = keys.find((key) => key.id === sshKeyId)

	const goTo = (next: number) => {
		const target = clampStep(next, ENROLL_STEPS.length)
		setDirection(directionBetween(step, target))
		setStep(target)
	}

	const canAdvance =
		step === 0 ? sshKeyId.length > 0 : step === 1 ? name.length > 0 && hostname.length > 0 : true

	const submit = () => {
		enrollMutation.mutate(
			{
				name,
				hostname,
				port: Number.parseInt(port, 10),
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
						<div>
							<h3 className="text-sm font-medium text-foreground">
								Choose the key to connect with
							</h3>
							<p className="mt-1 text-sm text-muted-foreground">
								The control plane authenticates to the host with this key. Its public half must
								already be in the host's authorized_keys.
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
							<Select value={sshKeyId} onValueChange={(value) => setSshKeyId(value ?? "")}>
								<SelectTrigger id="enroll-key">
									<SelectValue placeholder="Select a key" />
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
							<h3 className="text-sm font-medium text-foreground">Where the host lives</h3>
							<p className="mt-1 text-sm text-muted-foreground">
								A public address, or a tailnet address if the host is only reachable privately.
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
									onChange={(event) => setHostname(event.target.value)}
								/>
							</div>
							<div className="space-y-1.5">
								<Label htmlFor="enroll-port">Port</Label>
								<Input
									id="enroll-port"
									value={port}
									inputMode="numeric"
									onChange={(event) => setPort(event.target.value)}
								/>
							</div>
						</div>

						<div className="space-y-1.5">
							<Label htmlFor="enroll-username">SSH username</Label>
							<Input
								id="enroll-username"
								value={username}
								onChange={(event) => setUsername(event.target.value)}
							/>
						</div>
					</div>
				) : null}

				{step === 2 ? (
					<div className="space-y-4 pb-1">
						<div>
							<h3 className="text-sm font-medium text-foreground">Verify the host key</h3>
							<p className="mt-1 text-sm text-muted-foreground">
								Obtain this from your provider's console or an existing known_hosts entry. Do not
								take it from this dashboard. The control plane refuses enrolment on any mismatch
								without disclosing what the host presented.
							</p>
						</div>

						<div className="space-y-1.5">
							<Label htmlFor="enroll-fingerprint">Expected fingerprint</Label>
							<Input
								id="enroll-fingerprint"
								value={expectedFingerprint}
								placeholder="SHA256:…"
								onChange={(event) => setExpectedFingerprint(event.target.value)}
							/>
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
						disabled={enrollMutation.isPending || expectedFingerprint.length === 0}
						onClick={submit}
					>
						{enrollMutation.isPending ? "Enrolling…" : "Enroll host"}
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
