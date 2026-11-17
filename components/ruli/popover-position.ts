export type AnchorRect = {left:number;top:number;bottom:number};
export function placeParticipantPopover(
  anchor: AnchorRect,
  parent: {left:number;top:number},
  viewport: {width:number;height:number},
  contentHeight: number,
) {
  const margin=12, gap=8;
  const width=Math.max(1,Math.min(280,viewport.width-margin*2));
  const left=Math.max(margin,Math.min(anchor.left,viewport.width-margin-width));
  const below=Math.max(0,viewport.height-margin-anchor.bottom-gap);
  const above=Math.max(0,anchor.top-margin-gap);
  const placeBelow=below>=Math.min(220,contentHeight)||below>=above;
  const available=placeBelow?below:above;
  const maxHeight=Math.max(1,available);
  const height=Math.min(contentHeight,maxHeight);
  const top=placeBelow?anchor.bottom+gap:anchor.top-gap-height;
  return {left:left-parent.left,top:top-parent.top,width,maxHeight};
}

