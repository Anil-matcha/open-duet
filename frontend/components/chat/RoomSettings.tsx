"use client";

import { Select } from "@/components/ui/Select";

import { useState } from "react";
import { ApiError, type Agent } from "@/lib/api";
import { collaboration, type Room, type RoomInput } from "@/lib/collaboration";
import { useT } from "@/lib/use-i18n";

const FIELD = "mt-1 w-full rounded-field border border-line bg-raised px-3 py-2 text-sm";
export function RoomSettings({ room, agents, onSaved, onCancel }: { room?: Room; agents: Agent[]; onSaved: (room: Room) => void; onCancel: () => void }) {
  const t = useT();
  const [name, setName] = useState(room?.name ?? "");
  const [bulletin, setBulletin] = useState(room?.bulletin ?? "");
  const [members, setMembers] = useState<number[]>(room?.members.map(member => member.agent_id) ?? []);
  const [expectedMembers] = useState(room?.members.map(member => member.agent_id) ?? []);
  const [kind, setKind] = useState<Room["default_responder_kind"]>(room?.default_responder_kind ?? "mentions");
  const [responder, setResponder] = useState<number | null>(room?.default_responder_agent_id ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const choices = [
    ...agents.filter(agent => !agent.archived_at || expectedMembers.includes(agent.id)),
    ...(room?.members ?? []).filter(member => !agents.some(agent => agent.id === member.agent_id))
      .map(member => ({ id: member.agent_id, name: member.name })),
  ];
  const save = async (event: React.FormEvent) => {
    event.preventDefault(); setBusy(true); setError(null);
    try {
      const input: RoomInput = { name: name.trim(), bulletin, member_ids: members, default_responder_kind: kind, default_responder_agent_id: kind === "member" ? responder : null };
      const saved = room ? await collaboration.saveRoom(room.id, { ...input, expected_member_ids: expectedMembers }) : await collaboration.createRoom(input);
      onSaved(saved);
    } catch (err) { setError(err instanceof ApiError ? err.message : t("room.saveError")); }
    finally { setBusy(false); }
  };
  return <form onSubmit={save} className="space-y-4"><fieldset disabled={busy} className="space-y-4">
    <label className="block text-sm">{t("room.name")}<input required maxLength={80} className={FIELD} value={name} onChange={event => setName(event.target.value)} /></label>
    <fieldset className="space-y-2">
      <legend className="mb-2 text-sm">{t("room.members")}</legend>
      {choices.map(agent => <label key={agent.id} className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={members.includes(agent.id)} onChange={event => setMembers(previous => event.target.checked ? [...previous, agent.id] : previous.filter(id => id !== agent.id))} />
        {agent.name}
      </label>)}
      <p className="text-xs text-muted">{t("room.memberLimit")}</p>
      {room && <p className="text-xs text-muted">{t("room.removeHelp")}</p>}
    </fieldset>
    <label className="block text-sm">{t("room.instructions")}<textarea maxLength={12000} rows={4} className={FIELD} value={bulletin} onChange={event => setBulletin(event.target.value)} /><span className="mt-1 block text-xs text-muted">{t("room.instructionsHelp")}</span></label>
    <label className="block text-sm">{t("room.responderQuestion")}<Select className={FIELD} value={kind} onChange={event => setKind(event.target.value as Room["default_responder_kind"])}><option value="mentions">{t("room.taggedOnly")}</option><option value="member">{t("room.oneMember")}</option><option value="everyone">{t("room.everyone")}</option></Select></label>
    {kind === "member" && <label className="block text-sm">{t("room.defaultResponder")}<Select required className={FIELD} value={responder ?? ""} onChange={event => setResponder(Number(event.target.value) || null)}><option value="">{t("room.chooseMember")}</option>{agents.filter(agent => members.includes(agent.id)).map(agent => <option key={agent.id} value={agent.id}>{agent.name}</option>)}</Select></label>}
    {error && <p role="alert" className="text-sm text-danger">{error}</p>}
    <div className="flex gap-2"><button className="rounded-field border border-line px-3 py-2 text-sm hover:bg-hover" type="submit" disabled={!name.trim() || members.length === 0 || members.length > 12 || (kind === "member" && (!responder || !members.includes(responder)))}>{busy ? t("room.saving") : room ? t("room.save") : t("room.create")}</button><button className="px-3 py-2 text-sm underline" type="button" onClick={onCancel}>{t("room.cancel")}</button></div>
  </fieldset></form>;
}
