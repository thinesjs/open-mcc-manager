import { spawnSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
	configWriteCommand,
	envWriteCommand,
	INSTANCE_LAYOUT,
	instanceDir,
	instanceLayoutSteps,
	parseUnitStartState,
	renderEnvironmentFile,
	renderUnitEnv,
	startUnitCommand,
	unitName,
	validateInstanceId,
} from "./unit"

const TOKEN = "0123456789abcdef0123456789abcdef"

const DIR = '"$HOME"/.local/share/open-mcc/instances/abc123'

describe("instance id validation", () => {
	it("rejects a systemd specifier, naming that as the reason", () => {
		expect(() => validateInstanceId("a%i")).toThrow(/systemd/i)
	})

	it("rejects a path separator and whitespace", () => {
		expect(() => validateInstanceId("a/b")).toThrow()
		expect(() => validateInstanceId("a b")).toThrow()
		expect(() => validateInstanceId("")).toThrow()
	})

	it("accepts an ordinary generated id", () => {
		expect(validateInstanceId("V1StGXR8Z5jdHi6B")).toBe("V1StGXR8Z5jdHi6B")
	})
})

describe("what a bot's directory holds", () => {
	it("names each file and directory the units and the manager use", () => {
		expect(INSTANCE_LAYOUT).toEqual({
			config: "config",
			state: "state",
			replays: "replays",
			recordingCache: "recording-cache",
			unitEnv: "unit.env",
			env: "env",
			control: "control",
			collectLock: "collect.lock",
		})
	})
})

describe("making a bot's directory", () => {
	const steps = instanceLayoutSteps({
		instanceId: "abc123",
		liveControlPort: 33333,
		liveControlToken: TOKEN,
		configDocument: "[Main]\n",
	})

	it("makes every directory first, then the fifo, lock and port file, then the token and the config", () => {
		expect(steps.map((step) => step.command)).toEqual([
			`install -d -m 0700 ${DIR} ${DIR}/config ${DIR}/state ${DIR}/replays ${DIR}/recording-cache`,
			`(test -p ${DIR}/control || mkfifo -m 0600 ${DIR}/control) && (umask 077; : > ${DIR}/collect.lock && printf '%s' 'OPEN_MCC_PORT=33333\n' > ${DIR}/unit.env)`,
			`d=${DIR}; t=$(mktemp "$d"/.env.XXXXXX) || exit 1; if cat > "$t" && [ "$(wc -c < "$t")" -eq 52 ] && mv -f -- "$t" "$d"/env; then exit 0; fi; rm -f -- "$t"; exit 1`,
			`timeout -k 2 10 sh -c 't=$(mktemp ${DIR}/config/.MinecraftClient.ini.XXXXXX) || exit 1; if cat > "$t" && [ "$(wc -c < "$t")" -eq 7 ] && mv -f -- "$t" ${DIR}/config/MinecraftClient.ini; then exit 0; fi; rm -f -- "$t"; exit 1'; s=$?; exit $s`,
		])
	})

	it("sends the token and the config as stdin, never on a command line", () => {
		expect(steps.map((step) => step.stdin)).toEqual([
			undefined,
			undefined,
			`MCC_MCP_AUTH_TOKEN=${TOKEN}\n`,
			"[Main]\n",
		])
		for (const step of steps) expect(step.command).not.toContain(TOKEN)
	})

	it("refuses a port or a token the unit could not read", () => {
		expect(() =>
			instanceLayoutSteps({
				instanceId: "abc123",
				liveControlPort: 0,
				liveControlToken: TOKEN,
				configDocument: "",
			}),
		).toThrow(/port/i)
		expect(() =>
			instanceLayoutSteps({
				instanceId: "abc123",
				liveControlPort: 33333,
				liveControlToken: "not-hex",
				configDocument: "",
			}),
		).toThrow(/token/i)
	})
})

const scratch: string[] = []

afterEach(() => {
	for (const each of scratch.splice(0)) rmSync(each, { force: true, recursive: true })
})

const instanceOf = (home: string): string => join(home, ".local/share/open-mcc/instances/abc123")

const configOf = (home: string): string => join(instanceOf(home), INSTANCE_LAYOUT.config)

const scratchHome = (withConfigDirectory: boolean): string => {
	const home = mkdtempSync(join(tmpdir(), "instance-write-"))
	scratch.push(home)
	mkdirSync(withConfigDirectory ? configOf(home) : instanceOf(home), { recursive: true })
	const bin = join(home, "bin")
	mkdirSync(bin)
	writeFileSync(join(bin, "timeout"), '#!/bin/sh\nshift 3; exec "$@"\n')
	chmodSync(join(bin, "timeout"), 0o755)
	return home
}

