from pathlib import Path

from .hermes import unblock_cancel, unblock_check, unblock_file, unblock_park

ASK_SCHEMA = {
    "type": "object",
    "properties": {
        "purpose": {"type": "string", "enum": ["blocker", "decision", "consent", "spend", "message", "question", "permission"]},
        # The filing gate: why only the human can do this, and what the agent
        # already tried. The daemon rejects an ask without both.
        "only_you": {
            "type": "string",
            "enum": ["credential", "their_account", "spend", "message", "judgment"],
        },
        "tried": {
            "type": "array",
            "items": {"type": "string", "minLength": 20},
            "minItems": 1,
            "maxItems": 8,
        },
        "project": {"type": "string", "maxLength": 64},
        "title": {"type": "string", "maxLength": 90},
        "why": {"type": "string", "maxLength": 1200},
        "summary": {"type": "string", "maxLength": 140},
        "minutes": {"type": "integer", "minimum": 1, "maximum": 120},
        "after": {"type": "string", "maxLength": 140},
        "blocks": {"type": "array", "maxItems": 5, "items": {"type": "string", "maxLength": 60}},
        "permission": {"type": "object", "properties": {"tool": {"type": "string"}, "command": {"type": "string", "maxLength": 2000}, "path": {"type": "string"}, "summary": {"type": "string", "maxLength": 200}}, "required": ["tool", "summary"]},
        "consent_blocked_by": {"type": "string", "enum": ["sign_in", "not_signed_in", "no_browser", "types_secret", "device"]},
        "plan": {"type": "object", "properties": {"site": {"type": "string"}, "start_url": {"type": "string"}, "steps": {"type": "array", "items": {"type": "string"}}, "changes": {"type": "string"}, "untouched": {"type": "string"}}, "required": ["site", "start_url", "steps", "changes", "untouched"]},
        "spend": {"type": "object", "properties": {"item": {"type": "string"}, "vendor": {"type": "string"}, "vendor_url": {"type": "string"}, "amount_cents": {"type": "integer"}, "currency": {"type": "string"}, "cap_cents": {"type": "integer"}, "why": {"type": "string"}}, "required": ["item", "vendor", "vendor_url", "amount_cents", "currency", "cap_cents", "why"]},
        "message": {"type": "object", "properties": {"to": {"type": "string"}, "via": {"type": "string", "enum": ["email", "slack", "linkedin", "sms", "other"]}, "subject": {"type": "string"}, "text": {"type": "string"}}, "required": ["to", "via", "text"]},
        "fields": {
            "type": "array",
            "minItems": 1,
            "maxItems": 12,
            "items": {
                "type": "object",
                "properties": {
                    "name": {"type": "string"},
                    "type": {
                        "type": "string",
                        "enum": ["text", "secret", "choice", "confirm", "paste"],
                    },
                    "label": {"type": "string"},
                    "required": {"type": "boolean"},
                    "step": {"type": "integer", "minimum": 1},
                    "recommend": {
                        "type": "object",
                        "properties": {"value": {}, "why": {"type": "string", "maxLength": 200}},
                        "required": ["value", "why"],
                    },
                    "must_decide": {"type": "boolean"},
                    "help": {"type": "string"},
                    "url": {"type": "string"},
                    "choices": {"type": "array", "items": {"anyOf": [{"type": "string"}, {"type": "object", "properties": {"value": {"type": "string"}, "label": {"type": "string"}, "description": {"type": "string", "maxLength": 200}}, "required": ["value"]}]}},
                    "multi": {"type": "boolean"},
                    "command": {"type": "string"},
                    "multiline": {"type": "boolean"},
                    "placeholder": {"type": "string"},
                    "store": {"type": "string"},
                    "env_name": {"type": "string"},
                },
                "required": ["name", "type"],
            },
        },
        "steps": {"type": "array", "items": {"type": "string"}, "maxItems": 12},
        "links": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {"url": {"type": "string"}, "label": {"type": "string"}},
                "required": ["url"],
            },
        },
        "ttl_seconds": {"type": "number", "exclusiveMinimum": 0},
    },
    "required": ["title", "why"],
}


def register(ctx):
    ctx.register_tool(
        name="unblock_file",
        toolset="unblock",
        schema=ASK_SCHEMA,
        handler=unblock_file,
        description="File a nonblocking ask in the standalone Unblock queue. Clicks in a signed-in site are consent asks; sign-in is never consent. List what you tried first.",
        emoji="🟠",
    )
    ctx.register_tool(
        name="unblock_park",
        toolset="unblock",
        schema=ASK_SCHEMA,
        handler=unblock_park,
        description="Park until a gating ask is answered in Unblock.",
        emoji="⏸️",
    )
    ctx.register_tool(
        name="unblock_check",
        toolset="unblock",
        schema={"type": "object", "properties": {}},
        handler=unblock_check,
        description="Collect answered asks for the current Hermes session.",
        emoji="📥",
    )
    ctx.register_tool(
        name="unblock_cancel",
        toolset="unblock",
        schema={
            "type": "object",
            "properties": {"ticket": {"type": "string"}, "note": {"type": "string"}},
            "required": ["ticket"],
        },
        handler=unblock_cancel,
        description="Cancel an open ask in Unblock.",
        emoji="✖️",
    )
    skill = Path(__file__).resolve().parent / "skills" / "unblock" / "SKILL.md"
    ctx.register_skill("unblock", skill, "Use native Unblock for human asks.")
