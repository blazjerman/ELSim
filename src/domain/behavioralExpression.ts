export type BehavioralReferences = { nodes: string[]; components: string[] }

const functions = new Map<string, { min: number; max: number }>([
  ...['sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'sinh', 'cosh', 'tanh', 'asinh', 'acosh', 'atanh', 'exp', 'ln', 'log', 'log10', 'abs', 'sqrt', 'floor', 'ceil', 'u', 'u2', 'uramp'].map((name) => [name, { min: 1, max: 1 }] as const),
  ...['min', 'max', 'pow', 'pwr'].map((name) => [name, { min: 2, max: 2 }] as const),
])

type Token = { kind: 'number' | 'identifier' | 'operator'; text: string }

export function parseBehavioralExpression(expression: string): { references: BehavioralReferences } {
  if (expression.length === 0 || expression.length > 256 || /[\r\n;{}'"`\\#]/.test(expression)) throw new Error('Use one expression up to 256 characters. Newlines, directives, quotes, braces, and comments are not allowed.')
  const tokens: Token[] = []
  let offset = 0
  const tokenPattern = /\s+|(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?(?:meg|[tgkmunpf])?|[A-Za-z_][A-Za-z0-9_.$]*|<=|>=|==|!=|<>|&&|\|\||[()+\-*/^<>,?:!]/iy
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
  const nodes = new Set<string>(), components = new Set<string>()
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
      if (!['pi', 'time', 'temper', 'hertz'].includes(name)) throw new Error(`Unknown symbol “${token.text}”. Use pi, time, temper, hertz, V(node), or I(component).`)
      return
    }
    take('(')
    if (name === 'v' || name === 'i') {
      const reference = take()
      if (reference.kind !== 'identifier' && reference.kind !== 'number') throw new Error(`${name.toUpperCase()}() requires a node or component reference.`)
      if (name === 'v') nodes.add(reference.text)
      else components.add(reference.text)
      if (name === 'v' && peek(',')) {
        take(',')
        const second = take()
        if (second.kind !== 'identifier' && second.kind !== 'number') throw new Error('V(node1,node2) requires node names.')
        nodes.add(second.text)
      }
      take(')')
      return
    }
    const signature = functions.get(name)
    if (!signature) throw new Error(`Function “${token.text}” is not supported.`)
    let count = 0
    if (!peek(')')) {
      do { if (count > 0) take(','); parseConditional(); count += 1 } while (peek(','))
    }
    take(')')
    if (count < signature.min || count > signature.max) throw new Error(`${token.text}() expects ${signature.min === signature.max ? signature.min : `${signature.min} or ${signature.max}`} argument${signature.max === 1 ? '' : 's'}.`)
  }
  const parseUnary = (): void => { if (peek('+') || peek('-') || peek('!')) { take(); parseUnary() } else parsePrimary() }
  const parsePower = (): void => { parseUnary(); if (peek('^')) { take('^'); parsePower() } }
  const parseProduct = (): void => { parsePower(); while (peek('*') || peek('/')) { take(); parsePower() } }
  const parseSum = (): void => { parseProduct(); while (peek('+') || peek('-')) { take(); parseProduct() } }
  const parseCompare = (): void => { parseSum(); while (['<', '>', '<=', '>=', '==', '!=', '<>'].some((op) => peek(op))) { take(); parseSum() } }
  const parseLogical = (): void => { parseCompare(); while (peek('&&') || peek('||')) { take(); parseCompare() } }
  const parseConditional = (): void => { parseLogical(); if (peek('?')) { take('?'); parseConditional(); take(':'); parseConditional() } }
  parseConditional()
  if (cursor !== tokens.length) throw new Error(`Unexpected token “${tokens[cursor].text}”.`)
  return { references: { nodes: [...nodes], components: [...components] } }
}

export function validateBehavioralReferences(references: BehavioralReferences, nodes: string[], componentRefs: string[]): void {
  for (const node of references.nodes) if (node !== '0' && !nodes.some((known) => known.toLowerCase() === node.toLowerCase())) throw new Error(`Behavioral source refers to unknown node “${node}”. Add a net label first.`)
  for (const component of references.components) if (!componentRefs.some((known) => known.toLowerCase() === component.toLowerCase())) throw new Error(`Behavioral source refers to unknown component “${component}”.`)
}
