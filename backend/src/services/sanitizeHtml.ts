import sanitize from 'sanitize-html';

const SAFE_STYLE_VALUE = /^(?!.*(?:url\s*\(|expression|javascript:|\\|@import|behavior|-moz-binding)).*$/i;
const styleProps = [
  'color',
  'background-color',
  'font',
  'font-size',
  'font-family',
  'font-weight',
  'font-style',
  'text-align',
  'text-decoration',
  'text-transform',
  'letter-spacing',
  'line-height',
  'vertical-align',
  'white-space',
  'width',
  'min-width',
  'max-width',
  'height',
  'min-height',
  'max-height',
  'display',
  'padding',
  'padding-top',
  'padding-right',
  'padding-bottom',
  'padding-left',
  'margin',
  'margin-top',
  'margin-right',
  'margin-bottom',
  'margin-left',
  'border',
  'border-top',
  'border-right',
  'border-bottom',
  'border-left',
  'border-color',
  'border-style',
  'border-width',
  'border-radius',
  'border-collapse',
  'border-spacing',
  'table-layout',
  'list-style-type',
];
const allowedStyles = { '*': Object.fromEntries(styleProps.map((p) => [p, [SAFE_STYLE_VALUE]])) };

const SAFE_DATA_IMAGE = /^data:image\/(?:png|jpe?g|gif|webp);base64,[a-z0-9+/=\s]+$/i;
const CID_SRC = /^cid:(.+)$/i;

export interface SanitizeOptions {
  /** Content-ID (without angle brackets) -> data: URI for embedded images. */
  inlineImages?: Record<string, string>;
}

/**
 * Sanitises untrusted email HTML into a fragment that is safe to place in a sandboxed iframe.
 * Removes scripts, style blocks, iframes/objects/embeds/forms, event handlers, and any URL
 * scheme other than http(s)/mailto/tel (plus data: images and resolved cid: images).
 */
export function sanitizeEmailHtml(html: string, options: SanitizeOptions = {}): string {
  const inline = options.inlineImages ?? {};
  return sanitize(html, {
    allowedTags: [
      'a', 'abbr', 'b', 'bdi', 'bdo', 'big', 'blockquote', 'br', 'caption', 'center', 'cite', 'code', 'col',
      'colgroup', 'dd', 'del', 'details', 'dfn', 'div', 'dl', 'dt', 'em', 'font', 'h1', 'h2', 'h3', 'h4', 'h5',
      'h6', 'hr', 'i', 'img', 'ins', 'kbd', 'li', 'mark', 'ol', 'p', 'pre', 's', 'samp', 'small', 'span', 'strike',
      'strong', 'sub', 'summary', 'sup', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'tt', 'u', 'ul',
    ],
    allowedAttributes: {
      '*': ['style', 'title', 'dir', 'lang', 'align'],
      a: ['href', 'name', 'target', 'rel'],
      img: ['src', 'alt', 'width', 'height'],
      font: ['color', 'size', 'face'],
      table: ['width', 'height', 'border', 'cellpadding', 'cellspacing', 'bgcolor'],
      td: ['colspan', 'rowspan', 'width', 'height', 'valign', 'bgcolor'],
      th: ['colspan', 'rowspan', 'width', 'height', 'valign', 'bgcolor'],
      tr: ['bgcolor', 'valign'],
      col: ['span', 'width'],
      colgroup: ['span', 'width'],
      ol: ['start', 'type'],
    },
    allowedStyles,
    allowedSchemes: ['http', 'https', 'mailto', 'tel'],
    allowedSchemesByTag: { img: ['http', 'https', 'data'] },
    allowProtocolRelative: false,
    disallowedTagsMode: 'discard',
    transformTags: {
      a: (tagName, attribs) => ({
        tagName,
        attribs: { ...attribs, target: '_blank', rel: 'noopener noreferrer nofollow' },
      }),
      img: (tagName, attribs) => {
        const src = (attribs['src'] ?? '').trim();
        const cid = CID_SRC.exec(src);
        let resolved = src;
        if (cid) resolved = inline[decodeURIComponentSafe(cid[1] as string)] ?? '';
        else if (/^data:/i.test(src) && !SAFE_DATA_IMAGE.test(src)) resolved = '';
        const next: Record<string, string> = { ...attribs };
        if (resolved) next['src'] = resolved;
        else delete next['src'];
        return { tagName, attribs: next };
      },
    },
  });
}

function decodeURIComponentSafe(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

const ENTITIES: Record<string, string> = {
  '&nbsp;': ' ',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&amp;': '&',
};

/** Plain text rendering of an HTML body (used for previews and code extraction when no text part exists). */
export function htmlToText(html: string): string {
  const stripped = sanitize(html.replace(/<(br|\/p|\/div|\/tr|\/li|\/h[1-6])\s*\/?>/gi, '\n'), {
    allowedTags: [],
    allowedAttributes: {},
    nonTextTags: ['script', 'style', 'textarea', 'option', 'noscript', 'head', 'title'],
  });
  return stripped
    .replace(/&(?:nbsp|lt|gt|quot|#39|amp);/g, (e) => ENTITIES[e] ?? e)
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
}
