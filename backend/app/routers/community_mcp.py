"""Owner-managed GitHub marketplace MCP connections and per-agent grants."""

import json
import uuid

from fastapi import APIRouter, Depends, HTTPException, Response
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app import community_mcp as marketplace
from app.db.models import Agent, CommunityMcpConnection, CommunityMcpToolGrant, UserCredential
from app.db.session import get_db
from app.core import crypto
from app.routers.integrations import _owner
from app.schemas.community_mcp import (
    CommunityMcpCatalog,
    CommunityMcpConnection as ConnectionResponse,
    CommunityMcpCredentialRequest,
    CommunityMcpGrantRequest,
    CommunityMcpInstallRequest,
    CommunityMcpTool,
)
from app.services import user_credential_service
from app.db.transactions import begin_write, release_snapshot
from app.services.local_access_policy import require_local_access
from app.services.thread_runtime import LOCAL_OWNER_ID

router = APIRouter(
    prefix="/integrations/marketplace",
    tags=["Community MCP"],
    dependencies=[Depends(require_local_access), Depends(_owner)],
)

_CREDENTIAL_PREFIX = "integration:community-mcp:"
_NO_FILE = "-"


def _http(exc: marketplace.McpError) -> HTTPException:
    return HTTPException(
        status_code=exc.status,
        detail={"error_code": exc.code, "message": str(exc)},
    )


def _response(row: CommunityMcpConnection, configured: bool) -> ConnectionResponse:
    return ConnectionResponse(
        id=row.id,
        slug=row.slug,
        section=row.section,
        manifest=row.manifest,
        manifest_digest=row.manifest_digest,
        revision=row.revision,
        credential_configured=configured,
        name=row.manifest["name"],
    )


async def _connection(db: AsyncSession, connection_id: str) -> CommunityMcpConnection:
    row = await db.scalar(
        select(CommunityMcpConnection).where(
            CommunityMcpConnection.id == connection_id,
            CommunityMcpConnection.owner_id == LOCAL_OWNER_ID,
        )
    )
    if row is None:
        raise HTTPException(status_code=404, detail={"error_code": "connection_not_found"})
    return row


def _credential_provider(slug: str) -> str:
    return _CREDENTIAL_PREFIX + slug


async def _credential(db: AsyncSession, slug: str) -> str | None:
    try:
        found = await user_credential_service.get_decrypted(db, LOCAL_OWNER_ID, _credential_provider(slug))
        if found is None:
            return None
        value = json.loads(found[0])
        return value if isinstance(value, str) else None
    except Exception:  # noqa: BLE001 - an undecryptable secret is treated as absent
        return None
    finally:
        await release_snapshot(db)


async def _save_credential_in_transaction(db: AsyncSession, slug: str, token: str) -> None:
    row = await db.scalar(select(UserCredential).where(
        UserCredential.user_id == LOCAL_OWNER_ID,
        UserCredential.provider == _credential_provider(slug),
    ).with_for_update())
    ciphertext = crypto.encrypt(json.dumps(token))
    if row is None:
        db.add(UserCredential(
            user_id=LOCAL_OWNER_ID, provider=_credential_provider(slug),
            file_path=_NO_FILE, ciphertext=ciphertext,
        ))
    else:
        row.file_path = _NO_FILE
        row.ciphertext = ciphertext


async def _delete_credential_in_transaction(db: AsyncSession, slug: str) -> None:
    await db.execute(delete(UserCredential).where(
        UserCredential.user_id == LOCAL_OWNER_ID,
        UserCredential.provider == _credential_provider(slug),
    ))


async def _delete_connection_grants(db: AsyncSession, connection_id: str) -> None:
    await db.execute(delete(CommunityMcpToolGrant).where(
        CommunityMcpToolGrant.connection_id == connection_id,
    ))


