export type TaxRecognition='profit_loss'|'oci'|'equity'
export const TAX_RECOGNITION:Record<TaxRecognition,string>={profit_loss:'Income tax expense — deferred',oci:'Other comprehensive income — tax',equity:'Equity — tax adjustment'}
export type TaxJournalLine={account:string;debit:string;credit:string}
export type DeferredTaxReview={
  id:string;pool_id:string;cca_year_id:string;reporting_date:string;revision:number;rate_bp:number;rate_note:string;
  book_value:string;closing_ucc:string;pending_tax_cost:string;book_adjustment:string;tax_adjustment:string;tax_base:string;temporary_difference:string;
  liability:string;potential_asset:string;recognized_asset:string;previous_liability:string;previous_asset:string;recognition:TaxRecognition;
  note:string;policy_version:string;created_by:string;journal:TaxJournalLine[]
}
export type DeferredTaxInput={ccaYearId:string;rateBp:number;rateNote:string;bookAdjustment:bigint;taxAdjustment:bigint;recognizedAsset:bigint;openingLiability:bigint;openingAsset:bigint;recognition:TaxRecognition;scopeReviewed:boolean;note:string}
