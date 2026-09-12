import {
	type InstanceConfigInput,
	instanceConfigInput,
	type UpdateBotConfigInput,
	updateBotConfigInput,
} from "@open-mcc/contracts"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { BotConfigPanel } from "./bot-config-panel"

const mutate = vi.fn()

vi.mock("~/lib/trpc", () => ({
	useTRPC: () => ({
		instance: { updateBotConfig: { mutationOptions: () => ({ mutationFn: mutate }) } },
	}),
}))

const BASE = {
	accountType: "offline",
	minecraftAccount: "OpenMccBot",
	serverAddress: "play.example.com:25565",
	autoRelogRetries: 3,
	autoRelogEnabled: true,
	autoRelogDelaySeconds: { min: 5, max: 20 },
	antiAfkEnabled: true,
	antiAfkIntervalSeconds: { min: 90, max: 300 },
}

const configWith = (logFile: string): InstanceConfigInput =>
	instanceConfigInput.parse({
		...BASE,
		botConfig: { "ChatBot.ChatLog.Enabled": "true", "ChatBot.ChatLog.Log_File": logFile },
	})

const mount = (instanceId: string, config: InstanceConfigInput) => {
	const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } })
	return render(
		<QueryClientProvider client={client}>
			<BotConfigPanel instanceId={instanceId} config={config} onSaved={async () => undefined} />
		</QueryClientProvider>,
	)
}

const remount = (
	rerender: (element: React.ReactElement) => void,
	instanceId: string,
	config: InstanceConfigInput,
) => {
	const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } })
	rerender(
		<QueryClientProvider client={client}>
			<BotConfigPanel instanceId={instanceId} config={config} onSaved={async () => undefined} />
		</QueryClientProvider>,
	)
}

const sent = (): UpdateBotConfigInput | undefined => {
	const parsed = updateBotConfigInput.safeParse(mutate.mock.calls[0]?.[0])
	return parsed.success ? parsed.data : undefined
}

afterEach(() => {
	cleanup()
	mutate.mockReset()
})

describe("saving the bots an operator has configured", () => {
	it("sends what is on screen, under the instance it is showing", async () => {
		mount("i1", configWith("first.txt"))

		screen.getByText("Save bots").click()
		await act(async () => undefined)

		expect(sent()?.instanceId).toBe("i1")
		expect(sent()?.botConfig["ChatBot.ChatLog.Log_File"]).toBe("first.txt")
	})
})

describe("moving to another instance without the page being rebuilt", () => {
	it("★ shows the instance now on screen, not the draft left over from the last one", () => {
		const { rerender } = mount("i1", configWith("first.txt"))
		fireEvent.change(screen.getByLabelText("Chat log file"), {
			target: { value: "typed-but-never-saved.txt" },
		})

		remount(rerender, "i2", configWith("second.txt"))

		expect(screen.getByLabelText("Chat log file")).toHaveProperty("value", "second.txt")
	})

	it("★ saves the second instance's values, never the first one's", async () => {
		const { rerender } = mount("i1", configWith("first.txt"))
		fireEvent.change(screen.getByLabelText("Chat log file"), {
			target: { value: "typed-but-never-saved.txt" },
		})

		remount(rerender, "i2", configWith("second.txt"))
		screen.getByText("Save bots").click()
		await act(async () => undefined)

		expect(sent()?.instanceId).toBe("i2")
		expect(sent()?.botConfig["ChatBot.ChatLog.Log_File"]).toBe("second.txt")
	})

	it("keeps an edit while the operator stays on the same instance", () => {
		const { rerender } = mount("i1", configWith("first.txt"))
		fireEvent.change(screen.getByLabelText("Chat log file"), {
			target: { value: "still-being-typed.txt" },
		})

		remount(rerender, "i1", configWith("first.txt"))

		expect(screen.getByLabelText("Chat log file")).toHaveProperty("value", "still-being-typed.txt")
	})
})
