from pydantic import BaseModel, Field, SecretStr


class CommunityMcpTool(BaseModel):
    name: str
    description: str
    input_schema: dict
    schema_digest: str


class CommunityMcpCatalog(BaseModel):
    tested: list[dict]
    community: list[dict]


class CommunityMcpInstallRequest(BaseModel):
    manifest_digest: str = Field(pattern=r"^[a-f0-9]{64}$")


class CommunityMcpCredentialRequest(BaseModel):
    credential: SecretStr


class CommunityMcpConnection(BaseModel):
    id: str
    slug: str
    section: str
    manifest: dict
    manifest_digest: str
    revision: int
    credential_configured: bool
    name: str


class CommunityMcpGrantSelection(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    schema_digest: str = Field(pattern=r"^[a-f0-9]{64}$")


class CommunityMcpGrantRequest(BaseModel):
    tools: list[CommunityMcpGrantSelection] = Field(max_length=100)


class CommunityMcpGrant(BaseModel):
    agent_id: int
    tool_name: str
    schema_digest: str
    description: str
    input_schema: dict
