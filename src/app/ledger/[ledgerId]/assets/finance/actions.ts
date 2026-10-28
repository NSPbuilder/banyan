'use server'
import {requireLedger} from '@/lib/gate'
import {financialSetupAction} from '@/lib/operations-finance-actions'
import type {FormState} from '@/app/actions'
const id=(f:FormData)=>String(f.get('ledgerId')??'')
export async function initializeFinanceAction(_prev:FormState,f:FormData){const ledgerId=id(f),me=await requireLedger(ledgerId,'/assets');return financialSetupAction(me,ledgerId,'/assets',f,'initialize')}
export async function connectFinanceAction(_prev:FormState,f:FormData){const ledgerId=id(f),me=await requireLedger(ledgerId,'/assets');return financialSetupAction(me,ledgerId,'/assets',f,'connect')}
export async function financeSettingsAction(_prev:FormState,f:FormData){const ledgerId=id(f),me=await requireLedger(ledgerId,'/assets');return financialSetupAction(me,ledgerId,'/assets',f,'settings')}
