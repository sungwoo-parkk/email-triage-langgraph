export interface ThreadSnapshot {
  threadId: string;
  from: string;
  subject: string;
  listId: string | null;
  attachments: string[];
  bodyText: string;
  internalDateMs: number;
}

export interface NormalizedEmail {
  threadId: string;
  fromAddr: string;
  fromDomain: string;
  subject: string;
  listId: string | null;
  attachments: string[];
  bodyExcerpt: string;
  internalDateMs: number;
}

const BODY_CHARS = 1200;

export function extractAddr(header: string): string {
  const m = header.match(/<([^>]+)>/);
  return (m ? m[1] : header).trim().toLowerCase();
}

function cleanBody(s: string): string {
  return s.replace(/\r/g, "").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

export function normalize(s: ThreadSnapshot): NormalizedEmail {
  const fromAddr = extractAddr(s.from);
  return {
    threadId: s.threadId,
    fromAddr,
    fromDomain: fromAddr.includes("@") ? fromAddr.split("@").pop()! : fromAddr,
    subject: s.subject,
    listId: s.listId,
    attachments: s.attachments,
    bodyExcerpt: cleanBody(s.bodyText).slice(0, BODY_CHARS),
    internalDateMs: s.internalDateMs,
  };
}
