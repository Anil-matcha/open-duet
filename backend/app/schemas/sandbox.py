from datetime import datetime

from pydantic import BaseModel, Field

# A Boat sandbox id, and the OAuth/device code a person pastes back. Both end
# up inside a shell command run in the sandbox (auth_flow_service), so they are
# restricted to characters that cannot break out of quoting or an argument.
BOX_ID_PATTERN = r"^[A-Za-z0-9_-]{1,64}$"
# OAuth authorization codes and device codes are short tokens of letters,
# digits and a few punctuation marks; nothing here can terminate a shell word.
AUTH_CODE_PATTERN = r"^[A-Za-z0-9._~+/=-]{1,256}$"


class SandboxCreateRequest(BaseModel):
    # The acting user is taken from the session identity, never the body.
    ttl_seconds: int = Field(
        default=1800,
        ge=300,
        le=7200,
    )


class SandboxResponse(BaseModel):
    box_id: str
    state: str | None = None
    machine_type: str | None = None
    user_id: str | None = None
    ttl_seconds: int | None = None
    expires_at: datetime | None = None
    is_active: bool | None = None


class AuthLoginStartResponse(BaseModel):
    login_url: str


class AuthLoginSubmitRequest(BaseModel):
    code: str = Field(min_length=1, max_length=256, pattern=AUTH_CODE_PATTERN)


class AuthLoginSubmitResponse(BaseModel):
    status: str


class AuthStatusResponse(BaseModel):
    connected: bool


class DeviceLoginStartResponse(BaseModel):
    url: str
    code: str
