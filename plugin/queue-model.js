// Ordering is shared with the browser panel so the TUI and the page can never
// disagree about which ask is next.
export { sortAsks } from '../src/queue-model.js'

const isFilled = (value) => {
  if (value === undefined || value === null || value === false || value === '') return false
  if (Array.isArray(value)) return value.length > 0
  return true
}

export function missingFor(ask, values = {}) {
  return (ask.fields || [])
    .filter((field) => field.required)
    .filter((field) => !(field.name in (ask.answers || {})))
    .filter((field) => !isFilled(values[field.name]))
    .map((field) => field.name)
}

export function initialValues(ask) {
  const secrets = new Set(
    (ask.fields || []).filter((field) => field.type === 'secret').map((field) => field.name),
  )
  return Object.fromEntries(
    Object.entries(ask.draft || {}).filter(([name]) => !secrets.has(name)),
  )
}

function printable(key) {
  return !key.ctrl && !key.meta && typeof key.sequence === 'string' && key.sequence.length === 1 &&
    key.sequence >= ' ' && key.sequence !== '\x7f'
}

export function applyKey(fieldState, key, field) {
  const value = fieldState.value

  if (field.type === 'confirm') {
    if (key.name !== 'space' && key.sequence !== ' ') return fieldState
    return { ...fieldState, value: !Boolean(value) }
  }

  if (field.type === 'choice') {
    const choices = field.choices || []
    if (choices.length === 0) return fieldState
    const currentValue = field.multi && Array.isArray(value) ? value[0] : value
    let index = choices.findIndex((choice) => choice.value === currentValue)
    if (index < 0) index = 0

    let nextIndex
    if (key.name === 'left') nextIndex = (index - 1 + choices.length) % choices.length
    else if (key.name === 'right') nextIndex = (index + 1) % choices.length
    else if (/^[1-9]$/.test(key.sequence || '')) {
      nextIndex = Number(key.sequence) - 1
      if (nextIndex >= choices.length) return fieldState
    } else {
      return fieldState
    }

    const nextValue = choices[nextIndex].value
    return { ...fieldState, value: field.multi ? [nextValue] : nextValue }
  }

  const text = typeof value === 'string' ? value : ''
  if (key.name === 'backspace' || key.sequence === '\x7f') {
    if (text.length === 0) return fieldState
    return { ...fieldState, value: Array.from(text).slice(0, -1).join('') }
  }
  if (printable(key)) return { ...fieldState, value: text + key.sequence }
  return fieldState
}

export function redactValue(field, value) {
  if (field.type === 'secret') return '•'.repeat(typeof value === 'string' ? value.length : 0)
  if (field.type === 'choice') {
    const selected = Array.isArray(value) ? value : [value]
    return selected
      .map((item) => field.choices?.find((choice) => choice.value === item)?.label ?? item)
      .filter((item) => item !== undefined && item !== null)
      .join(', ')
  }
  if (value === undefined || value === null) return ''
  return String(value)
}
