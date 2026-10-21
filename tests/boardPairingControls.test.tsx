// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({
  pairing: { pending: vi.fn(async()=>null), finish: vi.fn(async()=>null), invite: vi.fn(async()=> 'invitation-code'), request: vi.fn(async()=>({code:'device-code',verification:'ABCD-1234-EF56'})), preview: vi.fn(async()=>({boardId:'board',verification:'ABCD-1234-EF56'})), approve: vi.fn(async()=>{}), cancel: vi.fn(async()=>{}) },
  stop: vi.fn(async()=>{}), start: vi.fn(async()=>{}), createCopy: vi.fn(async()=> 'copy-board'),
  exportProject: vi.fn(async()=>({items:[]})), getProject: vi.fn(async()=>({id:'board'})), selectProject: vi.fn(async()=>{})
}));
vi.mock('../src/sync/browser',()=>({boardCollaboration:{pairing:m.pairing,createCopy:m.createCopy},collaborationManager:{stop:m.stop,start:m.start,state:()=>({ready:false,error:null,connectedPeers:[],role:"private"})}}));
vi.mock('../src/storage/browser',()=>({repository:{exportProject:m.exportProject,getProject:m.getProject,selectProject:m.selectProject}}));
import { BoardPairingControls } from '../src/sidebar/components/BoardPairingControls';
let node:HTMLDivElement,root:ReturnType<typeof createRoot>;
beforeEach(()=>{vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);vi.clearAllMocks();node=document.createElement('div');document.body.append(node);root=createRoot(node);});
afterEach(()=>{act(()=>root.unmount());node.remove();vi.unstubAllGlobals();});
const button=(name:string)=>[...node.querySelectorAll('button')].find(b=>b.textContent===name)!;
async function input(label:string,value:string){await act(async()=>{const el=node.querySelector(`textarea[aria-label="${label}"]`)!;Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value')!.set!.call(el,value);el.dispatchEvent(new Event('input',{bubbles:true}));});}
it('requests access without admitting or approving the joining device',async()=>{
  await act(async()=>root.render(<BoardPairingControls projectId={null} onChanged={()=>{}}/>));
  await input('Invitation to join','invitation-code');await act(async()=>button('Request access').click());
  expect(m.pairing.request).toHaveBeenCalledWith('invitation-code');
  expect(node.textContent).toContain('ABCD-1234-EF56');
  expect(m.pairing.approve).not.toHaveBeenCalled();expect(m.start).not.toHaveBeenCalled();
});
it('requires matching-code confirmation before explicit owner approval',async()=>{
  await act(async()=>root.render(<BoardPairingControls projectId="board" onChanged={()=>{}}/>));
  await input('Device code to approve','device-code');await act(async()=>button('Review device').click());
  expect(button('Approve device').disabled).toBe(true);
  const checkbox=node.querySelector('input[type="checkbox"]') as HTMLInputElement;
  await act(async()=>checkbox.click());await act(async()=>button('Approve device').click());
  expect(m.pairing.approve).toHaveBeenCalledWith('device-code','ABCD-1234-EF56','editor');
  expect(m.start).toHaveBeenCalledWith('board');
});
it('requires explicit permission for a new collaborative copy and shares its new identity',async()=>{
  await act(async()=>root.render(<BoardPairingControls projectId="board" onChanged={()=>{}}/>));
  expect(button('Create collaborative copy').disabled).toBe(true);
  const checkbox=[...node.querySelectorAll('input[type="checkbox"]')].at(-1) as HTMLInputElement;
  await act(async()=>checkbox.click());await act(async()=>button('Create collaborative copy').click());
  expect(m.createCopy).toHaveBeenCalledWith('board');expect(m.pairing.invite).toHaveBeenCalledWith('copy-board');
  expect(m.start).toHaveBeenCalledWith('copy-board');
});
