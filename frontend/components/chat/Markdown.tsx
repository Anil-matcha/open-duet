"use client";

import { createContext, Fragment, memo, useContext, useState, type ReactNode } from "react";
import { copyToClipboard } from "@/lib/clipboard";
import { api, ApiError } from "@/lib/api";
import { parseMarkdown, workspaceRelativePath, type Block, type Inline } from "@/lib/markdown";

const WorkspaceDownloadContext = createContext<{ threadId: number | null; workspacePath: string | null }>({
  threadId: null,
  workspacePath: null,
});

function WorkspaceFileDownload({ path, children }: { path: string; children: ReactNode }) {
  const { threadId, workspacePath } = useContext(WorkspaceDownloadContext);
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const relative = workspaceRelativePath(path, workspacePath);

  if (threadId === null || relative === null) return <Fragment>{children}</Fragment>;

  const download = async () => {
    setDownloading(true);
    setError(null);
    try {
      const url = await api.workspaceDownloadUrl(threadId, relative);
      const link = document.createElement("a");
      link.href = url;
      link.download = relative.split("/").at(-1) || "download";
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not download this file.");
    } finally {
      setDownloading(false);
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={() => void download()}
        disabled={downloading}
        aria-busy={downloading}
        className="cursor-pointer text-accent underline underline-offset-2 hover:opacity-80 disabled:cursor-wait disabled:opacity-70"
      >
        {children}
        {downloading && <span className="ml-1 text-xs no-underline">Downloading…</span>}
      </button>
      {error && <span role="alert" className="ml-1 text-xs text-danger">{error}</span>}
    </>
  );
}

function renderInline(nodes: Inline[]): ReactNode {
  return nodes.map((node, i) => {
    switch (node.type) {
      case "text":
        return <Fragment key={i}>{node.text}</Fragment>;
      case "code":
        return (
          <code key={i} className="rounded bg-code px-1 py-0.5 font-mono text-[0.85em]">
            {node.text}
          </code>
        );
      case "strong":
        return <strong key={i}>{renderInline(node.children)}</strong>;
      case "em":
        return <em key={i}>{renderInline(node.children)}</em>;
      case "del":
        return <del key={i}>{renderInline(node.children)}</del>;
      case "link":
        return (
          <a
            key={i}
            href={node.href}
            target="_blank"
            rel="noopener noreferrer nofollow"
            className="text-accent underline underline-offset-2 hover:opacity-80"
          >
            {renderInline(node.children)}
          </a>
        );
      case "workspace-file":
        return (
          <WorkspaceFileDownload key={i} path={node.path}>
            {renderInline(node.children)}
          </WorkspaceFileDownload>
        );
    }
  });
}

function CodeBlock({ lang, text, closed }: { lang: string; text: string; closed: boolean }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    const ok = await copyToClipboard(text);
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  return (
    <div className="my-3 overflow-hidden rounded-field border border-line">
      <div className="flex items-center justify-between bg-inset px-3 py-1 text-xs text-muted">
        <span>{lang || "text"}</span>
        <button
          onClick={copy}
          disabled={!closed && text === ""}
          aria-label="Copy code"
          className="cursor-pointer rounded px-1.5 py-0.5 hover:bg-hover touch:px-3 touch:py-2"
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className="overflow-x-auto bg-code p-3 font-mono text-xs leading-relaxed text-ink">
        <code>{text}</code>
      </pre>
    </div>
  );
}

const HEADING_SIZE = ["", "text-xl", "text-lg", "text-base", "text-sm", "text-sm", "text-sm"];

function renderBlock(block: Block, key: number): ReactNode {
  switch (block.type) {
    case "paragraph":
      return (
        <p key={key} className="my-2 whitespace-pre-wrap break-words first:mt-0 last:mb-0">
          {renderInline(block.children)}
        </p>
      );
    case "heading":
      return (
        <p key={key} role="heading" aria-level={block.level} className={`mt-4 mb-1 font-semibold ${HEADING_SIZE[block.level]}`}>
          {renderInline(block.children)}
        </p>
      );
    case "code":
      return <CodeBlock key={key} lang={block.lang} text={block.text} closed={block.closed} />;
    case "quote":
      return (
        <blockquote key={key} className="my-2 border-l-2 border-line pl-3 text-muted">
          {block.blocks.map(renderBlock)}
        </blockquote>
      );
    case "list": {
      const Tag = block.ordered ? "ol" : "ul";
      return (
        <Tag
          key={key}
          start={block.ordered ? block.start : undefined}
          className={`my-2 space-y-1 pl-5 ${block.ordered ? "list-decimal" : "list-disc"}`}
        >
          {block.items.map((item, i) => (
            <li key={i} className="break-words">
              {renderInline(item)}
              {block.sub[i]?.length ? <div className="[&_ol]:my-1 [&_ul]:my-1">{block.sub[i].map(renderBlock)}</div> : null}
            </li>
          ))}
        </Tag>
      );
    }
    case "table":
      return (
        <div key={key} className="my-2 overflow-x-auto">
          <table className="min-w-full border-collapse text-xs">
            <thead>
              <tr>
                {block.header.map((cell, i) => (
                  <th
                    key={i}
                    style={{ textAlign: (block.align[i] ?? undefined) as "left" | "right" | "center" | undefined }}
                    className="border border-line bg-inset px-2 py-1 font-semibold"
                  >
                    {renderInline(cell)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, r) => (
                <tr key={r}>
                  {row.map((cell, i) => (
                    <td
                      key={i}
                      style={{ textAlign: (block.align[i] ?? undefined) as "left" | "right" | "center" | undefined }}
                      className="border border-line px-2 py-1"
                    >
                      {renderInline(cell)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case "rule":
      return <hr key={key} className="my-3 border-line" />;
  }
}

// An assistant answer as formatted text. It never renders raw HTML: the text is
// parsed to plain data first (see lib/markdown.ts), so it is safe on half-written
// answers while they stream.
export const Markdown = memo(function Markdown({
  text,
  threadId = null,
  workspacePath = null,
}: {
  text: string;
  threadId?: number | null;
  workspacePath?: string | null;
}) {
  return (
    <WorkspaceDownloadContext.Provider value={{ threadId, workspacePath }}>
      <div className="text-ink">{parseMarkdown(text).map(renderBlock)}</div>
    </WorkspaceDownloadContext.Provider>
  );
});
