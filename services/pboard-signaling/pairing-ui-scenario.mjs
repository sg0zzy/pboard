/** Shared actual-sidebar scenario; adapters provide only native browser control. */
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(fn,label,seconds=40){const end=Date.now()+seconds*1000;while(Date.now()<end){if(await fn())return;await pause(150);}throw Error(label);}
export async function exercisePairingUi(a,b){
  for(const page of [a,b]){await page.click('Enable WebSocket collaboration');await until(()=>page.evaluate("Boolean(document.querySelector('.board-pairing'))"),'Opt-in failed');await page.evaluate("document.querySelector('.board-pairing').parentElement.open=true");}
  await a.evaluate("document.querySelector('button[aria-label=\"New project\"]').click()");
  await until(()=>a.evaluate("Boolean(document.querySelector('input[placeholder=\"Project name\"]'))"),'Project form missing');
  await a.fill('input[placeholder="Project name"]','Real sidebar pairing test');await a.click('Create');
  await until(()=>a.evaluate("Boolean(document.querySelector('.edit-form textarea'))"),'New project/card missing');
  await a.fill('.edit-form textarea','PRIVATE_PAIRING_CARD original');
  await a.evaluate("document.querySelector('.edit-form textarea').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))");
  await until(()=>a.evaluate("!document.querySelector('.edit-form textarea')"),'Card did not save');
  await a.click('Share selected board');
  await until(()=>a.evaluate("Boolean(document.querySelector('textarea[aria-label=\"Invitation code\"]')?.value)"),'Invitation was not created');
  const invite=await a.evaluate("document.querySelector('textarea[aria-label=\"Invitation code\"]').value");
  await b.fill('textarea[aria-label="Invitation to join"]',invite);await b.click('Request access');
  await until(()=>b.evaluate("Boolean(document.querySelector('textarea[aria-label=\"Your device code\"]')?.value)"),'Device request failed');
  const request=await b.evaluate("document.querySelector('textarea[aria-label=\"Your device code\"]').value");
  if(await b.evaluate("Boolean(document.querySelector('[data-card-id]'))"))throw Error('Board arrived before owner approval');
  await b.reload();
  await until(()=>b.evaluate("Boolean(document.querySelector('.board-pairing'))"),'Manual pairing missing after reload');
  await b.evaluate("document.querySelector('.board-pairing').parentElement.open=true");
  await until(()=>b.evaluate("Boolean(document.querySelector('textarea[aria-label=\"Your device code\"]')?.value)"),'Pending request did not survive sidebar reload');
  await a.fill('textarea[aria-label="Device code to approve"]',request);await a.click('Review device');
  await until(()=>a.evaluate("[...document.querySelectorAll('button')].some(b=>b.textContent==='Approve device')"),'Request review failed');
  const code=await a.evaluate("document.querySelector('.board-pairing fieldset:nth-of-type(2) strong').textContent");
  if(!await b.evaluate(`document.querySelector('.board-pairing').textContent.includes(${JSON.stringify(code)})`))throw Error('Verification codes differ');
  await a.evaluate("document.querySelector('.board-pairing fieldset:nth-of-type(2) input[type=checkbox]').click()");
  await a.click('Approve device');
  await until(()=>b.evaluate("Boolean([...document.querySelectorAll('[data-card-id]')].find(c=>c.textContent.includes('PRIVATE_PAIRING_CARD original')))"),'Approved board did not arrive automatically',60);
  await b.evaluate("document.querySelector('[data-card-id]').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))");
  await until(()=>b.evaluate("Boolean(document.querySelector('.edit-form textarea'))"),'Editor did not enter edit mode');
  await b.fill('.edit-form textarea','PRIVATE_PAIRING_CARD edited in Browser B');
  await b.evaluate("document.querySelector('.edit-form textarea').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))");
  await until(()=>a.evaluate("[...document.querySelectorAll('[data-card-id]')].some(c=>c.textContent.includes('PRIVATE_PAIRING_CARD edited in Browser B'))"),'Real sidebar edit did not replicate');
  await b.reload();
  await until(()=>b.evaluate("Boolean(document.querySelector('.board-pairing'))"),'Manual pairing missing after reload');
  await b.evaluate("document.querySelector('.board-pairing').parentElement.open=true");
  await until(()=>b.evaluate("document.body.textContent.includes('PRIVATE_PAIRING_CARD edited in Browser B')"),'Approved board did not reopen');
  // Exercise the explicit copy path on a board that is already signed.
  const originalCard=await a.evaluate("document.querySelector('[data-card-id]').dataset.cardId");
  await a.evaluate("document.querySelector('.board-pairing details').open=true;document.querySelector('.board-pairing details input[type=checkbox]').click()");
  await a.click('Create collaborative copy');
  await until(()=>a.evaluate("document.querySelector('.project-picker-trigger').textContent.includes('(collaboration copy)') && Boolean(document.querySelector('textarea[aria-label=\"Invitation code\"]')?.value)"),'Collaborative copy did not become shareable');
  const copyInvite=await a.evaluate("document.querySelector('textarea[aria-label=\"Invitation code\"]').value");
  const expectedBoard=JSON.parse(Buffer.from(copyInvite.split(':')[1],'base64url').toString()).boardId;
  for(const page of [a,b])await page.evaluate(`window.__expectedPairingBoard=${JSON.stringify(expectedBoard)}`);
  await b.fill('textarea[aria-label="Invitation to join"]',copyInvite);await b.click('Request access');
  await until(()=>b.evaluate("Boolean(document.querySelector('textarea[aria-label=\"Your device code\"]')?.value)"),'Copy device request failed');
  const copyRequest=await b.evaluate("document.querySelector('textarea[aria-label=\"Your device code\"]').value");
  await a.fill('textarea[aria-label="Device code to approve"]',copyRequest);await a.click('Review device');
  await until(()=>a.evaluate("Boolean(document.querySelector('.board-pairing fieldset:nth-of-type(2) input[type=checkbox]'))"),'Copy review failed');
  await a.evaluate("document.querySelector('.board-pairing fieldset:nth-of-type(2) input[type=checkbox]').click()");await a.click('Approve device');
  await until(()=>b.evaluate("document.querySelector('.project-picker-trigger')?.textContent.includes('(collaboration copy)')"),'Copy did not arrive in joining browser',60);
  await until(()=>b.evaluate("[...document.querySelectorAll('[data-card-id]')].some(c=>c.textContent.includes('PRIVATE_PAIRING_CARD edited in Browser B'))"),'Copy cards did not arrive in joining browser',60);
  await b.evaluate("document.querySelector('[data-card-id]').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))");
  await until(()=>b.evaluate("Boolean(document.querySelector('.edit-form textarea'))"),'Copy not editable');
  await b.fill('.edit-form textarea','PRIVATE_PAIRING_CARD changed in copy');
  await b.evaluate("document.querySelector('.edit-form textarea').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))");
  await until(()=>a.evaluate("[...document.querySelectorAll('[data-card-id]')].some(c=>c.textContent.includes('PRIVATE_PAIRING_CARD changed in copy'))"),'Copy edit did not replicate');
  await a.evaluate("document.querySelector('.project-picker-trigger').click()");
  await a.evaluate("[...document.querySelectorAll('.project-picker-option')].find(button=>button.textContent.includes('Real sidebar pairing test')&&!button.textContent.includes('(collaboration copy)')).click()");
  await until(()=>a.evaluate(`Boolean(document.querySelector('[data-card-id="${originalCard}"]')) && document.body.textContent.includes('PRIVATE_PAIRING_CARD edited in Browser B')`),'Original board changed during copy');
}
