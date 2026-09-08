import { activeTraceIds, createRootLogger } from "@open-mcc/core"

export const SERVICE = "open-mcc-worker"

export const rootLogger = createRootLogger(SERVICE, process.env, { activeTrace: activeTraceIds })
