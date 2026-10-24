export type BehavioralReferences = { nodes: string[]; differentialNodes: string[]; components: string[]; parameters?: string[] }
export type BehavioralFunctionDefinition = { name: string; arguments: string[]; expression: string }
export type BehavioralDialect = 'ngspice' | 'ltspice'

/** ngspice B-source and par() expressions expose voltage-source branch current via I(Vname). */
export function behavioralCurrentReferences(expression: string): string[] {
  return [...expression.matchAll(/\bi\s*\(\s*([A-Za-z_][A-Za-z0-9_.$]*)\s*\)/gi)].map((match) => match[1])
}

export function ngspiceVoltageBranchReferences(parts: readonly { kind: string; ref: string; behavioralOutput?: string }[]): string[] {
  return parts.filter((part) => part.kind === 'source' || part.kind === 'vcvs' || part.kind === 'ccvs' || (part.kind === 'behavioral' && part.behavioralOutput === 'voltage')).map((part) => part.ref)
}

/** Return the first I() reference that ngspice cannot resolve as a branch current. */
export function unsupportedBehavioralCurrentReference(expression: string, voltageSourceRefs: readonly string[]): string | undefined {
  const supported = new Set(voltageSourceRefs.map((ref) => ref.toLowerCase()))
  return behavioralCurrentReferences(expression).find((ref) => !supported.has(ref.toLowerCase()))
}

export function behavioralCurrentReferenceError(ref: string): string {
  return `I(${ref}) is not a supported ngspice expression current; use I() with a voltage-source reference.`
}

