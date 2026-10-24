import type { Part } from '../domain/project'

type Coupling = NonNullable<Part['mutualCouplings']>[number]

export function DeviceTemperatureEditor({ part, circuitTemperature, onChange }: { part: Part; circuitTemperature: string; onChange: (patch: Pick<Part, 'deviceTemperature' | 'deviceTemperatureDelta'>) => void }) {
  return <>
    <label className="field-label">Device temperature offset (°C)
      <input aria-label={`Device temperature offset for ${part.ref}`} inputMode="decimal" value={part.deviceTemperatureDelta ?? ''} placeholder="0 °C (default)" onChange={(event) => onChange({ deviceTemperatureDelta: event.target.value || undefined, deviceTemperature: event.target.value ? undefined : part.deviceTemperature })}/>
    </label>
    <label className="field-label">Fixed device temperature (°C)
      <input aria-label={`Fixed device temperature for ${part.ref}`} inputMode="decimal" value={part.deviceTemperature ?? ''} placeholder={`Circuit temperature (${circuitTemperature} °C)`} onChange={(event) => onChange({ deviceTemperature: event.target.value || undefined, deviceTemperatureDelta: event.target.value ? undefined : part.deviceTemperatureDelta })}/>
    </label>
    <div className="field-hint">Use the offset to add degrees to the circuit temperature, or set a fixed temperature to override it for this part. The two settings are exclusive. The selected model must support instance temperature.</div>
  </>
}

export function PassiveTemperatureCoefficientsEditor({ part, onChange }: { part: Part; onChange: (patch: Pick<Part, 'tc1' | 'tc2' | 'tce'>) => void }) {
  return <details className="passive-temperature-coefficients">
    <summary>Temperature coefficients (advanced)</summary>
    <div className="field-hint">Model how this part’s value changes with temperature. TC1 and TC2 provide the polynomial model. Resistor-based parts also support TCE, the exponential model; ngspice uses that model when TCE is present. Leave fields blank to use the selected model’s values or ngspice defaults.</div>
    <label className="field-label">TC1 (per °C)
      <input aria-label={`TC1 temperature coefficient for ${part.ref}`} inputMode="decimal" placeholder="Model default" value={part.tc1 ?? ''} onChange={(event) => onChange({ tc1: event.target.value || undefined })}/>
    </label>
    <label className="field-label">TC2 (per °C²)
      <input aria-label={`TC2 temperature coefficient for ${part.ref}`} inputMode="decimal" placeholder="Model default" value={part.tc2 ?? ''} onChange={(event) => onChange({ tc2: event.target.value || undefined })}/>
    </label>
    {['resistor', 'lamp', 'potentiometer'].includes(part.kind) && <label className="field-label">TCE (exponential)
      <input aria-label={`TCE exponential temperature coefficient for ${part.ref}`} inputMode="decimal" placeholder="Model default" value={part.tce ?? ''} onChange={(event) => onChange({ tce: event.target.value || undefined })}/>
    </label>}
  </details>
}

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

export function AdvancedDeviceSettings({ part, parts, circuitTemperature, supportsDeviceTemperature, onChange }: { part: Part; parts: Part[]; circuitTemperature: string; supportsDeviceTemperature: boolean; onChange: (patch: Partial<Part>) => void }) {
  return <>
    {['resistor', 'lamp', 'potentiometer', 'capacitor', 'inductor'].includes(part.kind) && <PassiveTemperatureCoefficientsEditor part={part} onChange={onChange}/>}
    {supportsDeviceTemperature && <DeviceTemperatureEditor part={part} circuitTemperature={circuitTemperature} onChange={onChange}/>}
    {part.kind === 'inductor' && <MutualCouplingEditor part={part} parts={parts} onChange={(mutualCouplings) => onChange({ mutualCouplings, mutualCoupling: undefined })}/>}
  </>
}
