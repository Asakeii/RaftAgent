import { lazy, Suspense } from "react";

const MarkdownMessage = lazy(() => import("./MarkdownMessage").then(module => ({ default: module.MarkdownMessage })));

export function MessageContent({ text }: { text: string }) {
  return <Suspense fallback={<div className="message-loading">{text}</div>}><MarkdownMessage text={text} /></Suspense>;
}
