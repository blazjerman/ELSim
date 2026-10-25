import type { Project } from '../domain/project'

export type ToolMode = 'select' | 'wire' | 'label' | 'note' | 'probe' | 'junction'
export type Selection = { kind: 'part' | 'label'; id: string } | null
export type SheetSelectionState = { selection: Selection; partIds: string[]; wireIds: string[]; labelIds: string[] }
export type HoveredSchematicObject = { kind: 'part' | 'wire' | 'label'; id: string } | null
export type ProbeRequest = { kind: 'node'; name: string; wireId?: string; labelId?: string } | { kind: 'part'; id: string; winding?: 'P' | 'S'; port?: 1 | 2 }
export type SchematicProject = Pick<Project, 'activeSheetId' | 'parts' | 'wires' | 'junctions' | 'netLabels' | 'view'>
