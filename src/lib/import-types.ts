export const IMPORT_FILE_KINDS=['accounts','trial_balance','open_items','starting_trial_balance','starting_open_items','general_ledger','applications','bank_open_items','starting_bank_open_items'] as const
export type ImportFileKind=typeof IMPORT_FILE_KINDS[number]
export type ImportMode='opening'|'history'
export type ImportFormat={delimiter:','|';'|'\t'|'|';dateFormat:'ISO'|'DMY'|'MDY';amountFormat:'decimal_dot'|'decimal_comma'|'grouped_dot'|'grouped_comma';amountConvention:'signed'|'debit_credit';columns:Record<string,string>;ignoredColumns:string[]}
export type ImportAccount={type:'account';sourceAccount:string;name:string;accountType:'asset'|'liability'|'equity'|'revenue'|'expense'}
export type ImportBalance={type:'balance';sourceAccount:string;amount:string}
export type ImportItem={type:'item';sourceId:string;sourceAccount:string;sourceParty:string;direction:'sales'|'purchase';kind:'invoice'|'credit_note'|'unapplied';number:string;issuedOn:string;dueOn:string;amount:string;currency:string}
export type ImportGl={type:'gl';sourceId:string;sourceGroup:string;expectedLines:number;date:string;sourceAccount:string;sourceParty:string;amount:string;currency:string;documentType:'journal'|'payment'|'sales_invoice'|'sales_credit'|'purchase_bill'|'purchase_credit';number:string;dueOn:string;description:string}
export type ImportApplication={type:'application';sourceId:string;sourceTransactionId:string;targetDocumentId:string;amount:string}
export type ImportBankItem={type:'bank_item';sourceId:string;sourceAccount:string;date:string;amount:string;currency:string;number:string;description:string}
export type ImportData=ImportAccount|ImportBalance|ImportItem|ImportGl|ImportApplication|ImportBankItem
export type ImportStage={sourceLine:number;data:ImportData}
export type ImportIssue={level:'error'|'warning';code:string;message:string;fileId?:string;sourceLines?:number[]}
export type ImportCoverage={gl:'complete'|'partial'|'not_provided';parties:'complete'|'partial'|'not_provided';openItems:'complete'|'partial'|'not_provided';taxDetails:'partial'|'not_provided';bankReconciliation:'partial'|'not_provided';inventoryAssets:'not_provided';attachments:'not_provided'}

export const IMPORT_FIELDS:Record<ImportFileKind,string[]>={
  accounts:['source_account','name','account_type','row_type'],
  trial_balance:['source_account','amount','debit','credit','row_type'],
  starting_trial_balance:['source_account','amount','debit','credit','row_type'],
  open_items:['source_id','source_account','source_party','direction','kind','number','issued_on','due_on','amount','currency','row_type'],
  starting_open_items:['source_id','source_account','source_party','direction','kind','number','issued_on','due_on','amount','currency','row_type'],
  general_ledger:['source_id','source_group','expected_lines','date','source_account','source_party','amount','debit','credit','currency','document_type','number','due_on','description','row_type'],
  applications:['source_id','source_transaction_id','target_document_id','amount','row_type'],
  bank_open_items:['source_id','source_account','date','amount','currency','number','description','row_type'],
  starting_bank_open_items:['source_id','source_account','date','amount','currency','number','description','row_type'],
}
