'use server'
import {requireLedger} from '@/lib/gate'
import {financialSetupAction} from '@/lib/operations-finance-actions'
import type {FormState} from '@/app/actions'
const id=(f:FormData)=>String(f.get('ledgerId')??'')
export async function initializeFinanceAction(_prev:FormState,f:FormData){const ledgerId=id(f),me=await requireLedger(ledgerId,'/inventory');return financialSetupAction(me,ledgerId,'/inventory',f,'initialize')}
export async function connectFinanceAction(_prev:FormState,f:FormData){const ledgerId=id(f),me=await requireLedger(ledgerId,'/inventory');return financialSetupAction(me,ledgerId,'/inventory',f,'connect')}
export async function financeSettingsAction(_prev:FormState,f:FormData){const ledgerId=id(f),me=await requireLedger(ledgerId,'/inventory');return financialSetupAction(me,ledgerId,'/inventory',f,'settings')}
