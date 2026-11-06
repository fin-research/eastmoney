import {readFile,writeFile,mkdir,readdir,stat} from 'node:fs/promises';
import {realpathSync} from 'node:fs';
import {join,resolve,basename} from 'node:path';
import {pathToFileURL} from 'node:url';
import {homedir} from 'node:os';
import {parseBondLedgerBuffer,matchesLedgerFile} from './ledger-parser.mjs';

const fail=message=>{throw new Error(message);};
function object(value,label){return value&&typeof value==='object'&&!Array.isArray(value)?value:fail(`${label} 必须是对象`);}
function array(value,label){return Array.isArray(value)?value:fail(`${label} 必须是数组`);}
function unwrap(response,depth=0){
  object(response,'MCP 响应');
  if(depth>7) fail('无法识别 MCP 响应');
  if(response.isError||response.error||response.status>=400) fail('MCP 取数失败，不得当作空数据');
  if(response.structuredContent) return unwrap(response.structuredContent,depth+1);
  if(response.data!==undefined) return unwrap(response.data,depth+1);
  if(response.content){
    const parts=array(response.content,'MCP content').filter(part=>part.type==='text');
    if(parts.length!==1) fail('MCP 响应缺少单一 JSON 文本');
    return unwrap(JSON.parse(parts[0].text),depth+1);
  }
  return response;
}
async function readDatabaseDates(rawPath){
  const raw=JSON.parse(await readFile(rawPath,'utf8'));
  const inventory=unwrap(object(raw.inventory,'raw.inventory').response);
  return array(inventory.databaseDates,'inventory.databaseDates').map(String);
}
async function walk(root,depth=0){
  const found=[];
  if(depth>8) return found;
  let entries;
  try{entries=await readdir(root);}catch{return found;}
  for(const entry of entries){
    if(entry.startsWith('.')||entry==='node_modules') continue;
    const path=join(root,entry);
    let info;
    try{info=await stat(path);}catch{continue;}
    if(info.isDirectory()) found.push(...await walk(path,depth+1));
    else if(info.isFile()&&matchesLedgerFile(entry)) found.push({path,name:entry,size:info.size,mtimeMs:info.mtimeMs});
  }
  return found;
}
async function defaultRoots(){
  const roots=[join(homedir(),'Downloads')];
  const wechat=join(homedir(),'Library/Containers/com.tencent.xinWeChat/Data/Documents/xwechat_files');
  try{
    for(const wxid of await readdir(wechat)){
      if(!wxid.startsWith('.')) roots.push(join(wechat,wxid,'msg','file'));
    }
  }catch{}
  return roots.filter(Boolean);
}
async function parsePayload(path){
  const buffer=await readFile(path);
  const parsed=parseBondLedgerBuffer(buffer);
  return {fileName:basename(path),expectedDate:parsed.date,parsed,size:buffer.byteLength};
}
const sortFiles=(left,right)=>left.mtimeMs-right.mtimeMs;

export async function main(args){
  const [command]=args;
  if(command==='scan'){
    const roots=args.slice(1).length?args.slice(1):await defaultRoots();
    const files=(await Promise.all(roots.map(root=>walk(resolve(root))))).flat().sort(sortFiles);
    console.log(JSON.stringify(files.map(({path,name,size})=>({path,name,size})),null,2));
    return;
  }
  if(command==='parse'){
    const [xlsxPath,outputPath]=args.slice(1);
    if(!xlsxPath) fail('用法：node upload.mjs parse <台账.xlsx> [输出.json]');
    const payload=await parsePayload(resolve(xlsxPath));
    if(outputPath){await writeFile(resolve(outputPath),JSON.stringify(payload,null,2)+'\n');console.log(resolve(outputPath));}
    else console.log(JSON.stringify(payload,null,2));
    return;
  }
  if(command==='put'){
    const [uploadUrl,xlsxPath,contentType]=args.slice(1);
    if(!uploadUrl||!xlsxPath) fail('用法：node upload.mjs put <file_upload_request 返回的 uploadUrl> <台账.xlsx> [contentType]');
    const buffer=await readFile(resolve(xlsxPath));
    const headers={'Content-Length':String(buffer.byteLength)};
    headers['Content-Type']=contentType||'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    headers['If-None-Match']='*';
    let response;
    try{response=await fetch(uploadUrl,{method:'PUT',body:buffer,headers});}
    catch(error){fail(`直传网络失败：${error instanceof Error?error.message:String(error)}`);}
    if(!response.ok) fail(`直传失败（HTTP ${response.status}）：${(await response.text()).slice(0,200)||response.statusText}`);
    console.log(`已直传 ${basename(xlsxPath)}（${buffer.byteLength} 字节）`);
    return;
  }
  if(command==='prepare'){
    const [rawPath,outputDir,...dirs]=args.slice(1);
    if(!rawPath||!outputDir) fail('用法：node upload.mjs prepare <raw.json> <输出目录> [扫描目录...]');
    const databaseDates=await readDatabaseDates(rawPath);
    const roots=dirs.length?dirs:await defaultRoots();
    const scanned=(await Promise.all(roots.map(root=>walk(resolve(root))))).flat().sort(sortFiles);
    const pending=[],skipped=[],failed=[];
    const seen=new Map();
    for(const file of scanned){
      try{
        const payload=await parsePayload(file.path);
        const date=payload.expectedDate;
        const existing=seen.get(date);
        if(existing!==undefined){skipped.push({date,fileName:file.name,path:file.path,reason:'duplicate_date',newer:existing});continue;}
        if(databaseDates.includes(date)){skipped.push({date,fileName:file.name,path:file.path,reason:'already_imported'});continue;}
        seen.set(date,file.name);
        pending.push({date,fileName:file.name,path:file.path,size:payload.size,payload:date+'.json'});
      }catch(error){failed.push({path:file.path,fileName:file.name,error:error instanceof Error?error.message:String(error)});}
    }
    pending.sort((left,right)=>left.date.localeCompare(right.date));
    await mkdir(resolve(outputDir),{recursive:true});
    for(const item of pending){
      const {fileName,expectedDate,parsed,size}=await parsePayload(item.path);
      await writeFile(join(resolve(outputDir),item.payload),JSON.stringify({fileName,expectedDate,parsed,size},null,2)+'\n');
    }
    const manifest={scanned:scanned.map(({path,name,size})=>({path,name,size})),databaseDates,pending,skipped,failed};
    await writeFile(join(resolve(outputDir),'upload-manifest.json'),JSON.stringify(manifest,null,2)+'\n');
    console.log(JSON.stringify({pending:manifest.pending,skipped:manifest.skipped,failed:manifest.failed},null,2));
    return;
  }
  fail('用法：node upload.mjs scan [目录...] | parse <台账.xlsx> [输出.json] | put <uploadUrl> <台账.xlsx> [contentType] | prepare <raw.json> <输出目录> [目录...]');
}
if(process.argv[1]&&process.argv[1]!=='-'&&import.meta.url===pathToFileURL(realpathSync(process.argv[1])).href) main(process.argv.slice(2)).catch(error=>{console.error(error.message);process.exitCode=1;});
