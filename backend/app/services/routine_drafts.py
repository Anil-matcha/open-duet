"""Checked-message identity for confined, draft-only routine runs."""
import hashlib
import json
from email.utils import getaddresses

TOOL = "gmail_prepare_checked_reply"
READS = frozenset({"gmail_fetch_message", "gmail_fetch_thread", "gmail_fetch_emails", "gmail_get_profile"})


def valid_grants(grants):
    if TOOL not in grants:
        return False
    return (set(grants) <= READS | {TOOL}
            and {"gmail_fetch_message", "gmail_get_profile"} <= set(grants)
            and len(set(grants.values())) == 1)


def source_identity(data):
    """Require authoritative Gmail headers; missing or ambiguous shapes fail closed."""
    from app import composio_tools
    source = composio_tools._find(data, lambda v: isinstance(v, dict)
                                  and isinstance(v.get("payload"), dict)
                                  and isinstance(v["payload"].get("headers"), list))
    if source is None:
        raise composio_tools.BadArguments("The message has no verifiable reply headers.")
    headers = source["payload"]["headers"]
    def addresses(name):
        values = [h.get("value") for h in headers if isinstance(h, dict)
                  and str(h.get("name", "")).lower() == name]
        if len(values) != 1 or not isinstance(values[0], str) or any(c in values[0] for c in "\r\n"):
            raise composio_tools.BadArguments("The message has ambiguous reply headers.")
        parsed = getaddresses(values)
        if len(parsed) != 1:
            raise composio_tools.BadArguments("The message must have one sender.")
        return composio_tools._check("sender", composio_tools.EMAIL, parsed[0][1]).lower()
    sender = addresses("from")
    if any(isinstance(h, dict) and str(h.get("name", "")).lower() == "reply-to" for h in headers):
        if addresses("reply-to") != sender:
            raise composio_tools.BadArguments("The reply address differs from the sender.")
    message = source.get("id") or source.get("messageId")
    thread = source.get("threadId")
    if not isinstance(message, str) or not isinstance(thread, str):
        raise composio_tools.BadArguments("The message has no verifiable source IDs.")
    digest = hashlib.sha256(json.dumps(source, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    return {"message_id": message, "thread_id": thread, "sender": sender, "digest": digest}
