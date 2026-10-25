export default function RandomSamplingEditor({ value, onChange }: { value: number; onChange: (value: number) => void }) {
  return <div className="form-section parameter-sweep-section">
    <div className="form-section-title">RANDOM SAMPLING</div>
    <label className="field-label">Independent random runs
      <select aria-label="Independent random runs" value={value} onChange={(event) => onChange(Number(event.target.value))}>
        {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((count) => <option key={count} value={count}>{count === 1 ? 'Single run' : `${count} runs`}</option>)}
      </select>
    </label>
    <p className="field-hint">Runs native ngspice statistical expressions with a fresh seed per run and plots each result separately. Combines with parameter stepping; the total is limited to 10 runs.</p>
  </div>
}
