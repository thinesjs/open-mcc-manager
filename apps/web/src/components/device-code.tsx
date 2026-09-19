import type { DeviceCodeChallenge } from "@open-mcc/contracts"
import { KeyRound } from "lucide-react"
import { useEffect, useState } from "react"
import { Alert } from "~/components/ui/alert"
import { describeCodeValidity, hasCodeExpired } from "~/lib/device-code"

const TICK_MS = 15_000

export type DeviceCodeProps = {
	challenge: DeviceCodeChallenge
}

export const DeviceCode = ({ challenge }: DeviceCodeProps) => {
	const [now, setNow] = useState(() => Date.now())

	useEffect(() => {
		const timer = window.setInterval(() => setNow(Date.now()), TICK_MS)
		return () => window.clearInterval(timer)
	}, [])

	if (hasCodeExpired(challenge.expiresAt, now)) {
		return (
			<Alert variant="warning" icon={<KeyRound />}>
				{describeCodeValidity(challenge.expiresAt, now)}
			</Alert>
		)
	}

	return (
		<Alert variant="info" icon={<KeyRound />}>
			<span className="block">
				Open{" "}
				<a
					href={challenge.verificationUri}
					target="_blank"
					rel="noreferrer"
					className="text-primary underline underline-offset-4"
				>
					{challenge.verificationUri}
				</a>{" "}
				and enter the code{" "}
				<span className="font-mono font-semibold tracking-wider">{challenge.userCode}</span>. Then
				choose “I finished signing in”.
			</span>
			<span className="block text-xs">{describeCodeValidity(challenge.expiresAt, now)}</span>
		</Alert>
	)
}