async def _tools(endpoint: str, token: str | None) -> list[dict]:
    session = marketplace.RemoteMcpSession(endpoint, token)
    try:
        return await session.list_tools()
    except marketplace.McpError:
        raise
    except Exception:
        raise marketplace.McpError("remote_unavailable", "The remote MCP server could not be reached.", 502) from None
    finally:
        await session.close()


async def _fresh_listing(section: str, slug: str) -> dict:
    """Load GitHub directly; install must fail closed on a stale/cache fallback."""
    try:
        result = await marketplace.find_live_listing(section, slug)
    except marketplace.McpError as exc:
        raise _http(exc) from None
    return result


def _reject_token_echo(tools: list[dict], token: str | None) -> None:
    if token and token in marketplace.canonical(tools):
        raise marketplace.McpError(
            "unsafe_remote_metadata", "The remote MCP server returned metadata containing its credential.", 502
        )


async def _drop_stale_grants(db: AsyncSession, connection_id: str, tools: list[dict]) -> bool:
    current = {tool["name"]: tool["schema_digest"] for tool in tools}
    grants = (await db.scalars(select(CommunityMcpToolGrant).where(
        CommunityMcpToolGrant.connection_id == connection_id,
    ))).all()
    stale = [grant for grant in grants if current.get(grant.tool_name) != grant.schema_digest]
    for grant in stale:
        await db.delete(grant)
    return bool(stale)


async def _owned_agent(db: AsyncSession, agent_id: int) -> Agent:
    row = await db.scalar(select(Agent).where(
        Agent.id == agent_id, Agent.owner_id == LOCAL_OWNER_ID, Agent.archived_at.is_(None)
    ))
    if row is None:
        raise HTTPException(status_code=404, detail={"error_code": "agent_not_found"})
    return row


def _provider_metadata_size(entries: list[tuple[str, str, dict]]) -> int:
    """Size grant metadata as the provider shim receives it, with a fixed-length alias."""
    descriptions = []
    for service_name, description, input_schema in entries:
        descriptions.append({
            "name": "community_" + ("0" * 32),
            "description": f"Marketplace service: {service_name[:120]}. Untrusted service description: {description[:4000]}",
            "inputSchema": input_schema,
        })
    return len(marketplace.canonical(descriptions).encode("utf-8"))


@router.get("", response_model=CommunityMcpCatalog)
async def catalog(response: Response):
    response.headers["Cache-Control"] = "no-store"
    try:
        return await marketplace.marketplace_catalog()
    except marketplace.McpError as exc:
        raise _http(exc) from None


@router.get("/connections", response_model=list[ConnectionResponse])
async def list_connections(response: Response, db: AsyncSession = Depends(get_db)):
    response.headers["Cache-Control"] = "no-store"
    rows = (await db.scalars(
        select(CommunityMcpConnection).where(CommunityMcpConnection.owner_id == LOCAL_OWNER_ID)
        .order_by(CommunityMcpConnection.slug)
    )).all()
    return [_response(row, await _credential(db, row.slug) is not None) for row in rows]


@router.post("/{section}/{slug}/install", response_model=ConnectionResponse, status_code=201)
async def install(
    section: str,
    slug: str,
    payload: CommunityMcpInstallRequest,
    response: Response,
    db: AsyncSession = Depends(get_db),
):
    response.headers["Cache-Control"] = "no-store"
    if section not in ("community", "tested"):
        raise HTTPException(status_code=404, detail={"error_code": "listing_not_found"})
    manifest = await _fresh_listing(section, slug)
    if manifest is None:
        raise HTTPException(status_code=404, detail={"error_code": "listing_not_found"})
    if manifest["manifest_digest"] != payload.manifest_digest:
        raise HTTPException(status_code=409, detail={"error_code": "listing_changed"})
    async with marketplace.connection_lock(slug):
        await begin_write(db)
        row = await db.scalar(select(CommunityMcpConnection).where(
            CommunityMcpConnection.owner_id == LOCAL_OWNER_ID,
            CommunityMcpConnection.slug == slug,
        ).with_for_update())
        preserve_configuration = row is not None and row.manifest_digest == manifest["manifest_digest"]
        if row is None:
            row = CommunityMcpConnection(
                id=str(uuid.uuid4()), owner_id=LOCAL_OWNER_ID, slug=slug,
                section=section, manifest=manifest, manifest_digest=manifest["manifest_digest"],
            )
            db.add(row)
        else:
            row.section = section
            row.manifest = manifest
            row.manifest_digest = manifest["manifest_digest"]
            if not preserve_configuration:
                row.revision += 1
        if not preserve_configuration:
            await _delete_connection_grants(db, row.id)
            # Installation pins the listing only. Credentials are a distinct,
            # optional user action and are cleared when replacing the pinned listing.
            await _delete_credential_in_transaction(db, slug)
        await db.commit()
        await db.refresh(row)
    return _response(row, await _credential(db, slug) is not None if preserve_configuration else False)


