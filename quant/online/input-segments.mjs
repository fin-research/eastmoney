import { Buffer } from 'node:buffer';

// Read the JSON format written by putJson without parsing the complete snapshot.
// A checkpoint contains only an unfinished row and its enclosing dataset header.
const decode=text=>JSON.parse(Buffer.from(text,'latin1').toString('utf8'));
const strip=text=>text.replace(/^[\s,]+/,'');
function valueEnd(text) {
  let depth=0,quoted=false,escaped=false;
  for(let i=0;i<text.length;i++){
    const c=text[i];
    if(quoted){if(escaped)escaped=false;else if(c==='\\')escaped=true;else if(c==='"')quoted=false;continue;}
    if(c==='"')quoted=true;
    else if(c==='['||c==='{')depth++;
    else if(c===']'||c==='}') {if(--depth===0)return i+1;}
  }
  return -1;
}
export function scanInputSegment(previous,bytes,final=false) {
  const state={phase:'header',buffer:'',group:null,grid:null,groups:[],counts:{},...previous};
  state.buffer+=Buffer.from(bytes).toString('latin1');
  const rows=[];
  while(state.buffer.length){
    if(state.phase==='header'){
      const match=/"datasets"\s*:\s*\{/.exec(state.buffer);
      if(!match)break;
      state.meta=decode(state.buffer.slice(0,match.index)+'"datasets":{}}');
      delete state.meta.datasets;
      state.buffer=state.buffer.slice(match.index+match[0].length);state.phase='group';
    } else if(state.phase==='group'){
      state.buffer=strip(state.buffer);
      if(/^\}\s*\}/.test(state.buffer)){state.buffer=state.buffer.replace(/^\}\s*\}/,'');state.phase='done';continue;}
      const match=/^"([a-z_]+)"\s*:\s*/.exec(state.buffer);
      if(!match)break;
      const rest=state.buffer.slice(match[0].length);
      if(!rest.length)break;
      if(state.groups.includes(match[1]))throw Error('Duplicate input dataset');
      if(rest[0]==='['){state.grid=null;state.buffer=rest.slice(1);}
      else if(rest[0]==='{'){
        const start=/"rows"\s*:\s*\[/.exec(rest);
        if(!start)break;
        state.grid=decode(rest.slice(0,start.index)+'"rows":[]}');
        state.buffer=rest.slice(start.index+start[0].length);
      }else throw Error('Invalid input dataset container');
      state.group=match[1];state.groups.push(state.group);state.counts[state.group]=0;state.phase='rows';
    } else if(state.phase==='rows'){
      state.buffer=strip(state.buffer);
      if(!state.buffer.length)break;
      if(state.buffer[0]===']'){
        state.buffer=state.buffer.slice(1);state.phase=state.grid?'grid-end':'group';continue;
      }
      if(!['[','{'].includes(state.buffer[0]))throw Error('Invalid input row container');
      const end=valueEnd(state.buffer);if(end<0)break;
      const row=decode(state.buffer.slice(0,end));state.buffer=state.buffer.slice(end);
      state.counts[state.group]++;rows.push({group:state.group,row,grid:state.grid});
    } else if(state.phase==='grid-end'){
      state.buffer=state.buffer.trimStart();if(!state.buffer.length)break;
      if(state.buffer[0]!=='}')throw Error('Invalid curve grid end');
      state.buffer=state.buffer.slice(1);state.phase='group';
    } else {
      if(state.buffer.trim())throw Error('Unexpected snapshot suffix');
      state.buffer='';break;
    }
  }
  if(state.buffer.length>64*1024)throw Error('Input row or header exceeds segment checkpoint size');
  if(final&&(state.phase!=='done'||state.buffer.trim()))throw Error('Truncated frozen input');
  return {state,rows};
}
