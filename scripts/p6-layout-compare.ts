import {readFileSync,writeFileSync} from 'node:fs'
import {reporter} from './suite'
type Box={tag:string;name:string|null;text:string;x:number;y:number;width:number;height:number}
type Record={width:number;path:string;pageWidth:number;scrollWidth:number;elements:Box[]}
const r=reporter(85)
const read=(phase:string):Record[]=>JSON.parse(readFileSync(`docs/evidence/p6/layout-${phase}.json`,'utf8')).records
const before=[...read('before'),...read('before-master')],after=read('after')
function overlaps(es:Box[]){const controls=es.filter(e=>['INPUT','BUTTON'].includes(e.tag)&&e.width>0&&e.height>0),found=[]
  for(let a=0;a<controls.length;a++)for(let b=a+1;b<controls.length;b++){
    const x=controls[a],y=controls[b],w=Math.min(x.x+x.width,y.x+y.width)-Math.max(x.x,y.x),h=Math.min(x.y+x.height,y.y+y.height)-Math.max(x.y,y.y)
    if(w>1&&h>1)found.push({first:x.name||x.text,second:y.name||y.text,area:w*h})
  }return found
}
const comparisons=after.map((a,i)=>{
  const b=before.find(b=>b.width===a.width&&b.path===a.path);if(!b)throw Error('Missing prior measurement')
  const bh=b.elements.find(e=>e.tag==='H1')!,ah=a.elements.find(e=>e.tag==='H1')!,bo=overlaps(b.elements),ao=overlaps(a.elements)
  const hidden=a.elements.filter(e=>['INPUT','BUTTON'].includes(e.tag)&&(e.width<=0||e.height<=0))
  const overflowBefore=Math.max(0,b.scrollWidth-b.pageWidth),overflowAfter=Math.max(0,a.scrollWidth-a.pageWidth)
  r.check(ao.length<=bo.length,`P6L${i+1} ${a.width} ${a.path.split('/').at(-1)} no new control overlap`,`${bo.length} -> ${ao.length}`)
  r.check(overflowAfter<=overflowBefore&&hidden.length===0,`P6LV${i+1} visible controls and no added document overflow`,`${overflowBefore}px -> ${overflowAfter}px; ${hidden.length} zero-size controls`)
  r.check(Math.abs(bh.x-ah.x)<1&&Math.abs(bh.y-ah.y)<1,`P6LS${i+1} title spacing preserved`,`${bh.x},${bh.y} -> ${ah.x},${ah.y}`)
  return {width:a.width,path:a.path,overflowBefore,overflowAfter,overlapBefore:bo,overlapAfter:ao,zeroSizeControls:hidden,titleDelta:{x:ah.x-bh.x,y:ah.y-bh.y}}
})
writeFileSync('docs/evidence/p6/layout-comparison.json',JSON.stringify({at:new Date().toISOString(),comparisons,failures:r.failures},null,2)+'\n')
console.log(r.summary());process.exitCode=r.failures?1:0
