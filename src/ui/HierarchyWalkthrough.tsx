import { X } from 'lucide-react'

const steps = [
  {
    title: 'Run the circuit',
    guidance: 'Click Run simulation. The two divider instances use different RINPUT values.',
  },
  {
    title: 'Open the second divider instance',
    guidance: 'Select X2 and choose “Open sheet definition” in the inspector. Its RINPUT override is 2k.',
  },
  {
    title: 'Open the nested core block',
    guidance: 'Select XCORE and open its sheet definition to inspect the nested reusable core.',
  },
  {
    title: 'Probe the core resistor current',
    guidance: 'Choose the probe tool and click RCORE. Its current appears as a waveform.',
  },
  {
    title: 'Return to the root sheet',
    guidance: 'Click the Root sheet tab to finish. You can keep exploring the project afterward.',
  },
] as const

export function HierarchyWalkthrough({ step, onClose }: { step: number; onClose: () => void }) {
  const content = steps[step]
  if (!content) return null

  return <aside className="hierarchy-walkthrough" role="status" aria-live="polite">
    <div>
      <span className="eyebrow">GUIDED EXAMPLE · STEP {step + 1} OF {steps.length}</span>
      <strong>{content.title}</strong>
      <p>{content.guidance}</p>
    </div>
    <button className="subtle-icon" onClick={onClose} aria-label="Close walkthrough"><X size={15}/></button>
  </aside>
}