const ngspiceFunctions = new Map<string, { min: number; max: number }>([
  ...['sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'arctan', 'sinh', 'cosh', 'tanh', 'asinh', 'acosh', 'atanh', 'exp', 'ln', 'log', 'log10', 'abs', 'sqrt', 'floor', 'ceil', 'u', 'u2', 'uramp'].map((name) => [name, { min: 1, max: 1 }] as const),
  ...['min', 'max', 'pow', 'pwr'].map((name) => [name, { min: 2, max: 2 }] as const),
])

// LTspice B-source helpers are translated to native ngspice expressions. Do
// not accept these in the native dialect: several have different semantics or
// are not ngspice B-source functions at all.
const ltspiceOnlyFunctions = new Map<string, { min: number; max: number }>([
  ['if', { min: 3, max: 3 }],
  ['limit', { min: 3, max: 3 }],
  ...['arcsin', 'arccos', 'cbrt', 'buf', 'inv', 'int', 'square'].map((name) => [name, { min: 1, max: 1 }] as const),
  ...['pwrs', 'atan2', 'mod', 'xor', 'hypot'].map((name) => [name, { min: 2, max: 2 }] as const),
])

// These are native ngspice B-source built-ins, not LTspice expression helpers.
const ngspiceOnlyFunctions = new Map<string, { min: number; max: number }>([
  ['nint', { min: 1, max: 1 }],
  ['sgn', { min: 1, max: 1 }],
  ['ternary_fcn', { min: 3, max: 3 }],
])

const engineeringScale: Record<string, number> = { meg: 1e6, t: 1e12, g: 1e9, k: 1e3, m: 1e-3, u: 1e-6, n: 1e-9, p: 1e-12, f: 1e-15 }
// Keep an ideal 0.5 result false despite ngspice solve roundoff at the decision boundary.
function ltspiceBooleanCondition(value: string): string {
  return `((${value}) - 0.5) > 1e-12`
}

function booleanXorExpression(left: string, right: string): string {
  return `((${left} && !(${right})) || (!(${left}) && ${right}))`
}

/** Split only top-level Boolean operators; function arguments and parenthesized terms stay intact. */
function splitTopLevelBoolean(expression: string, operator: '&' | '|' | '^'): string[] {
  const parts: string[] = []
  let depth = 0
  let start = 0
  for (let index = 0; index < expression.length; index += 1) {
    if (expression[index] === '(') depth += 1
    else if (expression[index] === ')') depth -= 1
    else if (depth === 0 && expression[index] === operator && expression[index + 1] !== operator && expression[index - 1] !== operator) {
      parts.push(expression.slice(start, index).trim())
      start = index + 1
    }
  }
  if (parts.length) parts.push(expression.slice(start).trim())
  return parts
}

function translateBooleanBinaryOperators(expression: string, dialect: BehavioralDialect): string | null {
  if (dialect === 'ltspice') {
    for (const operator of ['&', '|', '^'] as const) {
      const terms = splitTopLevelBoolean(expression, operator)
      if (terms.length < 2) continue
      const booleans = terms.map((term) => ltspiceBooleanCondition(translateBehavioralExpression(term, dialect)))
      if (operator === '^') return booleans.slice(1).reduce(booleanXorExpression, booleans[0])
      return `(${booleans.join(operator === '&' ? ' && ' : ' || ')})`
    }
  }
  let output = ''
  let changed = false
  for (let index = 0; index < expression.length; index += 1) {
    if (expression[index] !== '(') { output += expression[index]; continue }
    let depth = 1
    let close = index + 1
    for (; close < expression.length && depth > 0; close += 1) {
      if (expression[close] === '(') depth += 1
      else if (expression[close] === ')') depth -= 1
    }
    if (depth !== 0) return null
    const inner = expression.slice(index + 1, close - 1)
    if (!/[&|^]/.test(inner)) { output += expression.slice(index, close); index = close - 1; continue }
    const translatedInner = translateBooleanBinaryOperators(inner, dialect)
    if (translatedInner === null) output += expression.slice(index, close)
    else { output += `(${translatedInner})`; changed = true }
    index = close - 1
  }
  if (changed) return output
  return null
}

function translateBooleanInversions(expression: string, dialect: BehavioralDialect): string {
  if (dialect === 'ngspice') return expression
  let output = expression
  for (let index = 0; index < output.length; index += 1) {
    const operator = output[index]
    if ((operator !== '!' && operator !== '~') || (operator === '!' && output[index + 1] === '=')) continue
    let previous = index - 1
    while (previous >= 0 && /\s/.test(output[previous])) previous -= 1
    if (previous >= 0 && !/[([{,:?=<>!&|+\-*\/%^]/.test(output[previous])) continue

    let start = index + 1
    while (start < output.length && /\s/.test(output[start])) start += 1
    let end = start
    if (output[end] === '(') {
      let depth = 1
      end += 1
      while (end < output.length && depth > 0) {
        if (output[end] === '(') depth += 1
        else if (output[end] === ')') depth -= 1
        end += 1
      }
      if (depth !== 0) throw new Error('Boolean inversion is missing a closing parenthesis.')
    } else {
      if (output[end] === '+' || output[end] === '-') end += 1
      const token = output.slice(end).match(/^[A-Za-z_][A-Za-z0-9_.$]*|^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?(?:meg|[tgkmunpf])?/i)
      if (!token) throw new Error('Boolean inversion requires a value or parenthesized expression.')
      end += token[0].length
      if (/^[A-Za-z_]/.test(token[0])) {
        let afterName = end
        while (afterName < output.length && /\s/.test(output[afterName])) afterName += 1
        if (output[afterName] === '(') {
          let depth = 1
          end = afterName + 1
          while (end < output.length && depth > 0) {
            if (output[end] === '(') depth += 1
            else if (output[end] === ')') depth -= 1
            end += 1
          }
          if (depth !== 0) throw new Error('Boolean inversion is missing a closing parenthesis.')
        }
      }
    }
    const operand = translateBehavioralExpression(output.slice(start, end).trim(), dialect)
    output = `${output.slice(0, index)}(${ltspiceBooleanCondition(operand)} ? 0 : 1)${output.slice(end)}`
    index += 1
  }
  return output
}

/** LTspice logical operators normalize both operands at the 0.5 threshold. */
function remainderExpression(value: string, divisor: string): string {
  const quotient = `((${value}) / (${divisor}))`
  return `((${value}) - (sgn(${quotient}) * floor(abs(${quotient})) * (${divisor})))`
}

function previousOperandStart(expression: string, end: number): number {
  while (end > 0 && /\s/.test(expression[end - 1])) end -= 1
  let start: number
  if (expression[end - 1] === ')') {
    let depth = 1
    start = end - 2
    while (start >= 0 && depth > 0) {
      if (expression[start] === ')') depth += 1
      else if (expression[start] === '(') depth -= 1
      start -= 1
    }
    if (depth !== 0) throw new Error('The left side of the % remainder operator has an unmatched parenthesis.')
    start += 1
    const beforeCall = expression.slice(0, start).match(/[A-Za-z_][A-Za-z0-9_.$]*\s*$/)
    if (beforeCall) start -= beforeCall[0].length
  } else {
    const token = expression.slice(0, end).match(/[A-Za-z_][A-Za-z0-9_.$]*|(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?(?:meg|[tgkmunpf])?\s*$/i)
    if (!token) throw new Error('The left side of the % remainder operator must be a value.')
    start = end - token[0].length
  }
  let before = start
  while (before > 0 && /\s/.test(expression[before - 1])) before -= 1
  if ((expression[before - 1] === '+' || expression[before - 1] === '-') && (before - 1 === 0 || /[([{,:?=<>!&|+\-*\/%^]/.test(expression[before - 2] ?? ''))) start = before - 1
  return start
}

/** Rewrite LTspice's remainder operator because the pinned ngspice B-source parser rejects `%`. */
function translateRemainderOperators(expression: string): string {
  let output = expression
  while (true) {
    const operator = output.indexOf('%')
    if (operator < 0) return output
    let leftEnd = operator
    while (leftEnd > 0 && /\s/.test(output[leftEnd - 1])) leftEnd -= 1
    let leftStart = previousOperandStart(output, leftEnd)
    let prefixEnd = leftStart
    while (prefixEnd > 0 && /\s/.test(output[prefixEnd - 1])) prefixEnd -= 1
    while (output[prefixEnd - 1] === '*' || output[prefixEnd - 1] === '/') {
      leftStart = previousOperandStart(output, prefixEnd - 1)
      prefixEnd = leftStart
      while (prefixEnd > 0 && /\s/.test(output[prefixEnd - 1])) prefixEnd -= 1
    }

    let rightStart = operator + 1
    while (rightStart < output.length && /\s/.test(output[rightStart])) rightStart += 1
    const signStart = rightStart
    if (output[rightStart] === '+' || output[rightStart] === '-') rightStart += 1
    let rightEnd: number
    if (output[rightStart] === '(') {
      let depth = 1
      rightEnd = rightStart + 1
      while (rightEnd < output.length && depth > 0) {
        if (output[rightEnd] === '(') depth += 1
        else if (output[rightEnd] === ')') depth -= 1
        rightEnd += 1
      }
      if (depth !== 0) throw new Error('The right side of the % remainder operator has an unmatched parenthesis.')
    } else {
      const token = output.slice(rightStart).match(/^[A-Za-z_][A-Za-z0-9_.$]*|^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?(?:meg|[tgkmunpf])?/i)
      if (!token) throw new Error('The right side of the % remainder operator must be a value.')
      rightEnd = rightStart + token[0].length
      if (/^[A-Za-z_]/.test(token[0])) {
        let afterName = rightEnd
        while (afterName < output.length && /\s/.test(output[afterName])) afterName += 1
        if (output[afterName] === '(') {
          let depth = 1
          rightEnd = afterName + 1
          while (rightEnd < output.length && depth > 0) {
            if (output[rightEnd] === '(') depth += 1
            else if (output[rightEnd] === ')') depth -= 1
            rightEnd += 1
          }
          if (depth !== 0) throw new Error('The right side of the % remainder operator has an unmatched parenthesis.')
        }
      }
    }
    const left = translateRemainderOperators(output.slice(leftStart, leftEnd).trim())
    const right = translateRemainderOperators(output.slice(signStart, rightEnd).trim())
    output = `${output.slice(0, leftStart)}${remainderExpression(left, right)}${output.slice(rightEnd)}`
  }
}

function tableScalar(token: Token): number | null {
  if (token.kind !== 'number') return null
  const match = token.text.match(/^([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)(meg|[tgkmunpf])?$/i)
  if (!match) return null
  const value = Number(match[1]) * (engineeringScale[match[2]?.toLowerCase() ?? ''] ?? 1)
  return Number.isFinite(value) ? value : null
}

function tableArgumentScalar(tokens: Token[]): number | null {
  if (tokens.length === 1) return tableScalar(tokens[0])
  if (tokens.length === 2 && (tokens[0].text === '+' || tokens[0].text === '-') && tokens[1].kind === 'number') {
    const value = tableScalar(tokens[1])
    return value === null ? null : tokens[0].text === '-' ? -value : value
  }
  return null
}

type Token = { kind: 'number' | 'identifier' | 'operator'; text: string }

export function parseBehavioralExpression(expression: string, dialect: BehavioralDialect = 'ngspice'): { references: BehavioralReferences } {
  if (expression.length === 0 || expression.length > 256 || /[\r\n;{}'"`\\#]/.test(expression)) throw new Error('Use one expression up to 256 characters. Newlines, directives, quotes, braces, and comments are not allowed.')
  const tokens: Token[] = []
  let offset = 0
  const tokenPattern = /\s+|(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?(?:meg|[tgkmunpf])?|[A-Za-z_][A-Za-z0-9_.$]*|<=|>=|==|!=|<>|\*\*|&&|\|\||[()+\-*/%^<>,?:!~&|]/iy
  while (offset < expression.length) {
    tokenPattern.lastIndex = offset
    const match = tokenPattern.exec(expression)
    if (!match) throw new Error(`Unsupported character at position ${offset + 1}.`)
    offset = tokenPattern.lastIndex
    const text = match[0]
    if (/^\s+$/.test(text)) continue
    const kind = /^[A-Za-z_]/.test(text) ? 'identifier' : /^[\d.]/.test(text) ? 'number' : 'operator'
    tokens.push({ kind, text })
  }
  let cursor = 0
  const nodes = new Set<string>(), differentialNodes = new Set<string>(), components = new Set<string>(), parameters = new Set<string>()
  const peek = (text?: string) => text === undefined ? tokens[cursor] : tokens[cursor]?.text === text
  const take = (text?: string) => {
    const token = tokens[cursor]
    if (!token || (text !== undefined && token.text !== text)) throw new Error(`Expected ${text ?? 'an expression'} near “${token?.text ?? 'end'}”.`)
    cursor += 1
    return token
  }
  const parsePrimary = (): void => {
    if (peek('(')) { take('('); parseConditional(); take(')'); return }
    const token = take()
    if (token.kind === 'number') return
    if (token.kind !== 'identifier') throw new Error(`Expected a number, reference, or function near “${token.text}”.`)
    const name = token.text.toLowerCase()
    if (!peek('(')) {
      if (!['pi', 'time', 'temper', 'hertz'].includes(name)) parameters.add(token.text)
      return
    }
    take('(')
    if (name === 'v' || name === 'i') {
      const reference = take()
      if (reference.kind !== 'identifier' && reference.kind !== 'number') throw new Error(`${name.toUpperCase()}() requires a node or component reference.`)
      if (name === 'v' && peek(',')) differentialNodes.add(reference.text)
      else if (name === 'v') nodes.add(reference.text)
      else components.add(reference.text)
      if (name === 'v' && peek(',')) {
        take(',')
        const second = take()
        if (second.kind !== 'identifier' && second.kind !== 'number') throw new Error('V(node1,node2) requires node names.')
        differentialNodes.add(second.text)
      }
      take(')')
      return
    }
    const piecewiseSignature = (name === 'pwl' && dialect === 'ngspice') || (name === 'table' && dialect === 'ltspice') ? { min: 5, max: 513 } : undefined
    const signature = ngspiceFunctions.get(name)
      ?? (dialect === 'ltspice' ? ltspiceOnlyFunctions.get(name) : ngspiceOnlyFunctions.get(name))
      ?? piecewiseSignature
    if (!signature) {
      if (dialect === 'ngspice' && name === 'sqr') throw new Error('sqr() is not available in native ngspice B-source expressions; write the value as x * x, for example V(in) * V(in).')
      throw new Error(`Function “${token.text}” is not supported.`)
    }
    let count = 0
    const argumentsTokens: Token[][] = []
    if (!peek(')')) {
      do {
        if (count > 0) take(',')
        const start = cursor
        parseConditional()
        argumentsTokens.push(tokens.slice(start, cursor))
        count += 1
      } while (peek(','))
    }
    take(')')
    if ((name === 'table' && dialect === 'ltspice') || (name === 'pwl' && dialect === 'ngspice')) {
      const functionName = name
      if (count % 2 !== 1 || count < 5) throw new Error(`${functionName}() expects an input followed by at least two x,y point pairs.`)
      const points = argumentsTokens.slice(1)
      const isSingleParameter = (argument: Token[]) => argument.length === 1 && argument[0].kind === 'identifier' && !['pi', 'time', 'temper', 'hertz'].includes(argument[0].text.toLowerCase())
      if (name === 'table' && points.some((argument) => tableArgumentScalar(argument) === null)) throw new Error('table() breakpoints and values must be numeric literals; parameters and expressions are not supported.')
      if (name === 'pwl' && points.some((argument) => tableArgumentScalar(argument) === null && !isSingleParameter(argument))) throw new Error('pwl() breakpoints and values must be numeric literals or parameter names.')
      let previous = -Infinity
      for (let index = 0; index < points.length; index += 2) {
        const x = tableArgumentScalar(points[index])
        if (x !== null) {
          if (x <= previous) throw new Error(`${functionName}() x breakpoints must be strictly increasing.`)
          previous = x
        } else previous = -Infinity
      }
    }
    if (count < signature.min || count > signature.max) throw new Error(`${token.text}() expects ${signature.min === signature.max ? signature.min : `${signature.min} or ${signature.max}`} argument${signature.max === 1 ? '' : 's'}.`)
  }
  const parseUnary = (): void => {
    if (peek('~') && dialect === 'ngspice') throw new Error('The unary ~ operator is supported only in the LTspice behavioral dialect; use ! for native ngspice.')
    if (peek('+') || peek('-') || peek('!') || peek('~')) { take(); parseUnary() } else parsePrimary()
  }
  const parsePower = (): void => { parseUnary(); if (peek('^') || peek('**')) { take(); parsePower() } }
  const parseProduct = (): void => { parsePower(); while (peek('*') || peek('/') || (dialect === 'ltspice' && peek('%'))) { take(); parsePower() } }
  const parseSum = (): void => { parseProduct(); while (peek('+') || peek('-')) { take(); parseProduct() } }
  const parseCompare = (): void => { parseSum(); while (['<', '>', '<=', '>=', '==', '!=', '<>'].some((op) => peek(op))) { take(); parseSum() } }
  const andOperator = dialect === 'ltspice' ? '&' : '&&'
  const orOperator = dialect === 'ltspice' ? '|' : '||'
  const parseLogicalAnd = (): void => { parseCompare(); while (peek(andOperator)) { take(andOperator); parseCompare() } }
  const parseLogical = (): void => { parseLogicalAnd(); while (peek(orOperator)) { take(orOperator); parseLogicalAnd() } }
  const parseConditional = (): void => { parseLogical(); if (peek('?')) { take('?'); parseConditional(); take(':'); parseConditional() } }
  parseConditional()
  if (cursor !== tokens.length) throw new Error(`Unexpected token “${tokens[cursor].text}”.`)
  return { references: { nodes: [...nodes], differentialNodes: [...differentialNodes], components: [...components], ...(parameters.size ? { parameters: [...parameters] } : {}) } }
}

/** Translate supported LTspice B-source helpers to equivalent ngspice expressions. */
export function translateBehavioralExpression(expression: string, dialect: BehavioralDialect = 'ngspice'): string {
  // Native B-source syntax is already ngspice syntax. Preserve it byte-for-byte;
  // only parsed LTspice expressions need dialect translation.
  if (dialect === 'ngspice') return expression
  const translatedBoolean = translateBooleanBinaryOperators(expression, dialect)
  if (translatedBoolean !== null) return translatedBoolean
  expression = translateRemainderOperators(expression)
  expression = translateBooleanInversions(expression, dialect)
  let output = ''
  let cursor = 0
  const translatableFunctionPattern = /\b(table|if|limit|mod|pwrs|xor|int|square|buf|inv|arccos|arcsin|arctan|atan2|cbrt|hypot|u)\s*\(/ig
  while (cursor < expression.length) {
    translatableFunctionPattern.lastIndex = cursor
    const found = translatableFunctionPattern.exec(expression)
    if (!found) { output += expression.slice(cursor); break }
    output += expression.slice(cursor, found.index)
    const open = expression.indexOf('(', found.index)
    let depth = 1
    let close = open + 1
    for (; close < expression.length && depth > 0; close += 1) {
      if (expression[close] === '(') depth += 1
      else if (expression[close] === ')') depth -= 1
    }
    if (depth !== 0) throw new Error('Behavioral function is missing a closing parenthesis.')
    const body = expression.slice(open + 1, close - 1)
    const args: string[] = []
    let start = 0, nested = 0
    for (let index = 0; index < body.length; index += 1) {
      if (body[index] === '(') nested += 1
      else if (body[index] === ')') nested -= 1
      else if (body[index] === ',' && nested === 0) { args.push(body.slice(start, index).trim()); start = index + 1 }
    }
    args.push(body.slice(start).trim())
    // Recurse into the input expression so nested table calls are supported.
    const input = translateBehavioralExpression(args[0] ?? '', dialect)
    if (found[1].toLowerCase() === 'if') {
      if (args.length !== 3) throw new Error('if() expects a condition, a true value, and a false value.')
      output += `(${ltspiceBooleanCondition(input)} ? ${translateBehavioralExpression(args[1], dialect)} : ${translateBehavioralExpression(args[2], dialect)})`
      cursor = close
      if (output.length > 4096) throw new Error('Translated behavioral expression exceeds 4,096 characters.')
      continue
    }
    if (found[1].toLowerCase() === 'buf' || found[1].toLowerCase() === 'inv') {
      if (args.length !== 1) throw new Error(`${found[1]}() expects one argument.`)
      const value = translateBehavioralExpression(args[0], dialect)
      output += found[1].toLowerCase() === 'buf' ? `(${ltspiceBooleanCondition(value)} ? 1 : 0)` : `(${ltspiceBooleanCondition(value)} ? 0 : 1)`
      cursor = close
      if (output.length > 4096) throw new Error('Translated behavioral expression exceeds 4,096 characters.')
      continue
    }
    if (found[1].toLowerCase() === 'u') {
      if (args.length !== 1) throw new Error('u() expects one argument.')
      const value = translateBehavioralExpression(args[0], dialect)
      output += dialect === 'ltspice' ? `((${value}) > 0 ? 1 : 0)` : `u(${value})`
      cursor = close
      if (output.length > 4096) throw new Error('Translated behavioral expression exceeds 4,096 characters.')
      continue
    }
    if (found[1].toLowerCase() === 'limit') {
      if (args.length !== 3) throw new Error('limit() expects a value, lower bound, and upper bound.')
      const [value, low, high] = args.map((argument) => translateBehavioralExpression(argument, dialect))
      output += `min(max(${value}, ${low}), ${high})`
      cursor = close
      if (output.length > 4096) throw new Error('Translated behavioral expression exceeds 4,096 characters.')
      continue
    }
    if (found[1].toLowerCase() === 'mod') {
      if (args.length !== 2) throw new Error('mod() expects a value and divisor.')
      const value = translateBehavioralExpression(args[0], dialect)
      const divisor = translateBehavioralExpression(args[1], dialect)
      output += remainderExpression(value, divisor)
      cursor = close
      if (output.length > 4096) throw new Error('Translated behavioral expression exceeds 4,096 characters.')
      continue
    }
    if (found[1].toLowerCase() === 'pwrs') {
      if (args.length !== 2) throw new Error('pwrs() expects a value and exponent.')
      const value = translateBehavioralExpression(args[0], dialect)
      const exponent = translateBehavioralExpression(args[1], dialect)
      output += `pwr(${value}, ${exponent})`
      cursor = close
      if (output.length > 4096) throw new Error('Translated behavioral expression exceeds 4,096 characters.')
      continue
    }
    if (found[1].toLowerCase() === 'xor') {
      if (args.length !== 2) throw new Error('xor() expects two Boolean values.')
      const left = ltspiceBooleanCondition(translateBehavioralExpression(args[0], dialect))
      const right = ltspiceBooleanCondition(translateBehavioralExpression(args[1], dialect))
      output += booleanXorExpression(left, right)
      cursor = close
      if (output.length > 4096) throw new Error('Translated behavioral expression exceeds 4,096 characters.')
      continue
    }
    if (found[1].toLowerCase() === 'int') {
      if (args.length !== 1) throw new Error('int() expects one argument.')
      const value = translateBehavioralExpression(args[0], dialect)
      output += `(sgn(${value}) * floor(abs(${value})))`
      cursor = close
      if (output.length > 4096) throw new Error('Translated behavioral expression exceeds 4,096 characters.')
      continue
    }
    if (found[1].toLowerCase() === 'square') {
      if (args.length !== 1) throw new Error('square() expects one argument.')
      const value = translateBehavioralExpression(args[0], dialect)
      output += `((${value}) * (${value}))`
      cursor = close
      if (output.length > 4096) throw new Error('Translated behavioral expression exceeds 4,096 characters.')
      continue
    }
    const inverseAlias: Record<string, string> = { arccos: 'acos', arcsin: 'asin', arctan: 'atan' }
    if (inverseAlias[found[1].toLowerCase()]) {
      if (args.length !== 1) throw new Error(`${found[1]}() expects one argument.`)
      output += `${inverseAlias[found[1].toLowerCase()]}(${translateBehavioralExpression(args[0], dialect)})`
      cursor = close
      if (output.length > 4096) throw new Error('Translated behavioral expression exceeds 4,096 characters.')
      continue
    }
    if (found[1].toLowerCase() === 'cbrt') {
      if (args.length !== 1) throw new Error('cbrt() expects one argument.')
      const value = `(${translateBehavioralExpression(args[0], dialect)})`
      output += `((${value} < 0) ? -pow(-${value}, 1/3) : pow(${value}, 1/3))`
      cursor = close
      if (output.length > 4096) throw new Error('Translated behavioral expression exceeds 4,096 characters.')
      continue
    }
    if (found[1].toLowerCase() === 'atan2') {
      if (args.length !== 2) throw new Error('atan2() expects y and x arguments.')
      const y = `(${translateBehavioralExpression(args[0], dialect)})`
      const x = `(${translateBehavioralExpression(args[1], dialect)})`
      const angle = `atan(${y} / ${x})`
      output += `((${x} > 0) ? ${angle} : ((${x} < 0) ? ((${y} > 0) ? ${angle} + pi : ((${y} < 0) ? ${angle} - pi : pi)) : ((${y} > 0) ? pi/2 : ((${y} < 0) ? -pi/2 : 0))))`
      cursor = close
      if (output.length > 4096) throw new Error('Translated behavioral expression exceeds 4,096 characters.')
      continue
    }
    if (found[1].toLowerCase() === 'hypot') {
      if (args.length !== 2) throw new Error('hypot() expects two arguments.')
      const x = `(${translateBehavioralExpression(args[0], dialect)})`
      const y = `(${translateBehavioralExpression(args[1], dialect)})`
      const scale = `max(abs(${x}), abs(${y}))`
      output += `((${scale} > 0) ? (${scale} * sqrt(pow(${x} / ${scale}, 2) + pow(${y} / ${scale}, 2))) : 0)`
      cursor = close
      if (output.length > 4096) throw new Error('Translated behavioral expression exceeds 4,096 characters.')
      continue
    }
    if (args.length < 5 || args.length % 2 !== 1 || args.slice(1).some((arg) => !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?(?:meg|[tgkmunpf])?$/i.test(arg))) throw new Error('table() requires an input followed by at least two literal numeric x,y point pairs.')
    const xs = args.slice(1).filter((_, index) => index % 2 === 0).map((value) => {
      const parsed = value.match(/^([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)(meg|[tgkmunpf])?$/i)!
      return Number(parsed[1]) * (engineeringScale[parsed[2]?.toLowerCase() ?? ''] ?? 1)
    })
    if (xs.some((value, index) => !Number.isFinite(value) || (index > 0 && value <= xs[index - 1]))) throw new Error('table() x breakpoints must be finite and strictly increasing numeric literals.')
    const points = args.slice(1).map((argument) => translateBehavioralExpression(argument, dialect)).join(', ')
    const firstY = args[2], lastY = args[args.length - 1]
    output += `((${input} < ${args[1]}) ? ${firstY} : ((${input} > ${args[args.length - 2]}) ? ${lastY} : pwl(${input}, ${points})))`
    cursor = close
    if (output.length > 4096) throw new Error('Translated behavioral expression exceeds 4,096 characters.')
  }
  return output
}

/** Inline bounded LTspice .func calls before validating/netlisting a schematic B source. */
export function expandBehavioralFunctions(expression: string, definitions: ReadonlyMap<string, BehavioralFunctionDefinition>): string {
  const expand = (source: string, stack: string[], depth: number): string => {
    if (depth > 16) throw new Error('User-defined behavioral functions exceed the 16-level expansion limit.')
    let output = ''
    let cursor = 0
    const callPattern = /\b([A-Za-z_][A-Za-z0-9_]*)\s*\(/g
    while (cursor < source.length) {
      callPattern.lastIndex = cursor
      const match = callPattern.exec(source)
      if (!match) { output += source.slice(cursor); break }
      const definition = definitions.get(match[1].toLowerCase())
      if (!definition) { output += source.slice(cursor, match.index + match[0].length); cursor = match.index + match[0].length; continue }
      output += source.slice(cursor, match.index)
      const open = source.indexOf('(', match.index)
      let nesting = 1
      let close = open + 1
      for (; close < source.length && nesting > 0; close += 1) {
        if (source[close] === '(') nesting += 1
        else if (source[close] === ')') nesting -= 1
      }
      if (nesting !== 0) throw new Error(`Function ${definition.name}() is missing a closing parenthesis.`)
      const body = source.slice(open + 1, close - 1)
      const args: string[] = []
      let start = 0, nested = 0
      for (let index = 0; index < body.length; index += 1) {
        if (body[index] === '(') nested += 1
        else if (body[index] === ')') nested -= 1
        else if (body[index] === ',' && nested === 0) { args.push(body.slice(start, index).trim()); start = index + 1 }
      }
      if (body.trim()) args.push(body.slice(start).trim())
      if (args.length !== definition.arguments.length) throw new Error(`Function ${definition.name}() expects ${definition.arguments.length} argument${definition.arguments.length === 1 ? '' : 's'}.`)
      const key = definition.name.toLowerCase()
      if (stack.includes(key)) throw new Error(`Recursive .func definition detected for ${definition.name}().`)
      const expandedArgs = args.map((argument) => expand(argument, stack, depth + 1))
      let functionBody = expand(definition.expression, [...stack, key], depth + 1)
      for (let index = 0; index < definition.arguments.length; index += 1) {
        const name = definition.arguments[index]
        const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        functionBody = functionBody.replace(new RegExp(`\\b${escaped}\\b`, 'gi'), (identifier, offset, full) => {
          const before = full.slice(0, offset)
          const after = full.slice(offset + identifier.length)
          if (/\b[vi]\s*\(\s*$/i.test(before) && /^\s*\)/.test(after)) return identifier
          if (/^\s*\(/.test(after)) return identifier
          return `(${expandedArgs[index]})`
        })
      }
      output += `(${functionBody})`
      cursor = close
      if (output.length + source.length - cursor > 4096) throw new Error('Expanded behavioral expression exceeds 4,096 characters.')
    }
    return output
  }
  return expand(expression, [], 0)
}

export function validateBehavioralReferences(references: BehavioralReferences, nodes: string[], componentRefs: string[], parameterNames: string[] = [], differentialNodeNames: string[] = nodes): void {
  for (const node of references.nodes) if (node !== '0' && !nodes.some((known) => known.toLowerCase() === node.toLowerCase())) throw new Error(`Behavioral source refers to unknown node “${node}”. Add a net label first.`)
  for (const node of references.differentialNodes) if (node !== '0' && !differentialNodeNames.some((known) => known.toLowerCase() === node.toLowerCase())) throw new Error(`Behavioral source refers to unknown node “${node}”. Connect the node to the circuit first.`)
  for (const component of references.components) if (!componentRefs.some((known) => known.toLowerCase() === component.toLowerCase())) throw new Error(`Behavioral source refers to unknown component “${component}”.`)
  for (const parameter of references.parameters ?? []) if (!parameterNames.some((known) => known.toLowerCase() === parameter.toLowerCase())) throw new Error(`Behavioral source refers to unknown parameter “${parameter}”. Declare it with .param first.`)
}
