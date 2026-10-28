'use client'
import { useState } from 'react'
import { ActionForm, type FormAction } from '@/components/ActionForm'
import { Floating } from '@/components/Floating'
import { DateInput } from '@/components/DateInput'
import { FormFields, FormSection, FORM_FIELD, FORM_FIELD_SHORT, FORM_FIELD_FULL } from '@/components/FormLayout'
import { BUTTON, QUIET, FIELD, LABEL } from '@/lib/ui'
import { quantityInput, formatQuantity } from '@/lib/quantity'
import type { InventoryItem,InventorySettings,Warehouse,MovementKind } from '@/lib/inventory-types'
import { MOVEMENT_LABELS } from '@/lib/inventory-types'
import {OperationsFinanceFields} from '@/components/OperationsFinanceFields'
import type {FinanceSetting,FundingOption} from '@/lib/operations-finance-types'
const input=`${FIELD} mt-1 block w-full`,label=`${LABEL} ${FORM_FIELD}`,short=`${LABEL} ${FORM_FIELD_SHORT}`
export function ItemForm({ledgerId,item,action}:{ledgerId:string;item?:InventoryItem;action:FormAction}) {
  const locked=item?.has_movements??false
  return <Floating label={item?'Edit item':'Add item'} title={item?'Edit inventory item':'Add inventory item'} buttonClassName={item?QUIET:BUTTON}>
    <ActionForm action={action} submit={item?'Save changes':'Add item'} working="Saving…" buttonClassName={BUTTON} className="mt-5 space-y-6" stickyActions>
      <input type="hidden" name="ledgerId" value={ledgerId}/>{item&&<><input type="hidden" name="itemId" value={item.id}/><input type="hidden" name="version" value={item.version}/></>}
      <FormSection title="Item identity"><FormFields>
        <label className={short}>SKU<input name="sku" required maxLength={60} defaultValue={item?.sku} className={input}/></label>
        <label className={label}>Item name<input name="name" required maxLength={240} defaultValue={item?.name} className={input}/></label>
        <label className={short}>Type<select aria-label="Type" name="kind" disabled={locked} defaultValue={item?.kind??'finished_goods'} className={input}><option value="finished_goods">Finished goods</option><option value="raw_material">Raw material</option><option value="work_in_progress">Work in progress</option></select>{locked&&<input type="hidden" name="kind" value={item!.kind}/>}</label>
        <label className={short}>Unit<input name="unit" required maxLength={30} defaultValue={item?.unit??'each'} readOnly={locked} className={input}/></label>
        <label className={short}>Reorder level<input name="reorderLevel" required inputMode="decimal" defaultValue={item?quantityInput(item.reorder_level):'0'} className={`${input} text-right tabular-nums`}/></label>
        {item&&<label className={short}>Availability<select aria-label="Availability" name="isActive" defaultValue={String(item.is_active)} className={input}><option value="true">Active</option><option value="false">Archived</option></select></label>}
      </FormFields></FormSection>
      <FormSection title="Optional tracking" description={locked?'Type, unit and tracking are fixed after stock or production history exists.':'Choose the tracking needed for this item. Both can be used together.'}>
        <div className="space-y-3 text-body"><label className="flex items-center gap-2"><input type="checkbox" style={{width:'auto'}} className="shrink-0" name="trackBatches" defaultChecked={item?.track_batches} disabled={locked}/>Track batches</label>
          <label className="flex items-center gap-2"><input type="checkbox" style={{width:'auto'}} className="shrink-0" name="trackSerials" defaultChecked={item?.track_serials} disabled={locked}/>Track individual serial numbers</label>
          {locked&&<>{item?.track_batches&&<input type="hidden" name="trackBatches" value="on"/>}{item?.track_serials&&<input type="hidden" name="trackSerials" value="on"/>}</>}
        </div>
      </FormSection>
      <label className={`${LABEL} ${FORM_FIELD_FULL}`}>Notes<textarea name="notes" rows={3} maxLength={10000} defaultValue={item?.notes} className={input}/></label>
    </ActionForm>
  </Floating>
}
export function InventorySettingsForm({ledgerId,settings,action}:{ledgerId:string;settings:InventorySettings;action:FormAction}) {
  return <Floating label="Settings" title="Inventory settings" buttonClassName={QUIET}><ActionForm action={action} submit="Save settings" working="Saving…" buttonClassName={BUTTON} className="mt-5 space-y-5" stickyActions>
    <input type="hidden" name="ledgerId" value={ledgerId}/><input type="hidden" name="version" value={settings.version}/>
    <label className="flex items-center gap-2 text-body font-medium"><input type="checkbox" name="warehousesEnabled" defaultChecked={settings.warehouses_enabled}/>Use multiple warehouses</label>
    <p className="max-w-prose text-body text-ink-secondary">When off, all stock uses the main location. Before turning this off, transfer stock from other warehouses to the main warehouse.</p>
    <label className={label}>Cost method<select aria-label="Cost method" name="costMethod" defaultValue={settings.cost_method} className={input}><option value="fifo">FIFO</option><option value="moving_average">Moving average</option></select></label>
    <p className="max-w-prose text-body text-ink-secondary">FIFO issues the oldest receipt costs. Moving average pools costs by item and warehouse. Clear all stock and close production orders before changing methods. Each movement keeps its original method.</p>
    <p className="text-metadata text-ink-muted">Batch and serial tracking are optional for each item and are fixed after its first movement.</p>
  </ActionForm></Floating>
}
export function WarehouseForm({ledgerId,warehouse,action}:{ledgerId:string;warehouse?:Warehouse;action:FormAction}) {
  return <Floating label={warehouse?'Edit':'Add warehouse'} title={warehouse?'Edit warehouse':'Add warehouse'} buttonClassName={warehouse?QUIET:BUTTON} ariaLabel={warehouse?`Edit warehouse ${warehouse.name}`:undefined}>
    <ActionForm action={action} submit={warehouse?'Save changes':'Add warehouse'} working="Saving…" buttonClassName={BUTTON} className="mt-5 space-y-4" stickyActions>
      <input type="hidden" name="ledgerId" value={ledgerId}/>{warehouse&&<><input type="hidden" name="warehouseId" value={warehouse.id}/><input type="hidden" name="version" value={warehouse.version}/></>}
      <FormFields><label className={short}>Code<input name="code" required maxLength={60} defaultValue={warehouse?.code} className={input}/></label>
        <label className={label}>Warehouse name<input name="name" required maxLength={240} defaultValue={warehouse?.name} className={input}/></label>
        {warehouse&&!warehouse.is_default&&<label className={short}>Availability<select aria-label="Availability" name="isActive" defaultValue={String(warehouse.is_active)} className={input}><option value="true">Active</option><option value="false">Archived</option></select></label>}
      </FormFields>
    </ActionForm>
  </Floating>
}
export function StockMovementForm({ledgerId,item,settings,warehouses,currency,today,requestKey,action,initialKind='receipt',finance,accounts=[]}:{ledgerId:string;item:InventoryItem;settings:InventorySettings;warehouses:Warehouse[];currency:string;today:string;requestKey:string;action:FormAction;initialKind?:MovementKind;finance?:FinanceSetting|null;accounts?:FundingOption[]}) {
  const [kind,setKind]=useState<MovementKind>(initialKind),[key,setKey]=useState(requestKey)
  const incoming=kind==='receipt'||kind==='adjust_in',outgoing=kind==='issue'||kind==='adjust_out'
  const available=warehouses.filter(w=>w.is_active),main=available.find(w=>w.is_default)
  const kinds=(Object.keys(MOVEMENT_LABELS) as MovementKind[]).filter(k=>settings.warehouses_enabled||k!=='transfer')
  return <Floating label="Record movement" title="Record stock movement" buttonClassName={BUTTON}>
    <ActionForm action={action} submit={kind==='receipt'?'Receive stock':kind==='issue'?'Issue stock':kind==='transfer'?'Transfer stock':'Record adjustment'} working="Recording…" buttonClassName={BUTTON} className="mt-5 space-y-5" stickyActions onSucceeded={()=>setKey(crypto.randomUUID())} requestError="The result could not be confirmed. Check the movement history before trying again; keep this form open to retry the same request.">
      <input type="hidden" name="ledgerId" value={ledgerId}/><input type="hidden" name="itemId" value={item.id}/><input type="hidden" name="requestKey" value={key}/>
      <p className="text-body"><strong>{item.sku} · {item.name}</strong><span className="ml-3 text-ink-muted">{formatQuantity(item.on_hand)} {item.unit} on hand</span></p>
      <FormFields><label className={short}>Movement<select aria-label="Movement" name="kind" value={kind} onChange={e=>setKind(e.target.value as MovementKind)} className={input}>{kinds.map(k=><option key={k} value={k}>{MOVEMENT_LABELS[k]}</option>)}</select></label>
        <label className={short}>Date<DateInput name="date" required defaultValue={today} className={input}/></label>
        <label className={short}>Quantity ({item.unit})<input name="quantity" required inputMode="decimal" className={`${input} text-right tabular-nums`}/></label>
        {incoming&&<label className={short}>Total receipt cost ({currency})<input name="cost" required inputMode="decimal" className={`${input} text-right tabular-nums`}/></label>}
      </FormFields>
      {settings.warehouses_enabled&&<FormFields>
        {!incoming&&<label className={label}>From warehouse<select aria-label="From warehouse" name="fromWarehouseId" required defaultValue={main?.id??''} className={input}><option value="">Choose a warehouse…</option>{available.map(w=><option key={w.id} value={w.id}>{w.code} · {w.name}</option>)}</select></label>}
        {!outgoing&&<label className={label}>{kind==='transfer'?'To warehouse':'Warehouse'}<select aria-label={kind==='transfer'?'To warehouse':'Warehouse'} name="toWarehouseId" required defaultValue={kind==='transfer'?'':main?.id??''} className={input}><option value="">Choose a warehouse…</option>{available.map(w=><option key={w.id} value={w.id}>{w.code} · {w.name}</option>)}</select></label>}
      </FormFields>}
      {item.track_batches&&<label className={label}>Batch<input name="batch" required maxLength={120} className={input}/></label>}
      {item.track_serials&&<label className={`${LABEL} ${FORM_FIELD_FULL}`}>Serial numbers · one per line<textarea name="serials" required rows={5} className={input}/><span className="mt-1 block text-metadata text-ink-muted">Enter one serial number for each whole unit. {kind==='adjust_in'?'Returned serial numbers must not already be on hand.':incoming?'Serial numbers must be new for this item. Use Adjustment in for returns.':'Use serial numbers currently held in the source warehouse.'}</span></label>}
      <label className={label}>Reference<input name="reference" maxLength={240} placeholder="Delivery, sales or count reference" className={input}/></label>
      {kind!=='transfer'&&<OperationsFinanceFields key={kind} options={accounts} defaultFunding={kind==='receipt'?finance?.funding_account_id:undefined} currency={currency} label={kind==='receipt'?'Funding account':'Expense account'} kinds={kind==='receipt'?['asset','liability','equity']:['expense']} tax={kind==='receipt'} optional={kind!=='receipt'}/>}
      <label className={`${LABEL} ${FORM_FIELD_FULL}`}>{kind.startsWith('adjust_')?'Adjustment reason':'Notes'}<textarea name="note" required={kind.startsWith('adjust_')} rows={3} maxLength={10000} className={input}/></label>
      <p className="max-w-prose text-metadata text-ink-muted">{incoming?'Enter the total cost for this receipt, including a zero cost when appropriate.':`Cost is calculated using ${settings.cost_method==='moving_average'?'moving average':'FIFO'}. Batch and serial selection track the physical stock independently.`} Movements are retained; record a new adjustment to correct a quantity.</p>
    </ActionForm>
  </Floating>
}
