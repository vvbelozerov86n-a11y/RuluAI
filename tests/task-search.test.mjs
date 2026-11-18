import test from "node:test";
import assert from "node:assert/strict";
import {dueTodaySource,hasTaskFilters,normalizeTaskFilters,overdueSource,searchTasks,taskAttentionSummary,taskDeadlineSource,taskEntries} from "../lib/ruli/task-search.ts";

const today="2026-11-18";
function leaf(id,changes={}) {
  return {id,parentId:"group",kind:"leaf",title:id,ownerId:"anna",status:"todo",dueDate:null,dueLabel:"Без срока",description:"",result:"",size:"small",theme:"teal",position:0,children:[],participants:[],version:1,deletedAt:null,splitSourceId:null,...changes};
}
function group(id,children,changes={}) {return {...leaf(id),kind:"group",status:null,ownerId:"manager",children,...changes};}
const ids=results=>results.map(entry=>entry.node.id);

test("summary counts leaf work once through nested groups and matches each destination",()=>{
  const tree=group("root",[group("project",[group("phase",[
    leaf("review-late",{status:"review",dueDate:"2026-11-17"}),
    leaf("review-today",{status:"review",dueDate:today}),
    leaf("doing-today",{status:"doing",dueDate:today}),
    leaf("future",{dueDate:"2026-11-19"}),
  ],{dueDate:"2026-11-30"})],{dueDate:"2026-11-30"})]);
  const summary=taskAttentionSummary(tree,today);
  assert.deepEqual(summary,{review:2,late:1,today:2});
  for(const [key,filters] of [["review",{status:"review"}],["late",{late:"1"}],["today",{due:"today"}]]) {
    const results=searchTasks(tree,filters,today);
    assert.equal(results.length,summary[key]);
    assert.ok(results.every(entry=>entry.node.kind==="leaf"));
  }
});

test("expired ancestor deadlines count unfinished leaves once and identify the source group",()=>{
  const tree=group("root",[group("project",[group("phase",[
    leaf("no-deadline"),
    leaf("future-deadline",{status:"review",dueDate:"2026-11-25"}),
    leaf("own-expired",{dueDate:"2026-11-15"}),
    leaf("finished",{status:"done"}),
    leaf("deleted",{deletedAt:"2026-11-18T01:00:00Z"}),
  ],{dueDate:"2026-11-17"})],{dueDate:"2026-11-16"})]);
  const results=searchTasks(tree,{late:"1"},today);
  assert.deepEqual(ids(results),["no-deadline","future-deadline","own-expired"]);
  assert.deepEqual(taskAttentionSummary(tree,today),{review:1,late:3,today:0});
  assert.equal(overdueSource(results[0],today)?.id,"phase");
  assert.equal(overdueSource(results[1],today)?.id,"phase");
  assert.equal(overdueSource(results[2],today)?.id,"own-expired");
  assert.deepEqual(ids(searchTasks(tree,{late:"1",status:"review",owner:"anna"},today)),["future-deadline"]);
  assert.equal(overdueSource(taskEntries(tree).find(entry=>entry.node.id==="finished"),today),null);
});

test("ancestor deadline today is not overdue and a completed group has no overdue source",()=>{
  const tree=group("root",[group("today-group",[leaf("unfinished")],{dueDate:today}),group("completed-group",[leaf("done",{status:"done"})],{dueDate:"2026-11-01"})]);
  assert.equal(taskAttentionSummary(tree,today).late,0);
  assert.equal(overdueSource(taskEntries(tree).find(entry=>entry.node.id==="completed-group"),today),null);
});

test("group deadlines today include unfinished leaves without double counting and explain the source",()=>{
  const tree=group("root",[group("project",[group("phase",[
    leaf("no-deadline"),
    leaf("future-deadline",{status:"review",dueDate:"2026-11-25"}),
    leaf("own-today",{dueDate:today}),
    leaf("already-late",{dueDate:"2026-11-17"}),
    leaf("finished",{status:"done"}),
    leaf("deleted",{deletedAt:"2026-11-18T01:00:00Z"}),
  ],{dueDate:today})],{dueDate:today})]);
  const results=searchTasks(tree,{due:"today"},today),summary=taskAttentionSummary(tree,today);
  assert.deepEqual(ids(results),["no-deadline","future-deadline","own-today"]);
  assert.equal(summary.today,results.length);
  assert.deepEqual(summary,{review:1,late:1,today:3});
  assert.equal(dueTodaySource(results[0],today)?.id,"phase");
  assert.equal(dueTodaySource(results[1],today)?.id,"phase");
  assert.equal(dueTodaySource(results[2],today)?.id,"own-today");
  assert.equal(dueTodaySource(taskEntries(tree).find(entry=>entry.node.id==="finished"),today),null);
  assert.deepEqual(ids(searchTasks(tree,{due:"today",status:"review",owner:"anna"},today)),["future-deadline"]);
});

test("an expired ancestor takes precedence over a later deadline today",()=>{
  const tree=group("root",[group("overdue-parent",[leaf("own-today",{dueDate:today}),group("today-group",[leaf("no-date")],{dueDate:today})],{dueDate:"2026-11-17"})]);
  assert.deepEqual(taskAttentionSummary(tree,today),{review:0,late:2,today:0});
  assert.deepEqual(searchTasks(tree,{due:"today"},today),[]);
  assert.deepEqual(ids(searchTasks(tree,{late:"1"},today)),["own-today","no-date"]);
});

