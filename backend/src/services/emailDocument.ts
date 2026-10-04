/**
 * Wraps an ALREADY SANITISED email HTML fragment in a standalone document for display in a
 * sandboxed iframe. The CSP is delivered as an HTTP header by the route (see messages.ts) and
 * repeated here as a <meta> so the document is also safe when saved or embedded elsewhere.
 */
export function emailCsp(allowRemoteImages: boolean): string {
  const images = allowRemoteImages ? 'data: https: http:' : 'data:';
  return [
    "default-src 'none'",
    `img-src ${images}`,
    "style-src 'unsafe-inline'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'self'",
    'sandbox allow-popups allow-popups-to-escape-sandbox',
  ].join('; ');
}

export function buildEmailDocument(sanitisedHtml: string, allowRemoteImages: boolean): string {
  // `sandbox` is not honoured inside <meta> CSP, so it is omitted there.
  const metaCsp = emailCsp(allowRemoteImages).replace(/;\s*sandbox[^;]*$/, '').replace(/;\s*frame-ancestors[^;]*/, '');
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${metaCsp}">
<meta name="referrer" content="no-referrer">
<meta name="viewport" content="width=device-width, initial-scale=1">
<base target="_blank">
<style>
  html { background: #fff; color: #1a1a1a; }
  body { margin: 0; padding: 16px; font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; overflow-wrap: anywhere; }
  img { max-width: 100%; height: auto; }
  table { max-width: 100%; }
  a { color: #0b57d0; }
  pre { white-space: pre-wrap; }
</style>
</head>
<body>
${sanitisedHtml}
</body>
</html>
`;
}
