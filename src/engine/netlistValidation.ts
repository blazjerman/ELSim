import { analyzeConnectivity } from '../domain/connectivity'
import type { Connectivity } from '../domain/connectivity'
import type { Project } from '../domain/project'
import { MAX_FINITE_PWL_POINTS, MAX_SOURCE_PWL_POINTS, validateSourcePwlPoints, validateSourcePwlRepeatBoundary } from '../domain/sourcePwl'
import { dcSweepPointCount, MAX_DC_SWEEP_POINTS } from '../domain/dcSweep'
import {
  spiceMagnitude, spiceNumber, spiceScalar, spiceSheetMagnitude, spiceSheetParameterDefault,
  spiceSheetScalar, spiceSheetTimeMagnitude, spiceSheetValue, spiceValueMagnitude,
} from './spiceValues'

export type AnalysisSettingField = 'temperature' | 'noiseOutput' | 'noiseSource' | 'noiseScale' | 'noisePoints' | 'noiseStartFrequency' | 'noiseStopFrequency' | 'stopTime' | 'maxStep' | 'startSavingTime' | 'acScale' | 'acPoints' | 'acStartFrequency' | 'acStopFrequency' | 'dcSource' | 'dcStart' | 'dcStop' | 'dcStep' | 'partAcMagnitude' | 'partAcPhase' | 'pwlPoints' | 'pulse.initial' | 'pulse.delay' | 'pulse.rise' | 'pulse.fall' | 'pulse.width' | 'pulse.period' | 'pulse.cycleCount' | 'sine.offset' | 'sine.amplitude' | 'sine.frequency' | 'sine.delay' | 'sine.damping' | 'sine.phase' | 'exp.initial' | 'exp.pulsed' | 'exp.riseDelay' | 'exp.riseTau' | 'exp.fallDelay' | 'exp.fallTau' | 'sffm.offset' | 'sffm.amplitude' | 'sffm.carrierFrequency' | 'sffm.modulationIndex' | 'sffm.signalFrequency' | 'am.offset' | 'am.modulationOffset' | 'am.modulationAmplitude' | 'am.modulationFrequency' | 'am.carrierFrequency' | 'am.delay' | 'am.modulationPhase' | 'am.carrierPhase' | 'trnoise.gaussianRms' | 'trnoise.timeStep' | 'trnoise.flickerExponent' | 'trnoise.flickerAmplitude' | 'trnoise.rtsAmplitude' | 'trnoise.rtsCaptureTime' | 'trnoise.rtsEmissionTime'
export type AnalysisSettingError = { field: AnalysisSettingField; message: string; sourceId?: string; settingPath?: string }

