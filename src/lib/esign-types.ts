export const DOCUMENT_KINDS = ['memo', 'contract', 'other'] as const
export type DocumentKind = typeof DOCUMENT_KINDS[number]
export type Recipient = { name: string; email: string; role: 'SIGNER' | 'APPROVER' | 'CC'; signingOrder: number }
export type SigningStatus = 'DRAFT' | 'PENDING' | 'COMPLETED' | 'REJECTED' | 'CANCELLED'
export type DocumentView = 'active' | 'completed' | 'archived'
export type SigningSnapshot = {
  id: string; externalId: string | null; status: SigningStatus; title: string; teamUrl: string;
  completedAt: string | null;
  recipients: Array<{ id: number; name: string; email: string; role: string; signingStatus: string; signingOrder: number | null; signedAt: string | null }>;
  items: Array<{ id: string; title: string }>;
  fields: Array<{ id: number; recipientId: number; itemId: string; type: string; page: number; x: number; y: number; width: number; height: number }>;
}
export type SigningRequest = {
  id: string; document_id: string; entity_id: string; connection_id: string | null;
  remote_id: string | null; team_url: string | null;
  operation: 'LOCAL' | 'CREATING' | 'UNCERTAIN' | 'LINKED' | 'DETACHED';
  remote_status: SigningStatus | null; recipients: Recipient[]; snapshot: SigningSnapshot | null;
  last_error: string | null; synced_at: string | null; completed_at: string | null; archived_at: string | null;
}
export type SigningDocument = {
  id: string; entity_id: string; title: string; kind: DocumentKind; note: string | null;
  revision: number; supersedes_id: string | null; created_at: string; created_by: string;
  request_id: string | null; remote_status: SigningStatus | null; operation: SigningRequest['operation'] | null;
  archived_at: string | null;
  completed_at: string | null;
  document_archived_at: string | null;
}
export type SigningFile = { id: string; document_id: string; kind: string; filename: string; sha256: string; byte_size: string }
export type ConnectionSummary = { id: string; enabled: boolean; readable: boolean; updated_at: string } | null
export function documentView(doc: Pick<SigningDocument, 'document_archived_at' | 'remote_status'>): DocumentView {
  if (doc.document_archived_at) return 'archived'
  return doc.remote_status === 'COMPLETED' ? 'completed' : 'active'
}
export function documentStatus(doc: Pick<SigningDocument, 'operation' | 'remote_status' | 'archived_at'>) {
  if (doc.operation === 'DETACHED') return 'Restored copy'
  if (doc.operation === 'CREATING' || doc.operation === 'UNCERTAIN') return 'Needs reconciliation'
  if (doc.remote_status === 'COMPLETED') return doc.archived_at ? 'Completed' : 'Completed · archive pending'
  return ({ DRAFT: 'Draft', PENDING: 'Awaiting signatures', REJECTED: 'Rejected', CANCELLED: 'Cancelled' } as const)[doc.remote_status ?? 'DRAFT']
}
