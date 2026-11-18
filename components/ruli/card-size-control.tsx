"use client";
import {useActionState,useRef} from "react";
import {Grid2X2} from "lucide-react";
import {resizeTaskState} from "@/app/actions";
import type {ActionState} from "@/lib/ruli/action-state";
import {BLOCK_SIZES,taskHref,type BlockSize,type ViewMode} from "@/lib/ruli/model";
import "./card-size-control.css";

export function CardSizeControl({taskId,parentId,version,size,mode}:{taskId:string;parentId:string;version:number;size:BlockSize;mode:ViewMode}) {
  const [state,action,pending]=useActionState<ActionState,FormData>(resizeTaskState,{});
  const detailsRef=useRef<HTMLDetailsElement>(null);
  const summaryRef=useRef<HTMLElement>(null);
  const current=BLOCK_SIZES[size];
  return <details ref={detailsRef} className="card-size-control" onKeyDown={event=>{
    if(event.key==="Escape"&&detailsRef.current?.open){event.preventDefault();detailsRef.current.open=false;summaryRef.current?.focus();}
  }}>
    <summary ref={summaryRef} aria-label={`Размер карточки: ${current.label}`} title="Изменить размер карточки"><Grid2X2 aria-hidden="true"/><span>{current.w} × {current.h}</span></summary>
    <div className="card-size-options">
      <span className="card-size-heading">Размер карточки</span>
      <div className="card-size-choices">{Object.entries(BLOCK_SIZES).map(([value,option])=><form action={action} key={value}>
        <input type="hidden" name="id" value={taskId}/><input type="hidden" name="version" value={version}/><input type="hidden" name="mode" value={mode}/><input type="hidden" name="size" value={value}/>
        <button type="submit" disabled={pending||value===size} aria-pressed={value===size} aria-label={`${option.label}, ${option.w} × ${option.h}${value===size?", выбран":""}`}>
          <span className={`card-size-preview ${value}`} aria-hidden="true"/><span>{option.label}<small>{option.w} × {option.h}</small></span>
        </button>
      </form>)}</div>
      <p className="card-size-mobile-note">На телефоне карточки идут в одну колонку. Форма меняется на широком экране.</p>
      {pending?<p className="card-size-feedback" role="status">Сохраняем размер…</p>:null}
      {state.error?<p className="card-size-error" role="alert">{state.error} <a href={`${taskHref(parentId,mode)}#task-card-${encodeURIComponent(taskId)}`}>Обновить карточку</a></p>:null}
    </div>
  </details>;
}
