'use client'
import {createContext,useContext,useState,type ReactNode} from 'react'
import {EditLease} from './EditLease'
import type {EditProof,EditResource} from '@/lib/edit-proof'
const Proof=createContext<EditProof|null>(null)
/** One lease per editor Window, shared by that object's several forms. */
export function MasterEdit({resource,version,children}:{resource:EditResource;version:string;children:ReactNode}){
  const [proof,setProof]=useState<EditProof>({version})
  return <Proof.Provider value={proof}><div data-edit-boundary>
    <EditLease resource={resource} version={version} boundary onProof={setProof}/>
    {children}
  </div></Proof.Provider>
}
export function MasterProof(){
  const proof=useContext(Proof);if(!proof)return null
  return <><input type="hidden" name="expectedVersion" value={proof.version}/><input type="hidden" name="editTab" value={proof.tabId??''}/>
    <input type="hidden" name="editToken" value={proof.token??''}/><input type="hidden" name="editGeneration" value={proof.generation??''}/></>
}