const runIn = (home: string, command: string, stdin: string) =>
	spawnSync("/bin/sh", ["-c", command], {
		env: { PATH: `${join(home, "bin")}:${process.env.PATH ?? "/usr/bin:/bin"}`, HOME: home },
		input: stdin,
	})

describe("writing a bot's settings file so no reader ever sees half of one", () => {
	const DOCUMENT = "[Main]\nNick = bot\n"

	const CONFIG = "MinecraftClient.ini"

	it("lands the whole document at 0600 and leaves no temporary behind", () => {
		const home = scratchHome(true)

		const ran = runIn(home, configWriteCommand("abc123", DOCUMENT), DOCUMENT)

		expect(ran.status, ran.stderr.toString()).toBe(0)
		expect(readFileSync(join(configOf(home), CONFIG), "utf8")).toBe(DOCUMENT)
		expect(statSync(join(configOf(home), CONFIG)).mode & 0o777).toBe(0o600)
		expect(readdirSync(configOf(home))).toEqual([CONFIG])
	})

	it("refuses a stdin one byte short of the count it announced, keeping the file it would have replaced", () => {
		const home = scratchHome(true)
		const previous = "[Main]\nNick = previous\n"
		writeFileSync(join(configOf(home), CONFIG), previous)

		const ran = runIn(home, configWriteCommand("abc123", DOCUMENT), DOCUMENT.slice(0, -1))

		expect(ran.status).toBe(1)
		expect(readFileSync(join(configOf(home), CONFIG), "utf8")).toBe(previous)
		expect(readdirSync(configOf(home))).toEqual([CONFIG])
	})

	it("fails rather than create a config directory that is gone", () => {
		const home = scratchHome(false)

		const ran = runIn(home, configWriteCommand("abc123", DOCUMENT), DOCUMENT)

		expect(ran.status).not.toBe(0)
		expect(existsSync(configOf(home))).toBe(false)
	})
})

describe("writing a bot's token and port files so a start never reads half of either", () => {
	const ENVIRONMENT = `MCC_MCP_AUTH_TOKEN=${TOKEN}\n`

	const PREVIOUS = `MCC_MCP_AUTH_TOKEN=${"f".repeat(32)}\n`

	it("renames the port file before the token, so a half-finished write leaves the port stale", () => {
		expect(envWriteCommand("abc123", ENVIRONMENT, 33333)).toBe(
			`d=${DIR}; t=$(mktemp "$d"/.env.XXXXXX) || exit 1; u=$(mktemp "$d"/.unit.env.XXXXXX) || { rm -f -- "$t"; exit 1; }; if cat > "$t" && [ "$(wc -c < "$t")" -eq 52 ] && printf '%s' 'OPEN_MCC_PORT=33333\n' > "$u" && mv -f -- "$u" "$d"/unit.env && mv -f -- "$t" "$d"/env; then exit 0; fi; rm -f -- "$t" "$u"; exit 1`,
		)
	})

	it("refuses a short stdin during creation, leaving the token file the bot already had", () => {
		const home = scratchHome(false)
		writeFileSync(join(instanceOf(home), INSTANCE_LAYOUT.env), PREVIOUS)
		const step = instanceLayoutSteps({
			instanceId: "abc123",
			liveControlPort: 33333,
			liveControlToken: TOKEN,
			configDocument: "[Main]\n",
		}).find((each) => each.stdin === ENVIRONMENT)
		if (step === undefined) throw new Error("creation writes no token file from stdin")

		const ran = runIn(home, step.command, ENVIRONMENT.slice(0, -1))

		expect(ran.status).toBe(1)
		expect(readFileSync(join(instanceOf(home), INSTANCE_LAYOUT.env), "utf8")).toBe(PREVIOUS)
		expect(readdirSync(instanceOf(home))).toEqual([INSTANCE_LAYOUT.env])
	})

	it("lands the token file whole when stdin arrives whole", () => {
		const home = scratchHome(false)
		writeFileSync(join(instanceOf(home), INSTANCE_LAYOUT.env), PREVIOUS)

		const ran = runIn(home, envWriteCommand("abc123", ENVIRONMENT), ENVIRONMENT)

		expect(ran.status, ran.stderr.toString()).toBe(0)
		expect(readFileSync(join(instanceOf(home), INSTANCE_LAYOUT.env), "utf8")).toBe(ENVIRONMENT)
		expect(statSync(join(instanceOf(home), INSTANCE_LAYOUT.env)).mode & 0o777).toBe(0o600)
		expect(readdirSync(instanceOf(home))).toEqual([INSTANCE_LAYOUT.env])
	})
})

