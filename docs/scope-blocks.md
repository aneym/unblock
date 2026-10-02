# Scope doc blocks

A scope doc is markdown plus a fixed set of fenced blocks. The page styles each block; a lane writes words only, never
HTML or classes. Every block works in light and dark and at 390 wide. Inline markdown (`**bold**`, `*italic*`,
`_italic_`, `` `code` ``, `[label](https://…)`) works inside every line. Unknown fences show as code.

## terms

A definition list: the term on the left, the definition on the right; on phones the term sits above.

````
```terms
slice :: One part of a project that one run builds, tests and merges as one pull request.
Tags: TN19
e.g. Slice S2 adds the Approve & ship button.
Not: piece, unit, task, chunk
See: spec, run, scenario
Code: slice ids S1, S2a

spec :: The written instructions for one slice: its files, interfaces, scenario and check.
```
````

- `term :: definition` starts an entry (space, two colons, space).
- `Tags: …` shows small and muted under the term.
- `e.g. …` is the example line.
- `Label: …` (a capitalized word or two, then a colon) becomes a labeled detail; labeled details share one muted line. Use `Not`, `See` and `Code`.
- Any other line is a muted detail line.

## example

````
```example
The machine claims slice S2, then the run sends it to review.
```
````

Sample usage, set apart from prose with an "e.g." label. A blank line starts a second example.

## do

````
```do
Do: Say "slice" for the work one pull request ships.
Don't: Say "piece", "unit" or "chunk".
```
````

`Say:` and `Avoid:` work as labels too. Any number of lines.

## compare

````
```compare
Before: The box claims the piece.
After: The machine claims the slice.
```
````

Two columns that stack on phones. Repeat `Before:`/`After:` pairs for more rows. For screens, use an image row
(`![…](shot.png)` lines side by side) instead.

## steps

````
```steps
Open the scope in Rails Admin.
Read each term and its example.
Press Approve scope.
```
````

One step per line; a leading `1.` is optional. Numbers come from the page.

## stat

````
```stat
57 captures :: Jev ranked 57 real captures for each question.
```
````

`<number> <unit> :: <one-line meaning>`. One line per figure; several lines sit in a row. Use it only when the
figure is the point.

## Tables

Pipe tables render as quiet document tables: hairline rows, small caps headers, the first column on one line, and a
side scroll on phones. Keep cells short; for a glossary, use `terms`.
