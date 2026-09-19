import type { ComponentProps } from "react"
import { cn } from "~/lib/utils"

const NOTICE =
	"Not an official Minecraft product, and not approved by or associated with Mojang or Microsoft."

export const AffiliationNotice = ({ className }: Pick<ComponentProps<"p">, "className">) => (
	<p
		className={cn(
			"text-[0.6875rem] font-normal leading-relaxed text-muted-foreground/70",
			className,
		)}
	>
		{NOTICE}
	</p>
)
