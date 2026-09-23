import { MINECRAFT_VERSION_OPTIONS, minecraftVersionSchema } from "@open-mcc/contracts"
import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { Label } from "~/components/ui/label"
import {
	AUTO_DETECT_LABEL,
	MINECRAFT_VERSION_CHOICES,
	MinecraftVersionSelect,
	minecraftVersionLabel,
} from "./minecraft-version-select"

afterEach(cleanup)

const mount = (value: Parameters<typeof minecraftVersionLabel>[0]) =>
	render(
		<div>
			<Label htmlFor="version">Minecraft version</Label>
			<MinecraftVersionSelect id="version" value={value} onChange={vi.fn()} />
		</div>,
	)

describe("choosing which Minecraft version a bot joins as", () => {
	it("★ offers auto-detect first, so the bot that needs no pin needs no decision", () => {
		expect(MINECRAFT_VERSION_CHOICES[0]).toBe("auto")
		expect(MINECRAFT_VERSION_CHOICES.slice(1)).toEqual([...MINECRAFT_VERSION_OPTIONS])
	})

	it("★ offers nothing the server would refuse to save", () => {
		for (const choice of MINECRAFT_VERSION_CHOICES) {
			expect(minecraftVersionSchema.safeParse(choice).success).toBe(true)
		}
	})

	it("names auto-detect in words and every other option as the version itself", () => {
		expect(minecraftVersionLabel("auto")).toBe(AUTO_DETECT_LABEL)
		expect(minecraftVersionLabel("1.8.9")).toBe("1.8.9")
	})

	it("shows auto-detect on a bot nobody pinned", () => {
		mount("auto")

		expect(screen.getByLabelText("Minecraft version").textContent).toContain(AUTO_DETECT_LABEL)
	})

	it("★ shows the pinned version rather than auto-detect once one is set", () => {
		mount("1.8.9")

		const trigger = screen.getByLabelText("Minecraft version")
		expect(trigger.textContent).toContain("1.8.9")
		expect(trigger.textContent).not.toContain(AUTO_DETECT_LABEL)
	})
})
