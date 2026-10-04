import type { CodeView, LinkView } from './types';

/** Highest confidence first; the sort is stable so ties keep server order. */
export function sortCodes(codes: CodeView[]): CodeView[] {
  return [...codes].sort((a, b) => b.confidence - a.confidence);
}

/** Verification links first, then the server order. */
export function sortLinks(links: LinkView[]): LinkView[] {
  return [...links].sort((a, b) => Number(b.isVerification) - Number(a.isVerification));
}
