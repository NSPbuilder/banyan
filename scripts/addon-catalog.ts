import type { ModuleManifest } from '../src/lib/module-contract'
import { manifest as payroll } from '../src/modules/payroll/manifest'
import { manifest as records } from '../src/modules/records/manifest'
import { manifest as crm } from '../src/modules/crm/manifest'
import { manifest as esign } from '../src/modules/esign/manifest'
import { manifest as project } from '../src/modules/project/manifest'
import { manifest as ops } from '../src/modules/ops/manifest'
import { manifest as sred } from '../src/modules/sred/manifest'

/** Build-time catalog. Never copied into an assembled application's src. */
export const addonCatalog: readonly ModuleManifest[] = [payroll, records, crm, esign, project, ops, sred]
