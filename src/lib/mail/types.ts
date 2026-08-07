export interface ThreadSnapshot {
  threadId: string;
  from: string;
  to: string[];
  subject: string;
  listId: string | null;
  attachments: string[];
  bodyText: string;
  internalDateMs: number;
  references: string[];
}

export interface MailClient {
  listNewThreads(sinceMs: number, opts?: { sent?: boolean }): Promise<ThreadSnapshot[]>;
  listHistory(opts: { months: number; maxThreads: number; sent?: boolean }): AsyncIterable<ThreadSnapshot>;
  ensureCategories(names: string[]): Promise<void>;
  applyCategories(threadId: string, names: string[]): Promise<void>;
  forward(threadId: string, to: string, contextBody: string): Promise<void>;
  sendMessage(to: string, subject: string, body: string): Promise<void>;
}
