import 'server-only'
import { createHash } from 'node:crypto'
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'
import sharp from 'sharp'
import { DocumentError } from './customer-docs'

export type ReceiptSupportingFile={filename:string;mime:string;bytes:Buffer}
export const RECEIPT_SUPPORTING_MAX_BYTES=100*1024*1024
const MAX_PAGES=200

/** Payment uploads must be exportable before they become saved supporting. */
export async function validateReceiptSupporting(file:ReceiptSupportingFile):Promise<void> {
  const body=await PDFDocument.create();body.addPage()
  await appendReceiptSupporting(Buffer.from(await body.save()),[file])
}

/** Append after every body page. Original stored supporting bytes are never edited. */
export async function appendReceiptSupporting(body:Buffer,files:ReceiptSupportingFile[]):Promise<Buffer> {
  if(!files.length)return body
  if(files.reduce((n,f)=>n+f.bytes.length,0)>RECEIPT_SUPPORTING_MAX_BYTES)
    throw new DocumentError('RECEIPT_SUPPORTING','The Receipt supporting exceeds 100 MB. Split or compress its files before exporting.')
  const result=await PDFDocument.load(body,{updateMetadata:false})
  const seen=new Set<string>()
  for(const file of files) {
    const sha=createHash('sha256').update(file.bytes).digest('hex')
    if(seen.has(sha))continue
    seen.add(sha)
    try {
      if(file.bytes.subarray(0,5).toString()==='%PDF-') {
        const source=await PDFDocument.load(file.bytes,{throwOnInvalidObject:true,updateMetadata:false})
        if(source.getPageCount()<1)throw new Error('Empty PDF')
        if(result.getPageCount()+source.getPageCount()>MAX_PAGES)throw new Error('Too many pages')
        for(const page of await result.copyPages(source,source.getPageIndices()))result.addPage(page)
      } else {
        const input=sharp(file.bytes,{limitInputPixels:40_000_000,failOn:'error'})
        const metadata=await input.metadata()
        if(!metadata.format||!['jpeg','png','webp','gif','tiff','heif','avif'].includes(metadata.format))throw new Error('Unsupported image')
        const bytes=await input.rotate().resize({width:2400,height:3200,fit:'inside',withoutEnlargement:true}).png().toBuffer()
        const image=await result.embedPng(bytes)
        const page=result.addPage([612,792]),scale=Math.min(540/image.width,684/image.height)
        const width=image.width*scale,height=image.height*scale
        page.drawText('Payment proof',{x:36,y:756,size:10,font:await result.embedFont(StandardFonts.Helvetica),color:rgb(0.3,0.3,0.3)})
        page.drawImage(image,{x:(612-width)/2,y:36+(684-height)/2,width,height})
        if(result.getPageCount()>MAX_PAGES)throw new Error('Too many pages')
      }
    } catch {
      throw new DocumentError('RECEIPT_SUPPORTING',`The supporting file "${file.filename}" could not be appended. Use a readable, unencrypted PDF or supported image (up to 40 megapixels); the combined Receipt is limited to 200 pages.`)
    }
  }
  return Buffer.from(await result.save())
}
