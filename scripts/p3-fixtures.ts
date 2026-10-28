/** Independently calculated CSV fixture. Expected ending cents are literal, not computed by the importer. */
export const HISTORY_CHART='source_account,name,account_type\n1000,Bank,asset\n1200,Receivables,asset\n1300,Tax recoverable,asset\n2000,Payables,liability\n2100,Tax payable,liability\n3000,Equity,equity\n3999,Conversion clearing,equity\n4000,Revenue,revenue\n5000,Expenses,expense'
export const HISTORY_TARGET_ACCOUNTS='1000,Bank,asset,,cash_and_cash_equivalents\n1200,Receivables,asset,,trade_receivables\n1300,Tax recoverable,asset,,gst_hst_recoverable\n2000,Payables,liability,,trade_payables\n2100,Tax payable,liability,,gst_hst_payable\n3000,Equity,equity,,retained_earnings\n3999,Conversion clearing,equity,,retained_earnings\n4000,Revenue,revenue,,revenue_from_contracts\n5000,Expenses,expense,,other_operating_expenses'
export const ITEM_HEADER='source_id,source_account,source_party,direction,kind,number,issued_on,due_on,amount,currency'
export const HISTORY_START='source_account,amount\n1000,1000.00\n3000,-1000.00'
export const HISTORY_END='source_account,amount\n1000,1090.00\n1200,280.00\n1300,40.00\n2000,-140.00\n2100,-80.00\n3000,-1000.00\n3999,0.00\n4000,-840.00\n5000,650.00'
export const HISTORY_OPEN=ITEM_HEADER+'\nINV1,1200,CUST,sales,invoice,H-INV1,2026-01-05,2026-02-05,400.00,CAD\nCR1,1200,CUST,sales,credit_note,H-CR1,2026-02-05,2026-02-05,20.00,CAD\nRC1,1200,CUST,sales,unapplied,,2026-01-12,2026-01-12,100.00,CAD\nBILL1,2000,SUP,purchase,invoice,H-BILL1,2026-01-10,2026-02-10,200.00,CAD\nPC1,2000,SUP,purchase,credit_note,H-PC1,2026-02-15,2026-02-15,10.00,CAD\nPP1,2000,SUP,purchase,unapplied,,2026-02-10,2026-02-10,50.00,CAD'
export const HISTORY_APPS='source_id,source_transaction_id,target_document_id,amount\nAPP1,RC1,INV1,500.00\nAPP2,CR1,INV1,200.00\nAPP3,PP1,BILL1,250.00\nAPP4,PC1,BILL1,100.00'
const header='source_id,source_group,expected_lines,date,source_account,source_party,amount,currency,document_type,number,due_on,description,row_type'
const group=(id:string,date:string,type:string,number:string,due:string,lines:Array<[string,string,string]>)=>lines.map(([account,party,amount])=>[id,'',lines.length,date,account,party,amount,'CAD',type,number,due,'Historical '+id,'transaction'].join(',')).join('\n')
export const HISTORY_GL=[header,
 group('INV1','2026-01-05','sales_invoice','H-INV1','2026-02-05',[['1200','CUST','1100.00'],['4000','','-1000.00'],['2100','','-100.00']]),
 group('BILL1','2026-01-10','purchase_bill','H-BILL1','2026-02-10',[['5000','','500.00'],['1300','','50.00'],['2000','SUP','-550.00']]),
 group('RC1','2026-01-12','payment','','',[['1000','','600.00'],['1200','CUST','-600.00']]),
 group('CR1','2026-02-05','sales_credit','H-CR1','2026-02-05',[['1200','CUST','-220.00'],['4000','','200.00'],['2100','','20.00']]),
 group('PP1','2026-02-10','payment','','',[['2000','SUP','300.00'],['1000','','-300.00']]),
 group('PC1','2026-02-15','purchase_credit','H-PC1','2026-02-15',[['5000','','-100.00'],['1300','','-10.00'],['2000','SUP','110.00']]),
 group('EXP1','2026-03-01','journal','SOURCE-EXP','',[['5000','','250.00'],['1000','','-250.00']]),
 group('INT1','2026-03-10','journal','SOURCE-INT','',[['1000','','40.00'],['4000','','-40.00']]),
 'SUBTOTAL,,2,2026-03-31,1000,,1090.00,CAD,journal,,,Report subtotal,subtotal',
 'DISPLAY,,2,2025-12-31,1000,,1000.00,CAD,journal,,,Opening display,opening_display'
].join('\n')
export const EXPECTED_HISTORY_CENTS={'1000':'109000','1200':'28000','1300':'4000','2000':'-14000','2100':'-8000','3000':'-100000','3999':'0','4000':'-84000','5000':'65000'}
