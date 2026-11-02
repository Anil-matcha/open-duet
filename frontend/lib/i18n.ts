// Strings for the new interface only; older components keep their literal text. The supported
// locale falls back to English for any catalog entry that has not been translated yet.
// Keys are surface.name; {name} in a message is a placeholder. Locale modules contain data only.
import { de } from "./locales/de.ts";
import { fr } from "./locales/fr.ts";
import { it } from "./locales/it.ts";
import { ja } from "./locales/ja.ts";
import { ko } from "./locales/ko.ts";
import { nl } from "./locales/nl.ts";
import { pl } from "./locales/pl.ts";
import { pt } from "./locales/pt.ts";
import { ru } from "./locales/ru.ts";
import { tr } from "./locales/tr.ts";
import { zh } from "./locales/zh.ts";

export const en = {
  "theme.label": "Theme",
  "theme.system": "System",
  "theme.light": "Light",
  "theme.dark": "Dark",
  "common.close": "Close",
  "common.loading": "Loading…",
  "common.cancel": "Cancel",
  "common.delete": "Delete",
  "shell.newChat": "New chat",
  "shell.skip": "Skip to the conversation",
  "shell.openSidebar": "Open conversations",
  "shell.conversations": "Conversations",
  "sidebar.apps": "Apps",
  "sidebar.agents": "Agents",
  "sidebar.manageAgents": "Manage agents",
  "sidebar.newAgent": "New agent",
  "sidebar.noAgents": "An agent has its own instructions, notes and computer.",
  "sidebar.recent": "Recent",
  "sidebar.search": "Search conversations",
  "sidebar.loading": "Loading…",
  "sidebar.empty": "Start one with New chat; they are kept on this computer.",
  "sidebar.emptyArchived": "No conversations.",
  "sidebar.showArchived": "Show archived",
  "sidebar.hideArchived": "Hide archived",
  "sidebar.routines": "Routines",
  "sidebar.legacyTasks": "Telegram & Boat tasks",
  "sidebar.settings": "Settings",
  "sidebar.rowActions": "Conversation actions",
  "sidebar.rename": "Rename",
  "sidebar.archive": "Archive",
  "sidebar.unarchive": "Unarchive",
  "sidebar.deleteAsk": "Delete…",
  "sidebar.deleteTitle": "Delete this conversation?",
  "sidebar.deleteBody": "Its messages and tool calls stored by this app are removed and cannot be restored. Claude's own copy of the session stays in your .claude folder.",
  "sidebar.renameLabel": "Conversation name",
  "sidebar.renameHint": "Enter to save, Escape to cancel",
  "sidebar.untitled": "New chat",
  "sidebar.archivedTag": "archived",
  "sidebar.showAll": "Show all conversations",
  "sidebar.showFewer": "Show fewer",
  "sidebar.showAllAgents": "Show all {n} agents",
  "sidebar.showFewerAgents": "Show fewer agents",
  "sidebar.agentActions": "Actions for {name}",
  "sidebar.agentSettings": "Agent settings",
  "sidebar.makeLead": "Make lead",
  "sidebar.removeLead": "Remove lead role",
  "sidebar.deleteAgent": "Delete agent…",
  "sidebar.noAgentsTitle": "No agents yet",
  "sidebar.emptyTitle": "No conversations yet",
  "sidebar.emptyAction": "Start a chat",
  "sidebar.loadingList": "Loading conversations",
  "time.now": "just now",
  "time.minutes": "{n} min ago",
  "time.hours": "{n} h ago",
  "time.yesterday": "yesterday",
  "time.days": "{n} days ago",
  "palette.title": "Go to",
  "palette.placeholder": "Search chats, agents and settings",
  "palette.empty": "Nothing matches.",
  "palette.newChat": "New chat",
  "palette.settings": "Settings",
  "palette.groupActions": "Actions",
  "palette.groupAgents": "Agents",
  "palette.groupChats": "Conversations",
  "palette.hint": "↑↓ to move, Enter to open, Esc to close",
  "status.working": "Working",
  "status.waiting": "Waiting for you",
  "status.unread": "Unread",
  "status.reset": "Needs a new session",
  "header.more": "More",
  "header.approvals": "Approvals",
  "header.files": "Files",
  "header.usage": "Usage",
  "header.agentForChat": "Agent for this chat",
  "header.noAgent": "No agent",
  "header.engine": "Choose engine and model",
  "header.reconnecting": "Reconnecting…",
  "header.unavailable": "Unavailable",
  "header.chatOnly": "chat only",
  "header.ready": "Ready",
  "notifications.title": "Notifications",
  "notifications.unread": "Notifications, {count} unread",
  "notifications.markAll": "Mark all read",
  "notifications.empty": "Nothing yet.",
  "chat.copy": "Copy message",
  "chat.copied": "Copied",
  "chat.working.thinking": "Thinking",
  "chat.working.tool": "Using {name}",
  "chat.working.waiting": "Waiting for you",
  "chat.loading": "Loading conversation",
  "chat.approval.show": "Show details",
  "chat.approval.hide": "Hide details",
  "composer.pasted": "Pasted text · {count} characters",
  "composer.removePasted": "Remove pasted text",
  "language.title": "App language",
  "language.description": "System default follows your browser language. Text not translated yet stays in English.",
  "language.label": "App language",
  "language.system": "System default",
  "language.english": "English",
  "language.spanish": "Español",
} as const;

