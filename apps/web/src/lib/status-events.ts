const TEMPLATES: Record<string, (subject: string) => string> = {
	"host.check_failed": (subject) => `${subject} did not answer a check.`,
	"host.check_recovered": (subject) => `${subject} answered again.`,
	"host.unreachable": (subject) => `OpenMCC lost contact with ${subject}.`,
	"host.recovered": (subject) => `OpenMCC can reach ${subject} again.`,
	"host.degraded": (subject) => `Something on ${subject} stopped running.`,
	"host.healthy": (subject) => `Everything on ${subject} is running again.`,
	"host.drift_started": (subject) => `${subject} no longer matches your saved setup.`,
	"host.drift_resolved": (subject) => `${subject} matches your saved setup again.`,
	"instance.joined": (subject) => `${subject} joined its server.`,
	"instance.disconnected": (subject) => `${subject} is off its server.`,
	"instance.reconnected": (subject) => `${subject} rejoined its server.`,
	"instance.kicked": (subject) => `${subject} was kicked.`,
	"instance.connection_lost": (subject) => `${subject} lost its connection.`,
	"instance.never_joined": (subject) => `${subject} is running but has not joined.`,
	"instance.started": (subject) => `${subject} started.`,
	"instance.stopped": (subject) => `${subject} was stopped.`,
	"instance.unexpected_stop": (subject) => `${subject} stopped on its own.`,
	"instance.needs_auth": (subject) => `${subject} needs to sign in again.`,
	"instance.drift_started": (subject) => `${subject} no longer matches your saved settings.`,
	"instance.drift_resolved": (subject) => `${subject} matches your saved settings again.`,
	"monitoring.gap": () => "OpenMCC was not checking for a while.",
}

export const describeStatusEvent = (kind: string, subject: string): string =>
	TEMPLATES[kind]?.(subject) ?? `${subject}: ${kind.replaceAll(".", " ").replaceAll("_", " ")}`
