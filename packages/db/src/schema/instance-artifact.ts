import type { Insertable, Selectable, SelectType } from "kysely"
import type { DB } from "../generated/database"

type RefinementOf<Narrowed extends Base, Base> = Narrowed

export type InstanceArtifactKind = "playerList" | "replay"

type _InstanceArtifactKindRefinesGeneratedColumn = RefinementOf<
	InstanceArtifactKind,
	SelectType<DB["instanceArtifact"]["kind"]>
>

export type InstanceArtifactTable = Omit<DB["instanceArtifact"], "kind"> & {
	kind: InstanceArtifactKind
}

export type InstanceArtifactRow = Selectable<InstanceArtifactTable>
export type InstanceArtifactInsert = Insertable<InstanceArtifactTable>
