import { createHash } from 'node:crypto'

export type AuditHead = { chainId:string; scope:string; entityId:string|null; ledgerId:string|null; sequence:string; hash:string }
export type AuditCheckpoint = { format:'FigTree.audit.checkpoint.v1'; createdAt:string; heads:AuditHead[] }
export type AuditProof = { format:'FigTree.audit.proof.v1'; checkpoint:AuditCheckpoint;
  events:Array<{ chainId:string; sequence:string; previousHash:string; hash:string; canonical:string; display:string }>;
  origins?:Array<{ source_checksum:string; proof:AuditProof; mapping:Record<string,string> }> }
export type AuditIssue = {scope:string; type:string; sequence?:string|null; chainId?:string; auditId?:string}
export type AuditVerification = { format:string; ok:boolean; chains:string; issues:AuditIssue[]; legacyProtectedSince:string;
  tailProof:string; independentCheckpointCompared?:boolean; checkpointCreatedAt?:string }
export const ZERO_AUDIT_HASH='0'.repeat(64)
export const auditDigest=(bytes:string)=>createHash('sha256').update('FigTree.audit.v1\n').update(bytes,'utf8').digest('hex')

/** Mirrors the published SQL format; refuses numeric JS values rather than
 * guessing whether a parsed bigint was rounded. Bytewise UTF-8 key ordering. */
export function canonicalAudit(value:unknown):string {
  if(value===null)return 'null'
  if(typeof value==='string'||typeof value==='boolean')return JSON.stringify(value)
  if(Array.isArray(value))return '['+value.map(canonicalAudit).join(',')+']'
  if(typeof value==='object')return '{'+Object.entries(value as Record<string,unknown>)
    .sort(([a],[b])=>Buffer.compare(Buffer.from(a),Buffer.from(b)))
    .map(([k,v])=>JSON.stringify(k)+':'+canonicalAudit(v)).join(',')+'}'
  throw Error('Invalid audit encoding: numbers must be exact decimal strings.')
}
const hashPattern=/^[a-f0-9]{64}$/
const seqPattern=/^(0|[1-9][0-9]*)$/
const uuidPattern=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
export function assertCheckpoint(value:unknown):asserts value is AuditCheckpoint {
  const v=value as AuditCheckpoint
  if(!v||v.format!=='FigTree.audit.checkpoint.v1'||!Number.isFinite(Date.parse(v.createdAt))||!Array.isArray(v.heads)||v.heads.length>10000
    ||v.heads.some(h=>!h||typeof h.chainId!=='string'||!uuidPattern.test(h.chainId)||typeof h.scope!=='string'
      ||typeof h.sequence!=='string'||h.sequence.length>19||!seqPattern.test(h.sequence)||BigInt(h.sequence)>9223372036854775807n
      ||typeof h.hash!=='string'||!hashPattern.test(h.hash)
      ||(h.entityId!==null&&(typeof h.entityId!=='string'||!uuidPattern.test(h.entityId)))
      ||(h.ledgerId!==null&&(typeof h.ledgerId!=='string'||!uuidPattern.test(h.ledgerId))))
    ||new Set(v.heads.map(h=>h.chainId)).size!==v.heads.length)throw Error('Invalid audit checkpoint.')
}
/** Source proof is immutable provenance, never assigned new entity IDs. */
export function verifyAuditProof(proof:AuditProof, depth=0):void {
  if(!proof||proof.format!=='FigTree.audit.proof.v1'||!Array.isArray(proof.events)||depth>8)throw Error('Invalid audit origin proof.')
  assertCheckpoint(proof.checkpoint)
  const byChain=new Map(proof.checkpoint.heads.map(h=>[h.chainId,h]))
  const cursors=new Map<string,{seq:bigint;hash:string}>()
  for(const e of proof.events) {
    const h=byChain.get(e.chainId),c=cursors.get(e.chainId)??{seq:0n,hash:ZERO_AUDIT_HASH}
    if(!h||!seqPattern.test(e.sequence)||BigInt(e.sequence)!==c.seq+1n||e.previousHash!==c.hash)throw Error('Audit origin sequence/previous hash mismatch.')
    const v=JSON.parse(e.canonical)
    if(canonicalAudit(v)!==e.canonical||e.display!==e.canonical||auditDigest(e.canonical)!==e.hash
      ||v.formatVersion!=='1'||v.chainId!==h.chainId||v.sequence!==e.sequence||v.previousHash!==e.previousHash
      ||v.scope.key!==h.scope||v.scope.entityId!==h.entityId||v.scope.ledgerId!==h.ledgerId)throw Error('Audit origin payload/display/hash mismatch.')
    cursors.set(e.chainId,{seq:BigInt(e.sequence),hash:e.hash})
  }
  for(const h of byChain.values()) {
    const c=cursors.get(h.chainId)??{seq:0n,hash:ZERO_AUDIT_HASH}
    if(c.seq.toString()!==h.sequence||c.hash!==h.hash)throw Error('Audit origin head mismatch.')
  }
  for(const origin of proof.origins??[])verifyAuditProof(origin.proof,depth+1)
}