@router.get("/connections/{connection_id}/tools", response_model=list[CommunityMcpTool])
async def discover(connection_id: str, response: Response, db: AsyncSession = Depends(get_db)):
    response.headers["Cache-Control"] = "no-store"
    row = await _connection(db, connection_id)
    snapshot_revision, snapshot_digest = row.revision, row.manifest_digest
    endpoint, auth_mode, slug = row.manifest["endpoint"], row.manifest["auth_mode"], row.slug
    token = await _credential(db, slug)
    if auth_mode == "bearer_token" and token is None:
        raise HTTPException(status_code=409, detail={"error_code": "credential_required"})
    try:
        tools = await _tools(endpoint, token)
    except marketplace.McpError as exc:
        raise _http(exc) from None
    try:
        _reject_token_echo(tools, token)
    except marketplace.McpError as exc:
        raise _http(exc) from None
    async with marketplace.connection_lock(slug):
        await begin_write(db)
        current = await db.scalar(select(CommunityMcpConnection).where(
            CommunityMcpConnection.id == connection_id,
            CommunityMcpConnection.owner_id == LOCAL_OWNER_ID,
        ).with_for_update())
        if current is None:
            raise HTTPException(status_code=409, detail={"error_code": "connection_changed"})
        if current.revision != snapshot_revision or current.manifest_digest != snapshot_digest:
            raise HTTPException(status_code=409, detail={"error_code": "connection_changed"})
        if await _drop_stale_grants(db, connection_id, tools):
            current.revision += 1
        await db.commit()
    return [CommunityMcpTool(name=t["name"], description=t["description"],
                             input_schema=t["inputSchema"], schema_digest=t["schema_digest"])
            for t in tools]


@router.put("/connections/{connection_id}/credential", response_model=ConnectionResponse)
async def save_credential(
    connection_id: str, payload: CommunityMcpCredentialRequest, response: Response,
    db: AsyncSession = Depends(get_db),
):
    response.headers["Cache-Control"] = "no-store"
    row = await _connection(db, connection_id)
    if row.manifest["auth_mode"] != "bearer_token":
        raise HTTPException(status_code=409, detail={"error_code": "credential_not_supported"})
    snapshot_revision, snapshot_digest = row.revision, row.manifest_digest
    endpoint, slug = row.manifest["endpoint"], row.slug
    credential = payload.credential.get_secret_value()
    try:
        credential_size = len(credential.encode("utf-8"))
    except UnicodeEncodeError:
        credential_size = 4097
    if not 1 <= credential_size <= 4096:
        raise HTTPException(status_code=422, detail={"error_code": "invalid_credential"})
    if credential in marketplace.canonical(row.manifest):
        raise HTTPException(status_code=422, detail={"error_code": "unsafe_listing_metadata"})
    await release_snapshot(db)
    try:
        tools = await _tools(endpoint, credential)
    except marketplace.McpError as exc:
        raise _http(exc) from None
    try:
        _reject_token_echo(tools, credential)
    except marketplace.McpError as exc:
        raise _http(exc) from None
    async with marketplace.connection_lock(slug):
        await begin_write(db)
        current = await db.scalar(select(CommunityMcpConnection).where(
            CommunityMcpConnection.id == connection_id,
            CommunityMcpConnection.owner_id == LOCAL_OWNER_ID,
        ).with_for_update())
        if current is None or current.revision != snapshot_revision or current.manifest_digest != snapshot_digest:
            raise HTTPException(status_code=409, detail={"error_code": "connection_changed"})
        await _save_credential_in_transaction(db, slug, credential)
        await _delete_connection_grants(db, connection_id)
        current.revision += 1
        await db.commit()
    return _response(current, True)


