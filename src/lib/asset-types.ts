export type AssetStatus = 'in_use' | 'in_storage' | 'under_repair' | 'disposed'
export type AssetRow = {
  id:string; code:string; name:string; category:string; acquired_on:string; in_service_on:string|null; warranty_until:string|null;
  acquisition_cost:string; supplier:string; serial_number:string; location:string; custodian:string; status:AssetStatus;
  disposed_on:string|null; disposal_proceeds:string; notes:string; version:number
}
export type AssetInput = {
  id?:string; version?:number; code:string; name:string; category:string; acquiredOn:string; inServiceOn:string;
  warrantyUntil:string; acquisitionCost:bigint; supplier:string; serialNumber:string; location:string; custodian:string;
  status:AssetStatus; disposedOn:string; disposalProceeds:bigint; notes:string
}
export const ASSET_STATUSES:Record<AssetStatus,string>={in_use:'In use',in_storage:'In storage',under_repair:'Under repair',disposed:'Disposed'}
