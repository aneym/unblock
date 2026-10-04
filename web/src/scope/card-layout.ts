export type Slot = { want: number; height: number }

export function placeCards(slots: Slot[], pivot: number, sortByWant: boolean): number[] {
  const order = slots.map((_, i) => i)
  if (sortByWant) order.sort((a, b) => slots[a].want - slots[b].want)
  const tops = slots.map(slot => slot.want)
  const lead = pivot < 0 ? 0 : order.indexOf(pivot)
  for (let i = lead + 1; i < order.length; i++) {
    const at = order[i], prev = order[i - 1]
    tops[at] = Math.max(slots[at].want, tops[prev] + slots[prev].height + 10)
  }
  for (let i = lead - 1; i >= 0; i--) {
    const at = order[i], next = order[i + 1]
    tops[at] = Math.min(slots[at].want, tops[next] - slots[at].height - 10)
  }
  if (order.length && tops[order[0]] < 8) {
    tops[order[0]] = 8
    for (let i = 1; i < order.length; i++) {
      const at = order[i], prev = order[i - 1]
      tops[at] = Math.max(tops[at], tops[prev] + slots[prev].height + 10)
    }
  }
  return tops
}
