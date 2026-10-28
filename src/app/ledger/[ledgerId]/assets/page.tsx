import {randomUUID} from 'node:crypto'
import { notFound } from 'next/navigation'
import { requireLedger } from '@/lib/gate'
import { ledgerHead } from '@/lib/ledger-head'
import {ccaRegister} from '@/lib/cca'
import {depreciationAssets} from '@/lib/depreciation'
import { assetRows } from '@/lib/assets'
import { localToday } from '@/lib/today'
import { AssetsScreen } from './AssetsScreen'
import { saveAssetAction } from './actions'
import {financeSetting,financialAccountOptions} from '@/lib/operations-finance'
export const dynamic='force-dynamic'
export default async function AssetsPage({params}:{params:Promise<{ledgerId:string}>}) {
  const {ledgerId}=await params;await requireLedger(ledgerId,'/assets')
  const head=await ledgerHead(ledgerId);if(!head)notFound()
  const [register,book,assets,finance,accounts]=await Promise.all([ccaRegister(ledgerId),depreciationAssets(ledgerId),assetRows(ledgerId),financeSetting(ledgerId,'/assets'),financialAccountOptions(ledgerId)])
  return <AssetsScreen ledgerId={ledgerId} entity={head.entity} currency={head.currency} today={localToday()} pools={register.pools} assignments={register.assignments} depreciation={book} assets={assets} finance={finance} accounts={accounts} saveAction={saveAssetAction} requestKey={randomUUID()}/>
}
