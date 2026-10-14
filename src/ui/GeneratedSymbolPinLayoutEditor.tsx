import type { ElsimPinSide } from '../domain/elsimSymbol'

export function GeneratedSymbolPinLayoutEditor({ filename, modelName, pins, pinSides, onPinSideChange, onCreate }: {
  filename: string
  modelName: string
  pins: string[]
  pinSides: ElsimPinSide[]
  onPinSideChange: (index: number, side: ElsimPinSide) => void
  onCreate: () => void
}) {
  return <div className="generated-symbol-pin-list">
    <p>Choose where each pin appears. Pin numbers stay in the library’s SPICE order.</p>
    {pins.map((pin, index) => <label key={`${index}:${pin}`}>{index + 1}. {pin}<select aria-label={`${filename} ${modelName} pin ${index + 1} ${pin} side`} value={pinSides[index]} onChange={(event) => onPinSideChange(index, event.target.value as ElsimPinSide)}>
      <option value="left">Left</option><option value="right">Right</option><option value="top">Top</option><option value="bottom">Bottom</option>
    </select></label>)}
    <button className="place-model" onClick={onCreate}>Create custom symbol &amp; place</button>
  </div>
}
