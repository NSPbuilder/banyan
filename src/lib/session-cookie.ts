import 'server-only'
import {cookies} from 'next/headers'
import {SESSION_COOKIE} from './gate'
import {SESSION_DAYS} from './users'
/** Internal helper, never an independently callable Server Action. */
export async function startSession(token:string){
  (await cookies()).set(SESSION_COOKIE,token,{httpOnly:true,sameSite:'lax',secure:process.env.NODE_ENV==='production',path:'/',maxAge:SESSION_DAYS*24*60*60})
}
