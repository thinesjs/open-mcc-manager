import type { NotificationKind } from "./notification"

export type NotificationSubject = { readonly name: string }

export type NotificationCopy = { readonly title: string; readonly body: string }

const COPY: Record<NotificationKind, (subject: NotificationSubject) => NotificationCopy> = {
	"host.unreachable": ({ name }) => ({
		title: `${name} is not responding`,
		body: "OpenMCC cannot reach this machine, so the bots on it are unmanaged.",
	}),
	"host.recovered": ({ name }) => ({
		title: `${name} is back`,
		body: "OpenMCC can reach this machine again.",
	}),
	"host.drift_started": ({ name }) => ({
		title: `${name} was changed elsewhere`,
		body: "Something on this machine no longer matches what OpenMCC set up.",
	}),
	"host.drift_resolved": ({ name }) => ({
		title: `${name} matches again`,
		body: "This machine is back to what OpenMCC set up.",
	}),
	"instance.disconnected": ({ name }) => ({
		title: `${name} left the server`,
		body: "It has not managed to get back on.",
	}),
	"instance.reconnected": ({ name }) => ({
		title: `${name} is back on the server`,
		body: "It rejoined and is playing again.",
	}),
	"instance.flapping": ({ name }) => ({
		title: `${name} keeps dropping out`,
		body: "It has left and rejoined repeatedly in the last half hour.",
	}),
	"instance.never_joined": ({ name }) => ({
		title: `${name} never got on the server`,
		body: "It started up but never joined.",
	}),
	"instance.unexpected_stop": ({ name }) => ({
		title: `${name} stopped on its own`,
		body: "Nobody asked it to stop.",
	}),
	"instance.process_recovered": ({ name }) => ({
		title: `${name} is running again`,
		body: "It started back up.",
	}),
	"instance.needs_auth": ({ name }) => ({
		title: `${name} needs you to sign in`,
		body: "Open OpenMCC and start sign-in again.",
	}),
	"instance.drift_started": ({ name }) => ({
		title: `${name} was changed elsewhere`,
		body: "Its settings no longer match what OpenMCC has.",
	}),
	"instance.drift_resolved": ({ name }) => ({
		title: `${name} settings match again`,
		body: "Its settings are back to what OpenMCC has.",
	}),
	test: ({ name }) => ({
		title: "Test from OpenMCC",
		body: `If you are reading this, ${name} is set up correctly.`,
	}),
}

export const notificationCopy = (
	kind: NotificationKind,
	subject: NotificationSubject,
): NotificationCopy => COPY[kind](subject)