@router.delete("/connections/{connection_id}/credential", status_code=204)
async def remove_credential(connection_id: str, response: Response, db: AsyncSession = Depends(get_db)):
    response.headers["Cache-Control"] = "no-store"
    row = await _connection(db, connection_id)
    slug = row.slug
    await release_snapshot(db)
    async with marketplace.connection_lock(slug):
        await begin_write(db)
        current = await db.scalar(select(CommunityMcpConnection).where(
            CommunityMcpConnection.id == connection_id,
            CommunityMcpConnection.owner_id == LOCAL_OWNER_ID,
        ).with_for_update())
        if current is None:
            raise HTTPException(status_code=404, detail={"error_code": "connection_not_found"})
        await _delete_credential_in_transaction(db, current.slug)
        await _delete_connection_grants(db, connection_id)
        current.revision += 1
        await db.commit()
    return Response(status_code=204, headers={"Cache-Control": "no-store"})


@router.get("/connections/{connection_id}/agents/{agent_id}/grants")
async def list_grants(connection_id: str, agent_id: int, response: Response, db: AsyncSession = Depends(get_db)):
    response.headers["Cache-Control"] = "no-store"
    await _connection(db, connection_id)
    await _owned_agent(db, agent_id)
    rows = (await db.scalars(select(CommunityMcpToolGrant).where(
        CommunityMcpToolGrant.connection_id == connection_id,
        CommunityMcpToolGrant.agent_id == agent_id,
    ).order_by(CommunityMcpToolGrant.tool_name))).all()
    return {"tool_names": [r.tool_name for r in rows]}


