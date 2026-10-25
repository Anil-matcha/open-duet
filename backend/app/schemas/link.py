from datetime import datetime

from pydantic import BaseModel


class LinkCodeCreateResponse(BaseModel):
    code: str
    expires_at: datetime
    bot_username: str | None = None


class LinkCodeStatusResponse(BaseModel):
    # The claimed user's id is deliberately not disclosed: the code is the
    # only secret, and the web UI only needs to know whether it was claimed.
    status: str  # "pending" | "claimed" | "expired"
