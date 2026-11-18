"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { linkedTextParts, parseMessageBlocks } from "./chat-message-utils";

function LinkedText({ text }: { text: string }) {
  return <>{linkedTextParts(text).map((part, index) => part.href
    ? <a key={index} href={part.href} target="_blank" rel="noopener noreferrer">{part.text}</a>
    : <span key={index}>{part.text}</span>)}</>;
}

function CodeBlock({ text, language }: { text: string; language: string }) {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");
  async function copy() {
    try { await navigator.clipboard.writeText(text); setCopied(true); setError(""); }
    catch { setCopied(false); setError("Не удалось скопировать. Выделите код и скопируйте вручную."); }
  }
  return <div className="message-code">
    <div className="message-code-header"><span className="message-code-language">{language || "Код"}</span>
      <button type="button" className="message-code-copy" onClick={copy} aria-label={copied ? "Код скопирован" : "Скопировать код"}>
        {copied ? <Check aria-hidden="true"/> : <Copy aria-hidden="true"/>}<span>{copied ? "Скопировано" : "Копировать"}</span>
      </button>
    </div><pre tabIndex={0} aria-label={language ? `Код: ${language}` : "Код"}><code>{text}</code></pre>
    <span className="message-copy-status" role="status">{error || (copied ? "Код скопирован." : "")}</span>
  </div>;
}

export function MessageContent({ body }: { body: string }) {
  return <div className="message-content">{parseMessageBlocks(body).map((block, index) => {
    if (block.type === "code") return <CodeBlock key={index} text={block.text} language={block.language}/>;
    if (block.type === "quote") return <blockquote className="message-quote" key={index}><LinkedText text={block.text}/></blockquote>;
    if (block.type === "list") {
      const List = block.ordered ? "ol" : "ul";
      return <List key={index}>{block.items.map((item, itemIndex) => <li key={itemIndex} value={block.numbers?.[itemIndex]}><LinkedText text={item}/></li>)}</List>;
    }
    return <p key={index}><LinkedText text={block.text}/></p>;
  })}</div>;
}