describe("starting a bot and reading what systemd made of it", () => {
	it("starts the unit and reads its state, its result and its sign-in's state in the same command", () => {
		expect(startUnitCommand("abc123")).toBe(
			"XDG_RUNTIME_DIR=/run/user/$(id -u) systemctl --user start 'open-mcc@abc123' && XDG_RUNTIME_DIR=/run/user/$(id -u) systemctl --user show -p ActiveState -p Result 'open-mcc@abc123' && printf 'SignIn=%s\\n' \"$(XDG_RUNTIME_DIR=/run/user/$(id -u) systemctl --user show -p ActiveState --value 'open-mcc-auth@abc123.service')\"",
		)
	})

	it("reads the three properties in any order", () => {
		expect(parseUnitStartState("ActiveState=active\nResult=success\nSignIn=inactive\n")).toEqual({
			activeState: "active",
			result: "success",
			signIn: "inactive",
		})
		expect(parseUnitStartState("SignIn=active\nResult=success\nActiveState=inactive")).toEqual({
			activeState: "inactive",
			result: "success",
			signIn: "active",
		})
	})

	it.each([
		["nothing", ""],
		["no result", "ActiveState=active\nSignIn=inactive\n"],
		["no state", "Result=success\nSignIn=inactive\n"],
		["no sign-in state", "ActiveState=active\nResult=success\n"],
		[
			"an extra property",
			"ActiveState=active\nResult=success\nSignIn=inactive\nSubState=running\n",
		],
		["Windows line endings", "ActiveState=active\r\nResult=success\r\nSignIn=inactive\r\n"],
		[
			"a repeated property",
			"ActiveState=active\nActiveState=failed\nResult=success\nSignIn=inactive\n",
		],
		["an empty value", "ActiveState=active\nResult=success\nSignIn=\n"],
		["both on one line", "ActiveState=active Result=success SignIn=inactive"],
	])("refuses output with %s rather than guess", (_case, output) => {
		expect(parseUnitStartState(output)).toBeUndefined()
	})
})

describe("the token file", () => {
	it("carries the token unquoted, since Podman keeps quotes as part of the value", () => {
		expect(renderEnvironmentFile({ liveControlToken: TOKEN })).toBe(`MCC_MCP_AUTH_TOKEN=${TOKEN}\n`)
	})

	it("accepts the token the controller mints", () => {
		const minted = randomUUID().replaceAll("-", "")

		expect(renderEnvironmentFile({ liveControlToken: minted })).toBe(
			`MCC_MCP_AUTH_TOKEN=${minted}\n`,
		)
	})

	it.each([
		["uppercase hex", TOKEN.toUpperCase()],
		["31 characters", TOKEN.slice(1)],
		["33 characters", `${TOKEN}0`],
		["a newline", `${TOKEN.slice(1)}\n`],
		["an equals sign", `${TOKEN.slice(1)}=`],
		["a double quote", `"${TOKEN.slice(2)}"`],
		["a single quote", `'${TOKEN.slice(2)}'`],
		["nothing", ""],
	])("refuses a token carrying %s", (_case, liveControlToken) => {
		expect(() => renderEnvironmentFile({ liveControlToken })).toThrow(/token/i)
	})

	it("never writes the account or server, which the client ignores anyway", () => {
		const rendered = renderEnvironmentFile({ liveControlToken: TOKEN })

		expect(rendered).not.toContain("MCC_SERVER")
		expect(rendered).not.toContain("MCC_ACCOUNT")
	})
})

describe("the unit's own environment file", () => {
	it("carries the live control port and nothing else", () => {
		expect(renderUnitEnv(33333)).toBe("OPEN_MCC_PORT=33333\n")
	})

	it("accepts both ends of the port range", () => {
		expect(renderUnitEnv(1)).toBe("OPEN_MCC_PORT=1\n")
		expect(renderUnitEnv(65535)).toBe("OPEN_MCC_PORT=65535\n")
	})

	it.each([
		["0", 0],
		["65536", 65536],
		["a negative number", -1],
		["a fraction", 33333.5],
		["not a number", Number.NaN],
		["infinity", Number.POSITIVE_INFINITY],
		["a number that prints with an exponent", 1e21],
	])("refuses %s, which is no port", (_case, port) => {
		expect(() => renderUnitEnv(port)).toThrow(/port/i)
	})
})

describe("names built from an instance id validate it by construction", () => {
	it("refuses to build a unit name for an id carrying a systemd specifier", () => {
		expect(() => unitName("a%i")).toThrow(/systemd/i)
	})

	it("refuses to build a directory path for an id carrying a path separator", () => {
		expect(() => instanceDir("../../etc")).toThrow()
	})

	it("builds both for an ordinary id", () => {
		expect(unitName("V1StGXR8Z5jdHi6B")).toBe("open-mcc@V1StGXR8Z5jdHi6B")
		expect(instanceDir("V1StGXR8Z5jdHi6B")).toBe(
			'"$HOME"/.local/share/open-mcc/instances/V1StGXR8Z5jdHi6B',
		)
	})
})
