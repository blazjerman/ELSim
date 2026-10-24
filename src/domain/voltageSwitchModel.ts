import { spiceModelParameterMagnitude } from './componentValue'

export type VoltageSwitchModelSource = {
  type: string
  conditional?: boolean
  parameters: readonly {
    name: string
    defaultValue: string
    defaultIsExpression?: boolean
    defaultVariesByCondition?: boolean
  }[]
}

export type NativeVoltageSwitchModel = { ron: string; roff: string; vt: string; vh: string }

/** Convert the numeric PSpice VSWITCH subset to ngspice's native SW model. */
export function translateVoltageSwitchModel(model: VoltageSwitchModelSource): NativeVoltageSwitchModel | null {
  if (model.type.toLowerCase() !== 'vswitch' || model.conditional || model.parameters.length !== 4) return null
  const values: Record<string, number> = {}
  for (const parameter of model.parameters) {
    const name = parameter.name.toLowerCase()
    if (!['von', 'voff', 'ron', 'roff'].includes(name) || Object.hasOwn(values, name) || parameter.defaultIsExpression || parameter.defaultVariesByCondition) return null
    const value = spiceModelParameterMagnitude(parameter.defaultValue)
    if (value === null) return null
    values[name] = value
  }
  const { von, voff, ron, roff } = values
  if (von < voff || ron <= 0 || roff <= ron) return null
  const scalar = (value: number) => String(Number(value.toPrecision(15)))
  return { ron: scalar(ron), roff: scalar(roff), vt: scalar(von / 2 + voff / 2), vh: scalar(von / 2 - voff / 2) }
}
