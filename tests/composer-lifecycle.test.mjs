import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import {createRequire} from "node:module";
import {fileURLToPath} from "node:url";
import React from "react";
import {renderToStaticMarkup} from "react-dom/server";
import ts from "typescript";

const project=fileURLToPath(new URL("../",import.meta.url));
const require=createRequire(import.meta.url);
const bot={memberId:"analyst",name:"Аналитик",kind:"llm",provider:"openai",model:"fixture-model",enabled:true,configured:true,ready:true,disabledReason:null};
const props={taskId:"task",viewerUserId:"manager",clientId:"initial-client-id",mode:"view",bots:[bot]};
const plain=value=>JSON.parse(JSON.stringify(value));
function deferred() {let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
function browser() {
  const saved=new Map();
  return {saved,window:{sessionStorage:{getItem:key=>saved.get(key)??null,setItem:(key,value)=>saved.set(key,value),removeItem:key=>saved.delete(key)},
    addEventListener(){},removeEventListener(){},dispatchEvent(){},matchMedia:()=>({matches:false})}};
}
function elements(node) {
  if(Array.isArray(node))return node.flatMap(elements);
  return React.isValidElement(node)?[node,...elements(node.props.children)]:[];
}

// Execute the actual component's onSubmit, onChange, action reducer and effects,
// backed by its actual draft modules. Only React lifecycle scheduling and the
// server response are controlled. A fresh runtime models a page reload, while
// remounting the same runtime models channel navigation with an in-flight action.
function runtime(web,send=async()=>({})) {
  let current;
  const cache=new Map();
  const depsEqual=(a,b)=>a&&b&&a.length===b.length&&a.every((item,index)=>Object.is(item,b[index]));
  const slot=initial=>{const mount=current,index=mount.cursor++;if(!(index in mount.slots))mount.slots[index]=initial();return mount.slots[index];};
  const hooks={...React,
    useState(initial){const state=slot(()=>({value:typeof initial==="function"?initial():initial}));return [state.value,next=>{state.value=typeof next==="function"?next(state.value):next;}];},
    useRef(initial){return slot(()=>({current:initial}));},
    useId(){return slot(()=>({id:`fixture-${current.cursor}`})).id;},
    useMemo(factory,deps){const state=slot(()=>({}));if(!depsEqual(state.deps,deps)){state.value=factory();state.deps=deps;}return state.value;},
    useSyncExternalStore(_subscribe,getSnapshot){return getSnapshot();},
    useEffect(effect,deps){const state=slot(()=>({}));if(!depsEqual(state.deps,deps)){state.deps=deps;current.effects.push(()=>{state.cleanup?.();state.cleanup=effect();});}},
    useActionState(reducer,initial){
      const state=slot(()=>({value:initial,pending:false}));
      return [state.value,async form=>{state.pending=true;try{const next=await reducer(state.value,form);state.value=next;return next;}finally{state.pending=false;}},state.pending];
    },
  };
  function load(relative) {
    let filename=path.resolve(project,relative);
    if(!path.extname(filename))filename=[".tsx",".ts"].map(ext=>filename+ext).find(fs.existsSync);
    if(cache.has(filename))return cache.get(filename).exports;
    const compiledModule={exports:{}};cache.set(filename,compiledModule);
    const code=ts.transpileModule(fs.readFileSync(filename,"utf8"),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText;
    const localRequire=id=>id==="react"?hooks:id==="@/app/collaboration-actions"?{sendMessageState:send}:id.endsWith(".css")?{}:id.startsWith(".")?load(path.resolve(path.dirname(filename),id)):id.startsWith("@/")?load(id.slice(2)):require(id);
    vm.runInNewContext(code,{module:compiledModule,exports:compiledModule.exports,require:localRequire,console,crypto,window:web.window,FormData,URL,CustomEvent:class {constructor(type,options){this.type=type;this.detail=options?.detail;}}},{filename});
    return compiledModule.exports;
  }
  const {MessageComposer}=load("components/ruli/message-composer.tsx");
  const {getDraftStore}=load("components/ruli/chat-draft-store.ts");
  const {draftStorageKey}=load("components/ruli/chat-drafts.ts");
  function mount(extra={}) {
    const state={slots:[],cursor:0,effects:[],props:{...props,...extra},alive:true,tree:null};
    const api={
      render(changes={}){assert.ok(state.alive);state.props={...state.props,...changes};state.cursor=0;state.effects=[];current=state;try{state.tree=MessageComposer(state.props);}finally{current=null;}for(const effect of state.effects)effect();return api;},
      find(predicate){const found=elements(state.tree).find(predicate);assert.ok(found,"Expected component element");return found;},
      body(text){api.find(element=>element.type==="textarea"&&element.props.name==="body").props.onChange({target:{value:text}});return api.render();},
      target(id){api.find(element=>element.type==="select"&&element.props.name==="botMemberId").props.onChange({target:{value:id}});return api.render();},
      snapshot(){return getDraftStore(draftStorageKey(state.props),state.props.clientId).getSnapshot();},
      formData(){const form=new FormData();for(const element of elements(state.tree)){const input=element.props;if(["input","textarea","select"].includes(element.type)&&input.name&&!input.disabled)form.set(input.name,String(input.value??""));}return form;},
      submit(){const form=api.find(element=>element.type==="form"),data=api.formData();let blocked=false;form.props.onSubmit({preventDefault(){blocked=true;}});return {blocked,data,promise:blocked?Promise.resolve(null):form.props.action(data)};},
      html(){return renderToStaticMarkup(state.tree);},
      unmount(){state.alive=false;for(const hook of state.slots)hook.cleanup?.();},
    };
    return api.render();
  }
  return {mount};
}

test("actual onSubmit persists A before response; reload while pending preserves A and separately edited B",()=>{
  const web=browser(),gate=deferred(),ui=runtime(web,()=>gate.promise),composer=ui.mount();
  composer.target(bot.memberId).body("Submitted A");
  const submitted=composer.submit();assert.equal(submitted.blocked,false);
  const a=plain(composer.snapshot().unsent[0]);
  assert.equal(a.body,"Submitted A");assert.equal(a.botMemberId,bot.memberId);
  assert.equal(submitted.data.get("clientId"),a.clientId);
  composer.render().body("New draft B");
  const b=plain(composer.snapshot().draft);
  composer.unmount();
  // No old-realm effects/action continuation run after a real page reload.
  const reloaded=runtime(web).mount();
  assert.deepEqual(plain(reloaded.snapshot().draft),b);
  assert.deepEqual(plain(reloaded.snapshot().unsent),[a]);
  assert.match(reloaded.html(),/Отправка не подтверждена/);
  assert.doesNotMatch(reloaded.html(),/Эти сообщения не удалось отправить/);
  assert.equal(reloaded.find(element=>element.type==="select").props.value,bot.memberId);
});

test("rejection after unmount leaves submitted A and edited B recoverable without depending on effects",async()=>{
  const web=browser(),gate=deferred(),ui=runtime(web,()=>gate.promise),composer=ui.mount();
  composer.target(bot.memberId).body("Submitted A");
  const submitted=composer.submit();composer.render().body("New draft B");
  const b=plain(composer.snapshot().draft);composer.unmount();
  gate.resolve({error:"Rejected",values:Object.fromEntries(submitted.data.entries())});await submitted.promise;
  const remounted=ui.mount();
  assert.deepEqual(plain(remounted.snapshot().draft),b);
  assert.equal(remounted.snapshot().unsent[0].body,"Submitted A");
  assert.equal(remounted.snapshot().unsent[0].botMemberId,bot.memberId);
  const reloaded=runtime(web).mount();assert.equal(reloaded.snapshot().unsent[0].body,"Submitted A");
});

test("transport rejection after submitted A never erases newer B during unmount and reload",async()=>{
  const web=browser(),gate=deferred(),ui=runtime(web,()=>gate.promise),composer=ui.mount();
  composer.body("Submitted A");const submitted=composer.submit();composer.render().body("New draft B");composer.unmount();
  gate.reject(new Error("Fixture connection lost"));await assert.rejects(submitted.promise,/connection lost/);
  const reloaded=runtime(web).mount();
  assert.equal(reloaded.snapshot().draft.body,"New draft B");assert.equal(reloaded.snapshot().unsent[0].body,"Submitted A");
});

test("ack after unmount removes only A while the newly mounted composer and storage retain B",async()=>{
  const web=browser(),gate=deferred(),ui=runtime(web,()=>gate.promise),composer=ui.mount();
  composer.target(bot.memberId).body("Submitted A");const submitted=composer.submit();
  composer.render().body("New draft B");const b=plain(composer.snapshot().draft);composer.unmount();
  const remounted=ui.mount();
  gate.resolve({sentClientId:submitted.data.get("clientId")});await submitted.promise;remounted.render();
  assert.deepEqual(plain(remounted.snapshot().draft),b);assert.equal(remounted.snapshot().unsent.length,0);
  const reloaded=runtime(web).mount();assert.deepEqual(plain(reloaded.snapshot().draft),b);assert.equal(reloaded.snapshot().unsent.length,0);
});

test("ack of the unchanged submitted draft clears text but preserves the selected recipient on reload",async()=>{
  const web=browser(),ui=runtime(web,async(_previous,form)=>({sentClientId:form.get("clientId")})),composer=ui.mount();
  composer.target(bot.memberId).body("Submitted A");const submitted=composer.submit();await submitted.promise;composer.render();
  assert.equal(composer.snapshot().draft.body,"");assert.equal(composer.snapshot().unsent.length,0);
  const reloaded=runtime(web).mount();assert.equal(reloaded.snapshot().draft.botMemberId,bot.memberId);
  assert.equal(reloaded.find(element=>element.type==="select").props.value,bot.memberId);
});

test("recipient survives channel navigation; removed or disabled recipients require an explicit choice",async()=>{
  const web=browser(),ui=runtime(web),composer=ui.mount();
  composer.target(bot.memberId).body("Question for analyst");composer.unmount();
  const other=ui.mount({channelMemberId:"anna"});assert.equal(other.snapshot().draft.body,"");other.unmount();
  const restored=ui.mount();assert.equal(restored.snapshot().draft.botMemberId,bot.memberId);
  restored.render({bots:[]});assert.match(restored.html(),/Прежний адресат недоступен/);
  const missing=restored.submit();assert.equal(missing.blocked,true);await missing.promise;
  assert.equal(restored.snapshot().draft.botMemberId,bot.memberId);
  restored.render({bots:[{...bot,ready:false,enabled:false,disabledReason:"Бот выключен"}]});
  assert.equal(restored.submit().blocked,true);assert.equal(restored.snapshot().draft.body,"Question for analyst");
  restored.target("");assert.equal(restored.snapshot().draft.botMemberId,undefined);
  const team=restored.submit();assert.equal(team.blocked,false);await team.promise;assert.equal(team.data.get("botMemberId"),"");
});

test("role-disabled AI stays blocked for saved recipients while an explicit team message remains sendable",async()=>{
  const web=browser(),ui=runtime(web),composer=ui.mount();
  composer.target(bot.memberId).body("Question");composer.unmount();
  const limited=runtime(web).mount({aiDisabledReason:"AI доступен только участникам задачи."});
  assert.match(limited.html(),/AI доступен только участникам задачи/);
  assert.equal(limited.find(element=>element.type==="option"&&element.props.value===bot.memberId).props.disabled,true);
  const blocked=limited.submit();assert.equal(blocked.blocked,true);await blocked.promise;
  assert.equal(limited.snapshot().unsent.length,0);
  limited.target("");const human=limited.submit();assert.equal(human.blocked,false);await human.promise;
});

test("recovery retains the original recipient and never merges it silently into another bot's draft",async()=>{
  const second={...bot,memberId:"writer",name:"Автор"};
  const web=browser(),gate=deferred(),ui=runtime(web,()=>gate.promise),composer=ui.mount({bots:[bot,second]});
  composer.target(bot.memberId).body("Question for analyst");const submitted=composer.submit();
  gate.resolve({error:"Rejected",values:Object.fromEntries(submitted.data.entries())});await submitted.promise;composer.render();
  composer.target(second.memberId).body("Question for writer");
  const restore=composer.find(element=>element.type==="button"&&element.props.children==="Добавить к черновику");
  restore.props.onClick();composer.render();
  assert.equal(composer.snapshot().draft.body,"Question for writer");assert.equal(composer.snapshot().draft.botMemberId,second.memberId);
  assert.equal(composer.snapshot().unsent[0].botMemberId,bot.memberId);
  assert.match(composer.html(),/разные адресаты/);
  composer.body("");composer.find(element=>element.type==="button"&&element.props.children==="Добавить к черновику").props.onClick();composer.render();
  assert.equal(composer.snapshot().draft.body,"Question for analyst");assert.equal(composer.snapshot().draft.botMemberId,bot.memberId);
  assert.equal(composer.snapshot().unsent.length,0);
});

test("pending submission keeps Enter usable for the next draft and blocks a duplicate submit",async()=>{
  const web=browser(),gate=deferred(),ui=runtime(web,()=>gate.promise),composer=ui.mount();
  composer.body("Submitted A");
  let requested=0,prevented=0;
  composer.find(element=>element.type==="form").props.ref.current={requestSubmit(){requested++;}};
  const enter=()=>({key:"Enter",keyCode:13,nativeEvent:{isComposing:false},shiftKey:false,altKey:false,ctrlKey:false,metaKey:false,preventDefault(){prevented++;}});
  composer.find(element=>element.type==="textarea"&&element.props.name==="body").props.onKeyDown(enter());
  assert.equal(requested,1);assert.equal(prevented,1);
  const submitted=composer.submit();composer.render().body("New draft B");
  requested=0;prevented=0;
  composer.find(element=>element.type==="textarea"&&element.props.name==="body").props.onKeyDown(enter());
  assert.equal(requested,0);assert.equal(prevented,0,"Enter must not swallow the newline while a request is pending");
  const duplicate=composer.submit();assert.equal(duplicate.blocked,true);await duplicate.promise;
  assert.equal(composer.snapshot().unsent.length,1);
  gate.resolve({sentClientId:submitted.data.get("clientId")});await submitted.promise;composer.render();
  assert.equal(composer.snapshot().draft.body,"New draft B");
});
