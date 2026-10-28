import {expect,vi} from 'vitest';
export function observationBucket() {
  const objects=new Map();
  return {objects,
    get:vi.fn(async key=>objects.has(key)?{size:new TextEncoder().encode(objects.get(key)).byteLength,text:async()=>objects.get(key)}:null),
    put:vi.fn(async(key,value,options)=>{
      expect(options.onlyIf.get('If-None-Match')).toBe('*');
      if(objects.has(key))return null;
      objects.set(key,value);return {key};
    }),
    list:vi.fn(async({prefix})=>({objects:[...objects.keys()].filter(key=>key.startsWith(prefix)).map(key=>({key})),truncated:false})),
  };
}