export function validateAnalysisSettings(project: Project, connectivity?: Connectivity): AnalysisSettingError[] {
  const errors: AnalysisSettingError[] = []
  // Source checks below use the same list in several analyses. Collect it once
  // instead of rescanning every schematic part for each waveform field group.
  const independentSources = project.simulation.analysis === 'op'
    ? []
    : project.parts.filter((part) => part.kind === 'source' || part.kind === 'currentSource')
  const add = (field: AnalysisSettingField, message: string, sourceId?: string, settingPath?: string) => errors.push({ field, message, ...(sourceId ? { sourceId } : {}), ...(settingPath ? { settingPath } : {}) })
  const temperature = Number(project.simulation.temperature ?? '27')
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test((project.simulation.temperature ?? '27').trim()) || !Number.isFinite(temperature) || temperature < -273.15 || temperature > 10000) add('temperature', 'Enter a temperature from −273.15 °C to 10000 °C.')
  const sourceParameters = project.sheets.find((sheet) => sheet.id === project.activeSheetId)?.parameters ?? []
  if (project.simulation.analysis === 'tran') {
    const stop = spiceMagnitude(project.simulation.stopTime, 'time')
    const step = spiceMagnitude(project.simulation.maxStep, 'time')
    if (stop === null || stop <= 0) add('stopTime', 'Enter a positive stop time, such as 100 ms.')
    if (step === null || step <= 0) add('maxStep', 'Enter a positive maximum step, such as 100 µs.')
    const startSavingText = project.simulation.startSavingTime?.trim()
    if (startSavingText) {
      const startSaving = spiceMagnitude(startSavingText, 'time')
      if (startSaving === null || startSaving < 0 || stop === null || startSaving >= stop) add('startSavingTime', 'Enter a nonnegative time earlier than the stop time, or leave this blank to save from time zero.')
    }
    for (const part of independentSources.filter((item) => item.kind === 'source' || item.sourceMode === 'pulse')) {
      if (part.kind === 'source' && part.sourceMode !== undefined && part.sourceMode !== 'pulse') continue
      const pulse = { initial: '0', delay: '0', rise: '1u', fall: '1u', width: '50m', period: '100m', ...part.pulse }
      const level = spiceSheetValue(pulse.initial, part.kind, sourceParameters)
      if (level === null) add('pulse.initial', `${part.ref} initial pulse level must be a valid SPICE value.`, part.id)
      for (const key of ['delay', 'rise', 'fall', 'width', 'period'] as const) {
        const magnitude = spiceSheetTimeMagnitude(pulse[key], sourceParameters)
        const invalid = magnitude === null || magnitude < 0 || (key === 'period' && magnitude <= 0)
        if (invalid) add(`pulse.${key}`, `${part.ref} ${key} must be a valid ${key === 'period' ? 'positive' : 'nonnegative'} time value.`, part.id)
      }
      if (pulse.cycleCount !== undefined && pulse.cycleCount.trim() !== '' && !/^(?:0|[1-9]\d*)$/.test(pulse.cycleCount.trim())) add('pulse.cycleCount', `${part.ref} pulse cycle count must be a nonnegative whole number; zero repeats indefinitely.`, part.id, 'pulse.cycleCount')
    }
    for (const part of independentSources.filter((item) => item.sourceMode === 'sine')) {
      const quantity = part.kind === 'source' ? 'voltage' : 'current'
      const sine = { offset: '0', amplitude: part.value, frequency: '1k', delay: '0', damping: '0', phase: '0', ...part.sine }
      if (spiceSheetValue(sine.offset, part.kind, sourceParameters) === null) add('sine.offset', `${part.ref} sine offset must be a valid ${quantity} or a declared parameter.`, part.id, 'sine.offset')
      if (spiceSheetValue(sine.amplitude, part.kind, sourceParameters) === null) add('sine.amplitude', `${part.ref} sine amplitude must be a valid ${quantity} or a declared parameter.`, part.id, 'sine.amplitude')
      const frequency = spiceSheetMagnitude(sine.frequency, 'frequency', sourceParameters)
      if (frequency === null || frequency <= 0) add('sine.frequency', `${part.ref} sine frequency must be positive.`, part.id, 'sine.frequency')
      const delay = spiceSheetTimeMagnitude(sine.delay, sourceParameters)
      if (delay === null || delay < 0) add('sine.delay', `${part.ref} sine delay must be a nonnegative time.`, part.id, 'sine.delay')
      const damping = spiceScalar(spiceSheetParameterDefault(sine.damping, sourceParameters) ?? sine.damping, '')
      if (damping === null || Number(damping) < 0) add('sine.damping', `${part.ref} sine damping must be nonnegative.`, part.id, 'sine.damping')
      if (spiceSheetScalar(sine.phase, sourceParameters) === null) add('sine.phase', `${part.ref} sine phase must be a numeric angle in degrees or a declared parameter.`, part.id, 'sine.phase')
    }
    for (const part of independentSources.filter((item) => item.sourceMode === 'exp')) {
      const quantity = part.kind === 'source' ? 'voltage' : 'current'
      const exp = { initial: '0', pulsed: part.value, riseDelay: '0', riseTau: '1u', fallDelay: '10m', fallTau: '1u', ...part.exp }
      if (spiceSheetValue(exp.initial, part.kind, sourceParameters) === null) add('exp.initial', `${part.ref} EXP initial level must be a valid ${quantity} or a declared parameter.`, part.id, 'exp.initial')
      if (spiceSheetValue(exp.pulsed, part.kind, sourceParameters) === null) add('exp.pulsed', `${part.ref} EXP pulsed level must be a valid ${quantity} or a declared parameter.`, part.id, 'exp.pulsed')
      const riseDelay = spiceSheetTimeMagnitude(exp.riseDelay, sourceParameters), riseTau = spiceSheetTimeMagnitude(exp.riseTau, sourceParameters), fallDelay = spiceSheetTimeMagnitude(exp.fallDelay, sourceParameters), fallTau = spiceSheetTimeMagnitude(exp.fallTau, sourceParameters)
      if (riseDelay === null || riseDelay < 0) add('exp.riseDelay', `${part.ref} EXP rise delay must be a nonnegative time.`, part.id, 'exp.riseDelay')
      if (riseTau === null || riseTau <= 0) add('exp.riseTau', `${part.ref} EXP rise time constant must be positive.`, part.id, 'exp.riseTau')
      if (fallDelay === null || fallDelay < 0 || riseDelay !== null && fallDelay < riseDelay) add('exp.fallDelay', `${part.ref} EXP fall delay must be nonnegative and no earlier than its rise delay.`, part.id, 'exp.fallDelay')
      if (fallTau === null || fallTau <= 0) add('exp.fallTau', `${part.ref} EXP fall time constant must be positive.`, part.id, 'exp.fallTau')
    }
    for (const part of independentSources.filter((item) => item.sourceMode === 'sffm')) {
      const quantity = part.kind === 'source' ? 'voltage' : 'current'
      const sffm = { offset: '0', amplitude: part.value, carrierFrequency: '1k', modulationIndex: '5', signalFrequency: '100', ...part.sffm }
      if (spiceSheetValue(sffm.offset, part.kind, sourceParameters) === null) add('sffm.offset', `${part.ref} SFFM offset must be a valid ${quantity} or a declared parameter.`, part.id, 'sffm.offset')
      if (spiceSheetValue(sffm.amplitude, part.kind, sourceParameters) === null) add('sffm.amplitude', `${part.ref} SFFM amplitude must be a valid ${quantity} or a declared parameter.`, part.id, 'sffm.amplitude')
      const carrier = spiceSheetMagnitude(sffm.carrierFrequency, 'frequency', sourceParameters), signal = spiceSheetMagnitude(sffm.signalFrequency, 'frequency', sourceParameters), index = spiceScalar(spiceSheetParameterDefault(sffm.modulationIndex, sourceParameters) ?? sffm.modulationIndex, '')
      if (carrier === null || carrier <= 0) add('sffm.carrierFrequency', `${part.ref} SFFM carrier frequency must be positive.`, part.id, 'sffm.carrierFrequency')
      if (signal === null || signal <= 0) add('sffm.signalFrequency', `${part.ref} SFFM modulating frequency must be positive.`, part.id, 'sffm.signalFrequency')
      const modulationIndex = index === null ? null : Number(index)
      if (modulationIndex === null || !Number.isFinite(modulationIndex) || modulationIndex < 0 || carrier !== null && carrier > 0 && signal !== null && signal > 0 && modulationIndex > carrier / signal) add('sffm.modulationIndex', `${part.ref} SFFM modulation index must be from zero through carrier/modulating frequency.`, part.id, 'sffm.modulationIndex')
    }
    for (const part of independentSources.filter((item) => item.sourceMode === 'am')) {
      const quantity = part.kind === 'source' ? 'voltage' : 'current'
      const am = { offset: '0', modulationOffset: part.value, modulationAmplitude: part.value, modulationFrequency: '100 Hz', carrierFrequency: '1 kHz', delay: '0', modulationPhase: '0', carrierPhase: '0', ...part.am }
      for (const field of ['offset', 'modulationOffset', 'modulationAmplitude'] as const) {
        if (spiceSheetValue(am[field], part.kind, sourceParameters) === null) add(`am.${field}`, `${part.ref} AM ${field === 'offset' ? 'offset' : field === 'modulationOffset' ? 'modulation offset' : 'modulation amplitude'} must be a valid ${quantity} or a declared parameter.`, part.id, `am.${field}`)
      }
      for (const field of ['modulationFrequency', 'carrierFrequency'] as const) {
        const magnitude = spiceSheetMagnitude(am[field], 'frequency', sourceParameters)
        if (magnitude === null || magnitude <= 0) add(`am.${field}`, `${part.ref} AM ${field === 'carrierFrequency' ? 'carrier' : 'modulating'} frequency must be positive.`, part.id, `am.${field}`)
      }
      const delay = spiceSheetTimeMagnitude(am.delay, sourceParameters)
      if (delay === null || delay < 0) add('am.delay', `${part.ref} AM delay must be a nonnegative time.`, part.id, 'am.delay')
      for (const field of ['modulationPhase', 'carrierPhase'] as const) {
        if (spiceScalar(spiceSheetParameterDefault(am[field], sourceParameters) ?? am[field], '') === null) add(`am.${field}`, `${part.ref} AM phase must be numeric degrees or a declared parameter.`, part.id, `am.${field}`)
      }
    }
    for (const part of independentSources.filter((item) => item.sourceMode === 'trnoise')) {
      if (part.kind !== 'source') {
        add('trnoise.gaussianRms', `${part.ref} transient TRNOISE is supported only on voltage sources by ngspice.`, part.id, 'trnoise.gaussianRms')
        continue
      }
      const settings = { gaussianRms: '10n', timeStep: '1u', flickerExponent: '0', flickerAmplitude: '0', rtsAmplitude: '0', rtsCaptureTime: '1u', rtsEmissionTime: '1u', ...part.trnoise }
      const amplitudeValues = ['gaussianRms', 'flickerAmplitude', 'rtsAmplitude'] as const
      const amplitudes = Object.fromEntries(amplitudeValues.map((field) => {
        const token = spiceSheetValue(settings[field], 'source', sourceParameters)
        const magnitude = token === null ? null : spiceValueMagnitude(token)
        if (magnitude === null || magnitude < 0) add(`trnoise.${field}`, `${part.ref} ${field === 'gaussianRms' ? 'Gaussian RMS' : field === 'flickerAmplitude' ? 'flicker' : 'RTS'} noise amplitude must be a nonnegative voltage.`, part.id, `trnoise.${field}`)
        return [field, magnitude]
      })) as Record<(typeof amplitudeValues)[number], number | null>
      const timeStep = spiceSheetTimeMagnitude(settings.timeStep, sourceParameters)
      if (timeStep === null || timeStep < 0) add('trnoise.timeStep', `${part.ref} transient-noise sample interval must be a nonnegative time.`, part.id, 'trnoise.timeStep')
      const noiseEnabled = amplitudeValues.some((field) => (amplitudes[field] ?? 0) > 0)
      if (noiseEnabled && timeStep === 0) add('trnoise.timeStep', `${part.ref} needs a positive transient-noise sample interval when a noise amplitude is nonzero.`, part.id, 'trnoise.timeStep')
      const exponentText = spiceScalar(spiceSheetParameterDefault(settings.flickerExponent, sourceParameters) ?? settings.flickerExponent, '')
      const exponent = exponentText === null ? null : Number(exponentText)
      if (exponent === null || !Number.isFinite(exponent) || exponent < 0 || exponent > 2 || (amplitudes.flickerAmplitude ?? 0) > 0 && (exponent <= 0 || exponent >= 2)) add('trnoise.flickerExponent', `${part.ref} flicker exponent must be from 0 through 2, and strictly between 0 and 2 when flicker noise is enabled.`, part.id, 'trnoise.flickerExponent')
      for (const [field, value] of [['rtsCaptureTime', settings.rtsCaptureTime], ['rtsEmissionTime', settings.rtsEmissionTime]] as const) {
        const time = spiceSheetTimeMagnitude(value, sourceParameters)
        const positiveRequired = (amplitudes.rtsAmplitude ?? 0) > 0
        if (time === null || time < 0 || positiveRequired && time <= 0) add(`trnoise.${field}`, `${part.ref} RTS ${field === 'rtsCaptureTime' ? 'capture' : 'emission'} time must be ${positiveRequired ? 'positive' : 'nonnegative'}.`, part.id, `trnoise.${field}`)
      }
    }
    for (const part of independentSources.filter((item) => item.sourceMode === 'pwl')) {
      const quantity = part.kind === 'source' ? 'voltage' : 'current'
      const points = part.kind === 'source' ? part.pwl : part.currentPwl
      if (!points || points.length < 2 || points.length > MAX_SOURCE_PWL_POINTS) {
        const settingPath = points && points.length > MAX_SOURCE_PWL_POINTS ? `${part.kind === 'source' ? 'pwl' : 'currentPwl'}.0.time` : `${part.kind === 'source' ? 'pwl' : 'currentPwl'}.points`
        add('pwlPoints', `${part.ref} PWL source needs between 2 and ${MAX_SOURCE_PWL_POINTS} points.`, part.id, settingPath)
        continue
      }
      const pointValues = points.map((point) => 'voltage' in point
        ? { time: point.time, voltage: spiceSheetParameterDefault(point.voltage, sourceParameters) ?? point.voltage }
        : { time: point.time, current: spiceSheetParameterDefault(point.current, sourceParameters) ?? point.current })
      const pointErrors = validateSourcePwlPoints(pointValues, quantity)
      const errorIndex = pointErrors?.findIndex((error) => error !== null) ?? -1
      if (errorIndex >= 0) {
        const pointIndex = Math.floor(errorIndex / 2)
        const valueField = errorIndex % 2 === 1
        const fieldName = part.kind === 'source' ? 'pwl' : 'currentPwl'
        add('pwlPoints', `${part.ref} ${pointErrors![errorIndex]}`, part.id, `${fieldName}.${pointIndex}.${valueField ? quantity : 'time'}`)
      }
      if (part.pwlRepeatCount !== undefined) {
        const maximum = Math.floor((MAX_FINITE_PWL_POINTS - points.length) / (points.length - 1)) + 1
        if (!Number.isInteger(part.pwlRepeatCount) || part.pwlRepeatCount < 1 || part.pwlRepeatCount > 31 || part.pwlRepeatCount > maximum) {
          add('pwlPoints', `${part.ref} finite PWL repeat count exceeds the ${MAX_FINITE_PWL_POINTS}-point expanded-table limit.`, part.id, 'pwl.repeatCount')
        } else {
          const boundary = validateSourcePwlRepeatBoundary(pointValues, part.pwlRepeatCount, quantity)
          if (boundary) add('pwlPoints', `${part.ref} ${boundary}`, part.id, 'pwl.repeatCount')
        }
      }
    }
  } else if (project.simulation.analysis === 'noise') {
    const sweep = project.simulation.noiseSweep ?? { outputNode: '', inputSource: '', scale: 'dec' as const, points: 10, startFrequency: '1 Hz', stopFrequency: '1 MHz' }
    const resolved = connectivity ?? analyzeConnectivity(project)
    const output = project.netLabels.find((label) => label.name.toLowerCase() === sweep.outputNode.trim().toLowerCase())
    if (!output || resolved.labelNets.get(output.id) === '0') add('noiseOutput', 'Choose a labeled non-ground output node for noise analysis.')
    if (!independentSources.some((part) => part.ref.toLowerCase() === sweep.inputSource.trim().toLowerCase())) add('noiseSource', 'Choose an independent voltage or current source as the noise input.')
    if (!['dec', 'oct', 'lin'].includes(sweep.scale)) add('noiseScale', 'Choose a decade, octave, or linear noise sweep.')
    if (!Number.isInteger(sweep.points) || sweep.points < 1 || sweep.points > 10000) add('noisePoints', 'Enter from 1 to 10,000 noise points per decade/octave or total linear points.')
    const start = spiceMagnitude(sweep.startFrequency, 'frequency'), stop = spiceMagnitude(sweep.stopFrequency, 'frequency')
    if (start === null || start <= 0) add('noiseStartFrequency', 'Enter a positive start frequency, such as 1 Hz.')
    if (stop === null || stop <= 0 || start !== null && stop <= start) add('noiseStopFrequency', 'Stop frequency must be greater than the start frequency.')
  } else if (project.simulation.analysis === 'ac') {
    for (const part of independentSources) {
      const unit = part.kind === 'source' ? 'source' : 'currentSource'
      const magnitudeText = part.acMagnitude ?? (part.kind === 'source' ? project.simulation.sourceAcMagnitude ?? '1 V' : part.value)
      const magnitude = spiceNumber(magnitudeText, unit)
      const magnitudeValue = spiceMagnitude(magnitudeText, part.kind === 'source' ? 'voltage' : 'current')
      if (magnitude === null || magnitudeValue === null || magnitudeValue < 0) add('partAcMagnitude', `${part.ref} AC magnitude must be a valid nonnegative ${part.kind === 'source' ? 'voltage' : 'current'} value.`, part.id)
      const phase = spiceScalar(part.acPhase ?? '0', '')
      if (phase === null || !Number.isFinite(Number(phase))) add('partAcPhase', `${part.ref} AC phase must be a finite numeric value in degrees.`, part.id)
    }
    const sweep = project.simulation.acSweep ?? { scale: 'dec' as const, points: 20, startFrequency: '10 Hz', stopFrequency: '1 MHz' }
    if (!['dec', 'oct', 'lin'].includes(sweep.scale)) add('acScale', 'Choose a supported sweep scale.')
    const pointDescription = sweep.scale === 'lin' ? 'total points in the sweep' : `points per ${sweep.scale === 'oct' ? 'octave' : 'decade'}`
    if (!Number.isInteger(sweep.points) || sweep.points < 1 || sweep.points > 10000) add('acPoints', `Enter from 1 to 10,000 ${pointDescription}.`)
    const start = spiceMagnitude(sweep.startFrequency, 'frequency')
    const stop = spiceMagnitude(sweep.stopFrequency, 'frequency')
    if (start === null || start <= 0) add('acStartFrequency', 'Enter a positive start frequency, such as 10 Hz.')
    if (stop === null || stop <= 0 || (start !== null && stop <= start)) add('acStopFrequency', 'Stop frequency must be greater than the start frequency.')
  } else if (project.simulation.analysis === 'dc') {
    const sweep = project.simulation.dcSweep ?? { source: 'V1', start: '0 V', stop: '5 V', step: '0.1 V' }
    const source = independentSources.find((part) => part.ref.toLowerCase() === sweep.source.toLowerCase())
    if (!source) add('dcSource', 'Choose an existing independent voltage or current source.')
    const quantity = source?.kind === 'currentSource' ? 'current' : 'voltage'
    const quantityName = quantity === 'current' ? 'current' : 'voltage'
    const unit = quantity === 'current' ? 'A' : 'V'
    const start = spiceMagnitude(sweep.start, quantity)
    const stop = spiceMagnitude(sweep.stop, quantity)
    const step = spiceMagnitude(sweep.step, quantity)
    if (start === null) add('dcStart', `Enter a valid start ${quantityName}, such as 0 ${unit}.`)
    if (stop === null) add('dcStop', `Enter a valid stop ${quantityName}, such as ${quantity === 'current' ? '10 mA' : '5 V'}.`)
    if (step === null || step === 0) add('dcStep', `Enter a nonzero ${quantityName} step, such as ${quantity === 'current' ? '1 mA' : '0.1 V'}.`)
    else if (start !== null && stop !== null && (stop - start) * step < 0) add('dcStep', `Step direction must lead from the start ${quantityName} to the stop ${quantityName}.`)
    const pointCount = source ? dcSweepPointCount(sweep.start, sweep.stop, sweep.step, source.kind === 'currentSource' ? 'currentSource' : 'source') : null
    if (pointCount !== null && pointCount > MAX_DC_SWEEP_POINTS) add('dcStep', `DC sweep is limited to ${MAX_DC_SWEEP_POINTS.toLocaleString()} points. Increase the step size or narrow the range.`)
  }
  return errors
}
