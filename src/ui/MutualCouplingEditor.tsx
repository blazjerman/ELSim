import type { Part } from '../domain/project'

type Coupling = NonNullable<Part['mutualCouplings']>[number]

export function MutualCouplingEditor({ part, parts, onChange }: {
  part: Part
  parts: Part[]
  onChange: (couplings: Coupling[] | undefined) => void
}) {
  const couplings = part.mutualCouplings ?? (part.mutualCoupling ? [part.mutualCoupling] : [])
  const partnerIds = new Set(couplings.map((coupling) => coupling.partnerId))
  const partnerCouplings = (candidate: Part) => candidate.mutualCouplings ?? (candidate.mutualCoupling ? [candidate.mutualCoupling] : [])
  const candidates = parts.filter((candidate) => candidate.kind === 'inductor' && candidate.id !== part.id)
  const canAdd = candidates.some((candidate) => !partnerIds.has(candidate.id) && !partnerCouplings(candidate).some((coupling) => coupling.partnerId === part.id))
  const update = (next: Coupling[]) => onChange(next.length ? next : undefined)

  return <div className="mutual-coupling-editor">
    <div className="field-hint">Pair each winding with another inductor and set its coupling coefficient. Every pair is an independent SPICE relationship.</div>
    {couplings.map((coupling, index) => {
      const partner = parts.find((candidate) => candidate.id === coupling.partnerId)
      const options = candidates.filter((candidate) => candidate.id === coupling.partnerId || !partnerIds.has(candidate.id) && !partnerCouplings(candidate).some((entry) => entry.partnerId === part.id))
      return <div className="mutual-coupling-row" key={`${coupling.partnerId}:${index}`}>
        <label className="field-label">Coupled inductor {index + 1}
          <select aria-label={`Mutual coupling partner ${index + 1} for ${part.ref}`} value={coupling.partnerId} onChange={(event) => update(couplings.map((entry, entryIndex) => entryIndex === index ? { ...entry, partnerId: event.target.value } : entry))}>
            {options.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.ref}</option>)}
          </select>
        </label>
        <label className="field-label">Coupling (0–1)
          <input aria-label={`Mutual coupling coefficient to ${partner?.ref ?? 'inductor'} for ${part.ref}`} type="number" min="0.000001" max="1" step="any" value={coupling.coefficient} onChange={(event) => update(couplings.map((entry, entryIndex) => entryIndex === index ? { ...entry, coefficient: event.target.value } : entry))}/>
        </label>
        <button className="subtle-icon mutual-coupling-remove" type="button" aria-label={`Remove coupling from ${part.ref} to ${partner?.ref ?? 'inductor'}`} onClick={() => update(couplings.filter((_, entryIndex) => entryIndex !== index))}>×</button>
      </div>
    })}
    <button className="place-model mutual-coupling-add" type="button" disabled={!canAdd} onClick={() => {
      const candidate = candidates.find((entry) => !partnerIds.has(entry.id) && !partnerCouplings(entry).some((coupling) => coupling.partnerId === part.id))
      if (candidate) update([...couplings, { partnerId: candidate.id, coefficient: '0.99' }])
    }}>Add coupled inductor</button>
    <div className="field-hint">Each coupled coil is marked at pin 1. Ngspice uses these dotted terminals to set polarity; reverse a coil to change its winding relationship.</div>
  </div>
}
