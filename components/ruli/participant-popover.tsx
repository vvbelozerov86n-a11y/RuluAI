"use client";
import {useCallback,useEffect,useId,useLayoutEffect,useRef,useState,type CSSProperties,type ReactNode} from "react";
import {placeParticipantPopover} from "./popover-position";

export function ParticipantPopover({label,summary,children,className}:{
  label:string;summary:ReactNode;children:ReactNode;className:string;
}) {
  const detailsRef=useRef<HTMLDetailsElement>(null);
  const summaryRef=useRef<HTMLElement>(null);
  const popupRef=useRef<HTMLDivElement>(null);
  const [open,setOpen]=useState(false);
  const [position,setPosition]=useState<CSSProperties|null>(null);
  const popupId=useId();
  const place=useCallback(()=>{
    const details=detailsRef.current,summary=summaryRef.current,popup=popupRef.current;
    if(!details?.open||!summary||!popup)return;
    const viewport={width:document.documentElement.clientWidth,height:document.documentElement.clientHeight};
    // Unmeasured content is display:none so an early native toggle cannot cause overflow.
    // Measure synchronously without painting an unconstrained popover.
    const previousStyle=popup.getAttribute("style");
    popup.style.display="block";
    popup.style.visibility="hidden";
    popup.style.width=`${Math.max(1,Math.min(280,viewport.width-24))}px`;
    popup.style.maxHeight="none";
    const contentHeight=popup.scrollHeight+2;
    if(previousStyle===null)popup.removeAttribute("style");else popup.setAttribute("style",previousStyle);
    const next=placeParticipantPopover(summary.getBoundingClientRect(),details.getBoundingClientRect(),
      viewport,contentHeight);
    setPosition(previous=>previous&&previous.left===next.left&&previous.top===next.top
      &&previous.width===next.width&&previous.maxHeight===next.maxHeight?previous:next);
  },[]);
  useLayoutEffect(()=>{
    // Native details can open before hydration attaches onToggle.
    const details=detailsRef.current;
    if(details?.open){setOpen(details.open);place();}
  },[place]);
  useEffect(()=>{
    if(!open)return;
    function close(restoreFocus=false) {
      if(detailsRef.current)detailsRef.current.open=false;
      if(restoreFocus)summaryRef.current?.focus();
    }
    function outside(event:PointerEvent) {
      if(event.target instanceof Node&&!detailsRef.current?.contains(event.target))close();
    }
    function keydown(event:KeyboardEvent) {
      if(event.key==="Escape"){event.preventDefault();close(true);}
    }
    window.addEventListener("resize",place);
    window.addEventListener("scroll",place,true);
    document.addEventListener("pointerdown",outside);
    document.addEventListener("keydown",keydown);
    return ()=>{
      window.removeEventListener("resize",place);
      window.removeEventListener("scroll",place,true);
      document.removeEventListener("pointerdown",outside);
      document.removeEventListener("keydown",keydown);
    };
  },[open,place]);
  return <details ref={detailsRef} className="participant-picker" onToggle={event=>{
    const next=event.currentTarget.open;setOpen(next);
    if(next)place();else setPosition(null);
  }}>
    <summary ref={summaryRef} className={className} aria-label={label} aria-controls={popupId}>{summary}</summary>
    <div ref={popupRef} id={popupId} className="participant-popover" role="region" aria-label={label}
      style={{...position,display:position?"block":"none",visibility:position?"visible":"hidden"}}>{children}</div>
  </details>;
}

