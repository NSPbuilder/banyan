/** Client-safe data contracts for the operational inventory register. */
export type InventoryItem = {
  id:string;sku:string;name:string;kind:'finished_goods'|'raw_material'|'work_in_progress';unit:string;reorder_level:string;
  track_batches:boolean;track_serials:boolean;is_active:boolean;notes:string;version:number;on_hand:string;fifo_cost:string;has_movements:boolean
}
export type Warehouse = {id:string;code:string;name:string;is_default:boolean;is_active:boolean;version:number;on_hand:string}
export type InventorySettings = {warehouses_enabled:boolean;cost_method:'fifo'|'moving_average';version:number}
export type MovementKind = 'receipt'|'issue'|'transfer'|'adjust_in'|'adjust_out'
export const MOVEMENT_LABELS: Record<MovementKind,string> = {receipt:'Receipt',issue:'Issue',transfer:'Transfer',adjust_in:'Adjustment in',adjust_out:'Adjustment out'}
export type MovementRow = {id:string;item_id:string;sku:string;item_name:string;unit:string;sequence:string;movement_date:string;kind:MovementKind;from_name:string|null;to_name:string|null;quantity:string;cost:string;reference:string;note:string;created_by:string;cost_method:'fifo'|'moving_average'}
export type StockRow = {id:string;warehouse_id:string;warehouse_name:string;batch:string;serial:string;quantity:string}
export type CostLayerRow = {id:string;warehouse_name:string;acquired_on:string;fifo_order:string;quantity:string;cost:string;remaining_quantity:string;remaining_cost:string}
