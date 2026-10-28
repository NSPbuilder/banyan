import 'server-only'
import { PDFDocument, PDFDict, PDFArray, PDFName, PDFStream, type PDFObject } from 'pdf-lib'
import { AutomationError } from './automation-errors'

export const INBOX_MAX_BYTES=8*1024*1024
export const INBOX_MAX_PAGES=30
export async function validateInboxFile(name:string,mime:string,bytes:Buffer) {
  if(!name || name.length>200 || /[/\\\x00-\x1f]/.test(name) || name==='.' || name==='..')
    throw new AutomationError('FILE_NAME','Choose a plain filename without directories or control characters.')
  if(!bytes.length || bytes.length>INBOX_MAX_BYTES)throw new AutomationError('FILE_SIZE','Choose a nonempty PDF, JPEG or PNG up to 8 MB.')
  const pdf=bytes.subarray(0,5).toString()==='%PDF-'
  const png=bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
  const jpeg=bytes[0]===255&&bytes[1]===216&&bytes[2]===255
  const actual=pdf?'application/pdf':png?'image/png':jpeg?'image/jpeg':null
  const extension=actual==='application/pdf'?/\.pdf$/i:actual==='image/png'?/\.png$/i:/\.jpe?g$/i
  if(!actual || mime!==actual || !extension.test(name))throw new AutomationError('FILE_TYPE','The file contents, extension and type must agree: PDF, JPEG or PNG.')
  try {
    if(pdf) {
      const doc=await PDFDocument.load(bytes,{throwOnInvalidObject:true,updateMetadata:false})
      const pages=doc.getPageCount()
      if(pages<1||pages>INBOX_MAX_PAGES)throw new AutomationError('FILE_PAGES','Choose a PDF with 1–30 pages. Split separate receipts before upload.')
      const active=new Set(['/JS','/JavaScript','/Launch','/OpenAction','/AA','/RichMedia','/EmbeddedFiles','/EF','/AF','/XFA','/A'])
      const activeValues=new Set(['/JavaScript','/Launch','/EmbeddedFile','/FileAttachment','/RichMedia','/Movie','/Sound','/3D','/Screen','/Rendition'])
      const visited=new Set<PDFObject>()
      const inspect=(object:PDFObject)=>{
        if(visited.has(object))return;visited.add(object)
        if(object instanceof PDFName&&activeValues.has(object.toString()))throw new AutomationError('FILE_ACTIVE','This PDF contains active actions or embedded content. Export a plain PDF before upload.')
        if(object instanceof PDFStream)inspect(object.dict)
        else if(object instanceof PDFDict){
          if(object.keys().some(key=>active.has(key.toString())))throw new AutomationError('FILE_ACTIVE','This PDF contains active actions or embedded content. Export a plain PDF before upload.')
          for(const [,value] of object.entries())inspect(value)
        }else if(object instanceof PDFArray)for(let i=0;i<object.size();i++)inspect(object.get(i))
      }
      for(const [,object] of doc.context.enumerateIndirectObjects())inspect(object)
      return {mime:actual,pages}
    }
    // Check the uncompressed dimensions before a PNG decoder allocates pixels.
    if(png) {
      if(bytes.length<33||bytes.readUInt32BE(8)!==13||bytes.subarray(12,16).toString()!=='IHDR')throw new AutomationError('FILE_INVALID','The PNG header is malformed.')
      const width=bytes.readUInt32BE(16),height=bytes.readUInt32BE(20)
      if(!width||!height||width*height>40_000_000)throw new AutomationError('FILE_IMAGE','Choose an image no larger than 40 megapixels.')
    }
    if(jpeg&&!(bytes[bytes.length-2]===255&&bytes[bytes.length-1]===217))throw new AutomationError('FILE_INVALID','The JPEG is incomplete.')
    const doc=await PDFDocument.create()
    const image=png?await doc.embedPng(bytes):await doc.embedJpg(bytes)
    if(image.width<1||image.height<1||image.width*image.height>40_000_000)
      throw new AutomationError('FILE_IMAGE','Choose an image no larger than 40 megapixels.')
    return {mime:actual,pages:1}
  } catch(error) {
    if(error instanceof AutomationError)throw error
    throw new AutomationError('FILE_INVALID','The document is malformed or encrypted. Export a readable, plain PDF or image.')
  }
}
