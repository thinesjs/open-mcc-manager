import type { ComponentProps } from "react"
import { cn } from "~/lib/utils"

const NOTICE =
	"Not an official Minecraft product. Not approved by or associated with Mojang or Microsoft."

export const AffiliationNotice = ({ className }: Pick<ComponentProps<"p">, "className">) => (
	<p className={cn("text-sm font-medium leading-snug text-muted-foreground", className)}>
		{NOTICE}
	</p>
)
