import { render } from "svelte/server";
import AuditPackReport from "./AuditPackReport.svelte";
import type { AuditPackData } from "./audit-pack";

/**
 * Self-contained print stylesheet: the report must open and print to PDF
 * without any external assets (auditors archive single files).
 */
const PRINT_CSS = `
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body {
    font-family: Georgia, "Times New Roman", serif;
    color: #1a1a1a;
    max-width: 56rem;
    margin: 0 auto;
    padding: 2rem 1.5rem 4rem;
    line-height: 1.5;
  }
  header { border-bottom: 3px solid #1a1a1a; padding-bottom: 1rem; margin-bottom: 2rem; }
  h1 { font-size: 1.9rem; margin: 0 0 0.25rem; }
  .subtitle { font-size: 1.2rem; margin: 0 0 0.75rem; color: #444; }
  h2 { font-size: 1.25rem; border-bottom: 1px solid #999; padding-bottom: 0.25rem; margin-top: 2.5rem; }
  h3 { font-size: 1rem; margin-top: 1.25rem; }
  .ref { font-size: 0.8rem; color: #666; font-style: italic; margin-top: -0.5rem; }
  .disclaimer {
    border: 1px solid #999;
    background: #f6f6f6;
    padding: 0.75rem 1rem;
    font-size: 0.85rem;
    margin-top: 1rem;
  }
  table { width: 100%; border-collapse: collapse; margin: 0.5rem 0 1rem; font-size: 0.85rem; }
  th, td { border: 1px solid #bbb; padding: 0.3rem 0.5rem; text-align: left; vertical-align: top; }
  th { background: #efefef; }
  code { font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 0.85em; background: #f3f3f3; padding: 0 0.2em; }
  .small { font-size: 0.75rem; word-break: break-word; }
  .gap { color: #a31515; }
  footer { margin-top: 3rem; border-top: 1px solid #999; padding-top: 0.75rem; font-size: 0.75rem; color: #555; }
  a { color: #0a4ea3; }
  @page { margin: 18mm 14mm; }
  @media print {
    body { max-width: none; padding: 0; font-size: 11pt; }
    section { break-inside: avoid-page; }
    section:has(table) { break-inside: auto; }
    h2 { break-after: avoid-page; }
    tr { break-inside: avoid; }
    a { color: inherit; text-decoration: none; }
    a[href^="http"]::after { content: " (" attr(href) ")"; font-size: 0.75em; }
  }
`;

export function renderAuditPackHtml(data: AuditPackData): string {
  const { body } = render(AuditPackReport, { props: { data } });
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Audit Evidence Pack: ${escapeHtml(data.cover.organizationName)}</title>
<style>${PRINT_CSS}</style>
</head>
<body>
${body}
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}
