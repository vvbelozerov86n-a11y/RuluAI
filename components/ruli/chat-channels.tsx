"use client";

import { useId, useRef, useState } from "react";
import { Bot, ChevronDown, MessageSquare, Search, Users, X } from "lucide-react";

export type ChatChannelItem = {
  id: string;
  name: string;
  label: string;
  description: string;
  initials: string;
  color: string;
  type: "human" | "bot";
  href: string;
  configuration?: { label: string; state: "ready" | "missing" | "disabled" };
};

export function ChatChannels({ channels, selectedId, generalHref }: {
  channels: ChatChannelItem[];
  selectedId?: string;
  generalHref: string;
}) {
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const menuId = useId();
  const search = query.trim().toLocaleLowerCase("ru-RU");
  const visible = channels.filter(channel => `${channel.label} ${channel.name} ${channel.description}`.toLocaleLowerCase("ru-RU").includes(search));
  const selected = channels.find(channel => channel.id === selectedId);
  const sections = [
    { type: "human" as const, label: "Команда", icon: <Users aria-hidden="true" /> },
    { type: "bot" as const, label: "AI", icon: <Bot aria-hidden="true" /> },
  ];

  return <aside className="chat-sidebar" data-expanded={expanded ? "true" : "false"}>
    <button className="chat-mobile-toggle" type="button" aria-expanded={expanded} aria-controls={menuId} onClick={() => setExpanded(value => !value)}>
      <MessageSquare aria-hidden="true" />
      <span><strong>Диалоги</strong><small>{selected?.label ?? "Общий чат"}</small></span>
      <ChevronDown className="chat-channel-chevron" aria-hidden="true" />
    </button>
    <div className="chat-channel-menu" id={menuId}>
      <div className="chat-sidebar-heading"><h3>Диалоги</h3><span>{channels.length + 1}</span></div>
      {channels.length > 0 ? <div className="chat-channel-search">
        <Search aria-hidden="true" />
        <input ref={inputRef} type="search" aria-label="Поиск диалогов" placeholder="Найти диалог" value={query} onChange={event => setQuery(event.target.value)} />
        {query ? <button type="button" aria-label="Очистить поиск диалогов" onClick={() => { setQuery(""); inputRef.current?.focus(); }}><X aria-hidden="true" /></button> : null}
      </div> : null}
      <nav className="chat-channel-list" aria-label="Диалоги задачи">
        <a className="chat-channel-link chat-channel-general" href={generalHref} aria-current={!selectedId ? "page" : undefined}>
          <span className="chat-channel-avatar general"><MessageSquare aria-hidden="true" /></span>
          <span className="chat-channel-copy"><strong>Общий чат</strong><small>Обсуждение задачи</small></span>
        </a>
        {sections.map(section => {
          const entries = visible.filter(channel => channel.type === section.type);
          if (!entries.length) return null;
          return <section className="chat-channel-group" key={section.type} aria-label={section.label}>
            <h4>{section.icon}<span>{section.label}</span><small>{entries.length}</small></h4>
            {entries.map(channel => <a className="chat-channel-link" key={channel.id} href={channel.href} aria-current={selectedId === channel.id ? "page" : undefined} title={channel.name}>
              <span className={`chat-channel-avatar ${channel.type}`} data-color={channel.color} aria-hidden="true">{channel.type === "bot" ? <Bot /> : channel.initials || channel.name.slice(0, 1)}</span>
              <span className="chat-channel-copy">
                <strong>{channel.label}</strong>
                <small>{channel.description}</small>
                {channel.configuration ? <span className={`chat-config-label ${channel.configuration.state}`}>{channel.configuration.label}</span> : null}
              </span>
            </a>)}
          </section>;
        })}
        {search && !visible.length ? <p className="chat-channel-empty" role="status">Диалог не найден. Попробуйте другое имя.</p> : null}
      </nav>
      <p className="chat-sidebar-note">Личные диалоги видны только руководителю и собеседнику.</p>
    </div>
  </aside>;
}