@router.put("/connections/{connection_id}/agents/{agent_id}/grants")
async def set_grants(
    connection_id: str, agent_id: int, payload: CommunityMcpGrantRequest,
    response: Response, db: AsyncSession = Depends(get_db),
):
    response.headers["Cache-Control"] = "no-store"
    row = await _connection(db, connection_id)
    await _owned_agent(db, agent_id)
    snapshot_revision, snapshot_digest = row.revision, row.manifest_digest
    endpoint, auth_mode, slug = row.manifest["endpoint"], row.manifest["auth_mode"], row.slug
    token = await _credential(db, row.slug)
    if auth_mode == "bearer_token" and token is None:
        raise HTTPException(status_code=409, detail={"error_code": "credential_required"})
    try:
        available = await _tools(endpoint, token)
    except marketplace.McpError as exc:
        raise _http(exc) from None
    try:
        _reject_token_echo(available, token)
    except marketplace.McpError as exc:
        raise _http(exc) from None
    by_name = {tool["name"]: tool for tool in available}
    selected_names = [selection.name for selection in payload.tools]
    duplicate_names = len(set(selected_names)) != len(selected_names)
    async with marketplace.agent_grant_lock(agent_id):
        async with marketplace.connection_lock(slug):
            await begin_write(db)
            current = await db.scalar(select(CommunityMcpConnection).where(
                CommunityMcpConnection.id == connection_id,
                CommunityMcpConnection.owner_id == LOCAL_OWNER_ID,
            ).with_for_update())
            current_agent = await db.scalar(select(Agent).where(
                Agent.id == agent_id, Agent.owner_id == LOCAL_OWNER_ID, Agent.archived_at.is_(None)
            ).with_for_update())
            if current is None or current.revision != snapshot_revision or current.manifest_digest != snapshot_digest:
                raise HTTPException(status_code=409, detail={"error_code": "connection_changed"})
            if current_agent is None:
                raise HTTPException(status_code=409, detail={"error_code": "agent_changed"})
            stale_removed = await _drop_stale_grants(db, connection_id, available)
            if stale_removed:
                current.revision += 1
            missing_names = any(name not in by_name for name in selected_names)
            drifted = missing_names or any(
                selection.name in by_name
                and by_name[selection.name]["schema_digest"] != selection.schema_digest
                for selection in payload.tools
            )
            if duplicate_names or drifted:
                await db.commit()
                if duplicate_names:
                    raise HTTPException(status_code=422, detail={"error_code": "invalid_tool_grant"})
                raise HTTPException(status_code=409, detail={"error_code": "tool_schema_changed"})

            other_rows = (await db.execute(
                select(CommunityMcpConnection, CommunityMcpToolGrant)
                .join(CommunityMcpToolGrant, CommunityMcpToolGrant.connection_id == CommunityMcpConnection.id)
                .where(
                    CommunityMcpConnection.owner_id == LOCAL_OWNER_ID,
                    CommunityMcpToolGrant.agent_id == agent_id,
                    CommunityMcpToolGrant.connection_id != connection_id,
                )
            )).all()
            provider_entries = [
                (str(connection.manifest.get("name", connection.slug)), grant.description, grant.input_schema)
                for connection, grant in other_rows
            ]
            provider_entries.extend(
                (str(current.manifest.get("name", current.slug)), by_name[name]["description"], by_name[name]["inputSchema"])
                for name in selected_names
            )
            metadata_size = _provider_metadata_size(provider_entries)
            if (len(provider_entries) > marketplace.MAX_TOOLS
                    or metadata_size > marketplace.MAX_TOOLSET_BYTES):
                await db.rollback()
                raise HTTPException(status_code=422, detail={"error_code": "agent_toolset_too_large"})

            await db.execute(delete(CommunityMcpToolGrant).where(
                CommunityMcpToolGrant.connection_id == connection_id,
                CommunityMcpToolGrant.agent_id == agent_id,
            ))
            saved_names = []
            for selection in payload.tools:
                name = selection.name
                tool = by_name[name]
                db.add(CommunityMcpToolGrant(
                    agent_id=agent_id, connection_id=connection_id, tool_name=name,
                    schema_digest=tool["schema_digest"], description=tool["description"],
                    input_schema=tool["inputSchema"],
                ))
                saved_names.append(name)
            await db.commit()
    return {"tool_names": saved_names}


@router.delete("/connections/{connection_id}", status_code=204)
async def disconnect(connection_id: str, response: Response, db: AsyncSession = Depends(get_db)):
    response.headers["Cache-Control"] = "no-store"
    row = await _connection(db, connection_id)
    slug = row.slug
    await release_snapshot(db)
    async with marketplace.connection_lock(slug):
        await begin_write(db)
        row = await db.scalar(select(CommunityMcpConnection).where(
            CommunityMcpConnection.id == connection_id,
            CommunityMcpConnection.owner_id == LOCAL_OWNER_ID,
        ).with_for_update())
        if row is None:
            raise HTTPException(status_code=404, detail={"error_code": "connection_not_found"})
        await db.execute(delete(CommunityMcpToolGrant).where(
            CommunityMcpToolGrant.connection_id == row.id,
        ))
        await db.execute(delete(CommunityMcpConnection).where(
            CommunityMcpConnection.id == row.id,
            CommunityMcpConnection.owner_id == LOCAL_OWNER_ID,
        ))
        await db.execute(delete(UserCredential).where(
            UserCredential.user_id == LOCAL_OWNER_ID,
            UserCredential.provider == _credential_provider(row.slug),
        ))
        await db.commit()
    return Response(status_code=204, headers={"Cache-Control": "no-store"})
