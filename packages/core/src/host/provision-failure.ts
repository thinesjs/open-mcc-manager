import {
	CLIENT_RUNS_STEP_LABEL,
	LINGER_STEP_LABEL,
	type ProvisionStepLabel,
	STORAGE_STEP_LABEL,
} from "@open-mcc/contracts"
import type { StorageStepWord } from "./podman-facts"

type OtherStepLabel = Exclude<ProvisionStepLabel, typeof STORAGE_STEP_LABEL>

const FAILURES: Readonly<Record<OtherStepLabel, string>> = {
	"Checking systemd":
		"Could not confirm systemd, a non-root account and a usable home folder on this host.",
	[LINGER_STEP_LABEL]:
		"Lingering is off for this user, so bots would stop at logout. Run sudo loginctl enable-linger for this user on the host.",
	"Checking Podman": "Podman isn't ready for this account. Run the setup script on the host again.",
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

const STORAGE_FAILURES: Readonly<Record<StorageStepWord, string>> = {
	refused:
		"One of XDG_CONFIG_HOME, XDG_DATA_HOME, CONTAINERS_STORAGE_CONF or rootless_storage_path in /etc/containers/storage.conf is sending Podman's storage elsewhere. Clear whichever is set on this host.",
	used: "Podman on this account already has data, and OpenMCC will not change it. Enrol an account that has never run Podman.",
	root: "Podman does not run rootless for this account. Bots can only run where it does.",
}

export const STORAGE_STEP_SAID_NOTHING =
	"Podman did not answer on this account, so nothing was set up on it. Run podman info there as this account to see why."

export const PROVISIONING_STOPPED_EARLY = "Provisioning stopped before its first step."

export const provisioningFailureFor = (
	step: ProvisionStepLabel | undefined,
	storage: StorageStepWord | null,
): string => {
	if (step === undefined) return PROVISIONING_STOPPED_EARLY
	if (step !== STORAGE_STEP_LABEL) return FAILURES[step]
	return storage === null ? STORAGE_STEP_SAID_NOTHING : STORAGE_FAILURES[storage]
}
