import { activeTraceIds, createRootLogger } from "@open-mcc/core"

export const SERVICE = "open-mcc-server"

export const rootLogger = createRootLogger(SERVICE, process.env, { activeTrace: activeTraceIds })
