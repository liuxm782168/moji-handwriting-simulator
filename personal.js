(function(){
'use strict';

const $=id=>document.getElementById(id);
const FILE_MODE=location.protocol==='file:';
const model={image:null,angle:0,source:null,style:null,fontOverride:false,glyphs:new Map(),disabled:new Set(),medianHeight:48,sourceAdvance:42,threshold:27,fallbackFont:'LCHand',ocrBusy:false,recognitionSeq:0,onChange:()=>{}};
const HANZI=/[\u3400-\u9fff]/u;
const PUNCT=/[，。！？、；：,.!?;:]/u;
const DPR=2, MARGIN=58, TOP=46, BOTTOM=46;
let progressTimer=0,progressStarted=0,styleRefreshTimer=0;
const baseGlyphCache=new Map();

function progressBegin(title){
  clearInterval(progressTimer);
  const box=$('personalProgress'),track=$('personalProgressTrack');
  box.hidden=false;box.classList.remove('done','error');
  $('personalProgressTitle').textContent=title;
  $('personalProgressTime').textContent='已等待 0 秒';
  track.removeAttribute('aria-valuenow');track.setAttribute('aria-valuetext',title);
  progressStarted=Date.now();
  progressTimer=setInterval(()=>{
    $('personalProgressTime').textContent='已等待 '+Math.floor((Date.now()-progressStarted)/1000)+' 秒';
  },1000);
}
function progressStep(title){
  $('personalProgressTitle').textContent=title;
  $('personalProgressTrack').setAttribute('aria-valuetext',title);
}
function progressEnd(ok,title){
  clearInterval(progressTimer);progressTimer=0;
  const box=$('personalProgress'),track=$('personalProgressTrack');
  box.hidden=false;box.classList.toggle('done',ok);box.classList.toggle('error',!ok);
  $('personalProgressTitle').textContent=title;
  $('personalProgressTime').textContent='用时 '+Math.ceil((Date.now()-progressStarted)/1000)+' 秒';
  track.setAttribute('aria-valuenow',ok?'100':'0');track.setAttribute('aria-valuetext',title);
}

function status(message,warn){
  const box=$('personalStatus');
  box.textContent=message;
  box.classList.toggle('warn',!!warn);
}
function random(seed,index,salt){
  let n=(seed^Math.imul(index+1,0x9e3779b1)^Math.imul(salt+1,0x85ebca6b))>>>0;
  n^=n>>>16;n=Math.imul(n,0x7feb352d);n^=n>>>15;n=Math.imul(n,0x846ca68b);n^=n>>>16;
  return (n>>>0)/4294967296;
}
function median(values,fallback){
  if(!values.length) return fallback;
  const sorted=values.slice().sort((a,b)=>a-b);
  return sorted[Math.floor(sorted.length/2)];
}
function clamp(value,min,max){return Math.max(min,Math.min(max,value));}
function useSampleGlyphs(){
  const c=coverage();
  return c.total>0&&c.covered/c.total>=.5;
}
function clearGlyphs(){
  model.glyphs.clear();
  model.disabled.clear();
  $('personalGlyphs').replaceChildren();
  model.onChange();
}
function rotateImage(){
  if(!model.image) return;
  const img=model.image;
  const scale=Math.min(1,2600/Math.max(img.naturalWidth,img.naturalHeight));
  const w=Math.round(img.naturalWidth*scale),h=Math.round(img.naturalHeight*scale);
  const rightAngle=model.angle%180!==0;
  const c=document.createElement('canvas');
  c.width=rightAngle?h:w;c.height=rightAngle?w:h;
  const g=c.getContext('2d',{willReadFrequently:true});
  g.fillStyle='#fff';g.fillRect(0,0,c.width,c.height);
  if(model.angle===90){g.translate(c.width,0);g.rotate(Math.PI/2);}
  else if(model.angle===180){g.translate(c.width,c.height);g.rotate(Math.PI);}
  else if(model.angle===270){g.translate(0,c.height);g.rotate(-Math.PI/2);}
  g.drawImage(img,0,0,w,h);
  model.source=c;
  const p=$('personalPreview');
  p.hidden=false;p.width=c.width;p.height=c.height;
  p.getContext('2d').drawImage(c,0,0);
  model.style=analyzeStyle();
  model.onChange();
}
function localBackground(gray,w,h){
  const stride=w+1,integral=new Uint32Array(stride*(h+1));
  for(let y=0;y<h;y++){
    let rowSum=0;
    for(let x=0;x<w;x++){
      rowSum+=gray[y*w+x];
      integral[(y+1)*stride+x+1]=integral[y*stride+x+1]+rowSum;
    }
  }
  const background=new Uint8Array(w*h),radius=30;
  for(let y=0;y<h;y++){
    const y0=Math.max(0,y-radius),y1=Math.min(h,y+radius+1);
    for(let x=0;x<w;x++){
      const x0=Math.max(0,x-radius),x1=Math.min(w,x+radius+1);
      const sum=integral[y1*stride+x1]-integral[y0*stride+x1]-integral[y1*stride+x0]+integral[y0*stride+x0];
      background[y*w+x]=Math.round(sum/((x1-x0)*(y1-y0)));
    }
  }
  return background;
}
function lineRuns(ink,w,h){
  const rows=new Int32Array(h);
  const x0=Math.floor(w*.01),x1=Math.ceil(w*.99);
  for(let y=0;y<h;y++) for(let x=x0;x<x1;x++) rows[y]+=ink[y*w+x];
  const smooth=new Float32Array(h);
  for(let y=0;y<h;y++){
    let sum=0,n=0;
    for(let k=-2;k<=2;k++) if(y+k>=0&&y+k<h){sum+=rows[y+k];n++;}
    smooth[y]=sum/n;
  }
  const minRow=Math.max(3,w*.003);
  const runs=[];
  let start=-1,last=-1;
  for(let y=0;y<h;y++){
    if(smooth[y]>minRow){if(start<0)start=y;last=y;}
    else if(start>=0&&y-last>10){runs.push({y0:start,y1:last+1});start=-1;}
  }
  if(start>=0)runs.push({y0:start,y1:last+1});
  return runs.filter(r=>r.y1-r.y0>=Math.max(10,h*.025)).map(r=>{
    let mass=0;for(let y=r.y0;y<r.y1;y++)mass+=rows[y];
    return {...r,mass};
  });
}
function analyzeStyle(){
  if(!model.source)return null;
  const c=model.source,w=c.width,h=c.height;
  const pixels=c.getContext('2d',{willReadFrequently:true}).getImageData(0,0,w,h).data;
  const gray=new Uint8Array(w*h);
  for(let i=0;i<gray.length;i++)gray[i]=Math.round(.299*pixels[i*4]+.587*pixels[i*4+1]+.114*pixels[i*4+2]);
  const background=localBackground(gray,w,h),ink=new Uint8Array(w*h);
  const contrasts=[],runs=[];
  for(let i=0;i<ink.length;i++){
    const diff=background[i]-gray[i];
    if(diff>27){ink[i]=1;if((i%7)===0)contrasts.push(diff);}
  }
  const lines=lineRuns(ink,w,h).sort((a,b)=>b.mass-a.mass).slice(0,8).sort((a,b)=>a.y0-b.y0);
  if(!lines.length||contrasts.length<40)return null;
  const lineHeights=[],lineAdvances=[],starts=[];
  const transcript=$('personalTranscript').value.replace(/\r/g,'').split('\n').map(x=>x.trim()).filter(Boolean);
  for(let li=0;li<lines.length;li++){
    const line=lines[li],height=line.y1-line.y0;
    lineHeights.push(height);starts.push(line.y0);
    const columns=new Int32Array(w);
    for(let y=line.y0;y<line.y1;y++){
      let run=0;
      for(let x=0;x<w;x++){
        if(ink[y*w+x]){columns[x]++;run++;}
        else if(run){if(run<=Math.max(12,height*.24))runs.push(run);run=0;}
      }
      if(run&&run<=Math.max(12,height*.24))runs.push(run);
    }
    let left=0,right=w;
    while(left<w-1&&columns[left]<2)left++;
    while(right>left+1&&columns[right-1]<2)right--;
    const chars=transcript[li]?[...transcript[li]].filter(ch=>!(/\s/u.test(ch))):[];
    if(chars.length>=4)lineAdvances.push((right-left)/chars.reduce((n,ch)=>n+(PUNCT.test(ch)?.48:1),0));
  }
  const lineHeight=median(lineHeights,56);
  const stroke=median(runs,Math.max(2,lineHeight*.055));
  const contrast=median(contrasts,65);
  const advance=median(lineAdvances,lineHeight*.64);
  const lineStep=starts.length>1?median(starts.slice(1).map((y,i)=>y-starts[i]),lineHeight*1.55):lineHeight*1.55;
  const style={
    lineHeight,stroke,contrast,
    advanceRatio:clamp(advance/(lineHeight*.72),.72,1.08),
    widthScale:clamp(advance/(lineHeight*.75),.76,1.13),
    lineSpacing:clamp(lineStep/lineHeight,1.35,1.8),
    inkAlpha:clamp(contrast/68,.72,1),
    strokeWarp:clamp(stroke/lineHeight*17,.5,1.7)
  };
  if(!model.fontOverride){
    model.fallbackFont=stroke/lineHeight<.085?'LCHand':'MSHand';
    $('personalFallbackSeg').querySelectorAll('button').forEach(b=>b.classList.toggle('on',b.dataset.font===model.fallbackFont));
  }
  document.fonts.load('30px '+model.fallbackFont).then(()=>{baseGlyphCache.clear();model.onChange();}).catch(()=>{});
  return style;
}
function styleSummary(){
  const s=model.style;
  if(!s)return '尚未取得可用的手写笔迹，请换一张清晰照片。';
  const width=s.widthScale<.87?'偏窄':s.widthScale>1.04?'偏宽':'适中';
  const ink=s.inkAlpha<.84?'偏浅':'较清晰';
  return '已分析整段笔迹：笔画约 '+s.stroke.toFixed(1)+' 像素，字幅'+width+'，墨色'+ink+'，行距约 '+s.lineSpacing.toFixed(2)+' 倍。';
}
function charWeight(ch){
  if(PUNCT.test(ch)) return .45;
  if(/\s/u.test(ch)) return .42;
  return HANZI.test(ch)?1:.65;
}
function chooseBounds(chars,columns,left,right,height){
  const weights=chars.map(charWeight);
  const total=weights.reduce((a,b)=>a+b,0);
  const unit=(right-left)/total;
  const bounds=[left];
  let cumulative=0;
  for(let i=1;i<chars.length;i++){
    cumulative+=weights[i-1];
    const expected=left+cumulative*unit;
    const radius=Math.max(5,unit*.38);
    const min=Math.max(bounds[i-1]+Math.max(3,unit*.25),Math.floor(expected-radius));
    const max=Math.min(right-Math.max(3,unit*.25),Math.ceil(expected+radius));
    let chosen=Math.round(expected),best=Infinity;
    for(let x=Math.ceil(min);x<=Math.floor(max);x++){
      const valley=(columns[x-1]||0)+columns[x]+(columns[x+1]||0);
      const deviation=Math.abs(x-expected)/unit;
      const score=valley/Math.max(1,height)+deviation*.22;
      if(score<best){best=score;chosen=x;}
    }
    bounds.push(Math.max(bounds[i-1]+1,chosen));
  }
  bounds.push(right);
  return bounds;
}
function extractGlyph(chars,bounds,line,gray,background,ink,w,h){
  const glyphs=[];
  for(let i=0;i<chars.length;i++){
    const cellLeft=bounds[i],cellRight=bounds[i+1];
    let minX=w,minY=h,maxX=-1,maxY=-1,count=0;
    for(let y=line.y0;y<line.y1;y++) for(let x=cellLeft;x<cellRight;x++){
      if(!ink[y*w+x])continue;
      count++;
      if(x<minX)minX=x;if(x>maxX)maxX=x;
      if(y<minY)minY=y;if(y>maxY)maxY=y;
    }
    if(count<3||maxX<minX||maxY<minY){glyphs.push(null);continue;}
    minX=Math.max(0,minX-2);maxX=Math.min(w-1,maxX+2);
    minY=Math.max(0,minY-2);maxY=Math.min(h-1,maxY+2);
    const gw=maxX-minX+1,gh=maxY-minY+1;
    const c=document.createElement('canvas');c.width=gw;c.height=gh;
    const g=c.getContext('2d');
    const out=g.createImageData(gw,gh);
    for(let yy=0;yy<gh;yy++)for(let xx=0;xx<gw;xx++){
      const lum=gray[(minY+yy)*w+minX+xx];
      const difference=background[(minY+yy)*w+minX+xx]-lum;
      const alpha=Math.max(0,Math.min(255,Math.round((difference-27)*255/65)));
      const at=(yy*gw+xx)*4;
      out.data[at]=31;out.data[at+1]=29;out.data[at+2]=36;out.data[at+3]=alpha;
    }
    g.putImageData(out,0,0);
    glyphs.push({canvas:c,w:gw,h:gh,char:chars[i],cellWidth:cellRight-cellLeft,bottomGap:line.y1-maxY-1});
  }
  return glyphs;
}
function showGlyphs(){
  const grid=$('personalGlyphs');grid.replaceChildren();
  for(const [char,entries] of model.glyphs){
    const item=document.createElement('button');item.type='button';item.className='personal-glyph';
    item.title='点击停用或恢复这个字形';item.setAttribute('aria-pressed','true');
    const img=document.createElement('canvas');img.width=entries[0].w;img.height=entries[0].h;
    img.getContext('2d').drawImage(entries[0].canvas,0,0);
    const label=document.createElement('span');label.textContent=char+(entries.length>1?' ×'+entries.length:'');
    item.append(img,label);grid.append(item);
    item.addEventListener('click',function(){
      if(model.disabled.has(char))model.disabled.delete(char);else model.disabled.add(char);
      item.classList.toggle('off',model.disabled.has(char));
      item.setAttribute('aria-pressed',String(!model.disabled.has(char)));
      updateStatus('已提取 '+model.glyphs.size+' 种字形');model.onChange();
    });
  }
}
function coverage(){
  const text=$('personalTarget').value;
  let covered=0,total=0;
  const missing=new Set();
  for(const ch of text){
    if(!HANZI.test(ch))continue;
    total++;
    if(model.glyphs.has(ch)&&!model.disabled.has(ch))covered++;else missing.add(ch);
  }
  return {covered,total,missing:[...missing]};
}
function getStepMessage(){
  if(FILE_MODE)return '当前是直接打开 HTML 文件。请双击文件夹中的「启动墨迹.cmd」后再上传照片。';
  if(!model.image)return '先在左侧上传一张清晰的手写照片。';
  if(model.ocrBusy)return '正在本机识别照片中的文字。左侧进度栏会显示当前步骤和已等待时间。';
  if(model.style)return '已分析整段笔迹，可直接输入要生成的文字。照片原文只用于估计字距。';
  return '照片未检测到清楚的笔迹，请换一张照片。';
}
function updateStatus(prefix){
  status(prefix+'。'+styleSummary(),!model.style);
  $('personalFeatures').textContent=styleSummary();
  $('personalNote').textContent='依据整段样本的笔画粗细、墨色、字幅和行距生成；新字使用可读字形骨架。当前为笔迹特征模拟。';
}
function analyze(){
  if(!model.source){status('请先选择手写照片。',true);return false;}
  const lines=$('personalTranscript').value.replace(/\r/g,'').split('\n').map(x=>x.trim()).filter(Boolean);
  if(!lines.length){status('请填写照片上的原文，并保持换行位置一致。',true);return false;}
  const c=model.source,w=c.width,h=c.height;
  const pixels=c.getContext('2d',{willReadFrequently:true}).getImageData(0,0,w,h).data;
  const gray=new Uint8Array(w*h);
  for(let i=0;i<gray.length;i++)gray[i]=Math.round(.299*pixels[i*4]+.587*pixels[i*4+1]+.114*pixels[i*4+2]);
  const background=localBackground(gray,w,h),threshold=27,ink=new Uint8Array(w*h);
  for(let i=0;i<ink.length;i++)ink[i]=background[i]-gray[i]>threshold?1:0;
  let detected=lineRuns(ink,w,h);
  if(detected.length>lines.length) detected=detected.sort((a,b)=>b.mass-a.mass).slice(0,lines.length).sort((a,b)=>a.y0-b.y0);
  if(detected.length!==lines.length){
    status('照片检测到 '+detected.length+' 行字，原文填写了 '+lines.length+' 行。请旋转照片或调整原文换行后重试。',true);
    return false;
  }
  const bank=new Map(),heights=[],advances=[];
  for(let li=0;li<lines.length;li++){
    const chars=[...lines[li]].filter(ch=>!(/\s/u.test(ch)));
    const run=detected[li],y0=Math.max(0,run.y0-3),y1=Math.min(h,run.y1+3);
    const cols=new Int32Array(w);
    for(let y=y0;y<y1;y++)for(let x=0;x<w;x++)cols[x]+=ink[y*w+x];
    let left=0,right=w;
    while(left<w-1&&cols[left]<2)left++;
    while(right>left+1&&cols[right-1]<2)right--;
    if(chars.length<1||right-left<chars.length*5){status('第 '+(li+1)+' 行的字迹太短或原文过长，请核对照片和文字。',true);return false;}
    const bounds=chooseBounds(chars,cols,left,right,y1-y0);
    const entries=extractGlyph(chars,bounds,{y0,y1},gray,background,ink,w,h);
    entries.forEach((entry,i)=>{
      if(!entry)return;
      if(!bank.has(chars[i]))bank.set(chars[i],[]);
      bank.get(chars[i]).push(entry);
      if(HANZI.test(chars[i])&&entry.h>=8){heights.push(entry.h);advances.push(entry.cellWidth);}
    });
  }
  model.medianHeight=median(heights,48);
  model.sourceAdvance=median(advances,42);
  // OCR 漏字会让后续字符对错位置；先丢弃明显只切到一小笔的字形。
  for(const [ch,entries] of bank){
    // 标点很容易与相邻字的笔画切在一起，统一交给字体排版。
    if(PUNCT.test(ch)){bank.delete(ch);continue;}
    if(!HANZI.test(ch))continue;
    const valid=entries.filter(entry=>entry.h>=model.medianHeight*.52&&entry.w>=model.sourceAdvance*.27);
    if(valid.length)bank.set(ch,valid);else bank.delete(ch);
  }
  model.glyphs=bank;
  model.disabled.clear();
  model.threshold=threshold;
  showGlyphs();
  updateStatus('已从 '+lines.length+' 行照片中提取 '+bank.size+' 种字形');
  model.onChange();
  return bank.size>0;
}
async function recognizePhoto(autoOrientation){
  if(!model.source){status('请先选择手写照片。',true);return;}
  if(FILE_MODE){status('直接打开 HTML 时自动识别不可用。请双击同文件夹的「启动墨迹.cmd」，在新打开的浏览器页面中上传照片。',true);progressEnd(false,'请使用启动墨迹.cmd');model.onChange();return;}
  const seq=++model.recognitionSeq;
  model.ocrBusy=true;
  progressBegin('正在加载本机识别模型');
  status('正在本机识别文字，请稍候。');
  model.onChange();
  try{
    if(!window.HandwritingOCR)throw new Error('识别组件尚未加载');
    const recognize=source=>{
      let timer;
      return Promise.race([
        window.HandwritingOCR.recognize(source,progressStep),
        new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('识别超时，请检查网络后重试')),90000);})
      ]).finally(()=>clearTimeout(timer));
    };
    let best=await recognize(model.source);
    if(seq!==model.recognitionSeq)return;
    if(autoOrientation&&model.image.naturalHeight>model.image.naturalWidth*1.2){
      progressStep('正在检查照片方向');
      model.angle=90;rotateImage();
      const rotated=await recognize(model.source);
      if(seq!==model.recognitionSeq)return;
      const quality=rows=>rows.reduce((sum,row)=>sum+row.text.length*Math.max(.2,row.score||0),0);
      if(quality(rotated)>quality(best))best=rotated;
      else{model.angle=0;rotateImage();}
    }
    model.ocrBusy=false;
    if(!best.length){
      updateStatus('照片文字未识别出来，仍可使用笔迹特征生成');
      progressEnd(!!model.style,model.style?'笔迹分析已完成，原文未识别':'未识别出文字');
      model.onChange();return;
    }
    $('personalTranscript').value=best.map(row=>row.text).join('\n');
    status('已自动识别 '+best.length+' 行，正在分析整段笔迹。');
    progressStep('正在分析笔画与字形特征');
    model.onChange();
    await new Promise(resolve=>setTimeout(resolve,0));
    model.style=analyzeStyle();
    updateStatus('笔迹分析完成');
    model.onChange();
    progressEnd(!!model.style,model.style?'识别与笔迹分析已完成':'照片笔迹不清楚');
  }catch(error){
    if(seq!==model.recognitionSeq)return;
    model.ocrBusy=false;
    status('原文自动识别失败：'+(error&&error.message?error.message:'请检查网络')+'。'+(model.style?'笔迹特征已分析，可继续生成。':'请换一张清晰照片。'),true);
    progressEnd(!!model.style,model.style?'笔迹可用，原文识别失败':'自动识别失败');
    model.onChange();
  }
}
function tokenize(text,width,size,seed,useSamples){
  const scale=size/model.medianHeight;
  const normalAdvance=model.sourceAdvance*scale;
  const rows=[[]];let x=MARGIN,index=0;
  for(const ch of text.replace(/\r/g,'')){
    if(ch==='\n'){rows.push([]);x=MARGIN;continue;}
    const variants=!useSamples||model.disabled.has(ch)?null:model.glyphs.get(ch);
    const variant=variants?variants[Math.floor(random(seed,index,4)*variants.length)]:null;
    const glyphScale=variant?scale*clamp(size*.88/(variant.h*scale),.75,1.45):0;
    let advance;
    if(/\s/u.test(ch))advance=size*.4;
    else if(variant)advance=clamp(Math.max(variant.w*glyphScale+size*.07,normalAdvance*(PUNCT.test(ch)?.45:.75)),size*.42,size*1.45);
    else advance=size*(PUNCT.test(ch)?.52:.95);
    if(x+advance>width-MARGIN&&rows[rows.length-1].length){rows.push([]);x=MARGIN;}
    rows[rows.length-1].push({ch,variant,glyphScale,x,advance,index});
    x+=advance+size*.035;
    index++;
  }
  return {rows,scale};
}
function baseGlyph(ch,size,font){
  const key=ch+'|'+size+'|'+font;
  if(baseGlyphCache.has(key))return baseGlyphCache.get(key);
  const side=Math.ceil(size*1.9),c=document.createElement('canvas');
  c.width=side*DPR;c.height=side*DPR;
  const g=c.getContext('2d');g.scale(DPR,DPR);
  g.font=size+'px '+font+', sans-serif';
  g.textAlign='center';g.textBaseline='alphabetic';
  g.fillStyle='#211e26';g.fillText(ch,side/2,side*.67);
  const result={canvas:c,side,baseline:side*.67};
  baseGlyphCache.set(key,result);
  return result;
}
function drawStyledGlyph(g,ch,x,baseline,advance,size,seed,index,style){
  const base=baseGlyph(ch,size,model.fallbackFont);
  const jitter=(random(seed,index,32)-.5)*size*.08;
  const angle=(random(seed,index,33)-.5)*.095;
  const heightScale=1+(random(seed,index,34)-.5)*.07;
  const widthScale=style.widthScale*(1+(random(seed,index,35)-.5)*.07);
  const phase=random(seed,index,36)*Math.PI*2;
  const warp=Math.min(size*.035,style.strokeWarp*.5);
  const rowStep=3;
  g.save();
  g.translate(x+advance/2,baseline+jitter);
  g.rotate(angle);
  g.transform(widthScale,0,(random(seed,index,37)-.5)*.055,heightScale,0,0);
  g.globalAlpha=style.inkAlpha*(.91+random(seed,index,38)*.09);
  for(let sy=0;sy<base.canvas.height;sy+=rowStep){
    const strip=Math.min(rowStep,base.canvas.height-sy);
    const y=sy/DPR-base.baseline;
    const shift=warp*(.65*Math.sin(y*.29+phase)+.35*Math.sin(y*.62+phase*1.7));
    g.drawImage(base.canvas,0,sy,base.canvas.width,strip,-base.side/2+shift,y,base.side,strip/DPR);
  }
  g.restore();
}
function renderStyle(canvas,options){
  const width=Math.max(360,Math.min(1600,options.width||820));
  const size=parseInt($('personalSize').value,10),seed=options.seed||0;
  const style=model.style,text=$('personalTarget').value.replace(/\r/g,'');
  const rows=[[]];let x=MARGIN,index=0;
  for(const ch of text){
    if(ch==='\n'){rows.push([]);x=MARGIN;continue;}
    const advance=/\s/u.test(ch)?size*.38:size*style.advanceRatio*(PUNCT.test(ch)?.55:1);
    if(x+advance>width-MARGIN&&rows[rows.length-1].length){rows.push([]);x=MARGIN;}
    rows[rows.length-1].push({ch,x,advance,index});
    x+=advance+size*.035;
    index++;
  }
  const step=size*style.lineSpacing;
  const height=Math.max(280,Math.ceil(TOP+rows.length*step+BOTTOM));
  canvas.width=width*DPR;canvas.height=height*DPR;
  canvas.style.width=width+'px';canvas.style.height=height+'px';
  const g=canvas.getContext('2d');g.setTransform(DPR,0,0,DPR,0,0);
  if(!options.transparent){g.fillStyle='#fff';g.fillRect(0,0,width,height);}
  rows.forEach((row,li)=>{
    const baseline=TOP+size+li*step;
    row.forEach(token=>{
      if(!(/\s/u.test(token.ch)))drawStyledGlyph(g,token.ch,token.x,baseline,token.advance,size,seed,token.index,style);
    });
  });
  return canvas;
}
function render(canvas,options){
  if(model.style)return renderStyle(canvas,options);
  const width=Math.max(360,Math.min(1600,options.width||820));
  const seed=options.seed||0;
  const size=parseInt($('personalSize').value,10);
  const text=$('personalTarget').value;
  const plan=tokenize(text,width,size,seed,useSampleGlyphs());
  const step=size*1.65;
  const height=Math.max(280,Math.ceil(TOP+plan.rows.length*step+BOTTOM));
  canvas.width=width*DPR;canvas.height=height*DPR;
  canvas.style.width=width+'px';canvas.style.height=height+'px';
  const g=canvas.getContext('2d');g.setTransform(DPR,0,0,DPR,0,0);
  if(!options.transparent){g.fillStyle='#fff';g.fillRect(0,0,width,height);}
  if(!model.glyphs.size)return canvas;
  plan.rows.forEach((row,li)=>{
    const baseline=TOP+size+li*step;
    row.forEach(token=>{
      const {ch,variant,glyphScale,x,advance,index}=token;
      if(/\s/u.test(ch))return;
      if(variant){
        const dw=variant.w*glyphScale,dh=variant.h*glyphScale;
        const dx=(random(seed,index,8)-.5)*size*.045;
        const dy=(random(seed,index,9)-.5)*size*.07;
        const angle=(random(seed,index,10)-.5)*.07;
        g.save();
        g.translate(x+advance/2+dx,baseline+dy);
        g.rotate(angle);
        g.drawImage(variant.canvas,-dw/2,-dh-Math.min(variant.bottomGap*glyphScale,size*.22),dw,dh);
        g.restore();
      }else{
        g.save();
        g.fillStyle='#25212a';
        g.font=size+'px '+model.fallbackFont+', sans-serif';
        g.textBaseline='alphabetic';
        const measured=g.measureText(ch).width;
        const dx=(random(seed,index,18)-.5)*size*.07;
        const dy=(random(seed,index,19)-.5)*size*.09;
        const angle=(random(seed,index,20)-.5)*.09;
        const scale=1+(random(seed,index,21)-.5)*.08;
        g.translate(x+advance/2+dx,baseline+dy);
        g.rotate(angle);
        g.scale(scale,scale);
        g.globalAlpha=.88+random(seed,index,22)*.12;
        g.fillText(ch,-measured/2,0);
        g.restore();
      }
    });
  });
  return canvas;
}
function buildTransparent(options){
  const c=document.createElement('canvas');
  render(c,{...options,transparent:true});
  const g=c.getContext('2d');
  const d=g.getImageData(0,0,c.width,c.height).data;
  let x0=c.width,y0=c.height,x1=-1,y1=-1;
  for(let y=0;y<c.height;y++)for(let x=0;x<c.width;x++)if(d[(y*c.width+x)*4+3]>8){
    if(x<x0)x0=x;if(x>x1)x1=x;if(y<y0)y0=y;if(y>y1)y1=y;
  }
  if(x1<x0)return c;
  const pad=8;
  x0=Math.max(0,x0-pad);y0=Math.max(0,y0-pad);
  x1=Math.min(c.width-1,x1+pad);y1=Math.min(c.height-1,y1+pad);
  const out=document.createElement('canvas');out.width=x1-x0+1;out.height=y1-y0+1;
  out.getContext('2d').drawImage(c,x0,y0,out.width,out.height,0,0,out.width,out.height);
  return out;
}
function loadImageBlob(file){
  if(!file||!file.type.startsWith('image/')||file.size>20*1024*1024){status('请选择不超过 20 MB 的图片。',true);return Promise.resolve(false);}
  progressBegin('正在读取手写照片');
  return new Promise(resolve=>{
    const url=URL.createObjectURL(file);
    const img=new Image();
    img.onload=async function(){
      URL.revokeObjectURL(url);model.image=img;model.angle=0;$('personalTranscript').value='';rotateImage();clearGlyphs();
      if(model.style)updateStatus('已读取手写样本');
      await recognizePhoto(true);resolve(true);
    };
    img.onerror=function(){URL.revokeObjectURL(url);status('无法读取这张图片，请换一张。',true);progressEnd(false,'照片读取失败');resolve(false);};
    img.src=url;
  });
}
function setup(){
  $('fileModeNotice').hidden=!FILE_MODE;
  $('personalFile').addEventListener('change',function(){
    const file=this.files&&this.files[0];
    if(file)loadImageBlob(file);
  });
  $('personalRotate').addEventListener('click',function(){
    if(!model.image){status('请先选择手写照片。',true);return;}
    model.recognitionSeq++;model.angle=(model.angle+90)%360;rotateImage();clearGlyphs();recognizePhoto(false);
  });
  $('personalRecognize').addEventListener('click',function(){recognizePhoto(false);});
  $('personalAnalyze').addEventListener('click',function(){
    progressBegin('正在重新分析整段笔迹');
    model.style=analyzeStyle();
    updateStatus('笔迹已重新分析');model.onChange();
    progressEnd(!!model.style,model.style?'笔迹分析已完成':'照片笔迹不清楚');
  });
  $('personalTranscript').addEventListener('input',function(){
    clearTimeout(styleRefreshTimer);
    styleRefreshTimer=setTimeout(()=>{
      if(model.source){model.style=analyzeStyle();updateStatus('已根据原文更新字距估计');model.onChange();}
    },350);
  });
  $('personalTarget').addEventListener('input',function(){
    model.onChange();
  });
  $('personalSize').addEventListener('input',function(){
    $('personalSizeVal').textContent=this.value;baseGlyphCache.clear();model.onChange();
  });
  $('personalFallbackSeg').addEventListener('click',function(event){
    const button=event.target.closest('button[data-font]');
    if(!button)return;
    model.fontOverride=true;
    model.fallbackFont=button.dataset.font;
    this.querySelectorAll('button').forEach(item=>item.classList.toggle('on',item===button));
    baseGlyphCache.clear();
    document.fonts.load('30px '+model.fallbackFont).then(()=>{baseGlyphCache.clear();model.onChange();}).catch(()=>model.onChange());
    model.onChange();
  });
}
setup();
document.fonts.load('30px '+model.fallbackFont).then(()=>{baseGlyphCache.clear();model.onChange();}).catch(()=>{});
window.PersonalHandwriting={render,buildTransparent,loadImage:loadImageBlob,setOnChange:fn=>{model.onChange=fn;},getCoverage:coverage,hasGlyphs:()=>!!model.style,hasStyle:()=>!!model.style,getStepMessage,getStyle:()=>model.style};
})();
