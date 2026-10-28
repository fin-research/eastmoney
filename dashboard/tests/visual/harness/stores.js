import {readable} from 'svelte/store';
import {page as state} from './state.js';
// Superforms reads the page store during component initialization. The fixture
// has no server actions or client router; navigation still reloads its URL.
export const page=readable({url:state.url,data:state.data,form:null,error:null,status:200,params:{},route:{id:null}});
export const navigating=readable(null);
