---
name: unblock
description: Ask the human for something only they can give — a credential, a console click, an approval (a blocker), or a decision only they should make (a grill). Use whenever you hit a wall you cannot clear yourself, instead of stalling or asking in chat.
---

# unblock

Two kinds of ask, and getting the kind right is most of the job.

## Which one is this?

Ask yourself: **do I already know what should happen?**

**Yes, but I cannot do it** → `purpose: "blocker"`.
The answer exists. What is missing is the human's *action*. They hold a key, they
must click something in a console, they must approve a spend. There is nothing to
recommend, because there is nothing you could have guessed.

**No, and I should not guess** → `purpose: "decision"`.
You have done the work and formed a view. What is missing is their *judgement*.
**Every field must carry your recommendation.** Their job is to ratify, not to author.

> Blocker = do something. Decision = decide something.

The schema enforces this. A blocker needs at least one `secret`, `confirm` or
`paste` field — something only the human can supply or perform. If your ask is all
choices and free text, it is a question, and it will be rejected until you make it
a decision with recommendations. A decision may not ask for a `secret` or a
`paste`: deliberation never touches credentials, and running a command to find
something out is your job.

## Gating: do you stop?

Separate axis from purpose. Either kind can be either.

| call | blocks? | how many open |
| --- | --- | --- |
| `unblock_file` | no — returns a ticket, keep working | unlimited |
| `unblock_park` | yes — holds until answered | **one per agent** |

One park per agent, because you can only be stopped in one place. If you need
three things before you can move, that is **one park with three fields**, not
three parks. Call `unblock_check` when you resume to collect anything you filed.

## Before you ask anything

1. **Can I do this myself?** Read the config, check the docs, run the command.
   Parking on work you could have done is the most common failure.
2. **Have I asked this before?** A repeat question gets the previous answer
   handed straight back. Do not re-ask what is already decided.
3. **What exactly do I need back?** Name each value.
4. **What turns green when it lands?** If you cannot say, they cannot prioritise.

## Writing it

`title` — verb first for a blocker ("Add the callback URI"), noun phrase for a
decision ("Migration strategy for the user table"). Under 90 characters.

`why` — one or two sentences: what is stuck, what starts working. State the
payoff, not the history. Never "as discussed above" — there is no above. The
human is not reading your transcript.

`project` — the workstream this ask files under. One short name, reused on
every ask from the same project ("homebase", "night-vision"), so the queue
page can group and filter by it. Set it on every ask. Without it the queue
falls back to guessing from workspace or repo.

`fields` — one per thing you need:

| type | for | blocker | decision |
| --- | --- | --- | --- |
| `secret` | keys, tokens, passwords | yes | **rejected** |
| `paste` | output only their machine can produce | yes | **rejected** |
| `confirm` | "I did the console thing" | yes | yes |
| `choice` | pick between real options | yes | yes |
| `text` | names, URLs, free answers | yes | yes |

`steps` — the shortest path to done. Console paths as `Product → Page → Field`.
`links` — bare action URLs only. Never a link to a repo file; inline that instead.

Every field gets its own optional context box, and the whole ask gets a
free-text reply box. You declare neither. Expect per-field notes back in the
answer (`their context: …`) and treat them as part of that field's answer.

## Recommendations (decisions only)

```json
{ "name": "strategy", "type": "choice",
  "choices": [{"value": "expand", "label": "Expand and contract"},
              {"value": "big_bang", "label": "One migration"}],
  "recommend": { "value": "expand", "why": "Reversible at every step; the table is hot." } }
```

`recommend.why` is one line, under 200 characters, and it is the reason — not a
restatement of the option. A recommendation you cannot justify in one line means
you have not finished thinking.

Nothing is pre-selected: the human clicks every answer themselves, and your
recommendation shows as a badge on the option it names (plus your one-line
why). Accept-all stays an explicit button.

Set `must_decide: true` on a field the human must actually engage with. Its
recommendation is hidden entirely and it is excluded from accept-all. Use it
sparingly — at most 3 per ask, and the schema rejects more. It is the only thing
standing between a twelve-question round and a rubber stamp.

## Secrets

You never receive a secret value. You get `{ref, store, env_name, resolve, hint}`.
Use `resolve` at the point of need and never print it:

```bash
op run --env STRIPE_KEY=op://Private/abc/credential -- ./deploy.sh   # masks it if printed
security find-generic-password -a unblock -s ub_x-key -w | base64 -d | tool --key-stdin
```

Never `echo $KEY`, never `env`, never `cat` a secrets file. That puts the value in
your own context, which is the exact thing this exists to prevent.

## Good

```json
{ "purpose": "blocker", "kind": "park",
  "title": "Add the Supabase callback to the Google OAuth client",
  "why": "Sign-in fails at the redirect. Nothing behind auth can be tested until this is registered.",
  "steps": ["Credentials page below, project prove-it-447000",
            "Client 5397…4kso → Authorized redirect URIs → Add URI",
            "Paste: https://<ref>.supabase.co/auth/v1/callback",
            "Save. Propagation takes about 5 minutes."],
  "links": [{"label": "Google Cloud credentials", "url": "https://console.cloud.google.com/apis/credentials"}],
  "fields": [{"name": "registered", "type": "confirm", "label": "URI registered"}] }
```

## Bad

- `{"title": "Need credentials", "why": "blocked"}` — nothing to act on.
- A `blocker` whose only field is a `choice` — that is a question. Make it a decision.
- A `decision` with no recommendation — you have not finished thinking.
- Three parks in a row instead of one ask with three fields.
- "See the earlier discussion" — there is no earlier discussion.
- A secret asked as `type: "text"` — it lands in your context in plain view.
- Filing an ask and then stopping anyway. If you file it, keep working.