export type MessageKey = keyof typeof en;
export const LOCALES = ["en", "de", "es", "fr", "it", "ja", "ko", "nl", "pl", "pt", "ru", "tr", "zh"] as const;
export type Locale = (typeof LOCALES)[number];
export type LanguageChoice = "system" | Locale;

export const LANGUAGE_KEY = "od-language";
export const LANGUAGE_CHOICES: readonly LanguageChoice[] = ["system", ...LOCALES];
export const LANGUAGE_LABELS: Record<Locale, string> = {
  en: "English",
  de: "Deutsch",
  es: "Español",
  fr: "Français",
  it: "Italiano",
  ja: "日本語",
  ko: "한국어",
  nl: "Nederlands",
  pl: "Polski",
  pt: "Português (Brasil)",
  ru: "Русский",
  tr: "Türkçe",
  zh: "简体中文",
};
export const LANGUAGE_TAGS: Record<Locale, string> = {
  en: "en",
  de: "de",
  es: "es",
  fr: "fr",
  it: "it",
  ja: "ja",
  ko: "ko",
  nl: "nl",
  pl: "pl",
  pt: "pt-BR",
  ru: "ru",
  tr: "tr",
  zh: "zh-CN",
};

export const es: Partial<Record<MessageKey, string>> = {
  "theme.label": "Tema",
  "theme.system": "Sistema",
  "theme.light": "Claro",
  "theme.dark": "Oscuro",
  "common.close": "Cerrar",
  "common.loading": "Cargando…",
  "common.cancel": "Cancelar",
  "common.delete": "Eliminar",
  "shell.newChat": "Nuevo chat",
  "shell.skip": "Saltar a la conversación",
  "shell.openSidebar": "Abrir conversaciones",
  "shell.conversations": "Conversaciones",
  "sidebar.apps": "Aplicaciones",
  "sidebar.agents": "Agentes",
  "sidebar.manageAgents": "Administrar agentes",
  "sidebar.newAgent": "Nuevo agente",
  "sidebar.noAgents": "Cada agente tiene sus propias instrucciones, notas y equipo.",
  "sidebar.recent": "Recientes",
  "sidebar.search": "Buscar conversaciones",
  "sidebar.loading": "Cargando…",
  "sidebar.empty": "Empieza con Nuevo chat; las conversaciones se guardan en este equipo.",
  "sidebar.emptyArchived": "No hay conversaciones.",
  "sidebar.showArchived": "Mostrar archivadas",
  "sidebar.hideArchived": "Ocultar archivadas",
  "sidebar.routines": "Rutinas",
  "sidebar.legacyTasks": "Tareas de Telegram y Boat",
  "sidebar.settings": "Configuración",
  "sidebar.rowActions": "Acciones de la conversación",
  "sidebar.rename": "Cambiar nombre",
  "sidebar.archive": "Archivar",
  "sidebar.unarchive": "Desarchivar",
  "sidebar.deleteAsk": "Eliminar…",
  "sidebar.deleteTitle": "¿Eliminar esta conversación?",
  "sidebar.deleteBody": "Se eliminarán de forma permanente sus mensajes y las llamadas a herramientas guardadas por esta aplicación. La copia de la sesión de Claude seguirá en tu carpeta .claude.",
  "sidebar.renameLabel": "Nombre de la conversación",
  "sidebar.renameHint": "Pulsa Intro para guardar o Esc para cancelar",
  "sidebar.untitled": "Nuevo chat",
  "sidebar.archivedTag": "archivada",
  "sidebar.showAll": "Mostrar todas las conversaciones",
  "sidebar.showFewer": "Mostrar menos",
  "sidebar.showAllAgents": "Mostrar los {n} agentes",
  "sidebar.showFewerAgents": "Mostrar menos agentes",
  "sidebar.agentActions": "Acciones de {name}",
  "sidebar.agentSettings": "Configuración del agente",
  "sidebar.makeLead": "Asignar como líder",
  "sidebar.removeLead": "Quitar el rol de líder",
  "sidebar.deleteAgent": "Eliminar agente…",
  "sidebar.noAgentsTitle": "Todavía no hay agentes",
  "sidebar.emptyTitle": "Todavía no hay conversaciones",
  "sidebar.emptyAction": "Iniciar un chat",
  "sidebar.loadingList": "Cargando conversaciones",
  "time.now": "ahora",
  "time.minutes": "hace {n} min",
  "time.hours": "hace {n} h",
  "time.yesterday": "ayer",
  "time.days": "hace {n} días",
  "palette.title": "Ir a",
  "palette.placeholder": "Buscar chats, agentes y configuración",
  "palette.empty": "No hay resultados.",
  "palette.newChat": "Nuevo chat",
  "palette.settings": "Configuración",
  "palette.groupActions": "Acciones",
  "palette.groupAgents": "Agentes",
  "palette.groupChats": "Conversaciones",
  "palette.hint": "↑↓ para moverte, Intro para abrir y Esc para cerrar",
  "status.working": "Trabajando",
  "status.waiting": "Esperando tu respuesta",
  "status.unread": "Sin leer",
  "status.reset": "Necesita una sesión nueva",
  "header.more": "Más",
  "header.approvals": "Aprobaciones",
  "header.files": "Archivos",
  "header.usage": "Uso",
  "header.agentForChat": "Agente de este chat",
  "header.noAgent": "Ningún agente",
  "header.engine": "Elegir motor y modelo",
  "header.reconnecting": "Reconectando…",
  "header.unavailable": "No disponible",
  "header.chatOnly": "solo chat",
  "header.ready": "Listo",
  "notifications.title": "Notificaciones",
  "notifications.unread": "Notificaciones, {count} sin leer",
  "notifications.markAll": "Marcar todo como leído",
  "notifications.empty": "Todavía no hay notificaciones.",
  "chat.copy": "Copiar mensaje",
  "chat.copied": "Copiado",
  "chat.working.thinking": "Pensando",
  "chat.working.tool": "Usando {name}",
  "chat.working.waiting": "Esperando tu respuesta",
  "chat.loading": "Cargando conversación",
  "chat.approval.show": "Mostrar detalles",
  "chat.approval.hide": "Ocultar detalles",
  "composer.pasted": "Texto pegado · {count} caracteres",
  "composer.removePasted": "Quitar el texto pegado",
  "language.title": "Idioma de la aplicación",
  "language.description": "La opción del sistema sigue el idioma del navegador. El texto aún no traducido se muestra en inglés.",
  "language.label": "Idioma de la aplicación",
  "language.system": "Idioma del sistema",
  "language.english": "English",
  "language.spanish": "Español",
};

