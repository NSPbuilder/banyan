import 'server-only'
import { createHash } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import type {Tx} from './acting'
import type { UserRecord } from './users'
import { operationWrite, operationId, operationText, operationDate, operationAmount, OperationsError } from './operations-scope'

import type {AssetRow,AssetInput} from './asset-types'
import {financeSetting} from './operations-finance'
export type {AssetRow,AssetStatus,AssetInput} from './asset-types'

const columns = sql`id::text,code,name,category,acquired_on::text,in_service_on::text,warranty_until::text,
  acquisition_cost::text,supplier,serial_number,location,custodian,status,disposed_on::text,disposal_proceeds::text,notes,version`
export async function assetRows(ledgerId:string) {
  return db.execute<AssetRow>(sql`SELECT ${columns} FROM fixed_asset WHERE ledger_id=${operationId(ledgerId)}::uuid ORDER BY lower(code),id`)
}
export async function assetDetail(ledgerId:string,id:string) {
  const [asset] = await db.execute<AssetRow>(sql`SELECT ${columns} FROM fixed_asset WHERE ledger_id=${operationId(ledgerId)}::uuid AND id=${operationId(id)}::uuid`)
  if (!asset) return null
  const [activities,changes] = await Promise.all([
    db.execute<{id:string;activity_date:string;kind:string;note:string;cost:string;created_by:string}>(sql`SELECT id::text,activity_date::text,kind,note,cost::text,created_by FROM fixed_asset_activity
      WHERE ledger_id=${ledgerId}::uuid AND asset_id=${id}::uuid ORDER BY activity_date DESC,created_at DESC`),
    db.execute<{occurred_at:string;actor:string;action:string;old_status:string|null;status:string;location:string;custodian:string}>(sql`SELECT occurred_at::text,actor,action,
      before->>'status' AS old_status,after->>'status' AS status,after->>'location' AS location,after->>'custodian' AS custodian
      FROM audit_log WHERE ledger_id=${ledgerId}::uuid AND table_name='fixed_asset' AND record_id=${id} ORDER BY id DESC LIMIT 200`),
  ])
  return {asset,activities,changes}
}
export async function saveAsset(me:UserRecord,ledgerId:string,input:AssetInput) {
  return operationWrite(me,ledgerId,'/assets',async tx=>{
    if((await financeSetting(ledgerId,'/assets',tx))?.connected_on){
      const [old]=input.id?await tx.execute<{disposed_on:string|null}>(sql`SELECT disposed_on::text FROM fixed_asset WHERE ledger_id=${ledgerId}::uuid AND id=${input.id}::uuid`):[]
      if(!input.id||input.disposedOn&&(old?.disposed_on??'')!==input.disposedOn)throw new OperationsError('FINANCE_INPUT','Use the financed acquisition/disposal form to post this asset business.')
    }
    return saveAssetInTransaction(tx,ledgerId,input)
  })
}
export async function saveAssetInTransaction(tx:Tx,ledgerId:string,input:AssetInput) {
  const code=operationText(input.code,'Asset code',60,true),name=operationText(input.name,'Asset name',240,true)
  const category=operationText(input.category,'Category',120),supplier=operationText(input.supplier,'Supplier',240)
  const serial=operationText(input.serialNumber,'Serial number',120),location=operationText(input.location,'Location',240)
  const custodian=operationText(input.custodian,'Custodian',240),notes=operationText(input.notes,'Notes',10000)
  const acquired=operationDate(input.acquiredOn),service=input.inServiceOn?operationDate(input.inServiceOn):null
  const warranty=input.warrantyUntil?operationDate(input.warrantyUntil):null,disposed=input.disposedOn?operationDate(input.disposedOn):null
  if (!['in_use','in_storage','under_repair','disposed'].includes(input.status)) throw new OperationsError('STATUS','Choose an available asset status.')
  if (service && service<acquired || warranty && warranty<acquired || disposed && disposed<(service??acquired))
    throw new OperationsError('DATE','Service, warranty and disposal dates cannot precede acquisition or service.')
  if ((input.status==='disposed')!==!!disposed || input.status!=='disposed' && input.disposalProceeds!==0n)
    throw new OperationsError('DISPOSAL','A disposed asset needs a disposal date. Other assets cannot have disposal proceeds.')
  operationAmount(input.acquisitionCost);operationAmount(input.disposalProceeds)
  if(input.id)operationId(input.id)
    const duplicate=await tx.execute(sql`SELECT id FROM fixed_asset WHERE ledger_id=${ledgerId}::uuid AND lower(code)=lower(${code}) AND (${input.id??null}::uuid IS NULL OR id<>${input.id??null}::uuid)`)
    if(duplicate.length)throw new OperationsError('CODE','That asset code is already in use.')
    if(input.id) {
      operationId(input.id)
      const [old]=await tx.execute<{version:number;acquisition_cost:string;acquired_on:string}>(sql`SELECT version,acquisition_cost::text,acquired_on::text FROM fixed_asset WHERE ledger_id=${ledgerId}::uuid AND id=${input.id}::uuid FOR UPDATE`)
      if(!old)throw new OperationsError('ASSET','This asset is unavailable in this ledger.')
      if(old.version!==input.version)throw new OperationsError('STALE','This asset changed. Reload before saving.')
      const [depreciation]=await tx.execute<{latest:string|null;entries:string;start:string|null;residual:string}>(sql`SELECT (SELECT max(entry_date)::text FROM asset_depreciation_entry WHERE asset_id=${input.id}::uuid) AS latest,(SELECT count(*)::text FROM asset_depreciation_entry WHERE asset_id=${input.id}::uuid) AS entries,(SELECT start_date::text FROM asset_depreciation_policy WHERE asset_id=${input.id}::uuid) AS start,coalesce((SELECT residual_value FROM asset_depreciation_policy WHERE asset_id=${input.id}::uuid),0)::text AS residual`)
      if(depreciation.entries!=='0'&&(BigInt(old.acquisition_cost)!==input.acquisitionCost||old.acquired_on!==acquired)||depreciation.start&&acquired>depreciation.start||BigInt(depreciation.residual)>input.acquisitionCost||disposed&&depreciation.latest&&disposed<depreciation.latest)throw new OperationsError('DEPRECIATION_HISTORY','Acquisition and disposal must preserve the recorded depreciation policy and history. Use a manual depreciation adjustment for a correction.')
      if(old.acquired_on!==acquired&&(await tx.execute(sql`SELECT 1 FROM asset_cca_assignment WHERE asset_id=${input.id}::uuid`)).length)throw new OperationsError('CCA_HISTORY','Acquisition date is fixed after a CCA assignment. Review the tax assignment before changing it.')
      const [span]=await tx.execute<{first:string|null;last:string|null}>(sql`SELECT min(activity_date)::text AS first,max(activity_date)::text AS last FROM fixed_asset_activity WHERE ledger_id=${ledgerId}::uuid AND asset_id=${input.id}::uuid`)
      if(span?.first&&acquired>span.first || span?.last&&disposed&&disposed<span.last)throw new OperationsError('ACTIVITY_DATES','Acquisition and disposal must include the recorded activity dates.')
      await tx.execute(sql`UPDATE fixed_asset SET code=${code},name=${name},category=${category},acquired_on=${acquired}::date,in_service_on=${service}::date,warranty_until=${warranty}::date,
        acquisition_cost=${input.acquisitionCost},supplier=${supplier},serial_number=${serial},location=${location},custodian=${custodian},status=${input.status},disposed_on=${disposed}::date,
        disposal_proceeds=${input.disposalProceeds},notes=${notes},version=version+1,updated_at=clock_timestamp() WHERE ledger_id=${ledgerId}::uuid AND id=${input.id}::uuid`)
      return input.id
    }
    const [row]=await tx.execute<{id:string}>(sql`INSERT INTO fixed_asset(ledger_id,code,name,category,acquired_on,in_service_on,warranty_until,acquisition_cost,supplier,serial_number,location,custodian,status,disposed_on,disposal_proceeds,notes)
      VALUES(${ledgerId}::uuid,${code},${name},${category},${acquired}::date,${service}::date,${warranty}::date,${input.acquisitionCost},${supplier},${serial},${location},${custodian},${input.status},${disposed}::date,${input.disposalProceeds},${notes}) RETURNING id::text`)
    return row.id
}
export async function addAssetActivity(me:UserRecord,ledgerId:string,input:{assetId:string;date:string;kind:string;note:string;cost:bigint;key:string}) {
  operationId(input.assetId);operationId(input.key);operationDate(input.date);operationAmount(input.cost)
  const note=operationText(input.note,'Activity note',10000,true)
  if(!['maintenance','inspection','note'].includes(input.kind))throw new OperationsError('ACTIVITY','Choose maintenance, inspection or note.')
  const hash=createHash('sha256').update(JSON.stringify([input.assetId,input.date,input.kind,note,input.cost.toString()])).digest('hex')
  return operationWrite(me,ledgerId,'/assets',async(tx,s)=>{
    const [previous]=await tx.execute<{id:string;request_hash:string}>(sql`SELECT id::text,request_hash FROM fixed_asset_activity WHERE ledger_id=${ledgerId}::uuid AND request_key=${input.key}::uuid`)
    if(previous){if(previous.request_hash!==hash)throw new OperationsError('REPLAY','This request was already used with different values. Reload before trying again.');return previous.id}
    const [asset]=await tx.execute<{acquired_on:string;disposed_on:string|null}>(sql`SELECT acquired_on::text,disposed_on::text FROM fixed_asset WHERE ledger_id=${ledgerId}::uuid AND id=${input.assetId}::uuid`)
    if(!asset)throw new OperationsError('ASSET','This asset is unavailable in this ledger.')
    if(input.date<asset.acquired_on || asset.disposed_on && input.date>asset.disposed_on)throw new OperationsError('DATE','Activity must fall between acquisition and disposal.')
    const [row]=await tx.execute<{id:string}>(sql`INSERT INTO fixed_asset_activity(ledger_id,asset_id,activity_date,kind,note,cost,request_key,request_hash,created_by)
      VALUES(${ledgerId}::uuid,${input.assetId}::uuid,${input.date}::date,${input.kind},${note},${input.cost},${input.key}::uuid,${hash},${s.email}) RETURNING id::text`)
    return row.id
  })
}