test("the earliest upcoming date is shown, preferring the task or nearest group for ties",()=>{
  const phase=group("phase",[
    leaf("inherited"),leaf("own-first",{dueDate:"2026-11-19"}),leaf("tie",{dueDate:"2026-11-20"}),
    leaf("done",{status:"done"}),
  ],{dueDate:"2026-11-20"});
  const project=group("project",[phase],{dueDate:"2026-11-20"});
  const entries=taskEntries(group("root",[project])).filter(({node})=>node.kind==="leaf");
  assert.deepEqual(entries.map(entry=>taskDeadlineSource(entry,today)?.id),["phase","own-first","tie",undefined]);
  project.dueDate="2026-11-19";
  assert.equal(taskDeadlineSource(entries[0],today)?.id,"project");
});

test("completed work is absent from urgency but searchable as completed",()=>{
  const tree=group("root",[leaf("done-old",{status:"done",dueDate:"2026-11-01"}),leaf("done-today",{status:"done",dueDate:today})]);
  assert.deepEqual(taskAttentionSummary(tree,today),{review:0,late:0,today:0});
  assert.deepEqual(ids(searchTasks(tree,{status:"done"},today)),["done-old","done-today"]);
  assert.deepEqual(searchTasks(tree,{status:"done",late:"1"},today),[]);
});

test("deleted nodes and descendants of a deleted group never leak into search or summary",()=>{
  const tree=group("root",[
    leaf("deleted",{status:"review",dueDate:today,deletedAt:"2026-11-18T01:00:00Z"}),
    group("deleted-parent",[leaf("hidden-live-child",{status:"review",dueDate:"2026-11-17"})],{deletedAt:"2026-11-18T01:00:00Z"}),
    leaf("visible"),
  ]);
  assert.deepEqual(ids(taskEntries(tree)),["visible"]);
  assert.deepEqual(taskAttentionSummary(tree,today),{review:0,late:0,today:0});
  assert.deepEqual(searchTasks(tree,{q:"hidden"},today),[]);
});

test("deadline categories reject invalid dates and distinguish today from overdue",()=>{
  const tree=group("root",[leaf("missing"),leaf("invalid",{dueDate:"2026-02-30"}),leaf("today",{dueDate:today}),leaf("past",{dueDate:"2026-11-17"})]);
  assert.deepEqual(ids(searchTasks(tree,{due:"today"},today)),["today"]);
  assert.deepEqual(ids(searchTasks(tree,{late:"1"},today)),["past"]);
  assert.deepEqual(taskAttentionSummary(tree,"invalid"),{review:0,late:0,today:0});
});

test("text search finds groups, descriptions and results with full breadcrumb paths",()=>{
  const tree=group("root",[group("project",[leaf("description",{description:"Подготовить ОБЗОР рынка"}),leaf("result",{status:"done",result:"Обзор готов"})],{title:"Обзор продукта"})]);
  const result=searchTasks(tree,{q:"  обзор  "},today);
  assert.deepEqual(ids(result),["project","description","result"]);
  assert.deepEqual(result[2].path.map(node=>node.id),["root","project","result"]);
});

test("combined owner, status, text and deadline filters narrow to the same task",()=>{
  const tree=group("root",[group("parent",[
    leaf("match",{title:"Отчёт",status:"review",dueDate:today}),
    leaf("other-owner",{title:"Отчёт",ownerId:"max",status:"review",dueDate:today}),
    leaf("other-status",{title:"Отчёт",dueDate:today}),
    leaf("other-day",{title:"Отчёт",status:"review",dueDate:"2026-11-19"}),
  ],{ownerId:"max"})]);
  assert.deepEqual(ids(searchTasks(tree,{q:"отчёт",owner:"anna",status:"review",due:"today"},today)),["match"]);
  assert.deepEqual(ids(searchTasks(tree,{owner:"max",status:"review"},today)),["other-owner"]);
  assert.deepEqual(searchTasks(tree,{owner:"missing"},today),[]);
});

test("selecting both deadlines includes either category while other filters still narrow the result",()=>{
  const review={title:"Отчёт",status:"review"};
  const tree=group("root",[
    group("late-project",[
      leaf("inherited-overdue",{...review,dueDate:today}),
      leaf("other-owner",{...review,ownerId:"max"}),
    ],{dueDate:"2026-11-17"}),
    leaf("due-today",{...review,dueDate:today}),
    leaf("other-text",{status:"review",title:"Счёт",dueDate:today}),
    leaf("other-status",{title:"Отчёт",dueDate:today}),
    leaf("future",{...review,dueDate:"2026-11-19"}),
    leaf("no-deadline",review),
    leaf("finished",{...review,status:"done",dueDate:today}),
  ]);
  const deadlines={late:"1",due:"today"};
  assert.deepEqual(ids(searchTasks(tree,deadlines,today)),["inherited-overdue","other-owner","due-today","other-text","other-status"]);
  assert.deepEqual(ids(searchTasks(tree,{...deadlines,q:"отчёт",owner:"anna",status:"review"},today)),["inherited-overdue","due-today"]);
});

test("empty and unsupported filters do not accidentally hide the normal overview",()=>{
  assert.equal(hasTaskFilters({q:" \n ",status:"unknown",late:"false",due:"tomorrow"}),false);
  assert.deepEqual(normalizeTaskFilters({q:"  рынок  ",owner:" anna ",status:"review",late:"1",due:"today"}),{q:"рынок",owner:"anna",status:"review",late:"1",due:"today"});
  assert.deepEqual(taskAttentionSummary(group("root",[group("empty",[],{dueDate:"2026-11-01"})]),today),{review:0,late:0,today:0});
});
