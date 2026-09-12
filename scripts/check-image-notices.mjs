import fs from "node:fs"
import path from "node:path"

const root = process.cwd()

const WORKFLOW = ".github/workflows/release.yml"

export const GENERATOR = "third-party-notices.mjs"

export const NOTICES_PATH = "/licenses/THIRD-PARTY-NOTICES.txt"

export const publishedImages = (workflow) =>
	workflow
		.split(/^\s*-\s+image:/m)
		.slice(1)
		.map((block) => ({
			image: block.split("\n")[0]?.trim() ?? "",
			dockerfile: block.match(/dockerfile:\s*(\S+)/)?.[1] ?? "",
			target: block.match(/target:\s*(\S+)/)?.[1] ?? "",
		}))

export const stagesOf = (dockerfile) => {
	const found = new Map()
	let current = ""
	for (const line of dockerfile.split("\n")) {
		const named = line.match(/^FROM\s+\S+\s+AS\s+(\S+)/i)?.[1]
		if (named !== undefined) {
			current = named
			found.set(current, [])
			continue
		}
		found.get(current)?.push(line)
	}
	return new Map([...found].map(([name, body]) => [name, body.join("\n")]))
}

export const generatesNotices = (dockerfile) =>
	new RegExp(`^RUN\\b[\\s\\S]*?${GENERATOR}`, "m").test(dockerfile)

export const carriesNotices = (stage) =>
	new RegExp(`^COPY\\b.*\\s${NOTICES_PATH}\\s*$`, "m").test(stage)

export const problemsFor = (published, dockerfile) => {
	const found = []
	if (published.dockerfile.length === 0 || published.target.length === 0) {
		return [`${WORKFLOW} publishes ${published.image} without naming a dockerfile and a target`]
	}
	if (!generatesNotices(dockerfile)) {
		found.push(`${published.dockerfile} never runs ${GENERATOR}`)
	}
	const stage = stagesOf(dockerfile).get(published.target)
	if (stage === undefined) {
		found.push(`${published.dockerfile} has no stage named ${published.target}`)
	} else if (!carriesNotices(stage)) {
		found.push(
			`${published.dockerfile} stage ${published.target} does not copy ${NOTICES_PATH} into the image`,
		)
	}
	return found
}

const main = () => {
	const images = publishedImages(fs.readFileSync(path.join(root, WORKFLOW), "utf8"))
	const problems =
		images.length === 0
			? [`${WORKFLOW} publishes no images, so nothing proves the notices ship`]
			: images.flatMap((published) =>
					problemsFor(
						published,
						published.dockerfile.length === 0
							? ""
							: fs.readFileSync(path.join(root, published.dockerfile), "utf8"),
					),
				)

	if (problems.length > 0) {
		for (const problem of [...new Set(problems)]) process.stdout.write(`${problem}\n`)
		process.exit(1)
	}
}

if (process.argv[1]?.endsWith("check-image-notices.mjs")) main()
