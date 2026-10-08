/**
 * One registry for scope, explainer, review, draft and report docs.
 * Pure: no I/O. The daemon, the CLI and the page share it.
 *
 * label: index group heading.
 * margin: the margin action and reply verb ("Ask" / "Comment").
 * approve: the doc can be approved.
 * resolve: comments resolve/park (check button, Resolved chip, show-resolved filter,
 *   nav over open comments, "N open" counter). False means every comment stays listed
 *   and the nav runs over all of them.
 * qa: comment cards render as question and answer ("You asked", "Answer" messages).
 * answerer: default for the per-doc `answerer: on|off` seam.
 */
export const DOC_KINDS = Object.freeze({
  scope:     { label: 'Scoping',    margin: 'Comment', approve: true,  resolve: true,  qa: false, answerer: true  },
  explainer: { label: 'Explainers', margin: 'Ask',     approve: false, resolve: false, qa: true,  answerer: true  },
  review:    { label: 'Reviews',    margin: 'Comment', approve: false, resolve: true,  qa: false, answerer: false },
  draft:     { label: 'Drafts',     margin: 'Comment', approve: false, resolve: true,  qa: false, answerer: false },
  visual: { label: 'Visual review', margin: 'Comment', approve: false, resolve: true, qa: false, answerer: false },
  report:    { label: 'Reports',    margin: 'Comment', approve: false, resolve: true,  qa: false, answerer: false },
})

export const KIND_IDS = Object.keys(DOC_KINDS)

export function kindOf(scope) {
  const kind = scope && typeof scope === 'object' ? scope.kind : undefined
  return KIND_IDS.includes(kind) ? kind : 'scope'
}

export function kindSpec(scope) {
  return DOC_KINDS[kindOf(scope)]
}
