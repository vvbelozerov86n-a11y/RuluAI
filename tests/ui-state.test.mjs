import test from "node:test";
import assert from "node:assert/strict";
import {draftStorageKey, readDraft, editDraft, acknowledgeDraft} from "../components/ruli/chat-drafts.ts";
import {placeParticipantPopover} from "../components/ruli/popover-position.ts";

test("private drafts are isolated by account, task and channel without delimiter collisions", () => {
  const contexts = [
    {viewerUserId:"alice", taskId:"task-one"},
    {viewerUserId:"bob", taskId:"task-one"},
    {viewerUserId:"alice", taskId:"task-two"},
    {viewerUserId:"alice", taskId:"task-one", channelMemberId:"anna"},
    {viewerUserId:"alice", taskId:"task-one", channelMemberId:"max"},
    {viewerUserId:"alice:a", taskId:"b", channelMemberId:"c"},
    {viewerUserId:"alice", taskId:"a:b", channelMemberId:"c"},
  ];
  assert.equal(new Set(contexts.map(draftStorageKey)).size, contexts.length);
});

test("a saved draft survives reload with the same idempotency key", () => {
  const draft={body:"Не потерять заметку после построения графика",clientId:"retry-key-123"};
  assert.deepEqual(readDraft(JSON.stringify(draft),"unused-fallback"),draft);
  assert.equal(editDraft(draft,draft.body,"unused-new-key"),draft);
});

test("editing after a failed or uncertain send gives the new revision a separate key", () => {
  const original={body:"Первая версия",clientId:"original-key"};
  const changed=editDraft(original,"Уточнённая версия","revision-key");
  assert.deepEqual(changed,{body:"Уточнённая версия",clientId:"revision-key"});
  assert.equal(original.body,"Первая версия");
  assert.equal(editDraft(changed,changed.body,"ignored-key"),changed);
});

test("only the acknowledgment for the current draft clears its body", () => {
  const draft={body:"Отправляем этот текст",clientId:"sending-key"};
  assert.equal(acknowledgeDraft(draft,"other-message","unused-key"),draft);
  assert.deepEqual(acknowledgeDraft(draft,"sending-key","next-message"),{body:"",clientId:"next-message"});
});

test("a delayed send acknowledgment cannot erase a newer draft", () => {
  const sent={body:"Отправленное сообщение",clientId:"sent-message"};
  const newer=editDraft(sent,"Следующее сообщение","next-message");
  assert.equal(acknowledgeDraft(newer,"sent-message","unused-key"),newer);
  assert.deepEqual(readDraft(JSON.stringify(newer),"fallback-key"),newer);
});

test("malformed browser storage does not inject an invalid draft or crash the composer", () => {
  for(const raw of ["{broken",JSON.stringify({body:17,clientId:"valid-key"}),JSON.stringify({body:"x",clientId:"bad key"}),JSON.stringify({body:"x".repeat(5001),clientId:"valid-key"})]){
    assert.deepEqual(readDraft(raw,"fallback-key"),{body:"",clientId:"fallback-key"});
  }
});

test("participant popovers stay inside the client viewport, including scrollbar width", () => {
  for(const [width,left] of [[1280,1016.9],[1265,1016.9],[390,94],[320,94]]){
    const parent={left,top:250},anchor={left,top:250,bottom:292};
    const position=placeParticipantPopover(anchor,parent,{width,height:800},250);
    const absoluteLeft=parent.left+position.left;
    assert.ok(absoluteLeft>=12);
    assert.ok(absoluteLeft+position.width<=width-12);
    assert.ok(parent.top+position.top>=12);
    assert.ok(parent.top+position.top+Math.min(250,position.maxHeight)<=788);
  }
});

test("tall participant lists open above a low trigger and remain scrollable within the viewport", () => {
  const parent={left:100,top:710},anchor={left:100,top:710,bottom:752};
  const position=placeParticipantPopover(anchor,parent,{width:1280,height:768},3000);
  assert.equal(parent.top+position.top,12);
  assert.ok(position.maxHeight<3000);
  assert.equal(parent.top+position.top+position.maxHeight,702);
});

