import { InternalError } from "./errors"
export const assertExhaustive = (value: never): never => {
	throw new InternalError(`Unhandled case: ${JSON.stringify(value)}`)
}