const catalogs: Record<Locale, Partial<Record<MessageKey, string>>> = {
  en,
  de,
  es,
  fr,
  it,
  ja,
  ko,
  nl,
  pl,
  pt,
  ru,
  tr,
  zh,
};

function isLocale(value: string): value is Locale {
  return (LOCALES as readonly string[]).includes(value);
}

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export function parseLanguageChoice(value: unknown): LanguageChoice {
  return value === "system" || (typeof value === "string" && isLocale(value)) ? value : "system";
}

export function resolveLocale(choice: LanguageChoice, systemLocale: string): Locale {
  if (choice !== "system") return choice;
  const browserLocale = systemLocale.split("-")[0]?.toLowerCase() ?? "";
  return isLocale(browserLocale) ? browserLocale : "en";
}

export function readLanguage(storage: () => StorageLike): LanguageChoice {
  try {
    return parseLanguageChoice(storage().getItem(LANGUAGE_KEY));
  } catch {
    return "system";
  }
}

export function writeLanguage(storage: () => StorageLike, choice: LanguageChoice): boolean {
  try {
    if (choice === "system") storage().removeItem(LANGUAGE_KEY);
    else storage().setItem(LANGUAGE_KEY, choice);
    return true;
  } catch {
    return false;
  }
}

type DocumentLike = {
  documentElement: {
    lang: string;
    dataset: Record<string, string | undefined>;
  };
};

export function applyLanguage(doc: DocumentLike, choice: LanguageChoice, systemLocale: string): Locale {
  const locale = resolveLocale(choice, systemLocale);
  doc.documentElement.lang = LANGUAGE_TAGS[locale];
  doc.documentElement.dataset.languageChoice = choice;
  return locale;
}

export const LANGUAGE_INIT_SCRIPT =
  '(function(){var d=document.documentElement,c="system",s="en",a=' +
  JSON.stringify(LOCALES) +
  ';function ok(v){return a.indexOf(v)>=0}' +
  'try{var v=localStorage.getItem(' + JSON.stringify(LANGUAGE_KEY) + ');if(ok(v))c=v}catch(e){}' +
  'try{s=(navigator.language||"en").split("-")[0].toLowerCase()}catch(e){}' +
  'var l=c==="system"?(ok(s)?s:"en"):c;d.dataset.languageChoice=c;' +
  'd.lang=l==="pt"?"pt-BR":l==="zh"?"zh-CN":l})();';

export function translate(locale: Locale, key: string, params?: Record<string, string | number>): string {
  const template: string = catalogs[locale][key as MessageKey] ?? en[key as MessageKey] ?? key;
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => (name in params ? String(params[name]) : whole));
}

// English is retained for older call sites and source-oriented tests.
export function t(key: MessageKey | string, params?: Record<string, string | number>): string {
  return translate("en", key, params);
}
