import {roundRatio} from './inventory-cost'
export type AllocationStub={id:string;employee_id:string;pay_date:string;period_start:string;period_end:string;hours:string;gross:string;bonus:string;employer:string;used_hours:string;used_gross:string;used_employer:string;entry_id:string}
export function allocationCeiling(stub:AllocationStub,hours:bigint) {
 const paid=BigInt(stub.hours),used=BigInt(stub.used_hours),regular=BigInt(stub.gross)-BigInt(stub.bonus)
 if(paid<=0n||hours<=0n||used+hours>paid)throw new Error('Production hours exceed the unallocated paid hours on this stub.')
 const employer=BigInt(stub.gross)>0n?roundRatio(BigInt(stub.employer),regular,BigInt(stub.gross)):0n
 return {gross:roundRatio(regular,used+hours,paid)-roundRatio(regular,used,paid),employer:roundRatio(employer,used+hours,paid)-roundRatio(employer,used,paid)}
}
