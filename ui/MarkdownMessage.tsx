import { Children, isValidElement, memo, useEffect, useRef, useState, type ComponentPropsWithoutRef } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import rehypeHighlight from "rehype-highlight";
import "./markdown.css";

function CodeBlock({ children }: ComponentPropsWithoutRef<"pre">) {
  const pre = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState<"idle" | "done" | "failed">("idle");
  useEffect(() => {
    if (copied === "idle") return;
    const timeout = setTimeout(() => setCopied("idle"), 2000);
    return () => clearTimeout(timeout);
  }, [copied]);
  const code = Children.toArray(children).find(child => isValidElement(child));
  const language = isValidElement<{ className?: string }>(code) ? /language-([^\s]+)/.exec(code.props.className ?? "")?.[1] : undefined;
  const copy = async () => {
    try { await navigator.clipboard.writeText(pre.current?.textContent ?? ""); setCopied("done"); }
    catch { setCopied("failed"); }
  };
  return <div className="code-block">
    <div className="code-toolbar"><span>{language || "纯文本"}</span><button type="button" onClick={() => void copy()} aria-label="复制代码"><span aria-live="polite">{copied === "done" ? "已复制" : copied === "failed" ? "复制失败，请手动选择" : "复制代码"}</span></button></div>
    <pre ref={pre} tabIndex={0} aria-label={language ? `${language} 代码` : "代码"}>{children}</pre>
  </div>;
}

const components: Components = {
  pre: CodeBlock,
  table: ({ children }) => <div className="markdown-table" tabIndex={0} role="region" aria-label="消息表格"><table>{children}</table></div>,
  a: ({ href, children, title }) => {
    // 普通网页在系统浏览器打开；本地路径只呈现，避免把文件路径当作应用路由。
    const external = href && /^(https?:|mailto:)/i.test(href);
    if (!external && !href?.startsWith("#")) return <span className="markdown-path" title={href || title}>{children}</span>;
    return <a href={href} title={title} {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}>{children}</a>;
  },
  // 消息不自动请求远程图片；沿用桌面 CSP，以可打开的图片链接呈现。
  img: ({ src, alt }) => typeof src === "string" && /^https?:/i.test(src)
    ? <a className="markdown-image-link" href={src} target="_blank" rel="noopener noreferrer">↗ {alt || "查看图片"}</a>
    : <span className="markdown-path">{alt || "图片"}</span>,
};
const remarkPlugins = [remarkGfm, remarkBreaks];
const rehypePlugins = [rehypeHighlight];

export const MarkdownMessage = memo(function MarkdownMessage({ text }: { text: string }) {
  return <div className="prose"><Markdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} components={components} skipHtml>{text}</Markdown></div>;
});
