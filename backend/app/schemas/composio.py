from pydantic import BaseModel, ConfigDict, Field


# There is no model for the key itself: a validation error would echo the
# submitted value back, so the route reads and checks that body by hand.


class ComposioConnectRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    toolkit: str = Field(max_length=64)
    alias: str | None = Field(default=None, max_length=64)


class ComposioApp(BaseModel):
    slug: str
    label: str


class ComposioStatus(BaseModel):
    configured: bool
    apps: list[ComposioApp]


class ComposioAccount(BaseModel):
    id: str
    toolkit: str
    alias: str | None
    status: str
    created_at: str | None
    updated_at: str | None


class ComposioLink(BaseModel):
    redirect_url: str
    account_id: str
    expires_in_seconds: int
