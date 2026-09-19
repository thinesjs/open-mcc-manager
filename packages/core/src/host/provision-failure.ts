import {
	CLIENT_RUNS_STEP_LABEL,
	LINGER_STEP_LABEL,
	type ProvisionStepLabel,
} from "@open-mcc/contracts"

const FAILURES: Readonly<Record<ProvisionStepLabel, string>> = {
	"Checking systemd":
		"Could not confirm systemd, a non-root account and a usable home folder on this host.",
	[LINGER_STEP_LABEL]:
		"Lingering is off for this user, so bots would stop at logout. Run sudo loginctl enable-linger for this user on the host.",
	"Checking Podman": "Podman isn't ready for this account. Run the setup script on the host again.",
	"Setting up container storage":
		"Container storage couldn't be set up. Use a fresh account that has never run Podman.",
	"Creating the instances directory": "The instances directory could not be created.",
	"Reading the host architecture":
		"This host's processor could not be read, or has no client build.",
	"Downloading the client": "The client could not be downloaded.",
	"Verifying the download": "The download did not match its checksum, so it was not installed.",
	"Installing the client": "The client could not be installed.",
	"Downloading the runtime image": "The runtime image could not be downloaded.",
	"Verifying the runtime image":
		"The downloaded runtime image was not the expected one, so it was not used.",
	[CLIENT_RUNS_STEP_LABEL]: "The client did not start.",
	"Installing the instance unit": "The bot service could not be installed.",
	"Installing the sleep units": "The sleep services could not be installed.",
	"Reloading systemd": "systemd could not reload its services.",
}

export const PROVISIONING_STOPPED_EARLY = "Provisioning stopped before its first step."

export const provisioningFailureFor = (step: ProvisionStepLabel | undefined): string =>
	step === undefined ? PROVISIONING_STOPPED_EARLY : FAILURES[step]
